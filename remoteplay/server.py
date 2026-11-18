"""Remote Play service.

The Node backend drives PS5 / PS4 Remote Play through this small HTTP
service: pairing (PSN sign-in, then the console's PIN), finding and waking
the console, and sessions - buttons, sticks, touchpad and motion in, the
console's picture out (encoded, for the backend's WebRTC, and as MJPEG for
browsers that cannot take that).

A session is one p5rp process, the helper built on libchiaki (rpnative/);
chiaki_engine.py talks to it. ddp.py finds and wakes consoles, psn_oauth.py
does the PSN sign-in.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import struct
import time
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

LOG_LEVEL = os.environ.get("REMOTEPLAY_SIDECAR_LOG", "info").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("rp-sidecar")

import chiaki_engine  # noqa: E402
import ddp  # noqa: E402
import psn_oauth  # noqa: E402

# The MJPEG stream decodes with PyAV and encodes with Pillow; WebRTC needs
# neither, so the service runs without them, only without MJPEG.
try:
    import av  # type: ignore  # noqa: F401
    from PIL import Image  # type: ignore  # noqa: F401
    VIDEO_STACK_OK = True
    VIDEO_STACK_ERR: Optional[str] = None
except Exception as _e:  # noqa: BLE001
    VIDEO_STACK_OK = False
    VIDEO_STACK_ERR = str(_e)

app = FastAPI(title="p5-manager-remoteplay", version="1.0.0")

# session_id -> {session, controller, receiver, ip, user, video, resolution, fps, created, last_used}
SESSIONS: Dict[str, Dict[str, Any]] = {}
# ip -> {reason, wait_started, wait_s}: a start waiting for the console to
# let go of a previous session, for /retry-status.
RETRY_STATUS: Dict[str, Dict[str, Any]] = {}
# ip -> lock, so two starts for one console never race each other.
START_LOCKS: Dict[str, asyncio.Lock] = {}
# How long the console keeps a finished session's place ("in use").
IN_USE_WAIT_S = 30.0

RESOLUTIONS = ("360p", "540p", "720p", "1080p")
FPS = (30, 60)


def _new_session_id() -> str:
    return secrets.token_hex(8)


def _normalize_stream(resolution: Optional[str], fps: Optional[int]):
    res = (resolution or "720p").lower().strip()
    if res not in RESOLUTIONS:
        log.warning("invalid resolution %r - falling back to 720p", resolution)
        res = "720p"
    f = int(fps or 30)
    if f not in FPS:
        f = 30
    return res, f


def _alive(entry: Optional[Dict[str, Any]]) -> bool:
    return bool(entry) and entry["session"].is_ready


def _live_for(ip: str):
    for sid, s in SESSIONS.items():
        if s.get("ip") == ip and _alive(s):
            return sid, s
    return None, None


def _describe(sid: str, s: Dict[str, Any], **extra) -> Dict[str, Any]:
    return {
        "session_id": sid,
        "state": "connected",
        "video": bool(s.get("video")),
        "resolution": s.get("resolution"),
        "fps": s.get("fps"),
        "engine": "chiaki",
        **extra,
    }


async def _close_entry(entry: Optional[Dict[str, Any]]) -> None:
    if not entry:
        return
    rx = entry.get("receiver")
    if rx is not None:
        try:
            rx.close()
        except Exception:  # noqa: BLE001
            pass
    try:
        await entry["session"].close()
    except Exception as e:  # noqa: BLE001
        log.debug("close error: %s", e)


# ─── Health ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    helper = chiaki_engine.find_helper()
    return {
        "ok": True,
        "engine": "chiaki",
        "helper": bool(helper),
        "helper_path": helper,
        "video_stack": VIDEO_STACK_OK,
        "video_stack_error": VIDEO_STACK_ERR,
        "sessions": [
            {"id": sid, "ip": s.get("ip"), "video": bool(s.get("video")), "resolution": s.get("resolution"),
             "fps": s.get("fps"), "stats": s["session"].stats}
            for sid, s in SESSIONS.items()
        ],
    }


# ─── PSN sign-in ─────────────────────────────────────────────────────────────

class OAuthExchange(BaseModel):
    redirect_url: str


@app.get("/oauth/login_url")
async def oauth_login_url():
    return {"url": psn_oauth.LOGIN_URL}


@app.post("/oauth/exchange")
async def oauth_exchange(req: OAuthExchange):
    try:
        user = await psn_oauth.exchange(req.redirect_url)
    except psn_oauth.OAuthError as e:
        raise HTTPException(400, f"OAuth exchange failed: {e}")
    except Exception as e:  # noqa: BLE001
        log.exception("oauth exchange failed")
        raise HTTPException(502, f"OAuth exchange failed: {e}")
    online_id = user.get("online_id") or user.get("onlineId") or user.get("name") or ""
    return {
        "account_id": str(user["user_id"]),
        "online_id": str(online_id),
        "user_rpid": user.get("user_rpid"),
        "credentials": user.get("credentials"),
        "raw": user,
    }


# ─── Discovery ───────────────────────────────────────────────────────────────

def _status_reply(ip: str, st: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    st = st or {}
    return {
        "ip": ip,
        "host_type": st.get("host-type"),
        "host_name": st.get("host-name"),
        "host_id": st.get("host-id"),
        "system_version": st.get("system-version"),
        "running_app": st.get("running-app-name"),
        "status_code": st.get("status-code"),
        "status": st.get("status"),
    }


@app.get("/discover")
async def discover(ip: str, host_type: Optional[str] = None):
    st = await ddp.status(ip, host_type, timeout=1.5, tries=3)
    if st is None:
        # A console in the middle of a session sometimes lets a search go
        # unanswered; one we are streaming from is certainly on.
        sid, s = _live_for(ip)
        if s is not None:
            return {**_status_reply(ip, None), "status_code": ddp.STATUS_OK, "status": "Ok", "via": "session"}
        raise HTTPException(502, f"no answer from {ip} - the console is off, unplugged from the network, or not there")
    return _status_reply(ip, st)


# ─── Pairing ─────────────────────────────────────────────────────────────────

class RegisterReq(BaseModel):
    ip: str
    account_id: str
    pin: str
    online_id: Optional[str] = None
    host_type: Optional[str] = None  # "PS5" | "PS4"; asked of the console otherwise


def _profile_name(online_id: Optional[str], account_id: str) -> str:
    name = (online_id or "").strip()
    return name or f"psn-{account_id[:8]}"


@app.post("/register")
async def register(req: RegisterReq):
    pin = req.pin.strip().replace("-", "").replace(" ", "")
    if len(pin) != 8 or not pin.isdigit():
        raise HTTPException(400, "PIN must be the 8-digit code shown on the console (Settings → System → Remote Play → Link Device)")
    if not req.account_id:
        raise HTTPException(400, "account_id required - run OAuth first")
    st = await ddp.status(req.ip, req.host_type, timeout=2.0, tries=3)
    if not st:
        raise HTTPException(502, f"The console at {req.ip} does not answer - is it on?")
    host_type = (req.host_type or str(st.get("host-type") or "PS5")).upper()
    try:
        result = await chiaki_engine.regist(
            req.ip, req.account_id, pin, ps4=host_type == "PS4", target=chiaki_engine.regist_target(st),
        )
    except chiaki_engine.ChiakiError as e:
        raise HTTPException(400, f"Register failed: {e} - check the PIN and that the console still shows it (Settings → System → Remote Play → Link Device)")

    # The profile in the layout paired consoles have always had (it began as
    # pyremoteplay's): hosts under the console's id, keys as hex.
    mac = str(st.get("host-id") or result.get("mac") or "").upper()
    host_data = {
        "RegistKey": result["regist_key"],
        "RP-Key": result["rp_key"],
        "RP-KeyType": str(result.get("rp_key_type", "")),
        "Mac": str(result.get("mac") or "").upper(),
        "Nickname": result.get("nickname") or st.get("host-name") or "",
    }
    name = _profile_name(req.online_id, req.account_id)
    profile = {
        "name": name,
        "data": {
            "id": psn_oauth.account_rpid(req.account_id),
            "hosts": {mac: {"type": host_type, "data": host_data}},
        },
    }
    log.info("paired with %s %s (%s)", host_type, req.ip, host_data["Nickname"])
    return {"ok": True, "profile": profile}


# ─── Waking ──────────────────────────────────────────────────────────────────

def _keys(user_profile: Dict[str, Any], mac: Optional[str] = None):
    try:
        return chiaki_engine.keys_from_profile(user_profile, mac)
    except chiaki_engine.ChiakiError as e:
        raise HTTPException(400, str(e))


def _decimal_account_id(account_id: Optional[str], user_profile: Optional[Dict[str, Any]]) -> str:
    """The decimal PSN account id LAUNCH is made from: given, or out of the
    profile's base64 id; a base64 id given is turned into it too."""
    aid = (account_id or "").strip()
    if aid and not aid.isdigit():
        aid = psn_oauth.account_id_from_rpid(aid)
    if not aid:
        rpid = ((user_profile or {}).get("data") or {}).get("id")
        if rpid:
            aid = psn_oauth.account_id_from_rpid(rpid)
    return aid


