"""Remote Play sessions through p5rp, the helper built on libchiaki.

The sidecar's HTTP API was written around pyremoteplay's objects: a device
with a `session` and a `controller`, and a receiver that hands out the latest
picture as a JPEG. This module offers the same shapes on top of one `p5rp`
process per session (see rpnative/), so the routes in server.py work with
either engine and only the place that opens a connection has to choose.

What the helper does natively - the Takion transport, encryption, error
correction, congestion control - is what pyremoteplay did in Python. The
video comes out of it as the console encoded it; it is decoded here only
while somebody asks for JPEGs, and handed on untouched to whoever wants the
stream itself (see `subscribe`).
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import shutil
import struct
import sys
import threading
import time
from typing import Any, Dict, Optional, Tuple

log = logging.getLogger("rp-sidecar.chiaki")

RECORD_HEAD = 14  # kind(1) flags(1) length(4) time(8)
FLAG_KEY = 1

# Names the app uses for buttons -> the helper's. L2 and R2 are triggers.
_BUTTONS = {
    "cross": "cross", "circle": "moon", "square": "box", "triangle": "pyramid",
    "moon": "moon", "box": "box", "pyramid": "pyramid",
    "up": "up", "down": "down", "left": "left", "right": "right",
    "l1": "l1", "r1": "r1", "l3": "l3", "r3": "r3",
    "options": "options", "share": "share", "create": "share",
    "touchpad": "touchpad", "ps": "ps",
}
_RESOLUTIONS = {"360p": 360, "540p": 540, "720p": 720, "1080p": 1080}


class ChiakiError(Exception):
    """The helper could not open or keep the session; `reason` is libchiaki's."""

    def __init__(self, message: str, reason: str = ""):
        super().__init__(message)
        self.reason = reason


def find_helper() -> Optional[str]:
    """Where p5rp is: P5RP_BIN, next to this service, or on the PATH."""
    exe = "p5rp.exe" if sys.platform == "win32" else "p5rp"
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.environ.get("P5RP_BIN") or "",
        os.path.join(here, exe),
        os.path.join(here, "p5rp", exe),
        # Windows package: <home>\runtime\p5rp, with this file in <home>\app\pyremoteplay
        os.path.join(here, "..", "..", "runtime", "p5rp", exe),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return os.path.abspath(c)
    return shutil.which("p5rp")


def keys_from_profile(user_profile: Dict[str, Any], mac: Optional[str] = None) -> Tuple[str, str, bool]:
    """(regist key, morning as hex, is_ps4) out of the profile /register returned.

    pyremoteplay keeps the regist key as the hex of its characters and the
    morning as `RP-Key`; hosts are filed under their MAC address.
    """
    data = (user_profile or {}).get("data") or {}
    hosts = data.get("hosts") or {}
    if not hosts:
        raise ChiakiError("the profile has no registered console - pair it again")
    host = None
    if mac:
        want = mac.replace(":", "").replace("-", "").upper()
        for key, value in hosts.items():
            if key.replace(":", "").replace("-", "").upper() == want:
                host = value
    if host is None:
        if len(hosts) > 1 and mac:
            raise ChiakiError("this console is not among the paired ones - pair it again")
        host = next(iter(hosts.values()))
    hd = host.get("data") or {}
    try:
        regist = bytes.fromhex(hd["RegistKey"]).decode("ascii").rstrip("\x00")
        morning = hd["RP-Key"]
        bytes.fromhex(morning)
    except Exception as e:  # noqa: BLE001
        raise ChiakiError(f"the pairing data is not usable ({e}) - pair the console again")
    if len(morning) != 32:
        raise ChiakiError("the pairing data is not usable (key length) - pair the console again")
    return regist, morning, str(host.get("type", "")).upper() == "PS4"


