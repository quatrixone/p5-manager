"""A console that is on but whose Remote Play service is not listening.

The session request goes to TCP 9295. A PS5 that answers discovery with
"Ok" can still refuse that port - Remote Play switched off, or its service
gone after a crash. Asking again cannot help, so the check is made once and
reported in words the user can act on.
"""
import asyncio
import socket
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ddp  # noqa: E402


def a_closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class RemotePlayPort(unittest.IsolatedAsyncioTestCase):
    async def test_an_open_port_is_seen_as_open(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        try:
            self.assertTrue(await ddp.tcp_open("127.0.0.1", server.getsockname()[1], timeout=1.0))
        finally:
            server.close()

    async def test_a_closed_port_is_seen_as_closed(self):
        self.assertFalse(await ddp.tcp_open("127.0.0.1", a_closed_port(), timeout=1.0))

    async def test_a_host_that_does_not_answer_times_out_instead_of_hanging(self):
        # 198.51.100.0/24 is reserved for documentation: nothing answers.
        loop = asyncio.get_running_loop()
        started = loop.time()
        self.assertFalse(await ddp.tcp_open("198.51.100.1", 9295, timeout=0.5))
        self.assertLess(loop.time() - started, 3.0)


if __name__ == "__main__":
    unittest.main()