async def _power_on(ip: str, regist_key: str, host_type: Optional[str]) -> int:
    """Power the console on and wait until it answers discovery with "Ok".

    Returns how many WAKEUP packets that took, 0 when it was already on. A
    console that has just gone into rest mode ignores the first packet (it
    is still winding its services down), and UDP loses packets anyway, so
    this nudges it every 30 s for up to 90 s before giving up.
    """
    st = await ddp.status(ip, host_type, timeout=1.5, tries=3)
    if st and st.get("status-code") == ddp.STATUS_OK:
        return 0
    log.info("console %s is %s - waking it (up to 90 s)", ip, (st or {}).get("status") or "silent")
    for sent in range(1, 4):
        ddp.wakeup(ip, regist_key, host_type)
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            await asyncio.sleep(2.0)
            st = await ddp.status(ip, host_type, timeout=1.0, tries=1)
            if st and st.get("status-code") == ddp.STATUS_OK:
                log.info("console %s is on (%d wakeup packet(s))", ip, sent)
                return sent
        log.info("console %s still asleep - another wakeup", ip)
    raise HTTPException(502, "The console did not wake within 90 s - wake it with the PS button, then try again.")


async def _bring_up(ip: str, regist_key: str, host_type: Optional[str], account_id: str) -> None:
    """Make sure the console is on and logged in before a session.

    On: nothing to do. Otherwise power it on and then LAUNCH, which logs
    the account in past the "press the PS button" screen a freshly woken
    console shows.
    """
    if await _power_on(ip, regist_key, host_type) == 0:
        return
    await asyncio.sleep(2.0)
    if account_id and ddp.launch(ip, account_id, host_type):
        log.info("LAUNCH sent to %s", ip)
        await asyncio.sleep(3.0)


