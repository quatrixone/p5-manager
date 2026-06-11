"""pyremoteplay Remote Play sidecar.

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
import io
import logging
import os
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

# Configure logging early so the patches module (and pyremoteplay itself)
# can use the same formatter from the very first import.
LOG_LEVEL = os.environ.get("PYREMOTEPLAY_SIDECAR_LOG",
                           os.environ.get("CHIAKI_SIDECAR_LOG", "info")).upper()
logging.basicConfig(level=LOG_LEVEL, format="[rp-sidecar] %(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("rp-sidecar")

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
    from pyremoteplay.receiver import AVReceiver  # type: ignore
    PYREMOTEPLAY_OK = True
    PYREMOTEPLAY_ERR: Optional[str] = None
except Exception as e:  # noqa: BLE001
    PYREMOTEPLAY_OK = False
    PYREMOTEPLAY_ERR = str(e)
    RPDevice = None  # type: ignore
    Profiles = None  # type: ignore
    ddp_launch = None  # type: ignore
    AVReceiver = None  # type: ignore

# Optional video stack. The MJPEG preview endpoint needs PyAV (which
# pyremoteplay also needs for its AVReceiver to actually decode frames) plus
# Pillow for the rgb24 -> JPEG step. We import them lazily so a sidecar
# without these libs still serves input-only sessions.
try:
    import av  # type: ignore  # noqa: F401
    from PIL import Image  # type: ignore  # noqa: F401
    VIDEO_STACK_OK = True
    VIDEO_STACK_ERR: Optional[str] = None
except Exception as e:  # noqa: BLE001
    VIDEO_STACK_OK = False
    VIDEO_STACK_ERR = str(e)

app = FastAPI(title="pyremoteplay-sidecar", version="0.2.0")

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

# Per-IP asyncio.Lock to serialize /sessions/start. The PS5 firmware only
# supports one Remote Play session at a time, and every failed handshake we
# fire at it resets the session lock heartbeat - so two clients clicking
# "Start" within a few seconds of each other actively keep the lock alive
# and starve themselves. Serializing per IP means the second click just
# waits for (and reuses) the first one's result.
START_LOCKS: Dict[str, asyncio.Lock] = {}


# ─── Video receiver ───────────────────────────────────────────────────────────
#
# pyremoteplay decodes incoming H.264/HEVC frames via its AVReceiver subclass.
# For the optional live-preview endpoint we keep only the **latest** rgb24
# VideoFrame in memory and lazily re-encode it as JPEG when a consumer asks.
# This keeps memory bounded (one frame) and CPU cost ~zero when nobody is
# watching the stream.
#
# Audio and the synced A/V (fragmented MP4) pipeline have been removed —
# only video preview (MJPEG) remains.


def _has_video(receiver) -> bool:
    """True iff `receiver` is producing a video stream."""
    if receiver is None:
        return False
    return bool(getattr(receiver, '_video_enabled', False))


class MjpegReceiver(AVReceiver if AVReceiver is not None else object):
    """Latest-frame-only video receiver for HTTP MJPEG streaming.

    Each new H.264 frame replaces the previous one. The actual JPEG encode
    is deferred until `get_latest_jpeg()` is called and cached against the
    frame counter, so repeated polls without new frames cost ~nothing.

    Audio is unconditionally short-circuited at handle_audio_data() so the
    PCM decode pass never runs — the sidecar no longer exposes any audio
    endpoint. When `enable_video=False`, video decode is skipped too
    (input-only mode — used for warm-cache pre-warm calls so the receiver
    burns ~0 CPU while parked).
    """

    def __init__(self, jpeg_quality: int = 70, enable_video: bool = True):
        super().__init__()
        self._video_enabled = bool(enable_video)
        self._latest_frame = None  # av.VideoFrame
        self._latest_jpeg: Optional[bytes] = None
        self._frame_counter: int = 0
        self._encoded_counter: int = -1
        self._lock = threading.Lock()
        self._jpeg_quality = max(1, min(95, jpeg_quality))
        self._closed = False

    # ─── Skip-decode short circuits ────────────────────────────────────
    # pyremoteplay calls handle_*_data() before invoking decode_*_frame().
    # Overriding here means we skip the (~30% CPU on a Pi) H.264 decode
    # when video is disabled, and always skip the audio path entirely.
    def handle_video_data(self, buf) -> None:  # type: ignore[override]
        if not self._video_enabled or self._closed:
            return
        try:
            super().handle_video_data(buf)
        except Exception as e:  # noqa: BLE001
            log.debug("video decode failed: %s", e)

    def handle_audio_data(self, buf) -> None:  # type: ignore[override]
        # Audio support was removed — drop every PCM packet at the
        # earliest point so we never burn CPU on the AAC decode pass.
        return

    # ─── Decoded-frame handlers ────────────────────────────────────────
    def handle_video(self, frame) -> None:  # type: ignore[override]
        if self._closed or not self._video_enabled:
            return
        with self._lock:
            self._latest_frame = frame
            self._frame_counter += 1

    def handle_audio(self, frame) -> None:  # type: ignore[override]
        # Audio was removed. Should never be called since
        # handle_audio_data() returns early, but kept defensive in case
        # pyremoteplay's internals ever change the call order.
        return

    def close(self) -> None:
        try:
            super().close()
        except Exception:  # noqa: BLE001
            pass
        with self._lock:
            self._closed = True
            self._latest_frame = None
            self._latest_jpeg = None

    @property
    def frame_counter(self) -> int:
        return self._frame_counter

    def get_latest_jpeg(self) -> Optional[bytes]:
        """Return JPEG-encoded bytes of the most recent frame (or None)."""
        with self._lock:
            if self._latest_frame is None:
                return None
            if self._encoded_counter == self._frame_counter and self._latest_jpeg is not None:
                return self._latest_jpeg
            frame = self._latest_frame
            counter = self._frame_counter
        # Encode outside the lock so handle_video can keep pushing frames.
        try:
            img = frame.to_image()  # PIL.Image
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=self._jpeg_quality, optimize=False)
            jpeg = buf.getvalue()
        except Exception as e:  # noqa: BLE001
            log.debug("jpeg encode failed: %s", e)
            return None
        with self._lock:
            # Only commit if we're still the freshest encode (another thread
            # could have encoded a newer frame meanwhile).
            if counter >= self._encoded_counter:
                self._latest_jpeg = jpeg
                self._encoded_counter = counter
        return jpeg


# Synced A/V (fragmented MP4 / MSE) receiver was removed - the sidecar
# now only exposes the MJPEG video preview endpoint.


@app.get("/health")
async def health():
    return {
        "ok": True,
        "pyremoteplay": PYREMOTEPLAY_OK,
        "pyremoteplay_error": PYREMOTEPLAY_ERR,
        "video_stack": VIDEO_STACK_OK,
        "video_stack_error": VIDEO_STACK_ERR,
        "sessions": [
            {"sid": sid, "ip": s.get("ip"),
             "video": _has_video(s.get("receiver")),
             "resolution": s.get("resolution")}
            for sid, s in SESSIONS.items()
        ],
        "warm_cache": [
            {"ip": ip, "sid": p["sid"], "age_s": round(time.monotonic() - p["paused_at"], 1),
             "video": _has_video(p.get("receiver")),
             "resolution": p.get("resolution")}
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
    # Optional override; when omitted we ask /discover before registering
    # so the value is auto-detected (current behaviour for PS5 stays
    # identical). Accepted values: "PS5" | "PS4". Anything else is
    # ignored and we fall back to discovery.
    host_type: Optional[str] = None


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


def _send_ddp_launch(host: str, account_id: str, host_type: Optional[str] = None) -> bool:
    """Best-effort DDP LAUNCH packet to log the user in remotely.

    `host_type` accepts "PS5" / "PS4". When omitted we default to PS5
    (historical behaviour); the wrapper from /start_session passes the
    auto-detected value from /discover.
    """
    if not ddp_launch:
        return False
    cred = _to_user_credential(account_id)
    if not cred:
        return False
    ht = (host_type or "PS5").upper()
    if ht not in ("PS5", "PS4"):
        ht = "PS5"
    try:
        ddp_launch(host, cred, host_type=ht)
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
    # When true, attach a video receiver to the session so /sessions/{id}/video.mjpeg
    # serves a live MJPEG stream. Default false to keep the input-only fast path
    # (zero CPU for frame decoding, ~10 MB less RAM).
    enable_video: Optional[bool] = False
    # PS5 / PS4 Remote Play stream resolution. Only 360p / 540p / 720p are
    # accepted - 1080p was removed because the MJPEG re-encode pass at
    # 1080p saturates a Pi-class CPU. 720p is the sweet spot.
    resolution: Optional[str] = "720p"
    # Optional console hint ("PS5" / "PS4"). When omitted we keep the
    # legacy auto-detect path (discover before LAUNCH so the host_type
    # is filled in from the live device).
    host_type: Optional[str] = None

# Resolution allowlist for the stream knob above. Anything outside falls
# back to the default - pyremoteplay raises a confusing AttributeError if
# you pass an unrecognised enum value, so we coerce here. The PS5 itself
# supports 1080p but the MJPEG re-encode pass at 1080p saturates a
# Pi-class CPU; capping at 720p keeps preview smooth.
_ALLOWED_RESOLUTIONS = ("360p", "540p", "720p")
# Hard-coded FPS for the PS5 link. pyremoteplay's preset enum exposes
# only 30 and 60 and the MJPEG re-encode pass is much happier at 30 on
# a Pi-class CPU. With audio + synced removed there's no longer a user
# knob to tune.
_PS5_FPS = 30


def _normalize_stream_params(resolution):
    res = (resolution or "720p").lower().strip()
    if res not in _ALLOWED_RESOLUTIONS:
        log.warning("invalid resolution %r - falling back to 720p", resolution)
        res = "720p"
    return res


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
            # Derive the console family from whatever pyremoteplay last
            # filled into device.status (PS5 / PS4 strings). When unknown
            # we let _send_ddp_launch default to PS5 which matches legacy
            # behaviour.
            ddp_host_type = None
            try:
                ddp_host_type = (device.status or {}).get("host-type")
            except Exception:  # noqa: BLE001
                ddp_host_type = None
            ok = _send_ddp_launch(ip, aid, host_type=ddp_host_type)
            if ok:
                log.info("DDP launch sent to %s (%s)", ip, ddp_host_type or "PS5")
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


async def _try_connect_once(device, name: str, profiles, receiver=None,
                            resolution: str = "720p") -> None:
    """Single create_session + connect attempt. Raises on failure so the
    caller can decide whether to back off and retry.

    `receiver` is the pyremoteplay AVReceiver to attach to the session. Pass
    None for input-only sessions (default - no video decode, lowest CPU).
    Pass an MjpegReceiver to enable the /sessions/{id}/video.mjpeg endpoint.

    `resolution` configures the PS5 stream itself - it maps onto
    pyremoteplay's Resolution enum. FPS is hard-coded to _PS5_FPS (30)
    since the FPS picker was removed alongside audio + synced support.

    Why only one attempt server-side: the frontend already does its own
    exponential-backoff reconnect (up to 5 tries), and stacking retries on
    both sides keeps the sidecar event loop blocked for 30-60 s, starving
    every other request and causing spurious 5 s timeouts on health/status.
    """
    try:
        device.create_session(name, profiles=profiles, resolution=resolution, fps=_PS5_FPS, receiver=receiver)
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

    if req.enable_video and not VIDEO_STACK_OK:
        raise HTTPException(
            503,
            f"Video preview requested but the media stack is missing: {VIDEO_STACK_ERR}. "
            "Rebuild the pyremoteplay container (PyAV + Pillow are required).",
        )

    # Serialize starts per IP. Without this, a user double-clicking Start
    # (or the UI re-firing Start during a slow connect) launches two parallel
    # handshake retry loops against the same PS5; both then keep its session
    # lock heartbeat alive on every failed TCP attempt and the console gets
    # stuck refusing both connections for minutes. With the lock, the second
    # caller waits and -- thanks to the existing-session check below -- just
    # reuses the same session_id when the first one succeeds.
    lock = START_LOCKS.setdefault(req.ip, asyncio.Lock())
    async with lock:
        # Existing-session fast-path: if a sibling request already brought
        # a live session up for this IP while we were waiting on the lock,
        # just return it. Cheaper than reconnecting and avoids triggering
        # the PS5 "Another Remote Play session" lock against ourselves.
        #
        # Reuse rule (same logic as the warm-cache path below): we can hand
        # back the cached session whenever it has *at least* what the caller
        # wants. So a video-enabled live session satisfies an input-only
        # caller (extra MJPEG decoder is harmless), but the reverse is not
        # true - if the caller wants video and the live session has none we
        # need a fresh start so /video.mjpeg actually has frames to send.
        wants_video = bool(req.enable_video)
        for sid, s in list(SESSIONS.items()):
            if s.get("ip") != req.ip:
                continue
            rx = s.get("receiver")
            has_video = _has_video(rx)
            # Live session can satisfy any caller whose media flag is a
            # subset of what it already decodes. Reverse direction (caller
            # needs video that the live session is not producing) forces a
            # fresh start since we can't retroactively attach a decoder.
            if wants_video and not has_video:
                continue
            dev_sess = getattr(s.get("device"), "session", None)
            if dev_sess is not None and not getattr(dev_sess, "is_stopped", True):
                s["last_used"] = time.time()
                log.info("session %s already live for %s (video=%s, wanted=%s, res=%s) - reusing",
                         sid, req.ip, has_video, wants_video, s.get("resolution", "?"))
                return {
                    "session_id": sid,
                    "state": "connected",
                    "reused": True,
                    "video": has_video,
                    "resolution": s.get("resolution"),
                }
        return await _session_start_impl(req)


async def _session_start_impl(req: StartSessionReq):
    wants_video = bool(req.enable_video)
    req_resolution = _normalize_stream_params(req.resolution)

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
        paused_rx = paused.get("receiver")
        paused_has_video = _has_video(paused_rx)
        alive = (
            paused_sess is not None
            and not getattr(paused_sess, "is_stopped", True)
            and age < WARM_CACHE_TTL_S
        )
        # Reuse rule: we can satisfy the caller as long as the warm cache
        # has *at least* the media capability they want. So a warm cache
        # with video happily serves an input-only caller (extra decoder
        # is harmless); a warm input-only cache can NOT serve a video
        # caller (no decoder attached → /video.mjpeg would 400). This
        # keeps the warm-cache win across the common mode change (live
        # video session → fast input-only script call).
        can_reuse = alive and (paused_has_video or not wants_video)
        if can_reuse:
            PAUSED_SESSIONS.pop(req.ip, None)
            sid = _new_session_id()
            # Carry over the warm cache's resolution. We do NOT silently
            # rebuild the session if the caller wanted a different
            # resolution - that would defeat the warm-cache benefit. The
            # response reports what the live session actually is so the
            # UI can warn.
            cached_res = paused.get("resolution")
            SESSIONS[sid] = {
                "device": paused_device,
                "user": req.user_profile,
                "ip": req.ip,
                "receiver": paused_rx,
                "resolution": cached_res,
                "created": time.time(),
                "last_used": time.time(),
            }
            notes = []
            if paused_has_video != wants_video:
                notes.append("video=%s wanted=%s" % (paused_has_video, wants_video))
            if cached_res and cached_res != req_resolution:
                notes.append("res=%s requested=%s" % (cached_res, req_resolution))
            note = (" (" + "; ".join(notes) + ")") if notes else ""
            log.info("session %s resumed from warm cache for %s (age %.1fs, video=%s)%s",
                     sid, req.ip, age, paused_has_video, note)
            return {
                "session_id": sid,
                "state": "connected",
                "resumed": True,
                "video": paused_has_video,
                "resolution": cached_res,
            }
        # Stale or actually unsatisfiable (wanted video, warm has none).
        log.info("warm cache stale/unsatisfiable for %s (age %.1fs, stopped=%s, video=%s vs want=%s) - discarding",
                 req.ip, age, getattr(paused_sess, "is_stopped", "?"),
                 paused_has_video, wants_video)
        PAUSED_SESSIONS.pop(req.ip, None)
        # Close the receiver explicitly so the underlying av decoder frees its
        # codec context promptly instead of waiting on GC.
        try:
            old_rx = paused.get("receiver")
            if old_rx is not None:
                old_rx.close()
        except Exception:  # noqa: BLE001
            pass
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

    # Build the media receiver up-front if video was requested. It has to
    # be passed to create_session() (we can't attach it later), and
    # creating it before the retry loop means a retry doesn't churn
    # through codec contexts.
    receiver = MjpegReceiver(enable_video=wants_video) if wants_video else None

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
                paused_rx_mid = paused.get("receiver")
                paused_has_video = _has_video(paused_rx_mid)
                # Same "warm has at least what caller wants" rule as the
                # top-of-function fast-path.
                paused_alive = (
                    paused_sess is not None
                    and not getattr(paused_sess, "is_stopped", True)
                    and (time.monotonic() - paused["paused_at"]) < WARM_CACHE_TTL_S
                    and (paused_has_video or not wants_video)
                )
                if paused_alive:
                    PAUSED_SESSIONS.pop(req.ip, None)
                    await _safe_disconnect(device)  # drop our half-baked one
                    if receiver is not None:
                        try: receiver.close()
                        except Exception: pass  # noqa: BLE001
                    sid = _new_session_id()
                    SESSIONS[sid] = {
                        "device": paused["device"],
                        "user": req.user_profile,
                        "ip": req.ip,
                        "receiver": paused_rx_mid,
                        "resolution": paused.get("resolution"),
                        "created": time.time(),
                        "last_used": time.time(),
                    }
                    log.info("retry attempt %d: warm cache appeared for %s - resuming instead of opening new session",
                             attempt, req.ip)
                    return {
                        "session_id": sid,
                        "state": "connected",
                        "resumed": True,
                        "video": paused_has_video,
                        "resolution": paused.get("resolution"),
                    }

        try:
            await _try_connect_once(device, name, profiles, receiver=receiver,
                                    resolution=req_resolution)
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
                # Prefer the client-supplied host_type, otherwise pull from
                # device.status (auto-detect). _send_ddp_launch falls back
                # to PS5 if both are unknown.
                ddp_host_type = req.host_type
                if not ddp_host_type:
                    try:
                        ddp_host_type = (device.status or {}).get("host-type")
                    except Exception:  # noqa: BLE001
                        ddp_host_type = None
                if _send_ddp_launch(req.ip, aid, host_type=ddp_host_type):
                    log.info("re-prime: DDP launch sent to %s (%s)", req.ip, ddp_host_type or "PS5")
                    await asyncio.sleep(2.0)

    if last_err is not None:
        log.warning("session connect failed: %s", last_err)
        # If we built a receiver, dispose it - nothing succeeded so no one
        # else holds a reference and we want to free its codec context.
        if receiver is not None:
            try: receiver.close()
            except Exception: pass  # noqa: BLE001
        await _safe_disconnect(device)
        msg = str(last_err)
        if "Another Remote Play session" in msg:
            msg += " - close any active Remote Play / Chiaki-ng client and try again in ~30s"
        raise HTTPException(502, f"Session connect failed: {msg}")

    sid = _new_session_id()
    SESSIONS[sid] = {
        "device": device,
        "user": req.user_profile,
        "ip": req.ip,
        "receiver": receiver,
        "resolution": req_resolution,
        "created": time.time(),
        "last_used": time.time(),
    }
    log.info("session %s started -> %s (video=%s, %s)",
             sid, req.ip, wants_video, req_resolution)
    return {
        "session_id": sid,
        "state": "connected",
        "video": wants_video,
        "resolution": req_resolution,
    }


class InputReq(BaseModel):
    button: Optional[str] = None
    action: Optional[str] = "tap"  # press | release | tap
    stick: Optional[str] = None  # "left" | "right"
    x: Optional[float] = None  # -1.0 .. 1.0
    y: Optional[float] = None
    duration_ms: Optional[int] = 80  # for "tap"
    # PS2 Classics (and SNK fighting games on PS4 BC) ignore the DualShock
    # touchpad CLICK and the DualSense Options button entirely. They listen
    # for a touchpad FINGER landing on a specific zone of the surface:
    #   * Select  → left  half of touchpad (X ≲ 960)
    #   * Start   → right half           (X ≳ 960)
    # The DS4 touchpad surface is 1920×942. Default click stays at center
    # (960×471) for normal use; pass touch_x/touch_y in pixel space (0..1920,
    # 0..942) to override. Sidecar forwards the coords to the patched
    # `controller.touchpad_click(duration_ms, x, y)` which emits the full
    # chiaki surface-down + click + surface-up sequence. See
    # pyremoteplay_patches.py::_patch_controller_touchpad_click and
    # altarofgaming.com/brook-universal-fighting-board-ps4-ps5-touchpad/
    # for the PS5 BC behaviour these coordinates target.
    touch_x: Optional[int] = None
    touch_y: Optional[int] = None


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
            button_name = (req.button or "").lower()
            is_touchpad = button_name == "touchpad"
            has_touch_xy = req.touch_x is not None or req.touch_y is not None
            if is_touchpad and has_touch_xy and req.action in (None, "tap", "press"):
                # When the caller supplies explicit X/Y we want the
                # **surface-only** tap (0xD0 finger-down → 0xC0 finger-up,
                # no 0x80 0xB1 click button). PS2 Classics + a handful of
                # PS5 DS4-BC titles map touchpad zones (Select ≈ left,
                # Start ≈ right) to surface events only; emitting the
                # click button alongside the surface event makes them
                # ignore the input. See
                # pyremoteplay_patches.py::touchpad_surface_tap for the
                # exact byte layout and the chiaki-ng parity rationale.
                #
                # When no X/Y is supplied (plain `button=touchpad` from
                # the UI) we still fall through the generic
                # controller.button("touchpad") path below, which goes
                # to touchpad_click and emits a real click button -
                # that's the right behaviour for menu navigation /
                # opening the OSK where the click matters.
                touch_surface_tap = getattr(controller, "touchpad_surface_tap", None)
                if touch_surface_tap is None:
                    raise HTTPException(
                        500,
                        "touchpad_surface_tap patch not applied (sidecar restart required)",
                    )
                x_px = int(req.touch_x if req.touch_x is not None else 960)
                y_px = int(req.touch_y if req.touch_y is not None else 471)
                x_px = max(0, min(1919, x_px))
                y_px = max(0, min(941, y_px))
                dur_ms = max(40, int(req.duration_ms or 200))
                # touchpad_surface_tap is synchronous (time.sleep inside)
                # but cheap; to_thread keeps the HTTP loop responsive.
                await asyncio.to_thread(touch_surface_tap, dur_ms, x_px, y_px)
            elif req.action == "press":
                controller.button(req.button, "press")
            elif req.action == "release":
                controller.button(req.button, "release")
            else:  # tap
                controller.button(req.button, "press")
                await asyncio.sleep(max(0.02, (req.duration_ms or 80) / 1000.0))
                controller.button(req.button, "release")
        elif req.stick:
            # `Controller.stick` accepts EITHER (stick_name, axis='x'|'y',
            # value=float) OR (stick_name, point=(x, y)). Earlier code
            # called `controller.stick(req.stick, x, y)` which positionally
            # mapped to `axis=<float x>, value=<float y>` — `axis.lower()`
            # then raised AttributeError on the float and the entire stick
            # input was silently dropped (FastAPI returns 500, browser
            # ignores it). Pass the (x, y) tuple through the `point`
            # keyword so both axes update atomically and the upstream
            # `_should_send.release()` fires exactly once per frame.
            x = max(-1.0, min(1.0, float(req.x or 0)))
            y = max(-1.0, min(1.0, float(req.y or 0)))
            controller.stick(req.stick, point=(x, y))
        else:
            raise HTTPException(400, "button or stick required")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("input failed")
        raise HTTPException(500, f"input failed: {e}")
    return {"ok": True}


class ShakeReq(BaseModel):
    """Trigger a one-shot motion-burst (accel + gyro waveform) on the
    active controller. Used by the fullscreen overlay's Shake button to
    simulate the player physically shaking the DualSense / DualShock 4.

    Both parameters are optional — the patch in
    `pyremoteplay_patches._patch_controller_shake` ships sensible defaults
    (700 ms, 85 % intensity, ~5.5 Hz lateral oscillation) that register
    reliably on every motion-driven title we tested.
    """

    duration_ms: Optional[int] = None
    intensity: Optional[float] = None


@app.post("/sessions/{session_id}/shake")
async def session_shake(session_id: str, req: ShakeReq):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    device = s["device"]
    controller = getattr(device, "controller", None)
    if not controller:
        raise HTTPException(500, "controller not available on session")
    shake_fn = getattr(controller, "shake", None)
    if shake_fn is None:
        # Either the patch failed to apply (older container) or pyremoteplay
        # upstream replaced our monkey-patched method. Tell the UI clearly
        # so it can show a fix-suggestion instead of silently swallowing
        # the gesture.
        raise HTTPException(
            501,
            "shake unsupported on this sidecar build (controller.shake not patched)",
        )
    s["last_used"] = time.time()
    # shake() is non-blocking (kicks off a daemon thread), so we can
    # return immediately. duration/intensity default to the patch's tuned
    # values when omitted by the caller.
    kwargs = {}
    if req.duration_ms is not None:
        kwargs["duration_ms"] = int(req.duration_ms)
    if req.intensity is not None:
        kwargs["intensity"] = float(req.intensity)
    try:
        await asyncio.to_thread(shake_fn, **kwargs)
    except Exception as e:  # noqa: BLE001
        log.exception("shake failed")
        raise HTTPException(500, f"shake failed: {e}")
    return {"ok": True, **kwargs}


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
        "video": _has_video(s.get("receiver")),
        "resolution": s.get("resolution"),
        "created": s["created"],
        "last_used": s["last_used"],
    }


# ─── Video preview (MJPEG over HTTP) ─────────────────────────────────────────
#
# Returns a multipart/x-mixed-replace stream so a plain <img src="..."> can
# render it. We poll the receiver at `fps` Hz (default 12) which is well
# under the actual frame rate from the PS5; the bottleneck on a Pi-class
# device is the JPEG encode, not the network, so capping fps keeps CPU
# usage predictable.
#
# The endpoint disconnects automatically when:
#   - the session is gone (404 condition mid-stream),
#   - the client closes the TCP connection (GeneratorExit),
#   - the receiver is closed via session_stop().

# ─── Pre-warm + warm-status (the "professional" wake flow) ───────────────────
#
# /sessions/prewarm:
#   1) start (or reuse) a Remote Play session - normal handshake + auth,
#   2) immediately park it in the PAUSED_SESSIONS warm cache,
#   3) return.
# Subsequent /sessions/start for the same IP then resume from warm cache in
# O(ms) instead of fighting the PS5's 60 s post-disconnect lock. This is what
# the UI's "Wake PS5" button drives, replacing the bare DDP WAKEUP packet
# (which only got the console out of standby but left RP unreachable).

@app.post("/sessions/prewarm")
async def session_prewarm(req: StartSessionReq):
    # Re-use the full /sessions/start machinery so per-IP locking,
    # warm-cache resume, retry loop and (optional) video receiver setup
    # all behave identically.
    result = await session_start(req)
    sid = result.get("session_id")

    # If the call returned `reused`, an existing live session was handed
    # back: someone is actively using it - do NOT yank it out from under
    # them by moving it to PAUSED_SESSIONS.
    if result.get("reused"):
        return {
            "ok": True,
            "ip": req.ip,
            "session_id": sid,
            "warm_cached": False,
            "already_live": True,
            "video": result.get("video", False),
            "resolution": result.get("resolution"),
        }

    s = SESSIONS.pop(sid, None) if sid else None
    if s is None:
        # Nothing to park - shouldn't happen on the happy path, but if it
        # does we still report what /sessions/start told us.
        return {
            "ok": True,
            "ip": req.ip,
            "session_id": sid,
            "warm_cached": False,
            "video": result.get("video", False),
            "resolution": result.get("resolution"),
        }

    ip = s.get("ip") or req.ip
    device = s["device"]
    # Evict any previous warm cache for this IP to avoid two parallel
    # protocol streams holding the same PS5 slot.
    prev = PAUSED_SESSIONS.pop(ip, None)
    if prev is not None:
        try:
            old_rx = prev.get("receiver")
            if old_rx is not None:
                old_rx.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await _safe_disconnect(prev["device"])
        except Exception:  # noqa: BLE001
            pass

    PAUSED_SESSIONS[ip] = {
        "sid": sid,
        "device": device,
        "user": s.get("user"),
        "receiver": s.get("receiver"),
        "resolution": s.get("resolution"),
        "paused_at": time.monotonic(),
    }
    log.info("session %s PRE-WARMED for %s (TTL %ds, video=%s, %s)",
             sid, ip, int(WARM_CACHE_TTL_S),
             _has_video(s.get("receiver")),
             s.get("resolution"))
    return {
        "ok": True,
        "ip": ip,
        "session_id": sid,
        "warm_cached": True,
        "warm_cache_ttl_s": int(WARM_CACHE_TTL_S),
        "video": _has_video(s.get("receiver")),
        "resolution": s.get("resolution"),
        "resumed": result.get("resumed", False),
    }


@app.get("/warm-status")
async def session_warm_status(ip: str):
    """Report whether the sidecar holds a usable RP session for `ip`.

    Returns the combined view of SESSIONS (live, in-use) and PAUSED_SESSIONS
    (warm-cached, ready to resume). The Node backend folds this into its
    /quick-status response so the UI keeps working across Node restarts -
    the source of truth lives on the sidecar.
    """
    # Prefer reporting the LIVE session if there is one - that's what callers
    # would actually want to adopt.
    for sid, s in SESSIONS.items():
        if s.get("ip") != ip:
            continue
        dev_sess = getattr(s.get("device"), "session", None)
        if dev_sess is not None and not getattr(dev_sess, "is_stopped", True):
            return {
                "ip": ip,
                "live": True,
                "warm": False,
                "session_id": sid,
                "video": _has_video(s.get("receiver")),
                "resolution": s.get("resolution"),
            }
    p = PAUSED_SESSIONS.get(ip)
    if not p:
        return {"ip": ip, "live": False, "warm": False}
    age_s = time.monotonic() - p["paused_at"]
    return {
        "ip": ip,
        "live": False,
        "warm": True,
        "session_id": p["sid"],
        "age_s": round(age_s, 1),
        "ttl_remaining_s": round(max(0.0, WARM_CACHE_TTL_S - age_s), 1),
        "video": _has_video(p.get("receiver")),
        "resolution": p.get("resolution"),
    }


@app.get("/sessions/{session_id}/video.mjpeg")
async def session_video_mjpeg(session_id: str, fps: int = 12):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    receiver = s.get("receiver")
    if not _has_video(receiver):
        raise HTTPException(
            400,
            "session was not started with enable_video=true - stop and re-start the session with the video toggle on",
        )

    # Sanitize fps. 1-30 covers everything from low-bandwidth links to
    # near-realtime; clamping prevents `?fps=9999` from spinning the loop.
    interval = 1.0 / max(1, min(30, int(fps or 12)))
    boundary = b"rpframe"

    async def gen():
        last_counter = -1
        # Initial wait so the first <img> chunk goes out as soon as the
        # decoder has at least one frame (otherwise the browser shows a
        # broken-image icon for ~1s while we wait on the first sleep).
        for _ in range(50):  # up to ~5 s
            if receiver.frame_counter > 0:
                break
            await asyncio.sleep(0.1)
        try:
            while True:
                # Bail out if the session was stopped (warm-cached or fully
                # disconnected). Either way the receiver is no longer
                # producing fresh frames.
                if session_id not in SESSIONS:
                    return
                jpeg = receiver.get_latest_jpeg()
                counter = receiver.frame_counter
                if jpeg is not None and counter != last_counter:
                    last_counter = counter
                    header = (
                        b"--" + boundary + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n"
                    )
                    yield header + jpeg + b"\r\n"
                await asyncio.sleep(interval)
        except (asyncio.CancelledError, GeneratorExit):
            return

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=" + boundary.decode(),
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, private",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no",  # nginx-style buffer off, harmless elsewhere
        },
    )


# Audio (/audio.mp3) and synced A/V (/stream.mp4) endpoints have been
# removed - only the MJPEG video preview remains.




class WakeReq(BaseModel):
    ip: str
    account_id: str
    online_id: Optional[str] = None
    user_profile: Optional[Dict[str, Any]] = None  # preferred - has registered hosts
    # Optional "PS5" / "PS4" override. When omitted the DDP launch packet
    # falls back to PS5 — matches the historical behaviour of /wake.
    host_type: Optional[str] = None


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

    # Also fire a DDP LAUNCH so the console logs the account in. Without it,
    # after a remote wakeup the console sits on the "Press PS button" prompt
    # and Remote Play stays unreachable. host_type defaults to PS5 inside
    # _send_ddp_launch when neither the client nor the cached status supply
    # it; PS4 callers explicitly pass req.host_type="PS4".
    launched = _send_ddp_launch(req.ip, req.account_id, host_type=req.host_type)

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
                prev_rx = prev.get("receiver")
                if prev_rx is not None:
                    prev_rx.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                await _safe_disconnect(prev["device"])
            except Exception:  # noqa: BLE001
                pass
        PAUSED_SESSIONS[ip] = {
            "sid": session_id,
            "device": device,
            "user": s.get("user"),
            "receiver": s.get("receiver"),
            "resolution": s.get("resolution"),
            "paused_at": time.monotonic(),
        }
        log.info("session %s warm-cached for %s (TTL %ds, video=%s, %s)",
                 session_id, ip, int(WARM_CACHE_TTL_S),
                 _has_video(s.get("receiver")),
                 s.get("resolution"))
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
    # Close the receiver so any active MJPEG stream returns and the av
    # codec context is freed deterministically.
    try:
        rx = s.get("receiver")
        if rx is not None:
            rx.close()
    except Exception:  # noqa: BLE001
        pass
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
        try:
            rx = s.get("receiver")
            if rx is not None:
                rx.close()
        except Exception:  # noqa: BLE001
            pass
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
            rx = p.get("receiver")
            if rx is not None:
                rx.close()
        except Exception:  # noqa: BLE001
            pass
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
                try:
                    rx = p.get("receiver")
                    if rx is not None:
                        rx.close()
                except Exception:  # noqa: BLE001
                    pass
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
        try:
            rx = s.get("receiver")
            if rx is not None:
                rx.close()
        except Exception:  # noqa: BLE001
            pass
        await _safe_disconnect(s["device"])
    SESSIONS.clear()
    for ip, p in list(PAUSED_SESSIONS.items()):
        try:
            rx = p.get("receiver")
            if rx is not None:
                rx.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await _safe_disconnect(p["device"])
        except Exception:  # noqa: BLE001
            pass
    PAUSED_SESSIONS.clear()


def main():
    port = int(os.environ.get("PYREMOTEPLAY_SIDECAR_PORT",
                              os.environ.get("CHIAKI_SIDECAR_PORT", "9555")))
    host = os.environ.get("PYREMOTEPLAY_SIDECAR_HOST",
                          os.environ.get("CHIAKI_SIDECAR_HOST", "127.0.0.1"))
    log.info("starting pyremoteplay-sidecar on %s:%s (pyremoteplay=%s)", host, port, PYREMOTEPLAY_OK)
    uvicorn.run(app, host=host, port=port, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
