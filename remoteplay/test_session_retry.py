"""A session that fails before it ever connects is tried again.

Remote Play on the console can crash; the next request then answers with a
crash or in-use reason until the console has cleared it. chiaki restarts the
session for about twenty seconds in that case, which is why reconnecting
after a crash works there. These tests hold us to the same behaviour.
"""
import asyncio
import os
import stat
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chiaki_engine  # noqa: E402


def fake_helper(tmp: Path, script: str) -> Path:
    path = tmp / "p5rp"
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(HEADER) + textwrap.dedent(script))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


HEADER = """
    import json, os, sys, time
    counter = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'attempts')
    with open(counter, 'a') as f:
        f.write('x')
    attempt = len(open(counter).read())
    say = lambda **e: (sys.stderr.write(json.dumps(e) + '\\n'), sys.stderr.flush())
"""


class SessionRetry(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="p5rp-test-"))
        self.original = chiaki_engine.find_helper

    def tearDown(self):
        chiaki_engine.find_helper = self.original

    def use(self, script: str):
        helper = fake_helper(self.tmp, script)
        chiaki_engine.find_helper = lambda: str(helper)

    def attempts(self) -> int:
        counter = self.tmp / "attempts"
        return len(counter.read_text()) if counter.exists() else 0

    def session(self):
        return chiaki_engine.ChiakiSession("10.0.0.1", "regist", "morning", ps4=False, resolution="720p")

    async def test_a_crash_before_connecting_is_tried_again(self):
        self.use("""
            if attempt == 1:
                say(event='quit', error=True, reason='Remote Play on Console has crashed')
                sys.exit(1)
            say(event='connected')
            time.sleep(30)
        """)
        session = self.session()
        try:
            await session.start(timeout=10.0)
            self.assertTrue(session.is_ready)
            self.assertEqual(self.attempts(), 2)
        finally:
            await session.close()

    async def test_a_console_that_keeps_refusing_still_reports_the_reason(self):
        self.use("""
            say(event='quit', error=True, reason='Remote Play on Console has crashed')
            sys.exit(1)
        """)
        session = self.session()
        try:
            with self.assertRaises(chiaki_engine.ChiakiError) as caught:
                await session.start(timeout=1.5)
            self.assertIn('crashed', str(caught.exception))
            self.assertGreater(self.attempts(), 1)
        finally:
            await session.close()

    async def test_in_use_is_left_to_the_quiet_wait_above(self):
        # The console holding the previous session is handled in server.py
        # with a wait the user can see; retrying here would only hide it.
        self.use("""
            say(event='quit', error=True, reason='Remote Play is in use')
            sys.exit(1)
        """)
        session = self.session()
        try:
            with self.assertRaises(chiaki_engine.ChiakiError):
                await session.start(timeout=5.0)
            self.assertEqual(self.attempts(), 1)
        finally:
            await session.close()

    async def test_a_console_waiting_on_a_system_message_is_not_asked_again(self):
        # It answers the same way however often it is asked; the user has to
        # confirm the message on the console, so say that straight away.
        self.use("""
            say(event='log', level='error', msg='Reported Application Reason: 0x80108b26 (unknown)')
            say(event='quit', error=True, reason='Unknown Session Request Error')
            sys.exit(1)
        """)
        session = self.session()
        try:
            with self.assertRaises(chiaki_engine.ChiakiError) as caught:
                await session.start(timeout=5.0)
            self.assertIn('system message', str(caught.exception))
            self.assertEqual(self.attempts(), 1)
        finally:
            await session.close()

    async def test_an_attempt_that_hangs_is_abandoned_and_tried_again(self):
        # A console whose Remote Play service is still coming up can leave
        # p5rp waiting with nothing to say. One attempt must not eat the
        # whole budget.
        self.use("""
            if attempt == 1:
                time.sleep(60)
            say(event='connected')
            time.sleep(30)
        """)
        session = self.session()
        try:
            await session.start(timeout=20.0)
            self.assertTrue(session.is_ready)
            self.assertEqual(self.attempts(), 2)
        finally:
            await session.close()

    async def test_a_console_that_never_answers_reports_the_timeout(self):
        self.use("""
            time.sleep(60)
        """)
        session = self.session()
        try:
            with self.assertRaises(chiaki_engine.ChiakiError) as caught:
                await session.start(timeout=9.0)
            self.assertIn('in time', str(caught.exception))
            self.assertGreater(self.attempts(), 1)
        finally:
            await session.close()

    async def test_a_session_that_connected_is_not_restarted_behind_our_back(self):
        self.use("""
            say(event='connected')
            time.sleep(30)
        """)
        session = self.session()
        try:
            await session.start(timeout=10.0)
            self.assertEqual(self.attempts(), 1)
        finally:
            await session.close()


if __name__ == "__main__":
    unittest.main()