async def _require_rp_service(ip: str, account_id: str, host_type: Optional[str]) -> None:
    """The console is on; make sure Remote Play itself is listening.

    A console that answers discovery can still refuse the session port -
    Remote Play switched off in its settings, or its service gone after a
    crash. LAUNCH is the one thing that can still start it (it also signs
    the account in past the user-select screen); when the port stays shut
    after that, asking p5rp twenty times only hides what is wrong.
    """
    if await ddp.tcp_open(ip, ddp.SESSION_PORT, timeout=2.0):
        return
    if account_id and ddp.launch(ip, account_id, host_type):
        log.info("console %s does not listen on %d - LAUNCH sent", ip, ddp.SESSION_PORT)
        for _ in range(4):
            await asyncio.sleep(2.0)
            if await ddp.tcp_open(ip, ddp.SESSION_PORT, timeout=2.0):
                return
    raise HTTPException(502, (
        "The console is on but Remote Play is not running on it: nothing answers on port "
        f"{ddp.SESSION_PORT}. Check Settings > System > Remote Play on the console, and if it is "
        "already on, restart the console - a crash leaves the Remote Play service down."
    ))


class WakeReq(BaseModel):
    ip: str
    user_profile: Optional[Dict[str, Any]] = None
    host_type: Optional[str] = None


