"""Chiaki Remote Play sidecar.

Thin HTTP wrapper over pyremoteplay so the Node.js backend can drive PSN
OAuth, console registration, session start/stop, and DualSense input emulation
without bundling Python into the main image.

Endpoints (all JSON):
  GET  /health                          -> { ok, version }
  GET  /oauth/login_url                 -> { url }
  POST /oauth/exchange   {redirect_url} -> { account_id, online_id }
  GET  /discover         ?ip            -> { status, host_type, ... }
  POST /register {ip, account_id, pin}  -> { ok, credentials }
  POST /sessions/start   {ip, user}     -> { session_id, state }
  POST /sessions/{id}/input  {button,action,value} -> { ok }
  POST /sessions/{id}/stop              -> { ok }
  GET  /sessions/{id}                   -> { state }

The wrapper keeps live sessions in an in-memory dict keyed by a generated id.
A pyremoteplay session runs its own asyncio loop so we adopt the FastAPI
event loop for its tasks and gracefully tear down sessions on shutdown.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import secrets
import time
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Configure logging early so the patches module (and pyremoteplay itself)
# can use the same formatter from the very first import.
LOG_LEVEL = os.environ.get("CHIAKI_SIDECAR_LOG", "info").upper()
logging.basicConfig(level=LOG_LEVEL, format="[chiaki] %(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chiaki")

# pyremoteplay imports - kept lazy/optional so a broken install still lets
# /health respond (useful for debugging the container itself).
_FALLBACK_LOGIN_URL = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize"
try:
    # Apply our pyremoteplay bug fixes *before* the first import so every
    # consumer (including modules imported transitively) picks them up.
    # See pyremoteplay_patches.py for what changes and why.
    from pyremoteplay_patches import apply as _apply_pyrp_patches  # type: ignore
    _apply_pyrp_patches()

    from pyremoteplay import RPDevice  # type: ignore
    from pyremoteplay.oauth import (  # type: ignore
        get_login_url,
        async_get_user_account,
    )
    from pyremoteplay.profile import Profiles  # type: ignore
    from pyremoteplay.ddp import launch as ddp_launch  # type: ignore
    PYREMOTEPLAY_OK = True
    PYREMOTEPLAY_ERR: Optional[str] = None
except Exception as e:  # noqa: BLE001
    PYREMOTEPLAY_OK = False
    PYREMOTEPLAY_ERR = str(e)
    RPDevice = None  # type: ignore
    Profiles = None  # type: ignore
    ddp_launch = None  # type: ignore

app = FastAPI(title="chiaki-sidecar", version="0.1.0")

# session_id -> { device: RPDevice, user: dict, created: ts, last_used: ts }
SESSIONS: Dict[str, Dict[str, Any]] = {}

# ip -> monotonic timestamp of when we last disconnected a session for this IP.
# pyremoteplay/PS5 have no protocol-level "session bye" message: when we close
# the TCP socket the PS5 keeps the session record alive until its heartbeat
# timer expires (~25-30 s). During that window any new "Start session" attempt
# is rejected with "Another Remote Play session is connected to host". We use
# this map to know when /sessions/start should automatically wait for that
# lock to expire instead of failing immediately.
RECENT_DISCONNECTS: Dict[str, float] = {}
# PS5 firmware holds the per-IP Remote Play session lock for ~60-75 s after an
# abrupt disconnect (pyremoteplay has no graceful BYE, so every disconnect is
# abrupt). 60 s wait + retry tail covers > 95 % of reconnects without an
# operator-visible failure. See `/sessions/start` retry loop for the remainder.
PS5_SESSION_LOCK_S = 60.0

# Warm cache: when a session is "stopped" we don't actually tear it down,
# we park the live RP protocol in PAUSED_SESSIONS for a few minutes so a
# subsequent /sessions/start for the same IP can resume the same session
# instantly instead of fighting the PS5 firmware lock for 60-150 s. After
# WARM_CACHE_TTL_S of inactivity the GC task tears it down properly.
#
# Indexed by IP because the PS5 (and our UI) only support one session per
# console at a time anyway.
PAUSED_SESSIONS: Dict[str, Dict[str, Any]] = {}
WARM_CACHE_TTL_S = 180.0


@app.get("/health")
async def health():
    return {
        "ok": True,
        "pyremoteplay": PYREMOTEPLAY_OK,
        "pyremoteplay_error": PYREMOTEPLAY_ERR,
        "sessions": list(SESSIONS.keys()),
        "warm_cache": [
            {"ip": ip, "sid": p["sid"], "age_s": round(time.monotonic() - p["paused_at"], 1)}
            for ip, p in PAUSED_SESSIONS.items()
        ],
    }


# ─── OAuth ────────────────────────────────────────────────────────────────────

class OAuthExchange(BaseModel):
    redirect_url: str


@app.get("/oauth/login_url")
async def oauth_login_url():
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    try:
        url = get_login_url()
    except Exception as e:  # noqa: BLE001
        url = _FALLBACK_LOGIN_URL
        log.warning("get_login_url failed, falling back: %s", e)
    return {"url": url}


@app.post("/oauth/exchange")
async def oauth_exchange(req: OAuthExchange):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    try:
        user = await async_get_user_account(req.redirect_url)
    except Exception as e:  # noqa: BLE001
        log.exception("oauth exchange failed")
        raise HTTPException(400, f"OAuth exchange failed: {e}")
    if not user:
        raise HTTPException(400, "PSN did not return user account or the redirect URL/code already expired - run the OAuth flow again")
    # pyremoteplay's _format_account_info() always sets "user_id" (the PSN
    # account id) plus "user_rpid" and "credentials". The PSN-supplied fields
    # vary, but commonly include "online_id" / "onlineId".
    account_id = (
        user.get("user_id")
        or user.get("account_id")
        or user.get("accountId")
    )
    online_id = (
        user.get("online_id")
        or user.get("onlineId")
        or user.get("name")
        or ""
    )
    if not account_id:
        raise HTTPException(400, f"PSN response missing user_id; raw keys: {list(user.keys())}")
    return {
        "account_id": str(account_id),
        "online_id": str(online_id),
        "user_rpid": user.get("user_rpid"),
        "credentials": user.get("credentials"),
        "raw": user,
    }


# ─── Discovery / Status ───────────────────────────────────────────────────────

@app.get("/discover")
async def discover(ip: str):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    device = RPDevice(ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"discover failed: {e}")
    status = device.status or {}
    return {
        "ip": ip,
        "host_type": status.get("host-type"),
        "host_name": status.get("host-name"),
        "host_id": status.get("host-id"),
        "running_app": status.get("running-app-name"),
        "status_code": status.get("status_code"),
        "status": status.get("status"),
    }


# ─── Register (pair) ──────────────────────────────────────────────────────────

class RegisterReq(BaseModel):
    ip: str
    account_id: str
    pin: str
    online_id: Optional[str] = None


def _profile_name(online_id: Optional[str], account_id: str) -> str:
    """Return a safe non-empty user name for the in-memory Profiles map."""
    name = (online_id or "").strip()
    if name:
        return name
    # Fall back to a deterministic placeholder derived from the account id so
    # the same PSN account always maps to the same slot.
    return f"psn-{account_id[:8]}"


def _to_user_credential(account_id: str) -> Optional[str]:
    """Return the sha256-hex of a decimal PSN account id.

    This is what the DDP LAUNCH packet (`user-credential` field) expects -
    sending it dismisses the "Press PS button to log in" prompt that the PS5
    shows after a remote wakeup and brings the console straight to the home
    screen, so /sessions/start can proceed without manual intervention.
    """
    aid = (account_id or "").strip()
    if not aid:
        return None
    try:
        return hashlib.sha256(aid.encode("utf-8")).hexdigest()
    except Exception:  # noqa: BLE001
        return None


def _send_ddp_launch(host: str, account_id: str) -> bool:
    """Best-effort DDP LAUNCH packet to log the user in remotely."""
    if not ddp_launch:
        return False
    cred = _to_user_credential(account_id)
    if not cred:
        return False
    try:
        ddp_launch(host, cred, host_type="PS5")
        return True
    except Exception as e:  # noqa: BLE001
        log.debug("ddp launch failed: %s", e)
        return False


def _to_user_rpid(account_id: str) -> str:
    """Return the base64 PSN id that pyremoteplay's register handshake expects.

    PSN's OAuth returns user_id as a decimal string (e.g. "2547189..."), but
    the Remote Play registration handshake on the PS5 wants the same value
    base64-encoded as 8 little-endian bytes. If the caller already passes the
    base64 form we keep it untouched.
    """
    aid = (account_id or "").strip()
    if not aid:
        return aid
    if aid.isdigit():
        try:
            return base64.b64encode(int(aid).to_bytes(8, "little")).decode()
        except Exception:  # noqa: BLE001
            return aid
    return aid


def _build_profiles(name: str, account_id: str, hosts: Optional[Dict[str, Any]] = None) -> "Profiles":
    """Create an in-memory Profiles map with a single user entry.

    pyremoteplay's RPDevice.register / create_session both resolve the user by
    PSN online_id against a Profiles dict (normally loaded from disk). We don't
    persist profiles to disk in the sidecar, so we hand-build a Profiles each
    call from the data we already have. The stored "id" must be the base64
    user_rpid - that's what gets sent to the PS5 during the handshake.
    """
    profiles = Profiles()
    profiles[name] = {"id": _to_user_rpid(account_id), "hosts": hosts or {}}
    return profiles


@app.post("/register")
async def register(req: RegisterReq):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    pin = req.pin.strip().replace("-", "").replace(" ", "")
    if len(pin) < 8 or not pin.isdigit():
        raise HTTPException(400, "PIN must be the 8-digit code shown on the PS5 (Settings → System → Remote Play → Link Device)")
    if not req.account_id:
        raise HTTPException(400, "account_id required - run OAuth first")

    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable at {req.ip}: {e}")
    if not device.status:
        raise HTTPException(502, f"PS5 at {req.ip} returned no status (powered off?)")

    name = _profile_name(req.online_id, req.account_id)
    profiles = _build_profiles(name, req.account_id)

    try:
        # Use the loop's executor so the blocking register call doesn't stall
        # the FastAPI event loop. Pass our hand-built profiles so the username
        # lookup succeeds.
        loop = asyncio.get_running_loop()
        user_profile = await loop.run_in_executor(
            None,
            lambda: device.register(name, pin, save=False, profiles=profiles),
        )
    except Exception as e:  # noqa: BLE001
        log.exception("register failed")
        raise HTTPException(400, f"Register failed: {e}")
    if not user_profile:
        raise HTTPException(
            400,
            "Register returned no profile - check that the PIN is correct and the PS5 is on the 'Link Device' screen (Settings → System → Remote Play → Link Device)",
        )

    # user_profile is a UserProfile (UserDict). Serialise to a plain dict the
    # Node backend can persist and hand back to /sessions/start.
    return {
        "ok": True,
        "profile": {
            "name": user_profile.name,
            "data": dict(user_profile.data),
        },
    }


# ─── Session lifecycle ────────────────────────────────────────────────────────

class StartSessionReq(BaseModel):
    ip: str
    user_profile: Dict[str, Any]  # the dict returned from /register
    account_id: Optional[str] = None  # decimal PSN account id, for DDP launch


def _new_session_id() -> str:
    return secrets.token_hex(8)


async def _safe_disconnect(device) -> None:
    """device.disconnect() in this pyremoteplay version is sometimes a plain
    function returning None, sometimes a coroutine. Handle both."""
    try:
        result = device.disconnect()
        if asyncio.iscoroutine(result):
            await result
    except Exception as e:  # noqa: BLE001
        log.debug("disconnect error: %s", e)


async def _prime_rp_control_port(device, ip: str, name: str, profiles, aid: str, was_standby: bool) -> None:
    """Send the wakeup + DDP launch + re-arm sequence that makes the PS5
    Remote Play control port (9295) actually accept a fresh HTTP connect.

    On its own pyremoteplay.connect() does *not* prime the RP service - it
    just opens the TCP socket. On a console that hasn't received a DDP
    launch packet recently the PS5 will respond with TCP RST ("Connection
    refused"). Sending wakeup + DDP launch + a small settle wait fixes it.
    Used by both /sessions/start and /standby (cold path).
    """
    try:
        device.wakeup(name, profiles=profiles)
        if was_standby:
            # Three-stage wait: poll for 30 s, nudge + poll 30 s, nudge + poll 30 s.
            # Deep-standby boots on PS5 routinely take 60-90 s, especially after
            # back-to-back standby cycles or a long idle (the console parks the
            # SSD and powers down half its boards). 50 s used to be enough but
            # newer firmware seems slower, so we give it up to 90 s total before
            # giving up.
            log.info("PS5 %s in standby - waiting for it to wake (up to 90 s)", ip)
            woke = await device.async_wait_for_wakeup(timeout=30.0)
            if not woke:
                log.info("PS5 %s still asleep after 30 s - re-sending wakeup nudge", ip)
                try:
                    device.wakeup(name, profiles=profiles)
                except Exception:  # noqa: BLE001
                    pass
                woke = await device.async_wait_for_wakeup(timeout=30.0)
            if not woke:
                log.info("PS5 %s still asleep after 60 s - one more wakeup nudge", ip)
                try:
                    device.wakeup(name, profiles=profiles)
                except Exception:  # noqa: BLE001
                    pass
                woke = await device.async_wait_for_wakeup(timeout=30.0)
            if not woke:
                raise HTTPException(
                    502,
                    "PS5 didn't wake up within 90 s - power-cycle the console or wake it manually with the PS button, then retry.",
                )
            log.info("PS5 %s woke - waiting 2 s, then sending LAUNCH (login)", ip)
            await asyncio.sleep(2.0)
        if aid:
            ok = _send_ddp_launch(ip, aid)
            if ok:
                log.info("DDP launch sent to %s", ip)
                await asyncio.sleep(3.0 if was_standby else 1.5)
            else:
                log.warning("Could not send DDP launch (no credential or pyremoteplay missing)")
        try:
            device.wakeup(name, profiles=profiles)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(1.0)
        try:
            await device.async_get_status()
        except Exception:  # noqa: BLE001
            pass
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("priming sequence error (continuing): %s", e)


async def _try_connect_once(device, name: str, profiles) -> None:
    """Single create_session + connect attempt. Raises on failure so the
    caller can decide whether to back off and retry.

    Why only one attempt server-side: the frontend already does its own
    exponential-backoff reconnect (up to 5 tries), and stacking retries on
    both sides keeps the sidecar event loop blocked for 30-60 s, starving
    every other request and causing spurious 5 s timeouts on health/status.
    """
    try:
        device.create_session(name, profiles=profiles, resolution="360p", fps=30, receiver=None)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"create_session failed: {e}") from e
    try:
        ok = await device.connect()
    except Exception as e:  # noqa: BLE001
        await _safe_disconnect(device)
        raise RuntimeError(f"connect failed: {e}") from e
    if not ok:
        sess_err = getattr(device.session, "error", "connect returned False")
        await _safe_disconnect(device)
        raise RuntimeError(str(sess_err))


@app.post("/sessions/start")
async def session_start(req: StartSessionReq):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")

    # ── Warm cache fast-path ────────────────────────────────────────────
    # If the user recently stopped a session for this IP and the protocol
    # streams are still alive, just resume it. PS5 never saw a disconnect
    # so there is no lock to fight - this turns a 60-150 s reconnect into
    # an O(ms) lookup.
    paused = PAUSED_SESSIONS.get(req.ip)
    if paused is not None:
        age = time.monotonic() - paused["paused_at"]
        paused_device = paused["device"]
        paused_sess = getattr(paused_device, "session", None)
        alive = (
            paused_sess is not None
            and not getattr(paused_sess, "is_stopped", True)
            and age < WARM_CACHE_TTL_S
        )
        if alive:
            PAUSED_SESSIONS.pop(req.ip, None)
            sid = _new_session_id()
            SESSIONS[sid] = {
                "device": paused_device,
                "user": req.user_profile,
                "ip": req.ip,
                "created": time.time(),
                "last_used": time.time(),
            }
            log.info("session %s resumed from warm cache for %s (age %.1fs)",
                     sid, req.ip, age)
            return {"session_id": sid, "state": "connected", "resumed": True}
        # Stale - drop it and fall through to a fresh connect.
        log.info("warm cache stale for %s (age %.1fs, stopped=%s) - discarding",
                 req.ip, age, getattr(paused_sess, "is_stopped", "?"))
        PAUSED_SESSIONS.pop(req.ip, None)
        try:
            await _safe_disconnect(paused_device)
        except Exception:  # noqa: BLE001
            pass

    device = RPDevice(req.ip)
    # Initial status check is best-effort: when the PS5 is mid-transition into
    # rest mode (just received a standby packet) DDP can briefly return empty.
    # We retry once with a short wake nudge so a "Start session" right after
    # "Standby" still works. The downstream async_wait_for_wakeup handles deep
    # standby explicitly.
    for attempt in range(3):
        try:
            await device.async_get_status()
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise HTTPException(502, f"PS5 not reachable: {e}")
            await asyncio.sleep(1.0)
            continue
        if device.status:
            break
        if attempt < 2:
            log.info("PS5 %s returned empty status (attempt %d) - retrying", req.ip, attempt + 1)
            await asyncio.sleep(1.5)
    # If status is still empty after retries we treat it as deep standby and
    # proceed - the wake sequence below will revive the console.

    # The Node backend gives us back the wrapped {name,data} profile we
    # returned from /register. Rebuild a Profiles dict for create_session.
    up = req.user_profile or {}
    name = up.get("name")
    data = up.get("data") if isinstance(up.get("data"), dict) else None
    if not name or not data or not data.get("id"):
        raise HTTPException(400, "user_profile missing name/data/id - re-pair the PS5")
    if not data.get("hosts"):
        raise HTTPException(400, "user_profile has no registered hosts - re-pair the PS5")
    # data["id"] is already user_rpid (base64) because it came back from a
    # successful /register call - put it straight into Profiles without
    # touching it.
    profiles = Profiles()
    profiles[name] = {"id": data["id"], "hosts": data.get("hosts") or {}}

    # Decide how long we need to wait after the wakeup packet. The PS5
    # behaves very differently depending on its current state:
    #
    #   - Already on (Ok)       -> RP service is already running, just send
    #                              the wakeup to (re)arm the control port and
    #                              wait ~1 s.
    #   - Standby / Sleep       -> Console needs ~10-25 s to fully boot the
    #                              RP service. Use async_wait_for_wakeup() to
    #                              poll the status until is_on flips, then
    #                              give the RP service ~3 s more to settle.
    was_standby = not bool(getattr(device, "is_on", False))
    # data["id"] is the base64 user_rpid - we need the *decimal* account_id to
    # compute the DDP LAUNCH credential. Use the caller-supplied account_id
    # when present; otherwise decode the user_rpid back to decimal (b64 -> 8
    # little-endian bytes -> int).
    aid = (req.account_id or "").strip()
    if not aid and data.get("id"):
        try:
            aid = str(int.from_bytes(base64.b64decode(data["id"]), "little"))
        except Exception:  # noqa: BLE001
            aid = ""

    # If we very recently disconnected a session for this IP, the PS5 still
    # holds the heartbeat-based session lock for ~25-30 s. Wait it out
    # before attempting to connect so we don't burn the attempt on a
    # guaranteed "Another Remote Play session" failure.
    import time as _time
    recent_dc = RECENT_DISCONNECTS.get(req.ip)
    if recent_dc is not None:
        elapsed = _time.monotonic() - recent_dc
        wait_s = PS5_SESSION_LOCK_S - elapsed
        if wait_s > 0.5:
            log.info("waiting %.1fs for PS5 %s to clear post-disconnect session lock", wait_s, req.ip)
            await asyncio.sleep(min(wait_s, PS5_SESSION_LOCK_S))
        RECENT_DISCONNECTS.pop(req.ip, None)

    # Always prime the RP control port. The PS5 needs DDP WAKEUP (to lift it
    # out of standby if it's there) and DDP LAUNCH (to dismiss the "Press PS
    # button" account-picker that appears on a freshly woken console).
    # Skipping this breaks every cold start.
    await _prime_rp_control_port(device, req.ip, name, profiles, aid, was_standby)

    # Connect with up to 2 fallback retries. We deliberately use **few** but
    # **long** retries here. Empirical PS5 behavior after a disconnect:
    #   - port 9295 oscillates between "Connection refused" (service cycling)
    #     and "Another Remote Play session" (lock still held) every ~10-20 s.
    #   - Every failed TCP handshake we send appears to reset the PS5 lock
    #     heartbeat, which means aggressive retries actively keep the lock
    #     alive. The user observed this directly.
    # So: one attempt, long quiet wait (45 s) with re-prime in the middle, one
    # final attempt. Worst case cumulative is 60 + 45 = 105 s of dead air with
    # only 2 TCP handshake attempts.
    #
    # Re-priming with DDP LAUNCH between attempts is still useful because the
    # PS5 sometimes drops back to the "Press PS button" account picker after
    # a session ends and LAUNCH dismisses it.
    last_err = None
    for attempt in range(3):
        # Warm-cache opportunistic re-check. A concurrent request (autoload,
        # script runner, second tab) may have parked a live session for this
        # IP while we were sleeping in the quiet-wait below. Picking it up
        # here lets us avoid burning another TCP handshake against the PS5
        # (which would just keep its lock heartbeat alive) and gives the user
        # a session in O(ms) instead of waiting out the rest of the retries.
        # We skip this on attempt 0 because the top-of-function check already
        # ran a few hundred ms ago and would only re-find what it dropped.
        if attempt > 0:
            paused = PAUSED_SESSIONS.get(req.ip)
            if paused is not None:
                paused_sess = getattr(paused["device"], "session", None)
                paused_alive = (
                    paused_sess is not None
                    and not getattr(paused_sess, "is_stopped", True)
                    and (time.monotonic() - paused["paused_at"]) < WARM_CACHE_TTL_S
                )
                if paused_alive:
                    PAUSED_SESSIONS.pop(req.ip, None)
                    await _safe_disconnect(device)  # drop our half-baked one
                    sid = _new_session_id()
                    SESSIONS[sid] = {
                        "device": paused["device"],
                        "user": req.user_profile,
                        "ip": req.ip,
                        "created": time.time(),
                        "last_used": time.time(),
                    }
                    log.info("retry attempt %d: warm cache appeared for %s - resuming instead of opening new session",
                             attempt, req.ip)
                    return {"session_id": sid, "state": "connected", "resumed": True}

        try:
            await _try_connect_once(device, name, profiles)
            last_err = None
            break
        except Exception as e:  # noqa: BLE001
            last_err = e
            err_msg = str(e)
            is_lock = "Another Remote Play session" in err_msg
            is_refused = "Connection refused" in err_msg or "Errno 111" in err_msg
            if attempt >= 2 or not (is_lock or is_refused):
                break
            # Long quiet wait so we don't keep the PS5 lock heartbeat alive
            # by pelting it with handshake attempts.
            wait_s = 45.0
            log.info("PS5 %s transient (%s) on attempt %d - quiet wait %ds + re-prime",
                     req.ip, "lock" if is_lock else "refused", attempt + 1, int(wait_s))
            await _safe_disconnect(device)
            await asyncio.sleep(wait_s)
            device = RPDevice(req.ip)
            try: await device.async_get_status()
            except Exception:  # noqa: BLE001
                pass
            # Fresh DDP LAUNCH right before the next attempt - dismisses any
            # stray "Press PS button" account picker and re-arms the RP
            # service state machine.
            try:
                device.wakeup(name, profiles=profiles)
            except Exception:  # noqa: BLE001
                pass
            if aid:
                if _send_ddp_launch(req.ip, aid):
                    log.info("re-prime: DDP launch sent to %s", req.ip)
                    await asyncio.sleep(2.0)

    if last_err is not None:
        log.warning("session connect failed: %s", last_err)
        await _safe_disconnect(device)
        msg = str(last_err)
        if "Another Remote Play session" in msg:
            msg += " - close any active Remote Play / Chiaki client and try again in ~30s"
        raise HTTPException(502, f"Session connect failed: {msg}")

    sid = _new_session_id()
    SESSIONS[sid] = {
        "device": device,
        "user": req.user_profile,
        "ip": req.ip,
        "created": time.time(),
        "last_used": time.time(),
    }
    log.info("session %s started -> %s", sid, req.ip)
    return {"session_id": sid, "state": "connected"}


class InputReq(BaseModel):
    button: Optional[str] = None
    action: Optional[str] = "tap"  # press | release | tap
    stick: Optional[str] = None  # "left" | "right"
    x: Optional[float] = None  # -1.0 .. 1.0
    y: Optional[float] = None
    duration_ms: Optional[int] = 80  # for "tap"


@app.post("/sessions/{session_id}/input")
async def session_input(session_id: str, req: InputReq):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    device = s["device"]
    controller = getattr(device, "controller", None)
    if not controller:
        raise HTTPException(500, "controller not available on session")
    s["last_used"] = time.time()

    try:
        if req.button:
            if req.action == "press":
                controller.button(req.button, "press")
            elif req.action == "release":
                controller.button(req.button, "release")
            else:  # tap
                controller.button(req.button, "press")
                await asyncio.sleep(max(0.02, (req.duration_ms or 80) / 1000.0))
                controller.button(req.button, "release")
        elif req.stick:
            x = max(-1.0, min(1.0, float(req.x or 0)))
            y = max(-1.0, min(1.0, float(req.y or 0)))
            controller.stick(req.stick, x, y)
        else:
            raise HTTPException(400, "button or stick required")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("input failed")
        raise HTTPException(500, f"input failed: {e}")
    return {"ok": True}


@app.get("/sessions/{session_id}")
async def session_status(session_id: str):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    device = s["device"]
    state = "unknown"
    try:
        sess = getattr(device, "session", None)
        if sess:
            state = "connected" if sess.is_running else "stopped"
    except Exception:
        pass
    return {
        "session_id": session_id,
        "ip": s["ip"],
        "state": state,
        "created": s["created"],
        "last_used": s["last_used"],
    }


class WakeReq(BaseModel):
    ip: str
    account_id: str
    online_id: Optional[str] = None
    user_profile: Optional[Dict[str, Any]] = None  # preferred - has registered hosts


@app.post("/wake")
async def wake(req: WakeReq):
    """Send wakeup UDP packets to the PS5 without creating a session.

    Used by the frontend between auto-reconnect attempts to encourage the
    console to release a stale RP slot (e.g. after a session was kicked by a
    physical controller picking up).
    """
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable: {e}")

    # Prefer the full paired profile so device.wakeup() can pull the right
    # RegistKey out of hosts[mac]. Fall back to a freshly-built Profiles when
    # the caller only passes account_id (mostly for manual recovery before
    # pairing is wired up).
    up = req.user_profile or {}
    name = up.get("name") or _profile_name(req.online_id, req.account_id)
    if up.get("data") and up["data"].get("hosts"):
        data = up["data"]
        profiles = Profiles()
        profiles[name] = {"id": data["id"], "hosts": data.get("hosts") or {}}
    else:
        profiles = _build_profiles(name, req.account_id)

    sent = 0
    last_err = None
    for _ in range(3):
        try:
            device.wakeup(name, profiles=profiles)
            sent += 1
        except Exception as e:  # noqa: BLE001
            last_err = e
        await asyncio.sleep(0.4)

    # Also fire a DDP LAUNCH so PS5 logs the account in. Without it, after a
    # remote wakeup the console sits on the "Press PS button" prompt and
    # Remote Play stays unreachable.
    launched = _send_ddp_launch(req.ip, req.account_id)

    if sent == 0:
        raise HTTPException(502, f"wake failed: {last_err}")
    return {"ok": True, "packets_sent": sent, "ddp_launch_sent": launched}


@app.post("/sessions/{session_id}/stop")
async def session_stop(session_id: str, force: bool = False):
    """Stop a session.

    Default behavior is a **soft stop**: we move the session into the warm
    cache (PAUSED_SESSIONS) without tearing down the underlying RP protocol.
    A subsequent /sessions/start for the same IP resumes it in O(ms),
    bypassing the PS5 firmware session-lock window completely. The warm
    cache is reaped after WARM_CACHE_TTL_S.

    Pass `force=true` to bypass the warm cache and fully tear down the
    protocol immediately (used by /sessions/stop-all and the shutdown
    handler, plus any UI path that means "really disconnect now").
    """
    s = SESSIONS.pop(session_id, None)
    if not s:
        raise HTTPException(404, "session not found")
    device = s["device"]
    ip = s.get("ip")

    if not force and ip:
        # ─── Soft stop: park in warm cache, do NOT call Session.stop() ─
        # We deliberately leave the RP protocol streams running so the PS5
        # never enters the post-disconnect lock state. If another session
        # for the same IP was already cached, evict it first.
        prev = PAUSED_SESSIONS.pop(ip, None)
        if prev is not None:
            try:
                await _safe_disconnect(prev["device"])
            except Exception:  # noqa: BLE001
                pass
        PAUSED_SESSIONS[ip] = {
            "sid": session_id,
            "device": device,
            "user": s.get("user"),
            "paused_at": time.monotonic(),
        }
        log.info("session %s warm-cached for %s (TTL %ds)",
                 session_id, ip, int(WARM_CACHE_TTL_S))
        return {"ok": True, "soft": True}

    # ─── Hard stop ────────────────────────────────────────────────────
    # Try graceful Session.stop() first so pyremoteplay closes its protocol
    # cleanly, then poll briefly for the PS5 ack before tearing down TCP.
    session_obj = getattr(device, "session", None)
    if session_obj is not None:
        try:
            stop_fn = getattr(session_obj, "stop", None)
            if stop_fn is not None:
                stop_fn()
            for _ in range(120):
                if getattr(session_obj, "is_stopped", False):
                    break
                await asyncio.sleep(0.1)
        except Exception as e:  # noqa: BLE001
            log.debug("graceful Session.stop failed: %s", e)
    await _safe_disconnect(device)
    if ip:
        RECENT_DISCONNECTS[ip] = time.monotonic()
    return {"ok": True, "soft": False}


async def _send_standby_and_wait(session_obj, timeout: float = 8.0) -> bool:
    """Send STANDBY to the PS5 and wait until the session reports stopped.

    Uses the patched `async_standby` (see pyremoteplay_patches.py) which we
    fixed to actually honor its timeout. We still wrap it so that:
      - we ensure the session is READY first (RP rejects STANDBY otherwise),
      - we add a small "settle" sleep after stopping so the PS5 finishes the
        transition before our caller tears down the TCP connections.
    """
    # Wait for READY - standby on a half-open session raises "Session is not ready".
    if not getattr(session_obj, "is_ready", False):
        wait_fn = getattr(session_obj, "async_wait", None)
        if wait_fn is not None:
            try:
                await wait_fn(timeout=10.0)
            except Exception:  # noqa: BLE001
                pass

    ok = False
    async_standby = getattr(session_obj, "async_standby", None)
    if async_standby is not None:
        try:
            ok = bool(await async_standby(timeout=timeout))
        except Exception as e:  # noqa: BLE001
            log.warning("async_standby raised %s - falling back to _send_standby", e)
            ok = False

    # Belt-and-suspenders: if for some reason async_standby returned False
    # (unpatched build? unusual error?) fall back to the low-level send +
    # poll loop. This is what we used to do unconditionally.
    if not ok:
        send_standby = getattr(session_obj, "_send_standby", None)
        if send_standby is not None:
            send_standby()
            for _ in range(int(timeout * 10)):
                if getattr(session_obj, "is_stopped", False):
                    ok = True
                    break
                await asyncio.sleep(0.1)

    # Give the PS5 a moment to finalize standby before TCP teardown so we
    # don't leave a stale session lock on the console side.
    await asyncio.sleep(2.0)
    return ok


@app.post("/standby")
async def standby(req: StartSessionReq):
    """Put the PS5 into rest mode via Remote Play.

    Reuses an existing cached session for the IP when available, otherwise
    spins up a temporary RP session, sends the standby control packet, and
    tears the session down. The PS5 firmware does not expose a true 'restart'
    command over the RP protocol - only standby/sleep.
    """
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")

    # 1) Try to use a live session if we already have one - cheapest path.
    for sid, s in list(SESSIONS.items()):
        if s.get("ip") != req.ip:
            continue
        device = s["device"]
        try:
            session_obj = getattr(device, "session", None)
            if session_obj is None:
                continue
            ok = await _send_standby_and_wait(session_obj, timeout=8.0)
            await _safe_disconnect(device)
            SESSIONS.pop(sid, None)
            log.info("standby: used live session %s for %s (ok=%s)", sid, req.ip, ok)
            return {"ok": True, "via": "existing_session"}
        except Exception as e:  # noqa: BLE001
            log.warning("standby via live session failed (%s): %s", sid, e)
            # Fall through.

    # 2) If a warm-cached session exists, use it. Critical: if we skipped this
    # and spun up a temp session, the PS5 would reject us with "Another
    # Remote Play session" because the warm-cached protocol streams are
    # still alive from the PS5's perspective.
    paused = PAUSED_SESSIONS.pop(req.ip, None)
    if paused is not None:
        device = paused["device"]
        try:
            session_obj = getattr(device, "session", None)
            if session_obj is not None and not getattr(session_obj, "is_stopped", True):
                ok = await _send_standby_and_wait(session_obj, timeout=8.0)
                await _safe_disconnect(device)
                log.info("standby: used warm-cached session %s for %s (ok=%s)",
                         paused["sid"], req.ip, ok)
                return {"ok": True, "via": "warm_cached_session"}
            # Cached session was stale - drop it before falling through.
            await _safe_disconnect(device)
        except Exception as e:  # noqa: BLE001
            log.warning("standby via warm-cached session failed (%s): %s",
                        paused.get("sid"), e)
            try:
                await _safe_disconnect(device)
            except Exception:  # noqa: BLE001
                pass

    # 3) No live or warm-cached session - create a temporary one just for standby.
    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable: {e}")
    if not getattr(device, "is_on", False):
        return {"ok": True, "already_standby": True, "message": "PS5 already in standby"}

    up = req.user_profile or {}
    name = up.get("name")
    data = up.get("data") if isinstance(up.get("data"), dict) else None
    if not name or not data or not data.get("id") or not data.get("hosts"):
        raise HTTPException(400, "user_profile missing - pair the PS5 first")
    profiles = Profiles()
    profiles[name] = {"id": data["id"], "hosts": data.get("hosts") or {}}

    # account_id is needed for the DDP LAUNCH packet that primes the RP
    # control port. Decode it from the base64 user_rpid when caller did not
    # supply it directly.
    aid = (req.account_id or "").strip()
    if not aid and data.get("id"):
        try:
            aid = str(int.from_bytes(base64.b64decode(data["id"]), "little"))
        except Exception:  # noqa: BLE001
            aid = ""

    # The PS5 RP service often TCP-RSTs fresh connects on port 9295 unless it
    # was recently primed by a wake + DDP LAUNCH sequence. Use the same
    # priming helper as /sessions/start so cold standby works after the
    # console has been idle for a while.
    await _prime_rp_control_port(device, req.ip, name, profiles, aid, was_standby=False)

    try:
        await _try_connect_once(device, name, profiles)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"standby connect failed: {e}")

    try:
        session_obj = getattr(device, "session", None)
        if session_obj is None:
            raise RuntimeError("device has no session after connect")
        ok = await _send_standby_and_wait(session_obj, timeout=8.0)
        log.info("standby: sent to %s (ok=%s, stopped=%s)", req.ip, ok,
                 getattr(session_obj, "is_stopped", "?"))
    except Exception as e:  # noqa: BLE001
        await _safe_disconnect(device)
        raise HTTPException(502, f"standby failed: {e}")
    finally:
        await _safe_disconnect(device)

    return {"ok": True, "via": "temporary_session"}


@app.post("/sessions/stop-all")
async def session_stop_all(ip: Optional[str] = None):
    """Hard-tear-down every cached sidecar session, optionally filtered by IP.

    Hits BOTH the live SESSIONS pool and the warm PAUSED_SESSIONS cache, so
    callers asking for "stop everything" actually get everything stopped
    (otherwise a warm-cached session would still be holding a PS5 RP slot).
    Useful when the Node cache and the sidecar maps drift out of sync, or
    when the user wants to fully release the PS5.
    """
    stopped = []
    for sid, s in list(SESSIONS.items()):
        if ip and s.get("ip") != ip:
            continue
        await _safe_disconnect(s["device"])
        sip = s.get("ip")
        if sip:
            RECENT_DISCONNECTS[sip] = time.monotonic()
        SESSIONS.pop(sid, None)
        stopped.append(sid)
    for pip, p in list(PAUSED_SESSIONS.items()):
        if ip and pip != ip:
            continue
        try:
            await _safe_disconnect(p["device"])
        except Exception:  # noqa: BLE001
            pass
        RECENT_DISCONNECTS[pip] = time.monotonic()
        PAUSED_SESSIONS.pop(pip, None)
        stopped.append(p.get("sid"))
    return {"ok": True, "stopped": stopped}


async def _warm_cache_gc_task():
    """Tear down warm-cached sessions that have outlived WARM_CACHE_TTL_S.

    Runs every 30 s. A cache entry older than its TTL is fully disconnected
    (Session.stop() + TCP teardown) and its IP is recorded in
    RECENT_DISCONNECTS so the next /sessions/start applies the post-
    disconnect lock wait.
    """
    while True:
        try:
            await asyncio.sleep(30.0)
            now = time.monotonic()
            for ip, p in list(PAUSED_SESSIONS.items()):
                if now - p["paused_at"] < WARM_CACHE_TTL_S:
                    continue
                PAUSED_SESSIONS.pop(ip, None)
                device = p.get("device")
                if device is not None:
                    try:
                        session_obj = getattr(device, "session", None)
                        if session_obj is not None:
                            stop_fn = getattr(session_obj, "stop", None)
                            if stop_fn is not None:
                                stop_fn()
                            for _ in range(60):
                                if getattr(session_obj, "is_stopped", False):
                                    break
                                await asyncio.sleep(0.1)
                    except Exception as e:  # noqa: BLE001
                        log.debug("warm GC stop error for %s: %s", ip, e)
                    try:
                        await _safe_disconnect(device)
                    except Exception:  # noqa: BLE001
                        pass
                RECENT_DISCONNECTS[ip] = now
                log.info("warm cache expired and torn down for %s", ip)
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            log.warning("warm cache GC error: %s", e)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_warm_cache_gc_task())


@app.on_event("shutdown")
async def _shutdown():
    for sid, s in list(SESSIONS.items()):
        await _safe_disconnect(s["device"])
    SESSIONS.clear()
    for ip, p in list(PAUSED_SESSIONS.items()):
        try:
            await _safe_disconnect(p["device"])
        except Exception:  # noqa: BLE001
            pass
    PAUSED_SESSIONS.clear()


def main():
    port = int(os.environ.get("CHIAKI_SIDECAR_PORT", "9555"))
    host = os.environ.get("CHIAKI_SIDECAR_HOST", "127.0.0.1")
    log.info("starting chiaki-sidecar on %s:%s (pyremoteplay=%s)", host, port, PYREMOTEPLAY_OK)
    uvicorn.run(app, host=host, port=port, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
