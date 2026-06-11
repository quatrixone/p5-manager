"""Runtime monkey-patches for the archived pyremoteplay 0.7.6 library.

pyremoteplay was archived upstream on Nov 25, 2025 and has several bugs
that affect every consumer. We can't push a PR (repo is read-only), and we
don't want to fork + maintain a whole package, so we patch the relevant
methods at import time. Call `apply()` once before any pyremoteplay code
runs (top of sidecar startup).

Each patch is documented with:
  - the file/method affected upstream,
  - what the bug is,
  - what we change.

If a future version of pyremoteplay ships with the bug fixed we'll just
no-op (the patch detects the broken predicate before replacing).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

log = logging.getLogger("rp-sidecar.patches")

_APPLIED = False


def apply() -> None:
    """Apply every patch. Idempotent."""
    global _APPLIED
    if _APPLIED:
        return

    try:
        from pyremoteplay.session import Session  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("pyremoteplay not importable - skipping patches: %s", e)
        return

    _patch_session_wait(Session)
    _patch_session_standby(Session)
    _patch_session_async_standby(Session)
    _patch_session_ctrl_handshake(Session)
    # NOTE: `_patch_feedback_event_pack` was removed - see note at the
    # bottom of this file. Forcing chiaki's 2-byte system-button format
    # regressed OPTIONS/SHARE/PS/L3/R3 on real PS5 sessions, even though
    # it's byte-for-byte what chiaki-ng emits. The PS5 firmware
    # apparently tolerates pyremoteplay's native 3-byte form for every
    # system button, so we leave the upstream byte layout alone and only
    # add the missing surface events around touchpad clicks.
    _patch_feedback_state_controller_kind()
    _patch_controller_touchpad_click()
    _patch_controller_shake()
    _patch_controller_state_heartbeat()
    _patch_send_event_hexdump()

    _APPLIED = True
    log.info("pyremoteplay runtime patches applied")


# ─── FeedbackState controller-kind flag (PS5 → DualSense, PS4 → DS4) ───────
#
# pyremoteplay's `FeedbackState.pack` appends a 3-byte tail on every PS5
# session: `00 00 01`. The trailing byte is a "controller kind" flag where
# 0 = DualSense, 1 = DualShock 4 (per the upstream comment
# `# 1 DS4; 0 DualSense` in pyremoteplay/stream_packets.py around L944).
# Upstream hard-codes `1` (DS4) for every PS5 session, which makes the
# PS5 firmware route the controller input through its DS4-compat shim
# instead of the native DualSense path.
#
# We want the actual hardware-matched kind:
#   * PS5 host  → DualSense (0)
#   * PS4 host  → DualShock 4 (no tail at all - upstream already does this)
#
# The PS4 case needs no change: pyremoteplay only writes the tail when
# `host_type == TYPE_PS5`. The PS5 case needs the trailing byte flipped
# from `1` to `0`. We surgically rewrite the pack() method instead of
# duplicating it.

def _patch_feedback_state_controller_kind() -> None:
    try:
        from struct import pack_into  # noqa: WPS433
        from pyremoteplay.stream_packets import FeedbackState  # noqa: WPS433
        from pyremoteplay.const import TYPE_PS5  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("FeedbackState/TYPE_PS5 not importable - kind patch skipped: %s", e)
        return

    motion_length = getattr(FeedbackState, "_MOTION_LENGTH", 17)
    motion_idle = getattr(FeedbackState, "_MOTION_IDLE", None)
    if motion_idle is None:
        log.warning("FeedbackState._MOTION_IDLE missing - kind patch skipped")
        return

    def patched_pack(self, buf: bytearray) -> None:
        """Pack motion + sticks + (PS5 only) controller-kind tail = DS4."""
        # When a sidecar caller (see Controller.shake() patch) flips the
        # `_p5m_burst` flag on the active ControllerState, encode the real
        # motion sub-state via the (already-implemented but never-called)
        # `_pack_motion_state` helper so accelerometer / gyro waveforms
        # actually fly. Default = idle blob — same byte-for-byte behaviour
        # the upstream library produces, so heartbeat ticks for stationary
        # controllers stay indistinguishable from a real DualSense at rest.
        if getattr(self.state, "_p5m_burst", False):
            try:
                motion_bytes = self._pack_motion_state()
            except Exception:  # noqa: BLE001
                motion_bytes = motion_idle
        else:
            motion_bytes = motion_idle
        pack_into(
            f"!{motion_length}shhhh",
            buf,
            12,  # FeedbackHeader.LENGTH; chiaki & pyremoteplay agree on 12
            motion_bytes,
            self.state.left.x,
            self.state.left.y,
            self.state.right.x,
            self.state.right.y,
        )
        if self.host_type == TYPE_PS5:
            # tail = (0x0000, 0x01). Last byte: 0 = DualSense, 1 = DS4.
            # pyremoteplay only emits motion-idle + sticks state (no haptics,
            # no adaptive triggers, no DualSense-specific button slots), so
            # the PS5 firmware needs to route our input through the DS4
            # compat shim or it ends up filtering events out as "incomplete
            # DualSense state". DS4 is therefore the only mode that gives
            # us full button compatibility on PS5 - including PS4 BC titles.
            pack_into(
                "!hB",
                buf,
                FeedbackState.LENGTH - 3,
                0,
                1,
            )

    FeedbackState.pack = patched_pack
    log.info(
        "patched FeedbackState.pack (controller kind: PS5→DS4 compat, PS4→DS4 implicit)"
    )


# ─── Controller.touchpad_click + button() interceptor ──────────────────────
#
# Physical DS4 / DualSense controllers can only register a touchpad CLICK
# while at least one finger is touching the touchpad surface. The Remote
# Play firmware on modern PS5 (and PS4) preserves that invariant - a bare
# `0x80 0xB1` button event without a preceding "finger down" touchpad
# surface event is dropped as an impossible state.
#
# chiaki-ng's feedback_sender_record_history (lib/src/feedbacksender.c)
# always emits the touchpad surface events FIRST (0xD0 = finger down,
# 0xC0 = finger up) and the click button second, on the same history
# buffer. pyremoteplay never emits any surface event at all because its
# Controller API has no `set_touch` method.
#
# We add `Controller.touchpad_click(duration_ms, x, y)` that emits the
# full chiaki-compatible sequence:
#
#   1. surface DOWN  (0xD0 + finger id + 12-bit x/y)   →  finger touches
#   2. button PRESS  (0x80 0xB1)                       →  click goes down
#   3. ... hold for `duration_ms` ...
#   4. button RELEASE(0x80 0x91)                       →  click goes up
#   5. surface UP    (0xC0 + finger id + 12-bit x/y)   →  finger lifts
#
# The default touch point is the center of the DS4 touchpad (1920×942,
# so 960×471), which avoids any side-swipe gesture interpretation by the
# console. We also wrap `Controller.button(name="touchpad", ...)` to call
# `touchpad_click` so the existing sidecar code path (and any future
# input scripts that say `touchpad`) gets the corrected behaviour for
# free.

_TOUCHPAD_DEFAULT_X = 960
_TOUCHPAD_DEFAULT_Y = 471
_TOUCHPAD_DEFAULT_HOLD_MS = 120


def _pack_touchpad_surface_event(down: bool, pointer_id: int, x: int, y: int) -> bytes:
    """Match chiaki_feedback_history_event_set_touchpad byte-for-byte."""
    prefix = 0xD0 if down else 0xC0
    pid = pointer_id & 0x7F
    x &= 0x0FFF
    y &= 0x0FFF
    b2 = (x >> 4) & 0xFF
    b3 = (((x & 0x0F) << 4) | ((y >> 8) & 0x0F)) & 0xFF
    b4 = y & 0xFF
    return bytes((prefix, pid, b2, b3, b4))


def _patch_controller_touchpad_click() -> None:
    """Inject touchpad surface events around the click and expose touchpad_click()."""
    try:
        import time as _time  # noqa: WPS433
        from pyremoteplay.controller import Controller  # noqa: WPS433
        from pyremoteplay.stream_packets import FeedbackEvent  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("touchpad_click patch skipped: %s", e)
        return

    original_button = Controller.button

    def _push_raw_event(controller, data: bytes) -> None:
        """Push a pre-formatted raw event onto the controller buffer."""
        controller._event_buf.appendleft(data)

    def _send_now(controller) -> None:
        controller._send_event()

    def _next_pointer_id(controller) -> int:
        # 7-bit id, monotonic per session. Stored on the controller so we
        # never reuse the previous click's id (the PS5 would dedupe it).
        pid = getattr(controller, "_touch_pointer_id", 0)
        controller._touch_pointer_id = (pid + 1) & 0x7F
        return pid

    def touchpad_press(
        self,
        x: int = _TOUCHPAD_DEFAULT_X,
        y: int = _TOUCHPAD_DEFAULT_Y,
    ):
        """Finger-down + click-press in one feedback packet."""
        if not self._check_session():
            return None
        pid = _next_pointer_id(self)
        # Remember which pointer id is currently "down" so the matching
        # release can use the SAME id (otherwise the PS5 sees two
        # different fingers and ignores the click).
        self._touchpad_pid_active = pid
        self._touchpad_xy = (x, y)
        down = _pack_touchpad_surface_event(True, pid, x, y)
        _push_raw_event(self, down)
        self._add_event_buffer(FeedbackEvent(FeedbackEvent.Type.TOUCHPAD, is_active=True))
        _send_now(self)
        return FeedbackEvent.Type.TOUCHPAD, Controller.ButtonAction.PRESS

    def touchpad_release(self):
        """Click-release + finger-up in one feedback packet."""
        if not self._check_session():
            return None
        pid = getattr(self, "_touchpad_pid_active", 0)
        x, y = getattr(self, "_touchpad_xy", (_TOUCHPAD_DEFAULT_X, _TOUCHPAD_DEFAULT_Y))
        up = _pack_touchpad_surface_event(False, pid, x, y)
        self._add_event_buffer(FeedbackEvent(FeedbackEvent.Type.TOUCHPAD, is_active=False))
        _push_raw_event(self, up)
        _send_now(self)
        return FeedbackEvent.Type.TOUCHPAD, Controller.ButtonAction.RELEASE

    def touchpad_click(
        self,
        duration_ms: int = _TOUCHPAD_DEFAULT_HOLD_MS,
        x: int = _TOUCHPAD_DEFAULT_X,
        y: int = _TOUCHPAD_DEFAULT_Y,
    ):
        """Full chiaki touchpad-click sequence with configurable hold."""
        touchpad_press(self, x=x, y=y)
        _time.sleep(max(0.02, duration_ms / 1000.0))
        return touchpad_release(self)

    # ── Surface-only variants (no TOUCHPAD click button) ──────────────
    #
    # PS2 Classics on PS5 (and a few stock PS5 titles that rely on the
    # DualShock 4 backwards-compat input path) treat the touchpad button
    # 0x80 0xB1 / 0x91 as a separate "menu" trigger, distinct from a
    # finger touching the surface. Their zone-mapped inputs (Select
    # ≈ left half, Start ≈ right half) listen exclusively for the
    # surface-down event 0xD0 + xy, NOT the click button.
    #
    # chiaki-ng matches the same split: `HandleMouseMoveEvent` with
    # the left mouse button (i.e. the gesture/drag path) calls
    # `chiaki_controller_state_start_touch` and never sets the
    # CHIAKI_CONTROLLER_BUTTON_TOUCHPAD bit. The touchpad button is
    # only set on right-/middle-mouse press inside
    # `HandleMousePressEvent`. So gestures and zone taps emit surface
    # events without a click; the click is a separate explicit user
    # action.
    #
    # We expose surface-only press / release / tap so the sidecar can
    # pick the right variant per call: zone-targeted taps go through
    # surface-only, anything claiming "press the touchpad button"
    # keeps the existing click path.
    def touchpad_surface_press(
        self,
        x: int = _TOUCHPAD_DEFAULT_X,
        y: int = _TOUCHPAD_DEFAULT_Y,
    ):
        """Surface finger-down ONLY (no 0x80 0xB1 click button)."""
        if not self._check_session():
            return None
        pid = _next_pointer_id(self)
        self._touchpad_pid_active = pid
        self._touchpad_xy = (x, y)
        down = _pack_touchpad_surface_event(True, pid, x, y)
        _push_raw_event(self, down)
        _send_now(self)
        return FeedbackEvent.Type.TOUCHPAD, Controller.ButtonAction.PRESS

    def touchpad_surface_release(self):
        """Surface finger-up ONLY (no 0x80 0x91 click release)."""
        if not self._check_session():
            return None
        pid = getattr(self, "_touchpad_pid_active", 0)
        x, y = getattr(self, "_touchpad_xy", (_TOUCHPAD_DEFAULT_X, _TOUCHPAD_DEFAULT_Y))
        up = _pack_touchpad_surface_event(False, pid, x, y)
        _push_raw_event(self, up)
        _send_now(self)
        return FeedbackEvent.Type.TOUCHPAD, Controller.ButtonAction.RELEASE

    def touchpad_surface_tap(
        self,
        duration_ms: int = _TOUCHPAD_DEFAULT_HOLD_MS,
        x: int = _TOUCHPAD_DEFAULT_X,
        y: int = _TOUCHPAD_DEFAULT_Y,
    ):
        """Surface-only finger DOWN → hold → UP at the given coordinates.

        Mirrors chiaki's `start_touch` … `stop_touch` gesture without
        ever setting CHIAKI_CONTROLLER_BUTTON_TOUCHPAD. This is the
        sequence PS2 Classics actually listens to for Select / Start
        zone taps - 0xD0 finger-down at x≈400/x≈1500 followed by 0xC0
        finger-up some ms later. No 0x80 0xB1/0x91 anywhere in the
        wire bytes.
        """
        touchpad_surface_press(self, x=x, y=y)
        _time.sleep(max(0.02, duration_ms / 1000.0))
        return touchpad_surface_release(self)

    def patched_button(self, name, action="tap", delay=0.1):
        """Route touchpad through the surface-aware sequence; everything else unchanged."""
        is_touchpad = False
        try:
            if isinstance(name, str) and name.lower() == "touchpad":
                is_touchpad = True
            elif isinstance(name, FeedbackEvent.Type) and name == FeedbackEvent.Type.TOUCHPAD:
                is_touchpad = True
        except Exception:  # noqa: BLE001
            pass

        if not is_touchpad:
            return original_button(self, name, action, delay)

        action_str = action.lower() if isinstance(action, str) else None
        try:
            if isinstance(action, Controller.ButtonAction):
                action_str = action.name.lower()
        except Exception:  # noqa: BLE001
            pass

        if action_str == "press":
            return touchpad_press(self)
        if action_str == "release":
            return touchpad_release(self)
        # tap (or anything else)
        duration_ms = int(max(0.02, delay) * 1000)
        return touchpad_click(self, duration_ms=duration_ms)

    Controller.touchpad_press = touchpad_press
    Controller.touchpad_release = touchpad_release
    Controller.touchpad_click = touchpad_click
    Controller.touchpad_surface_press = touchpad_surface_press
    Controller.touchpad_surface_release = touchpad_surface_release
    Controller.touchpad_surface_tap = touchpad_surface_tap
    Controller.button = patched_button
    log.info(
        "patched Controller.button + added touchpad_press/release/click "
        "(emits 0xD0 surface-down + 0x80 0xB1 click; 0x80 0x91 release + 0xC0 surface-up) "
        "+ surface-only variants touchpad_surface_press/release/tap (no click button)"
    )


# ─── Controller.shake() — motion-burst on demand ───────────────────────────
#
# DualSense and DualShock 4 controllers stream accelerometer + gyro samples
# inside every `FeedbackState` packet. Games (Death Stranding "shake to
# clean BB", Resogun "shake to bomb", PS2 Classics that read motion, etc.)
# look for a sustained spike on the accel axes. pyremoteplay never wires
# the motion sub-state into `FeedbackState.pack()` — it hard-codes
# `_MOTION_IDLE` — so motion-driven game features are unreachable from
# Remote Play.
#
# Our `_patch_feedback_state_controller_kind` already swaps to the real
# `_pack_motion_state()` encoder when `state._p5m_burst` is True. This
# patch adds `Controller.shake(duration_ms, intensity)` which:
#
#   1. mutates `state.motion.accel.x/y/z` and `state.motion.gyro.x/y/z`
#      through a short sinusoidal envelope (so the PS5 sees a real
#      acceleration spike, not a constant offset),
#   2. flips `state._p5m_burst = True` so the heartbeat worker's
#      `FeedbackState` packets carry the modulated motion bytes,
#   3. resets everything to rest (accel.y = +1g gravity, gyro = 0) and
#      clears the burst flag when the duration elapses.
#
# Runs the animation in a background daemon thread so the FastAPI request
# returns immediately (the call is one-shot, like touchpad_click). The
# heartbeat worker already ticks at ~5 Hz / on every history event, so
# during a 700 ms shake the PS5 receives ≥4 motion-carrying state packets
# - enough for any motion-listening title to register the spike.

_SHAKE_DEFAULT_MS = 700
_SHAKE_DEFAULT_INTENSITY = 0.85  # 0..1, scaled against state.motion.accel.max()
_SHAKE_FREQ_HZ = 5.5              # rough frequency of the human-scale shake
_SHAKE_TICK_MS = 25               # animation resolution


def _patch_controller_shake() -> None:
    try:
        import math
        import threading
        from pyremoteplay.controller import Controller  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("Controller.shake patch skipped: %s", e)
        return

    def _drive_shake(controller, duration_ms: int, intensity: float) -> None:
        """Animate motion sub-state then restore rest.

        Runs on a daemon thread; the heartbeat worker (see
        `_patch_controller_state_heartbeat`) sends the FeedbackState
        packets that carry our motion bytes to the PS5.
        """
        # IMPORTANT: pyremoteplay's Controller exposes the live state
        # via `stick_state` (alias for `_stick_state`) — there is NO
        # `controller.state` attribute. `Controller.update_sticks` sends
        # `FeedbackState(state=self.stick_state, ...)` on every worker
        # tick, so this IS the object whose motion bytes hit the wire.
        # An earlier version of this patch wrote to `controller.state`
        # which silently no-op'd (None), so motion never modulated and
        # the PS5 saw an idle controller.
        state = getattr(controller, "stick_state", None)
        if state is None:
            state = getattr(controller, "_stick_state", None)
        if state is None or getattr(state, "motion", None) is None:
            return
        motion = state.motion
        try:
            accel_max = float(motion.accel.max())
        except Exception:  # noqa: BLE001
            accel_max = 5.0
        try:
            gyro_max = float(motion.gyro.max())
        except Exception:  # noqa: BLE001
            gyro_max = 5.0

        clamp = max(0.0, min(1.0, float(intensity)))
        # Pull peak amplitude just below the encoder ceiling so the
        # uint16-quantization head-room stays clean — running right at
        # `max()` rolls over to 0xFFFF which the PS5 also treats as
        # "saturated, ignore this sample".
        accel_amp = accel_max * 0.85 * clamp
        gyro_amp = gyro_max * 0.65 * clamp

        # Save the rest pose so we can restore exactly what the caller
        # had configured (most callers leave the default
        # accel = (0, +1, 0) i.e. gravity along the vertical axis).
        try:
            rest = (
                (motion.accel.x, motion.accel.y, motion.accel.z),
                (motion.gyro.x, motion.gyro.y, motion.gyro.z),
            )
        except Exception:  # noqa: BLE001
            rest = ((0.0, 1.0, 0.0), (0.0, 0.0, 0.0))

        state._p5m_burst = True
        t0 = time.monotonic()
        end = t0 + max(0.05, duration_ms / 1000.0)
        try:
            while True:
                now = time.monotonic()
                if now >= end:
                    break
                t = now - t0
                envelope = math.sin(math.pi * t / max(0.05, duration_ms / 1000.0))
                wave = math.sin(2.0 * math.pi * _SHAKE_FREQ_HZ * t)
                # Lateral shake: alternating X with a tiny Z wobble so the
                # 3D vector actually rotates a bit (matches a real hand
                # snapping the controller side-to-side).
                ax = accel_amp * envelope * wave
                az = accel_amp * envelope * wave * 0.35
                # Keep gravity on Y so the orientation estimator on the
                # PS5 doesn't think the controller is in free-fall — only
                # the lateral component is what games key off for "shake".
                ay = rest[0][1]
                gx = gyro_amp * envelope * wave * 0.4
                gy = gyro_amp * envelope * (1.0 - wave) * 0.4
                gz = gyro_amp * envelope * wave * 0.6
                try:
                    motion.accel.x = ax
                    motion.accel.y = ay
                    motion.accel.z = az
                    motion.gyro.x = gx
                    motion.gyro.y = gy
                    motion.gyro.z = gz
                except Exception:  # noqa: BLE001
                    break
                # Nudge the heartbeat worker if it's installed — that
                # patch exposes `_should_send` (asyncio.Event-like). If
                # not present we simply rely on the 200 ms heartbeat tick.
                try:
                    ev = getattr(controller, "_should_send", None)
                    if ev is not None and hasattr(ev, "set"):
                        ev.set()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(_SHAKE_TICK_MS / 1000.0)
        finally:
            try:
                motion.accel.x, motion.accel.y, motion.accel.z = rest[0]
                motion.gyro.x, motion.gyro.y, motion.gyro.z = rest[1]
            except Exception:  # noqa: BLE001
                pass
            state._p5m_burst = False

    def shake(self, duration_ms: int = _SHAKE_DEFAULT_MS,
              intensity: float = _SHAKE_DEFAULT_INTENSITY) -> None:
        """Fire a one-shot DualSense / DualShock-4 shake gesture.

        Non-blocking — the animation runs on a daemon thread so the
        sidecar's HTTP handler can return immediately. Multiple concurrent
        calls overwrite each other (last writer wins for the motion
        sub-state); that's acceptable because a shake event is inherently
        a single user-intent action.
        """
        t = threading.Thread(
            target=_drive_shake,
            args=(self, int(duration_ms), float(intensity)),
            name="p5m-shake",
            daemon=True,
        )
        t.start()

    Controller.shake = shake
    log.info(
        "patched Controller.shake (motion burst: %d ms default, %.0f%% intensity, %.1f Hz)",
        _SHAKE_DEFAULT_MS,
        _SHAKE_DEFAULT_INTENSITY * 100.0,
        _SHAKE_FREQ_HZ,
    )


# ─── Controller state heartbeat (chiaki-ng parity) ─────────────────────────
#
# Symptom we're chasing: button events (CROSS/X most visibly, but the
# whole DS4 set in general) emit the correct wire bytes to the PS5 — the
# diagnostic hexdump patch below confirms `0x80 0x88 0xFF` for X press
# byte-for-byte identical to chiaki-ng — yet games inside the PS5
# routinely fail to register them. PS2 Classics is the loudest failure
# mode but stock PS5 titles also miss the occasional first input after a
# session start. The user observed the same setup works fine in
# chiaki-ng (Enter on the keyboard maps to CROSS and lands every time).
#
# Root cause analysis
# -------------------
#   * pyremoteplay sends a `FeedbackState` packet ONLY when one of the
#     analog sticks moves. `Controller.update_sticks` short-circuits on
#     `stick_state == _last_state` and returns without sending.
#   * The producer of `FeedbackState` packets is the controller's
#     worker thread (`Controller.__worker` → `update_sticks`). That
#     worker is started by `Controller.start()`, but `start()` is
#     called only by the upstream GUI (`pyremoteplay/gui/workers.py`)
#     and CLI (`pyremoteplay/__main__.py`). The library path that
#     sidecars use - `create_session()` + `device.controller.button()`
#     - never starts the worker, so `FeedbackState` packets never fly
#     for the entire lifetime of the session. All button input flows
#     through `FeedbackHistory` packets only.
#   * chiaki-ng's `feedback_sender_thread_func`
#     (`lib/src/feedbacksender.c`) does the opposite: it sends a fresh
#     `FeedbackState` packet every `FEEDBACK_STATE_TIMEOUT_MAX_MS`
#     (200 ms) regardless of whether anything changed, and on any
#     controller-state change it sends ONE state packet on top of the
#     history packet for the same tick.
#
# Working hypothesis (consistent with every observed symptom and with
# the protocol traces): the PS5 firmware drives its input pipeline off
# the `FeedbackState` cadence — each state packet acts as a "tick"
# that drains queued `FeedbackHistory` events and forwards them to the
# running title. Without a heartbeat the events accumulate on the
# PS5 side, the input pipeline never ticks, and games see no
# input even though our bytes are perfect.
#
# Fix
# ---
# We make pyremoteplay's Controller behave like chiaki-ng's
# feedback sender in three small wraps:
#
#   1. `Controller.connect(session)` auto-starts the worker thread
#      after the session is attached, so the heartbeat begins at t=0.
#   2. `Controller.update_sticks()` becomes unconditional - it always
#      sends a `FeedbackState` packet on every worker tick, even if
#      the sticks are idle. Mirrors chiaki's timer-driven send.
#   3. `Controller._send_event()` (history packet emit) immediately
#      nudges the worker via the existing `_should_send` semaphore.
#      The next worker iteration runs within a couple of ms, so each
#      button history packet is followed by a fresh state packet -
#      exactly chiaki's `controller_state_changed` → state send path.

def _patch_controller_state_heartbeat() -> None:
    try:
        from pyremoteplay.controller import Controller  # noqa: WPS433
        from pyremoteplay.stream_packets import FeedbackHeader  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("controller state heartbeat patch skipped: %s", e)
        return

    original_connect = Controller.connect
    original_send_event = Controller._send_event

    def patched_connect(self, session):
        result = original_connect(self, session)
        # Auto-start the worker. Upstream only starts it from the GUI /
        # CLI front-ends; in the library/sidecar path nobody does, so
        # no FeedbackState heartbeat ever flies. See module docstring.
        try:
            if self._thread is None and self._session is not None:
                self.start()
        except Exception as e:  # noqa: BLE001
            log.debug("auto-start controller worker failed: %s", e)
        return result

    def patched_update_sticks(self):
        """Unconditional FeedbackState send (chiaki heartbeat parity)."""
        if not self._check_session():
            return
        # Update the dedupe snapshot so the downstream packet handler
        # (and any future upstream change-detection logic) still sees
        # the latest stick values; we just stop using it as a gate.
        self._last_state.left = self.stick_state.left
        self._last_state.right = self.stick_state.right
        try:
            self._session.stream.send_feedback(
                FeedbackHeader.Type.STATE,
                self._sequence_state,
                state=self.stick_state,
            )
            self._sequence_state += 1
        except Exception as e:  # noqa: BLE001
            log.debug("FeedbackState heartbeat send failed: %s", e)

    def patched_send_event(self):
        # Emit the history packet through any wrapper chain already in
        # place (the diagnostic hexdump patch wraps this method too).
        original_send_event(self)
        # Then nudge the worker so a FeedbackState packet follows the
        # FeedbackHistory packet within a few ms. Mirrors chiaki's
        # `controller_state_changed → state send` immediate path. The
        # semaphore is a `threading.Semaphore()` - a release() while
        # nobody is waiting just increments the count, so the next
        # acquire() in the worker returns immediately. Harmless if the
        # worker hasn't been started yet (e.g. patches were applied
        # but `connect()` hasn't run).
        try:
            self._should_send.release()
        except Exception:  # noqa: BLE001
            pass

    Controller.connect = patched_connect
    Controller.update_sticks = patched_update_sticks
    Controller._send_event = patched_send_event
    log.info(
        "patched Controller for chiaki-ng heartbeat parity: "
        "auto-start worker on connect, unconditional 200ms FeedbackState ticks, "
        "post-event state nudge via _should_send"
    )


# ─── Controller._send_event hexdump (diagnostic only) ──────────────────────
#
# Logs the raw bytes that go out on the feedback channel every time a
# button changes state. Lets us verify on a live session that the
# 2-byte system-button format actually reaches the wire, and gives us a
# trace we can compare against chiaki-ng if the touchpad still misbehaves.
#
# The log line is INFO-level and only fires when something interesting
# happens (button events) so it doesn't spam.

def _patch_send_event_hexdump() -> None:
    try:
        from pyremoteplay.controller import Controller  # noqa: WPS433
        from pyremoteplay.stream_packets import FeedbackHeader  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("send_event hexdump patch skipped: %s", e)
        return

    original = Controller._send_event

    def patched_send_event(self) -> None:
        try:
            data = b"".join(self._event_buf)
            if data:
                log.info(
                    "feedback_event seq=%d data=%s",
                    getattr(self, "_sequence_event", -1),
                    data.hex(" "),
                )
        except Exception:  # noqa: BLE001
            pass
        return original(self)

    Controller._send_event = patched_send_event
    log.info("patched Controller._send_event (diagnostic hexdump enabled)")


# ─── FeedbackEvent.pack DS4-history-event format fix ───────────────────────
#
# pyremoteplay always packs every feedback event as 3 bytes:
#   [PREFIX(0x80)] [button_id] [state(0x00 / 0xFF)]
# and the Controller event buffer concatenates them.
#
# This is wrong for the "system" buttons (OPTIONS, SHARE, PS, L3, R3,
# TOUCHPAD). On a real DualShock 4 RP session — and chiaki-ng confirms this
# byte-for-byte (`lib/src/feedback.c::chiaki_feedback_history_event_set_button`)
# — these buttons use a 2-byte event where the state is already encoded in
# the +32 id shift:
#       press   →  0x80 0xB1     (TOUCHPAD)
#       release →  0x80 0x91
#
# By writing 3 bytes pyremoteplay appends a stray `0xFF` (press) or `0x00`
# (release) immediately after a 2-byte event. The PS5 parser walks the
# history buffer one event at a time using the first byte as the event-kind
# prefix; the stray byte therefore becomes a "start of next event" with an
# invalid prefix. The PS5 silently tolerates the corruption for OPTIONS /
# SHARE / PS / L3 / R3 (those happen to be sent in isolation often enough
# that the bad trailing byte just terminates the frame), but the TOUCHPAD
# click is *also* the start of the touchpad surface event range (0xC0/0xD0)
# so the trailing 0xFF/0x00 collides with the surface-event grammar and the
# entire click is dropped. This is why every other system button works in
# pyremoteplay and TOUCHPAD does not — same bug, different symptoms.
#
# The fix is to match chiaki-ng exactly: 2 bytes for the short-format
# buttons, 3 bytes for everything else, *and* size the per-event slot in
# `Controller._add_event_buffer` to the correct length (otherwise the
# bytearray pre-allocation leaves the trailing byte at 0x00 again).
#
# Compatible with both PS4 (DualShock 4 session) and PS5 (PS5 sessions also
# emulate DS4 in pyremoteplay — see FeedbackState.pack tail flag `1 # DS4`).

# Button base IDs that use the chiaki 2-byte "system" history-event format.
# Source: chiaki-ng lib/src/feedback.c (cases that `return` early before
# writing event->buf[2]).
_SHORT_FORMAT_BUTTON_IDS = frozenset({
    0x8C,  # OPTIONS
    0x8D,  # SHARE
    0x8E,  # PS
    0x8F,  # L3
    0x90,  # R3
    0x91,  # TOUCHPAD
})


def _patch_feedback_event_pack() -> None:
    """Match chiaki history-event byte layout for system buttons."""
    try:
        from struct import pack_into  # noqa: WPS433
        from pyremoteplay.stream_packets import FeedbackEvent  # noqa: WPS433
        from pyremoteplay.controller import Controller  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        log.warning("FeedbackEvent/Controller not importable - pack patch skipped: %s", e)
        return

    def patched_pack(self, buf: bytearray) -> None:
        """Pack one history event in the chiaki-compatible byte layout."""
        base_id = int(self.type)
        if base_id in _SHORT_FORMAT_BUTTON_IDS:
            # State is encoded in button_id (+32 shift when active).
            pack_into("!BB", buf, 0, self.PREFIX, self.button_id)
        else:
            pack_into("!BBB", buf, 0, self.PREFIX, self.button_id, self.state)

    def patched_add_event_buffer(self, event) -> None:
        """Size the per-event slot to match chiaki's wire format."""
        base_id = int(event.type)
        length = 2 if base_id in _SHORT_FORMAT_BUTTON_IDS else 3
        buf = bytearray(length)
        event.pack(buf)
        self._event_buf.appendleft(buf)

    FeedbackEvent.pack = patched_pack
    Controller._add_event_buffer = patched_add_event_buffer
    log.info(
        "patched FeedbackEvent.pack + Controller._add_event_buffer "
        "(2-byte system-button events: OPTIONS/SHARE/PS/L3/R3/TOUCHPAD)"
    )