@app.post("/wake")
async def wake(req: WakeReq):
    """Power the console on, and answer once it is really on.

    Nothing else. No LAUNCH, no session - signing the account in and taking
    the Remote Play slot belong to starting a session, not to waking. Can
    take most of a minute: see _power_on.
    """
    if not req.user_profile:
        raise HTTPException(400, "user_profile required - pair the console first")
    regist, _, is_ps4 = _keys(req.user_profile)
    host_type = req.host_type or ("PS4" if is_ps4 else "PS5")
    started = time.monotonic()
    sent = await _power_on(req.ip, regist, host_type)
    return {"ok": True, "on": True, "already_on": sent == 0, "packets_sent": sent,
            "waited_s": round(time.monotonic() - started, 1)}


# ─── Sessions ────────────────────────────────────────────────────────────────

class StartSessionReq(BaseModel):
    ip: str
    user_profile: Dict[str, Any]  # what /register returned
    account_id: Optional[str] = None  # decimal PSN account id, for LAUNCH
    # Whether the caller shows the picture. Every session carries it (the
    # protocol sends it anyway); this only says what the session is for.
    enable_video: Optional[bool] = False
    enable_audio: Optional[bool] = True
    resolution: Optional[str] = "720p"
    fps: Optional[int] = 30
    host_type: Optional[str] = None  # "PS5" | "PS4"


@app.post("/sessions/start")
async def session_start(req: StartSessionReq):
    RETRY_STATUS.pop(req.ip, None)
    lock = START_LOCKS.setdefault(req.ip, asyncio.Lock())
    async with lock:
        # A live session for the console serves any caller: the picture is
        # in every session, a JPEG decoder is added when one is wanted.
        sid, s = _live_for(req.ip)
        if s is not None:
            s["last_used"] = time.time()
            if req.enable_video and not s.get("video"):
                s["video"] = True
                if s.get("receiver") is None:
                    s["receiver"] = chiaki_engine.ChiakiReceiver(s["session"])
            log.info("session %s already live for %s - reusing", sid, req.ip)
            return _describe(sid, s, reused=True)
        return await _session_open(req)


async def _session_open(req: StartSessionReq) -> Dict[str, Any]:
    res, fps = _normalize_stream(req.resolution, req.fps)
    regist, morning, is_ps4 = _keys(req.user_profile)
    if req.host_type:
        is_ps4 = str(req.host_type).upper() == "PS4"
    host_type = "PS4" if is_ps4 else "PS5"
    account = _decimal_account_id(req.account_id, req.user_profile)
    await _bring_up(req.ip, regist, host_type, account)
    await _require_rp_service(req.ip, account, host_type)

    last: Optional[Exception] = None
    session = None
    # The console keeps a finished session's place for a while ("in use"):
    # one quiet wait and a second try.
    for attempt in range(2):
        session = chiaki_engine.ChiakiSession(
            req.ip, regist, morning, ps4=is_ps4, resolution=res, fps=fps,
            audio=req.enable_audio is not False,
        )
        try:
            await session.start()
            last = None
            break
        except chiaki_engine.ChiakiError as e:
            last = e
            await session.close()
            if attempt == 0 and "in use" in (e.reason or "").lower():
                RETRY_STATUS[req.ip] = {"reason": "lock", "wait_started": time.monotonic(), "wait_s": IN_USE_WAIT_S}
                log.info("console %s says Remote Play is in use - quiet wait %ds", req.ip, int(IN_USE_WAIT_S))
                await asyncio.sleep(IN_USE_WAIT_S)
                RETRY_STATUS.pop(req.ip, None)
                continue
            break
    if last is not None:
        log.warning("session connect failed: %s", last)
        msg = str(last)
        if "Another Remote Play session" in msg:
            msg += " - close any active Remote Play / Chiaki-ng client and try again in ~30s"
        raise HTTPException(502, f"Session connect failed: {msg}")

    sid = _new_session_id()
    SESSIONS[sid] = {
        "session": session,
        "controller": chiaki_engine.ChiakiController(session),
        "receiver": chiaki_engine.ChiakiReceiver(session) if req.enable_video else None,
        "ip": req.ip,
        "user": req.user_profile,
        "video": bool(req.enable_video),
        "resolution": res,
        "fps": fps,
        "created": time.time(),
        "last_used": time.time(),
        "last_input": time.time(),
    }
    log.info("session %s started -> %s (%s/%d, video=%s, %.1fs)",
             sid, req.ip, res, fps, bool(req.enable_video), time.monotonic() - session.started_at)
    return _describe(sid, SESSIONS[sid])


