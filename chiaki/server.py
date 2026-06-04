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

# pyremoteplay imports - kept lazy/optional so a broken install still lets
# /health respond (useful for debugging the container itself).
_FALLBACK_LOGIN_URL = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize"
try:
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

LOG_LEVEL = os.environ.get("CHIAKI_SIDECAR_LOG", "info").upper()
logging.basicConfig(level=LOG_LEVEL, format="[chiaki] %(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("chiaki")

app = FastAPI(title="chiaki-sidecar", version="0.1.0")

# session_id -> { device: RPDevice, user: dict, created: ts, last_used: ts }
SESSIONS: Dict[str, Dict[str, Any]] = {}


@app.get("/health")
async def health():
    return {
        "ok": True,
        "pyremoteplay": PYREMOTEPLAY_OK,
        "pyremoteplay_error": PYREMOTEPLAY_ERR,
        "sessions": list(SESSIONS.keys()),
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
    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable: {e}")
    if not device.status:
        raise HTTPException(502, "PS5 returned no status - is it powered on?")

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

    try:
        device.wakeup(name, profiles=profiles)
        if was_standby:
            log.info("PS5 %s in standby - waiting for it to wake (up to 30 s)", req.ip)
            woke = await device.async_wait_for_wakeup(timeout=30.0)
            if not woke:
                raise HTTPException(
                    502,
                    "PS5 didn't wake up within 30 s - power-cycle the console or wake it manually with the PS button, then retry.",
                )
            log.info("PS5 %s woke - waiting 2 s, then sending LAUNCH (login)", req.ip)
            await asyncio.sleep(2.0)

        # ALWAYS send the DDP LAUNCH packet (carries the user-credentials
        # hash). On a fresh wake this dismisses the "Press PS button" account
        # picker; on an already-on console it's harmless. Without this the
        # PS5 leaves Remote Play locked behind a manual login.
        if aid:
            ok = _send_ddp_launch(req.ip, aid)
            if ok:
                log.info("DDP launch sent to %s", req.ip)
                # Give PS5 a couple seconds to process the login and open the
                # RP control port.
                await asyncio.sleep(3.0 if was_standby else 1.5)
            else:
                log.warning("Could not send DDP launch (no credential or pyremoteplay missing)")

        # Final re-arm wakeup so the RP control service is definitely armed.
        try:
            device.wakeup(name, profiles=profiles)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(1.0)
        try:
            await device.async_get_status()
        except Exception:
            pass
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.warning("wakeup sequence error (continuing): %s", e)

    try:
        await _try_connect_once(device, name, profiles)
    except Exception as e:  # noqa: BLE001
        log.warning("session connect failed: %s", e)
        await _safe_disconnect(device)
        msg = str(e)
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
async def session_stop(session_id: str):
    s = SESSIONS.pop(session_id, None)
    if not s:
        raise HTTPException(404, "session not found")
    await _safe_disconnect(s["device"])
    return {"ok": True}


@app.post("/sessions/stop-all")
async def session_stop_all(ip: Optional[str] = None):
    """Tear down every cached sidecar session, optionally filtered by IP.

    Useful when the Node cache and the sidecar SESSIONS map drift out of sync,
    or when a previous test run left a session lingering after a sidecar
    restart killed the Python process without a proper teardown.
    """
    stopped = []
    for sid, s in list(SESSIONS.items()):
        if ip and s.get("ip") != ip:
            continue
        await _safe_disconnect(s["device"])
        SESSIONS.pop(sid, None)
        stopped.append(sid)
    return {"ok": True, "stopped": stopped}


@app.on_event("shutdown")
async def _shutdown():
    for sid, s in list(SESSIONS.items()):
        await _safe_disconnect(s["device"])
    SESSIONS.clear()


def main():
    port = int(os.environ.get("CHIAKI_SIDECAR_PORT", "9555"))
    host = os.environ.get("CHIAKI_SIDECAR_HOST", "127.0.0.1")
    log.info("starting chiaki-sidecar on %s:%s (pyremoteplay=%s)", host, port, PYREMOTEPLAY_OK)
    uvicorn.run(app, host=host, port=port, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