# ─── Session.wait / standby / async_standby ────────────────────────────────
#
# All three upstream methods share the same inverted-condition bug. The loop
# guard is written as `while time.time() - start > timeout and not <state>`
# but should be `<`. As shipped the loop body never runs even once, so
# the methods return immediately - which means:
#   - wait()         returns False even on a session that *would* be ready a
#                    few ms later.
#   - standby()      sends the STANDBY message and returns before the PS5
#                    has actually transitioned, leaving the session locked
#                    on the PS5 side after disconnect.
#   - async_standby  same as standby() but async.
#
# Bug reference:
#   https://raw.githubusercontent.com/ktnrg45/pyremoteplay/master/pyremoteplay/session.py
#   See `wait`, `standby`, `async_standby`. Repo archived 2025-11-25.
#
# Our fix: replace the broken method with one that uses `<` correctly. We
# also detect already-fixed builds by sniffing the source, so the patch is
# a no-op when running against a hypothetical maintained fork.

def _looks_broken(fn) -> bool:
    """Return True iff the function source contains the inverted while."""
    try:
        import inspect
        src = inspect.getsource(fn)
    except Exception:  # noqa: BLE001
        return True  # be conservative - patch anyway
    return "start > timeout" in src and "start < timeout" not in src


def _patch_session_wait(Session) -> None:
    if not _looks_broken(Session.wait):
        log.info("Session.wait already fixed - skipping")
        return

    DEFAULT_SESSION_TIMEOUT = _default_timeout(Session)

    def wait(self, timeout=DEFAULT_SESSION_TIMEOUT) -> bool:
        """Patched: block until session.is_ready or timeout. Returns
        True if the session reaches the READY state within the window."""
        start = time.time()
        while time.time() - start < timeout and not self.is_ready:
            if self.is_stopped:
                return False
            time.sleep(0.01)
        return self.is_ready

    Session.wait = wait
    log.info("patched Session.wait (inverted while condition)")