@app.get("/sessions/{session_id}")
async def session_status(session_id: str):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    return {
        "session_id": session_id,
        "ip": s["ip"],
        "state": "connected" if _alive(s) else "stopped",
        "video": bool(s.get("video")),
        "resolution": s.get("resolution"),
        "fps": s.get("fps"),
        "stats": s["session"].stats,
        "created": s["created"],
        "last_used": s["last_used"],
        "last_input": s.get("last_input", s["created"]),
    }


@app.post("/sessions/{session_id}/stop")
async def session_stop(session_id: str):
    """End the session."""
    s = SESSIONS.pop(session_id, None)
    if not s:
        raise HTTPException(404, "session not found")
    await _close_entry(s)
    log.info("session %s stopped for %s", session_id, s.get("ip"))
    return {"ok": True}


@app.post("/sessions/stop-all")
async def session_stop_all(ip: Optional[str] = None):
    """End every session, optionally only for one console."""
    stopped = []
    for sid, s in list(SESSIONS.items()):
        if ip and s.get("ip") != ip:
            continue
        SESSIONS.pop(sid, None)
        await _close_entry(s)
        stopped.append(sid)
    return {"ok": True, "stopped": stopped}


@app.get("/retry-status")
async def session_retry_status(ip: str):
    r = RETRY_STATUS.get(ip)
    if not r:
        return {"waiting": False}
    remaining = max(0.0, r["wait_s"] - (time.monotonic() - r["wait_started"]))
    return {"waiting": True, "reason": r["reason"], "remaining_s": round(remaining, 1), "total_s": r["wait_s"]}


@app.get("/live-status")
async def session_live_status(ip: str):
    """The live session for a console, if there is one."""
    sid, s = _live_for(ip)
    if s is None:
        return {"ip": ip, "live": False}
    return {"ip": ip, "live": True, "session_id": sid,
            "last_input": s.get("last_input", s["created"]), "video": bool(s.get("video")),
            "resolution": s.get("resolution"), "fps": s.get("fps")}


# ─── Input ───────────────────────────────────────────────────────────────────

class InputReq(BaseModel):
    button: Optional[str] = None
    action: Optional[str] = "tap"  # press | release | tap
    stick: Optional[str] = None  # "left" | "right"
    x: Optional[float] = None  # -1.0 .. 1.0
    y: Optional[float] = None
    duration_ms: Optional[int] = 80  # for "tap"
    # A finger on the touchpad surface at this point (0..1919, 0..941),
    # without the click: PS2 Classics and some PS4 games on the PS5 take
    # Select from the left half and Start from the right, and ignore a click.
    touch_x: Optional[int] = None
    touch_y: Optional[int] = None


def _controller(session_id: str):
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    if not _alive(s):
        raise HTTPException(410, "the session has ended")
    s["last_used"] = time.time()
    s["last_input"] = s["last_used"]
    return s["controller"]


