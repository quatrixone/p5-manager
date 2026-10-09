#!/usr/bin/env python3
"""Send a PS4 RP payload and collect its machine-readable result over FTP."""
import argparse
import ftplib
import io
import json
import pathlib
import re
import socket
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAYLOADS = {
    "offact": (ROOT / "p5managerclient/offact-ps4/offact-ps4.bin", "/data/.p5manager-offact-ps4.log"),
    "get-pin": (ROOT / "p5managerclient/rp-get-pin-ps4/rp-get-pin-ps4.bin", "/data/.p5manager-rp-get-pin-ps4.log"),
}


def result_from_log(text):
    result = {"log": text.splitlines()}
    for key, pattern in {
        "account_id": r"^Account ID: ([A-Za-z0-9+/]{11}=)$",
        "user": r"^User: (.+)$",
        "activated": r"^Activated: (already|yes|failed)$",
    }.items():
        match = re.search(pattern, text, re.M)
        if match:
            result[key] = match[1]
    match = re.search(r"^Pin code: (\d{4}) (\d{4})$", text, re.M)
    if match:
        result["pin"] = "".join(match.groups())
    return result


def ftp_connect(ip, port):
    ftp = ftplib.FTP()
    ftp.connect(ip, port, timeout=8)
    ftp.login()
    return ftp


def run(ip, name, loader_port=None, ftp_port=2121, timeout=60):
    payload, log_path = PAYLOADS[name]
    binary = payload.read_bytes()
    # A previous log must never be mistaken for this invocation's result.
    with ftp_connect(ip, ftp_port) as ftp:
        try:
            ftp.delete(log_path)
        except ftplib.error_perm as error:
            if not str(error).startswith("550"):
                raise
    ports = [loader_port] if loader_port else [9020, 9090]
    for port in ports:
        try:
            conn = socket.create_connection((ip, port), timeout=8)
        except ConnectionRefusedError:
            continue
        with conn:
            conn.sendall(binary)
            conn.shutdown(socket.SHUT_WR)
        break
    else:
        raise RuntimeError(f"PS4 BinLoader is unavailable on {ip}, ports {ports}")
    deadline = time.monotonic() + timeout
    last_result = {"log": []}
    while time.monotonic() < deadline:
        with ftp_connect(ip, ftp_port) as ftp:
            output = io.BytesIO()
            try:
                ftp.retrbinary(f"RETR {log_path}", output.write)
            except ftplib.error_perm as error:
                if not str(error).startswith("550"):
                    raise
            text = output.getvalue().decode("utf-8", errors="replace")
        last_result = result_from_log(text)
        if name == "get-pin" and last_result.get("pin") and last_result.get("account_id"):
            return {"success": True, "loader_port": port, **last_result}
        if "Done" in text.splitlines():
            success = name == "offact" and last_result.get("activated") in ("already", "yes")
            return {"success": success, "loader_port": port, **last_result}
        time.sleep(0.5)
    return {"success": False, "error": "Payload output timed out", "loader_port": port, **last_result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", choices=PAYLOADS)
    parser.add_argument("--ip", required=True)
    parser.add_argument("--loader-port", type=int)
    parser.add_argument("--ftp-port", type=int, default=2121)
    args = parser.parse_args()
    try:
        result = run(args.ip, args.payload, args.loader_port, args.ftp_port)
    except (OSError, ftplib.Error, RuntimeError) as error:
        result = {"success": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