def _patch_session_standby(Session) -> None:
    if not _looks_broken(Session.standby):
        log.info("Session.standby already fixed - skipping")
        return

    def standby(self, timeout: float = 8.0) -> bool:
        """Patched: send STANDBY, wait for the session to actually stop
        before returning. The previous implementation returned immediately
        which let callers `disconnect()` mid-transition and left the PS5
        with a stale RP session record that blocked the next Start session
        for ~30 s.
        """
        self._send_standby()
        start = time.time()
        while time.time() - start < timeout and not self.is_stopped:
            time.sleep(0.01)
        return self.is_stopped

    Session.standby = standby
    log.info("patched Session.standby (inverted while + extended timeout)")


def _patch_session_async_standby(Session) -> None:
    if not _looks_broken(Session.async_standby):
        log.info("Session.async_standby already fixed - skipping")
        return

    async def async_standby(self, timeout: float = 8.0) -> bool:
        """Patched async variant - see Session.standby docstring."""
        self._send_standby()
        start = time.time()
        while time.time() - start < timeout and not self.is_stopped:
            await asyncio.sleep(0.05)
        return self.is_stopped

    Session.async_standby = async_standby
    log.info("patched Session.async_standby (inverted while + extended timeout)")


def _default_timeout(Session) -> float:
    """Best-effort lookup of DEFAULT_SESSION_TIMEOUT used by upstream."""
    try:
        from pyremoteplay.const import DEFAULT_SESSION_TIMEOUT  # noqa: WPS433
        return float(DEFAULT_SESSION_TIMEOUT)
    except Exception:  # noqa: BLE001
        return 10.0