@app.post("/sessions/{session_id}/input")
async def session_input(session_id: str, req: InputReq):
    controller = _controller(session_id)
    try:
        if req.button:
            name = req.button.lower()
            has_xy = req.touch_x is not None or req.touch_y is not None
            if name == "touchpad" and has_xy and req.action in (None, "tap", "press"):
                x = max(0, min(1919, int(req.touch_x if req.touch_x is not None else 960)))
                y = max(0, min(941, int(req.touch_y if req.touch_y is not None else 471)))
                await asyncio.to_thread(controller.touchpad_surface_tap, max(40, int(req.duration_ms or 200)), x, y)
            elif name == "touchpad" and req.action in (None, "tap"):
                # A click on the middle of the pad, with the finger the
                # console expects around it (menus, the on-screen keyboard).
                await asyncio.to_thread(controller.touchpad_click, max(40, int(req.duration_ms or 100)))
            elif req.action == "press":
                controller.button(name, "press")
            elif req.action == "release":
                controller.button(name, "release")
            else:
                controller.button(name, "press")
                await asyncio.sleep(max(0.02, (req.duration_ms or 80) / 1000.0))
                controller.button(name, "release")
        elif req.stick:
            x = max(-1.0, min(1.0, float(req.x or 0)))
            y = max(-1.0, min(1.0, float(req.y or 0)))
            controller.stick(req.stick, point=(x, y))
        else:
            raise HTTPException(400, "button or stick required")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("input failed")
        raise HTTPException(500, f"input failed: {e}")
    return {"ok": True}


class ShakeReq(BaseModel):
    duration_ms: Optional[int] = None
    intensity: Optional[float] = None


@app.post("/sessions/{session_id}/shake")
async def session_shake(session_id: str, req: ShakeReq):
    """Shake the controller for a moment - for games that ask for it."""
    controller = _controller(session_id)
    duration_ms = max(50, min(5000, int(req.duration_ms or 700)))
    intensity = max(0.0, min(1.0, float(req.intensity if req.intensity is not None else 0.85)))
    asyncio.get_running_loop().run_in_executor(None, controller.shake, duration_ms, intensity)
    return {"ok": True, "duration_ms": duration_ms, "intensity": intensity}


# ─── Picture ─────────────────────────────────────────────────────────────────

@app.post("/sessions/{session_id}/idr")
async def session_idr(session_id: str):
    """Ask the console for a key frame - a WebRTC viewer whose picture broke."""
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    s["session"].request_key_frame()
    return {"ok": True}


@app.get("/sessions/{session_id}/stream")
async def session_stream(session_id: str):
    """The session's video and sound as the console encoded them, in p5rp's
    records - what the backend packs into WebRTC. Starts at a key frame,
    which is asked for here."""
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    session = s["session"]
    queue = session.subscribe()
    session.request_key_frame()

    async def gen():
        try:
            if session.audio_format:
                yield b"H" + b"\x00" + struct.pack(">I", len(session.audio_format)) + b"\x00" * 8 + session.audio_format
            while True:
                item = await queue.get()
                if item is None or session_id not in SESSIONS:
                    return
                head, data = item
                yield head + data
                if queue.waiting_for_key:
                    # It fell behind and lost frames: begin again from a key frame.
                    session.request_key_frame()
        except (asyncio.CancelledError, GeneratorExit):
            return
        finally:
            session.unsubscribe(queue)

    return StreamingResponse(gen(), media_type="application/octet-stream", headers={
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        "X-Stream-Resolution": str(s.get("resolution") or ""),
    })


