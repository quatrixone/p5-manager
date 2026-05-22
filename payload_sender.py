#!/usr/bin/env python3
import socket
import sys

def send_payload(ip, port, filepath):
    with open(filepath, 'rb') as f:
        data = f.read()

    print(f"Sending {filepath} ({len(data)} bytes) to {ip}:{port}")

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    try:
        sock.connect((ip, port))
        sock.sendall(data)
        sock.close()
        print("Payload sent successfully!")
        return True
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python payload_sender.py <ip> <port> <file>")
        print("Example: python payload_sender.py 192.168.1.100 9026 helloworld.lua")
        sys.exit(1)

    ip = sys.argv[1]
    port = int(sys.argv[2])
    filepath = sys.argv[3]

    send_payload(ip, port, filepath)