# ─── Session._send_auth_request (ctrl handshake race) ──────────────────────
#
# pyremoteplay's `Session._connect` does:
#
#   1. GET /sie/ps5/rp/sess/init     (gets nonce, Connection: close)
#   2. _parse_init() to extract nonce
#   3. GET /sie/ps5/rp/sess/ctrl     (auth handshake)
#
# These are two SEPARATE TCP connections to PS5 port 9295. Between #1 and #3
# pyremoteplay adds *zero* delay. The PS5's Remote Play service tears down
# the init listener and re-binds for ctrl, and during that ~100-500 ms
# window the kernel returns ECONNREFUSED to anyone trying to connect. The
# `requests` library doesn't retry TCP-level connection refusals, so the
# first attempt fails immediately - and because the init exchange already
# happened, the PS5 now holds a session reservation against our registkey
# for ~60 s. The NEXT init then fails with "Another Remote Play session is
# connected to host" (the lock state), and the cycle keeps repeating.
#
# chiaki-ng works around the same race with a 10 ms wait
#   ( https://github.com/streetpea/chiaki-ng/blob/master/lib/src/session.c
#     `// PS4 doesn't always react right away, sleep a bit` )
# but 10 ms isn't always enough on PS5 (we've measured 100-500 ms). Our
# patch adds:
#   - a configurable head-start (default 0.30 s) before the ctrl request,
#   - retries on TCP-level ECONNREFUSED with backoff (PS5 may need several
#     hundred ms more after a transient bind glitch).
#
# We only apply this to the ctrl ("session") request - the init request is
# the first thing we send and a real ECONNREFUSED there means the PS5 RP
# service is genuinely down and we should fail fast.

