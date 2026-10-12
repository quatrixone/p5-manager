"""What the user is told when the console refuses a session.

The console answers a session request with an application reason code.
libchiaki knows a few of them; the one a PS5 sends while a system message
is waiting on its screen (after a crash) is not among them, and "Unknown
Session Request Error" tells nobody what to do about it.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chiaki_engine  # noqa: E402


def session_with(reason: str, app_reason: str = "", detail: str = ""):
    s = chiaki_engine.ChiakiSession("10.0.0.1", "r", "m", ps4=False, resolution="720p")
    s.quit_reason = reason
    s.quit_detail = detail
    s.quit_app_reason = app_reason
    return s


class QuitMessages(unittest.TestCase):
    def test_a_console_waiting_on_a_system_message_says_so(self):
        text = session_with("Unknown Session Request Error", "0x80108b26")._describe_quit()
        self.assertIn("console", text.lower())
        self.assertIn("screen", text.lower())
        self.assertNotIn("Unknown Session Request Error", text)

    def test_the_known_reasons_keep_their_own_words(self):
        self.assertIn("Another Remote Play session", session_with("Remote Play is in use", "0x80108b10")._describe_quit())
        self.assertIn("crashed", session_with("Remote Play on Console has crashed", "0x80108b15")._describe_quit())

    def test_without_a_code_the_reason_is_passed_through(self):
        self.assertEqual(session_with("Stopped")._describe_quit(), "Stopped")
        self.assertEqual(session_with("Stopped", detail="why")._describe_quit(), "Stopped: why")

    def test_the_application_reason_is_read_from_the_helper_log(self):
        s = chiaki_engine.ChiakiSession("10.0.0.1", "r", "m", ps4=False, resolution="720p")
        s._note_log("Reported Application Reason: 0x80108b26 (unknown)")
        self.assertEqual(s.quit_app_reason, "0x80108b26")
        s._note_log("something else entirely")
        self.assertEqual(s.quit_app_reason, "0x80108b26")


if __name__ == "__main__":
    unittest.main()