@app.get("/sessions/{session_id}/video.mjpeg")
async def session_video_mjpeg(session_id: str, fps: int = 12):
    """The picture as MJPEG for an <img>, for browsers without WebRTC."""
    s = SESSIONS.get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    if not VIDEO_STACK_OK:
        raise HTTPException(503, f"MJPEG needs PyAV and Pillow: {VIDEO_STACK_ERR}")
    receiver = s.get("receiver")
    if receiver is None:
        receiver = s["receiver"] = chiaki_engine.ChiakiReceiver(s["session"])
        s["video"] = True
    interval = 1.0 / max(1, min(30, int(fps or 12)))
    boundary = b"rpframe"

    async def gen():
        last_counter = -1
        for _ in range(50):  # the first picture, up to ~5 s
            if receiver.frame_counter > 0:
                break
            await asyncio.sleep(0.1)
        try:
            while session_id in SESSIONS:
                jpeg = await asyncio.to_thread(receiver.get_latest_jpeg)
                counter = receiver.frame_counter
                if jpeg is not None and counter != last_counter:
                    last_counter = counter
                    yield (b"--" + boundary + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                           + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                await asyncio.sleep(interval)
        except (asyncio.CancelledError, GeneratorExit):
            return

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=" + boundary.decode(), headers={
        "Cache-Control": "no-cache, no-store, must-revalidate, private",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",
    })


# ─── Rest mode ───────────────────────────────────────────────────────────────

@app.post("/standby")
async def standby(req: StartSessionReq):
    """Put the console into rest mode, through a session: the live one when
    there is one (a second session would be turned away as "in use"), a
    short one of its own otherwise."""
    for sid, s in list(SESSIONS.items()):
        if s.get("ip") == req.ip and _alive(s):
            SESSIONS.pop(sid, None)
            ok = await s["session"].async_standby(timeout=8.0)
            await _close_entry(s)
            log.info("standby: through live session %s for %s (ok=%s)", sid, req.ip, ok)
            return {"ok": True, "via": "existing_session"}
    regist, morning, is_ps4 = _keys(req.user_profile)
    if req.host_type:
        is_ps4 = str(req.host_type).upper() == "PS4"
    st = await ddp.status(req.ip, "PS4" if is_ps4 else "PS5", timeout=1.5, tries=3)
    if st and st.get("status-code") == ddp.STATUS_STANDBY:
        return {"ok": True, "already_standby": True, "message": "The console is already in rest mode"}
    temp = chiaki_engine.ChiakiSession(req.ip, regist, morning, ps4=is_ps4, resolution="360p", fps=30)
    try:
        await temp.start()
    except chiaki_engine.ChiakiError as e:
        await temp.close()
        raise HTTPException(502, f"standby connect failed: {e}")
    try:
        ok = await temp.async_standby(timeout=8.0)
        log.info("standby: sent to %s through a session of its own (ok=%s)", req.ip, ok)
    finally:
        await temp.close()
    return {"ok": True, "via": "temporary_session"}


# ─── Upkeep ──────────────────────────────────────────────────────────────────

async def _upkeep_task():
    """Every 15 s: forget sessions the console has ended by itself (rest
    mode, network gone)."""
    while True:
        try:
            await asyncio.sleep(15.0)
            for sid, s in list(SESSIONS.items()):
                if s["session"].is_stopped:
                    SESSIONS.pop(sid, None)
                    await _close_entry(s)
                    log.info("session %s for %s ended by the console (%s)", sid, s.get("ip"),
                             s["session"].quit_reason or "no reason given")
        except asyncio.CancelledError:
            return
        except Exception as e:  # noqa: BLE001
            log.warning("upkeep error: %s", e)


@app.on_event("startup")
async def _startup():
    if not chiaki_engine.find_helper():
        log.error("p5rp was not found (P5RP_BIN, next to this service, or on the PATH) - sessions and pairing will fail")
    asyncio.create_task(_upkeep_task())


@app.on_event("shutdown")
async def _shutdown():
    for s in list(SESSIONS.values()):
        await _close_entry(s)
    SESSIONS.clear()


def main():
    port = int(os.environ.get("REMOTEPLAY_SIDECAR_PORT", "9555"))
    host = os.environ.get("REMOTEPLAY_SIDECAR_HOST", "127.0.0.1")
    log.info("starting the Remote Play service on %s:%s (p5rp: %s)", host, port, chiaki_engine.find_helper() or "missing")
    uvicorn.run(app, host=host, port=port, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