class ChiakiSession:
    """One p5rp process. Quacks like pyremoteplay's Session where server.py looks."""

    def __init__(self, ip: str, regist: str, morning: str, *, ps4: bool, resolution: str,
                 fps: int = 30, audio: bool = False):
        self.ip = ip
        self._regist = regist
        self._morning = morning
        self._ps4 = ps4
        self.resolution = resolution
        self.fps = fps
        self.audio = audio
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._tasks: list = []
        self._connected = asyncio.Event()
        self._ended = asyncio.Event()
        self.quit_reason: str = ""
        self.quit_detail: str = ""
        self.quit_is_error = False
        self.stats: Dict[str, Any] = {}
        self.audio_format: Optional[bytes] = None  # the 'H' record's text
        self._subscribers: list = []
        self.on_video = None  # callable(flags, data), set by the receiver
        self.started_at = time.monotonic()
        self.first_frame_s: Optional[float] = None

    # ── what server.py reads ──────────────────────────────────────────
    @property
    def is_ready(self) -> bool:
        return self._connected.is_set() and not self._ended.is_set()

    @property
    def is_running(self) -> bool:
        return self.is_ready

    @property
    def is_stopped(self) -> bool:
        return self._ended.is_set()

    # ── life cycle ────────────────────────────────────────────────────
    async def start(self, timeout: float = 20.0) -> None:
        helper = find_helper()
        if not helper:
            raise ChiakiError("p5rp is not installed next to the Remote Play service")
        args = [helper, "--host", self.ip, "--res", str(_RESOLUTIONS.get(self.resolution, 720)), "--fps", str(self.fps)]
        if self._ps4:
            args.append("--ps4")
        if self.audio:
            args.append("--audio")
        env = dict(os.environ, P5RP_REGIST_KEY=self._regist, P5RP_MORNING=self._morning)
        self._proc = await asyncio.create_subprocess_exec(
            *args, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        self._tasks = [asyncio.create_task(self._read_events()), asyncio.create_task(self._read_records())]
        connected = asyncio.create_task(self._connected.wait())
        ended = asyncio.create_task(self._ended.wait())
        try:
            await asyncio.wait({connected, ended}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            connected.cancel()
            ended.cancel()
        if self._ended.is_set():
            raise ChiakiError(self._describe_quit(), self.quit_reason)
        if not self._connected.is_set():
            await self.close()
            raise ChiakiError("the console did not answer in time", "timeout")

    def _describe_quit(self) -> str:
        reason = self.quit_reason or "the session ended"
        if "in use" in reason.lower():
            return "Another Remote Play session is connected to the console"
        return reason + (f": {self.quit_detail}" if self.quit_detail else "")

    async def _read_events(self) -> None:
        assert self._proc and self._proc.stderr
        try:
            async for raw in self._proc.stderr:
                try:
                    e = json.loads(raw)
                except Exception:  # noqa: BLE001
                    continue
                kind = e.get("event")
                if kind == "connected":
                    self._connected.set()
                elif kind == "quit":
                    self.quit_reason = str(e.get("reason") or "")
                    self.quit_detail = str(e.get("detail") or "")
                    self.quit_is_error = bool(e.get("error"))
                    self._ended.set()
                elif kind == "stats":
                    self.stats = e
                elif kind == "log":
                    msg = str(e.get("msg") or "")
                    # The console answers the session request with a text that
                    # libchiaki dumps as hex, harmless and long.
                    if "Session Id" in msg or msg.startswith(("offset", " ")):
                        continue
                    (log.warning if e.get("level") == "error" else log.debug)("p5rp %s: %s", self.ip, msg)
                elif kind == "fec_failure":
                    log.debug("p5rp %s: a frame could not be repaired", self.ip)
        finally:
            self._ended.set()

    async def _read_records(self) -> None:
        assert self._proc and self._proc.stdout
        out = self._proc.stdout
        try:
            while True:
                head = await out.readexactly(RECORD_HEAD)
                size = struct.unpack(">I", head[2:6])[0]
                data = await out.readexactly(size)
                kind = head[0:1]
                if kind == b"H":
                    self.audio_format = data
                elif kind == b"V":
                    if self.first_frame_s is None:
                        self.first_frame_s = time.monotonic() - self.started_at
                    cb = self.on_video
                    if cb is not None:
                        cb(head[1], data)
                for q in list(self._subscribers):
                    self._offer(q, head, data)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self._ended.set()
            for q in list(self._subscribers):
                self._offer(q, None, None)

    # ── the stream as it is, for whoever forwards it (WebRTC) ─────────
    def subscribe(self, max_records: int = 600) -> "asyncio.Queue":
        """A queue of (head, data) records, video and sound; None ends it.

        A reader that falls behind loses what it could not take and is fed
        again from the next key frame, which it should ask for with
        `request_key_frame()` - half a picture is worth nothing to a decoder.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=max_records)
        q.waiting_for_key = True  # type: ignore[attr-defined]
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: "asyncio.Queue") -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    def _offer(self, q: "asyncio.Queue", head: Optional[bytes], data: Optional[bytes]) -> None:
        if head is None:
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass
            return
        if head[0:1] == b"V":
            if q.waiting_for_key:  # type: ignore[attr-defined]
                if not head[1] & FLAG_KEY:
                    return
                q.waiting_for_key = False  # type: ignore[attr-defined]
        try:
            q.put_nowait((head, data))
        except asyncio.QueueFull:
            q.waiting_for_key = True  # type: ignore[attr-defined]

    def request_key_frame(self) -> None:
        self.send("idr")

    # ── commands ──────────────────────────────────────────────────────
    def send(self, line: str) -> None:
        p = self._proc
        if p is None or p.stdin is None or p.returncode is not None:
            return
        try:
            p.stdin.write((line + "\n").encode())
        except Exception:  # noqa: BLE001
            pass

    def stop(self) -> None:
        self.send("stop")

    def _send_standby(self) -> None:
        self.send("standby")

    async def async_wait(self, timeout: float = 10.0) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return self.is_ready

    async def async_standby(self, timeout: float = 8.0) -> bool:
        """Rest mode. True once the console has let the session go."""
        self.send("standby")
        try:
            await asyncio.wait_for(self._ended.wait(), timeout)
        except asyncio.TimeoutError:
            return False
        return True

    async def close(self) -> None:
        p = self._proc
        if p is None:
            return
        if p.returncode is None:
            self.send("stop")
            try:
                if p.stdin:
                    p.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                await asyncio.wait_for(p.wait(), 6.0)
            except asyncio.TimeoutError:
                try:
                    p.kill()
                except ProcessLookupError:
                    pass
                await p.wait()
        for t in self._tasks:
            t.cancel()
        self._ended.set()


class ChiakiController:
    """pyremoteplay's Controller, as far as server.py uses it."""

    def __init__(self, session: ChiakiSession):
        self._s = session

    def button(self, name: str, action: str = "tap", delay: float = 0.1) -> None:
        n = (name or "").lower()
        down = action != "release"
        if n in ("l2", "r2"):
            self._s.send(f"trigger {n} {255 if down else 0}")
        elif n in _BUTTONS:
            self._s.send(f"btn {_BUTTONS[n]} {1 if down else 0}")
        else:
            raise ValueError(f"unknown button: {name}")
        if action == "tap":
            # server.py presses and releases by itself; a bare tap is not used
            # there, but keep it meaning what it says.
            time.sleep(max(0.02, delay))
            self.button(name, "release")

    def stick(self, stick_name: str, axis: Optional[str] = None, value: Optional[float] = None,
              point: Optional[Tuple[float, float]] = None) -> None:
        side = "l" if (stick_name or "").lower().startswith("l") else "r"
        state = self.__dict__.setdefault("_sticks", {"l": [0.0, 0.0], "r": [0.0, 0.0]})
        if point is not None:
            state[side] = [float(point[0]), float(point[1])]
        elif axis is not None and value is not None:
            state[side][0 if axis.lower() == "x" else 1] = float(value)
        x, y = (max(-1.0, min(1.0, v)) for v in state[side])
        self._s.send(f"stick {side} {int(x * 32767)} {int(y * 32767)}")

    def touchpad_surface_tap(self, duration_ms: int = 200, x: int = 960, y: int = 471) -> None:
        self._s.send(f"touch down {int(x)} {int(y)}")
        time.sleep(max(0.04, duration_ms / 1000.0))
        self._s.send("touch up")

    def touchpad_click(self, duration_ms: int = 100, x: int = 960, y: int = 471) -> None:
        self._s.send(f"touch down {int(x)} {int(y)}")
        self._s.send("btn touchpad 1")
        time.sleep(max(0.04, duration_ms / 1000.0))
        self._s.send("btn touchpad 0")
        self._s.send("touch up")


class ChiakiDevice:
    """pyremoteplay's RPDevice, as far as server.py uses it once connected."""

    engine = "chiaki"

    def __init__(self, session: ChiakiSession):
        self.session = session
        self.controller = ChiakiController(session)
        self.host = session.ip

    async def disconnect(self) -> None:
        await self.session.close()


class ChiakiReceiver:
    """The latest picture as a JPEG, like MjpegReceiver - decoded only on demand.

    Nothing is decoded until a JPEG is asked for: with a WebRTC viewer the
    browser does the decoding and this stays idle. The first request starts
    a decoder and asks the console for a key frame to begin with; the
    decoder stops again when nobody has asked for a while.
    """

    IDLE_S = 8.0

    def __init__(self, session: ChiakiSession, jpeg_quality: int = 70, enable_video: bool = True):
        self._session = session
        self._video_enabled = bool(enable_video)
        self._quality = max(1, min(95, jpeg_quality))
        self._lock = threading.Lock()
        self._codec = None
        self._wait_key = True
        self._latest_frame = None
        self._latest_jpeg: Optional[bytes] = None
        self._frame_counter = 0
        self._encoded_counter = -1
        self._last_asked = 0.0
        self._closed = False
        if self._video_enabled:
            session.on_video = self._on_video

    @property
    def frame_counter(self) -> int:
        # A poll counts as interest: the MJPEG route waits on this before it
        # asks for the first JPEG.
        self._want()
        return self._frame_counter

    def _want(self) -> None:
        now = time.monotonic()
        starting = self._codec is None or now - self._last_asked > self.IDLE_S
        self._last_asked = now
        if starting and not self._closed and self._video_enabled:
            with self._lock:
                if self._codec is None:
                    import av  # noqa: WPS433 - only where pictures are wanted
                    self._codec = av.CodecContext.create("h264", "r")
                    self._wait_key = True
            self._session.request_key_frame()

    def _on_video(self, flags: int, data: bytes) -> None:
        if self._closed or self._codec is None:
            return
        if time.monotonic() - self._last_asked > self.IDLE_S:
            with self._lock:
                self._codec = None
                self._latest_frame = None
            return
        if self._wait_key:
            if not flags & FLAG_KEY:
                return
            self._wait_key = False
        try:
            import av  # noqa: WPS433
            frames = self._codec.decode(av.Packet(data))
        except Exception as e:  # noqa: BLE001
            log.debug("video decode failed: %s", e)
            self._wait_key = True
            self._session.request_key_frame()
            return
        if frames:
            with self._lock:
                self._latest_frame = frames[-1]
                self._frame_counter += 1

    def get_latest_jpeg(self) -> Optional[bytes]:
        self._want()
        with self._lock:
            if self._latest_frame is None:
                return None
            if self._encoded_counter == self._frame_counter and self._latest_jpeg is not None:
                return self._latest_jpeg
            frame = self._latest_frame
            counter = self._frame_counter
        try:
            buf = io.BytesIO()
            frame.to_image().save(buf, format="JPEG", quality=self._quality, optimize=False)
            jpeg = buf.getvalue()
        except Exception as e:  # noqa: BLE001
            log.debug("jpeg encode failed: %s", e)
            return None
        with self._lock:
            if counter >= self._encoded_counter:
                self._latest_jpeg = jpeg
                self._encoded_counter = counter
        return jpeg

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._codec = None
            self._latest_frame = None
            self._latest_jpeg = None
        if self._session.on_video == self._on_video:
            self._session.on_video = None