# Tunables (overridable via env if anyone needs them later).
_CTRL_PREDELAY_S = 0.30
_CTRL_MAX_ATTEMPTS = 6
_CTRL_BACKOFF_BASE_S = 0.30
_CTRL_BACKOFF_FACTOR = 1.6
_CTRL_BACKOFF_CAP_S = 2.0


def _is_econnrefused(exc: BaseException) -> bool:
    """True iff the exception is (or wraps) a TCP-level ECONNREFUSED.

    `requests.get(...)` wraps ECONNREFUSED in
    `requests.exceptions.ConnectionError -> urllib3.exceptions.NewConnectionError`,
    which stringifies as ``Failed to establish a new connection: [Errno 111]
    Connection refused``. We match the message rather than the exception type
    so we don't have to import urllib3 internals.
    """
    if isinstance(exc, ConnectionRefusedError):
        return True
    msg = str(exc)
    return (
        "Connection refused" in msg
        or "Errno 111" in msg
        or "ECONNREFUSED" in msg.upper()
    )


def _patch_session_ctrl_handshake(Session) -> None:
    """Add a pre-delay + retry loop around the ctrl HTTP request."""
    original = getattr(Session, "_send_auth_request", None)
    if original is None:
        log.info("Session._send_auth_request missing - skipping ctrl handshake patch")
        return

    # Guard: if upstream ever adds a sleep before the ctrl request we want to
    # back off, otherwise we'll just double the delay. We sniff the source.
    try:
        import inspect
        src = inspect.getsource(original)
        if "time.sleep" in src or "asyncio.sleep" in src:
            log.info(
                "Session._send_auth_request already has a sleep - "
                "skipping ctrl handshake patch to avoid stacking delays"
            )
            return
    except Exception:  # noqa: BLE001
        pass  # be conservative - patch anyway

    def patched_send_auth_request(self, request_type, headers, stream):
        # Init request: keep upstream behaviour. A real ECONNREFUSED here
        # means the PS5 RP service is down and the caller already handles
        # that case (long quiet wait + DDP re-prime in _session_start_impl).
        if request_type != "session":
            return original(self, request_type, headers, stream)

        # ctrl request: give PS5 a head-start to re-bind port 9295 after
        # the init request closed its socket.
        time.sleep(_CTRL_PREDELAY_S)

        last_exc = None
        for attempt in range(_CTRL_MAX_ATTEMPTS):
            try:
                return original(self, request_type, headers, stream)
            except Exception as e:  # noqa: BLE001
                if not _is_econnrefused(e):
                    # 4xx / 5xx response or timeout - upstream will handle.
                    raise
                last_exc = e

            remaining = _CTRL_MAX_ATTEMPTS - attempt - 1
            if remaining <= 0:
                break
            backoff = min(
                _CTRL_BACKOFF_BASE_S * (_CTRL_BACKOFF_FACTOR ** attempt),
                _CTRL_BACKOFF_CAP_S,
            )
            log.warning(
                "ctrl handshake refused for %s (attempt %d/%d), retrying in %.2fs",
                getattr(self, "host", "?"),
                attempt + 1,
                _CTRL_MAX_ATTEMPTS,
                backoff,
            )
            time.sleep(backoff)

        assert last_exc is not None
        raise last_exc

    Session._send_auth_request = patched_send_auth_request
    log.info(
        "patched Session._send_auth_request "
        "(ctrl pre-delay %.2fs, %d attempts, ECONNREFUSED backoff)",
        _CTRL_PREDELAY_S,
        _CTRL_MAX_ATTEMPTS,
    )
