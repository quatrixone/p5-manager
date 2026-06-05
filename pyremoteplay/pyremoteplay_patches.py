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

    _APPLIED = True
    log.info("pyremoteplay runtime patches applied")


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
