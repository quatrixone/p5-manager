"""Device Discovery Protocol - how a console on the LAN is found and woken.

A few lines of text over UDP: SRCH asks a console how it is (on, or in
rest mode), WAKEUP brings it out of rest mode, LAUNCH logs the account in
on a console that has just woken and shows "press the PS button". The PS5
listens on 9302 and speaks protocol version 00030010, the PS4 on 987 with
00020020 (as chiaki-ng has them); it answers to port 9303, so that is the
port we send from when it is free.

Every message goes to both: the console's own port first, then the other
one, so a console filed under the wrong family is still found and woken -
the one that is not there just never hears it.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import socket
from typing import Dict, Optional

log = logging.getLogger("rp-sidecar.ddp")

PORTS = {"PS5": 9302, "PS4": 987}
VERSIONS = {"PS5": "00030010", "PS4": "00020020"}
LOCAL_PORT = 9303
STATUS_OK = 200
STATUS_STANDBY = 620

_STATUS_LINE = re.compile(r"HTTP/1\.1 (?P<code>\d+) (?P<status>.*)")


def message(kind: str, fields: Optional[Dict[str, str]] = None, version: str = VERSIONS["PS5"]) -> bytes:
    lines = [f"{kind} * HTTP/1.1"]
    lines += [f"{k}:{v}" for k, v in (fields or {}).items()]
    lines.append(f"device-discovery-protocol-version:{version}")
    return ("\n".join(lines) + "\n").encode()


def parse(data: bytes, ip: str) -> Dict[str, object]:
    """A console's answer as a dict: status-code, status, host-type, host-id..."""
    out: Dict[str, object] = {}
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _STATUS_LINE.match(line)
        if m:
            out["status-code"] = int(m.group("code"))
            out["status"] = m.group("status").strip()
        elif ":" in line:
            key, value = line.split(":", 1)
            out[key.strip()] = value.strip()
    if out:
        out["host-ip"] = ip
    return out


def wake_credential(regist_key: str) -> str:
    """WAKEUP's user-credential: the regist key's hex digits as a number
    (chiaki-ng's SendWakeup does the same)."""
    key = regist_key.split("\x00", 1)[0]
    if not key or len(key) > 16:
        raise ValueError("the regist key is not usable for waking - pair the console again")
    return str(int(key, 16))


def launch_credential(account_id: str) -> Optional[str]:
    """LAUNCH's user-credential: sha256 of the decimal PSN account id."""
    aid = (account_id or "").strip()
    return hashlib.sha256(aid.encode()).hexdigest() if aid else None


def _socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        sock.bind(("0.0.0.0", LOCAL_PORT))
    except OSError:
        # Another program has it (a second sidecar, chiaki on the same
        # box); a PS4 answers any port, a PS5 mostly does too.
        sock.bind(("0.0.0.0", 0))
    sock.setblocking(False)
    return sock


def _families(host_type: Optional[str]):
    """Both families, the given one first."""
    ht = (host_type or "").upper()
    return [ht, "PS4" if ht == "PS5" else "PS5"] if ht in PORTS else ["PS5", "PS4"]


def send(ip: str, kind: str, fields: Optional[Dict[str, str]] = None, host_type: Optional[str] = None) -> None:
    sock = _socket()
    try:
        for family in _families(host_type):
            try:
                sock.sendto(message(kind, fields, VERSIONS[family]), (ip, PORTS[family]))
            except OSError as e:
                log.debug("ddp %s to %s:%s failed: %s", kind, ip, PORTS[family], e)
    finally:
        sock.close()


class _Answers(asyncio.DatagramProtocol):
    def __init__(self, ip: str):
        self.ip = ip
        self.found: "asyncio.Future[Dict[str, object]]" = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr) -> None:
        if addr[0] != self.ip or self.found.done():
            return
        parsed = parse(data, self.ip)
        if "status-code" in parsed:
            self.found.set_result(parsed)


async def status(ip: str, host_type: Optional[str] = None, timeout: float = 2.0,
                 tries: int = 2) -> Optional[Dict[str, object]]:
    """The console's answer to SRCH, or None when it does not answer (off, or
    asleep too deeply, or not there). The search goes out `tries` times
    within `timeout`, as one UDP packet can get lost."""
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(lambda: _Answers(ip), sock=_socket())
    try:
        for _ in range(max(1, tries)):
            for family in _families(host_type):
                try:
                    transport.sendto(message("SRCH", None, VERSIONS[family]), (ip, PORTS[family]))
                except OSError as e:
                    log.debug("ddp search to %s:%s failed: %s", ip, PORTS[family], e)
            try:
                return await asyncio.wait_for(asyncio.shield(proto.found), timeout / max(1, tries))
            except asyncio.TimeoutError:
                continue
        return None
    finally:
        transport.close()


def wakeup(ip: str, regist_key: str, host_type: Optional[str] = None) -> None:
    send(ip, "WAKEUP", {
        "client-type": "vr",
        "auth-type": "R",
        "model": "w",
        "app-type": "r",
        "user-credential": wake_credential(regist_key),
    }, host_type)


def launch(ip: str, account_id: str, host_type: Optional[str] = None) -> bool:
    cred = launch_credential(account_id)
    if not cred:
        return False
    send(ip, "LAUNCH", {
        "user-credential": cred,
        "client-type": "a",
        "auth-type": "C",
    }, host_type)
    return True
