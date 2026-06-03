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
    PYREMOTEPLAY_OK = True
    PYREMOTEPLAY_ERR: Optional[str] = None
except Exception as e:  # noqa: BLE001
    PYREMOTEPLAY_OK = False
    PYREMOTEPLAY_ERR = str(e)
    RPDevice = None  # type: ignore

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
        raise HTTPException(400, "PSN did not return user account")
    # pyremoteplay returns: {"online_id":..., "account_id":..., "country":..., "language":...}
    return {
        "account_id": user.get("account_id"),
        "online_id": user.get("online_id") or user.get("npLanguage") or "",
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


@app.post("/register")
async def register(req: RegisterReq):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    if len(req.pin.strip()) < 8:
        raise HTTPException(400, "PIN must be the 8-digit code shown on the PS5")
    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable at {req.ip}: {e}")
    try:
        # pyremoteplay's register expects: account_id (b64), pin, save=False
        user = device.register(req.account_id, req.pin, save=False)
    except Exception as e:  # noqa: BLE001
        log.exception("register failed")
        raise HTTPException(400, f"Register failed: {e}")
    if not user:
        raise HTTPException(400, "Register returned no profile - wrong PIN or PS5 not in Add Device mode")
    # The returned profile is keyed by online_id and contains "hosts" with the
    # registration credentials we need to keep.
    return {"ok": True, "profile": user}


# ─── Session lifecycle ────────────────────────────────────────────────────────

class StartSessionReq(BaseModel):
    ip: str
    user_profile: Dict[str, Any]  # the dict returned from /register


def _new_session_id() -> str:
    return secrets.token_hex(8)


@app.post("/sessions/start")
async def session_start(req: StartSessionReq):
    if not PYREMOTEPLAY_OK:
        raise HTTPException(503, f"pyremoteplay unavailable: {PYREMOTEPLAY_ERR}")
    device = RPDevice(req.ip)
    try:
        await device.async_get_status()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"PS5 not reachable: {e}")
    try:
        # Create session without video/audio decoders - input only.
        device.create_session(req.user_profile, resolution="360p", fps=30, receiver=None)
    except Exception as e:  # noqa: BLE001
        log.exception("create_session failed")
        raise HTTPException(400, f"create_session failed: {e}")
    try:
        # device.connect() spawns an asyncio task; we await its readiness
        ok = await device.connect()
        if not ok:
            raise RuntimeError(getattr(device.session, "error", "connect returned False"))
    except Exception as e:  # noqa: BLE001
        log.exception("session connect failed")
        try:
            await device.disconnect()
        except Exception:
            pass
        raise HTTPException(502, f"Session connect failed: {e}")

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


@app.post("/sessions/{session_id}/stop")
async def session_stop(session_id: str):
    s = SESSIONS.pop(session_id, None)
    if not s:
        raise HTTPException(404, "session not found")
    device = s["device"]
    try:
        await device.disconnect()
    except Exception as e:  # noqa: BLE001
        log.warning("disconnect error: %s", e)
    return {"ok": True}


@app.on_event("shutdown")
async def _shutdown():
    for sid, s in list(SESSIONS.items()):
        try:
            await s["device"].disconnect()
        except Exception:
            pass
    SESSIONS.clear()


def main():
    port = int(os.environ.get("CHIAKI_SIDECAR_PORT", "9555"))
    host = os.environ.get("CHIAKI_SIDECAR_HOST", "127.0.0.1")
    log.info("starting chiaki-sidecar on %s:%s (pyremoteplay=%s)", host, port, PYREMOTEPLAY_OK)
    uvicorn.run(app, host=host, port=port, log_level=LOG_LEVEL.lower())


if __name__ == "__main__":
    main()
