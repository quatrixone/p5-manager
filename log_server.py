#!/usr/bin/env python3
import socket
import sys
import threading
from datetime import datetime

class LogServer:
    def __init__(self, ip='0.0.0.0', port=8080):
        self.ip = ip
        self.port = port
        self.running = False
        self.sock = None

    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((self.ip, self.port))
        self.sock.settimeout(1)
        self.running = True

        print(f"Log server started on {self.ip}:{self.port}")
        print("Waiting for logs from PS5...")

        while self.running:
            try:
                data, addr = self.sock.recvfrom(4096)
                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                message = data.decode('utf-8', errors='replace').rstrip('\n')
                print(f"[{timestamp}] {message}")
            except socket.timeout:
                continue
            except Exception as e:
                if self.running:
                    print(f"Error: {e}")

    def stop(self):
        self.running = False
        if self.sock:
            self.sock.close()
        print("Log server stopped")

if __name__ == "__main__":
    port = 8080
    if len(sys.argv) > 1:
        port = int(sys.argv[1])

    ip = '0.0.0.0'
    if len(sys.argv) > 2:
        ip = sys.argv[2]

    server = LogServer(ip, port)
    try:
        server.start()
    except KeyboardInterrupt:
        server.stop()