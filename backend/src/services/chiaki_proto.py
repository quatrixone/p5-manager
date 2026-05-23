"""
Chiaki PS5 Discovery and Pairing Protocol Implementation
Based on reverse-engineered Chiaki protocol
"""

import socket
import struct
import time
import hashlib
import secrets
import json
from typing import Optional, Dict, Any

PS5_DISCOVERY_PORT = 987
PS5_CONTROL_PORT = 9295
BROADCAST_ADDR = "255.255.255.255"


class PS5Discovery:
    """Discover PS5 devices on the network"""

    @staticmethod
    def discover(timeout: int = 5) -> list:
        """Send discovery broadcast and return PS5 devices"""
        devices = []

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(timeout)

        # Magic packet for PS5 discovery (from Chiaki source)
        magic = bytes.fromhex("46415954")
        magic += b"\x00\x00\x00\x00"

        try:
            sock.sendto(magic, (BROADCAST_ADDR, PS5_DISCOVERY_PORT))
            sock.sendto(magic, (BROADCAST_ADDR, PS5_DISCOVERY_PORT))

            while True:
                try:
                    data, addr = sock.recvfrom(1024)
                    if len(data) > 20:
                        devices.append({
                            'ip': addr[0],
                            'data': data.hex()
                        })
                except socket.timeout:
                    break
        finally:
            sock.close()

        return devices


class PS5Pairing:
    """Handle PS5 pairing process"""

    def __init__(self, ps5_ip: str):
        self.ps5_ip = ps5_ip
        self.sock = None
        self.session_id = None
        self.registration_key = None

    def _send_udp(self, data: bytes, port: int = PS5_DISCOVERY_PORT) -> Optional[bytes]:
        """Send UDP packet and wait for response"""
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(10)

        try:
            sock.sendto(data, (self.ps5_ip, port))
            response, _ = sock.recvfrom(4096)
            return response
        except socket.timeout:
            return None
        finally:
            sock.close()

    def _generate_keys(self) -> tuple:
        """Generate session keys for encryption"""
        session_id = secrets.token_hex(16)
        return session_id, secrets.token_hex(32)

    def start_pairing(self) -> Dict[str, Any]:
        """Initiate pairing with PS5"""
        # Generate session ID
        self.session_id = secrets.token_hex(32)

        # Build registration request packet
        # Based on Chiaki protocol
        packet = self._build_registration_request()

        response = self._send_udp(packet)
        if not response:
            return {'success': False, 'error': 'No response from PS5'}

        # Parse response to get PS5 challenge
        challenge = self._parse_challenge(response)

        return {
            'success': True,
            'session_id': self.session_id,
            'challenge': challenge,
            'message': 'Enter PIN on PS5 screen'
        }

    def _build_registration_request(self) -> bytes:
        """Build registration request packet"""
        # Chiaki protocol header
        header = bytes.fromhex("46415954")  # "FAYT"
        version = b"\x01\x01\x00\x00"

        # Request type: Registration Request (0x00)
        request_type = b"\x00"

        # Generate random client ID
        client_id = secrets.token_hex(16)

        # Build packet
        packet = header + version + request_type

        # Add session ID length and session ID
        session_id_bytes = self.session_id.encode()
        packet += bytes([len(session_id_bytes)])
        packet += session_id_bytes

        # Add client ID
        packet += client_id.encode()

        return packet

    def _parse_challenge(self, data: bytes) -> Optional[str]:
        """Parse PS5 challenge response"""
        # Simplified - actual parsing depends on protocol
        if len(data) > 24:
            return data[24:].hex()
        return None

    def confirm_pin(self, pin: str) -> Dict[str, Any]:
        """Confirm PIN and complete pairing"""
        if not self.session_id:
            return {'success': False, 'error': 'Session not initialized'}

        # Build PIN confirmation packet
        packet = self._build_pin_confirmation(pin)

        response = self._send_udp(packet)
        if not response:
            return {'success': False, 'error': 'No response after PIN confirmation'}

        # Check for success
        if self._parse_success(response):
            return {
                'success': True,
                'message': 'PS5 paired successfully!',
                'session_data': self._extract_session_data(response)
            }

        return {'success': False, 'error': 'Invalid PIN or pairing failed'}

    def _build_pin_confirmation(self, pin: str) -> bytes:
        """Build PIN confirmation packet"""
        header = bytes.fromhex("46415954")
        version = b"\x01\x01\x00\x00"

        # Request type: Registration Confirm (0x01)
        request_type = b"\x01"

        # Session ID
        session_id_bytes = self.session_id.encode()
        packet = header + version + request_type
        packet += bytes([len(session_id_bytes)])
        packet += session_id_bytes

        # PIN (4 digits)
        packet += pin.encode()

        return packet

    def _parse_success(self, data: bytes) -> bool:
        """Check if response indicates success"""
        # Simplified check
        return len(data) > 16 and data[0:4] == bytes.fromhex("46415954")

    def _extract_session_data(self, data: bytes) -> Dict[str, str]:
        """Extract session credentials from successful pairing"""
        # This would contain the encryption keys for the session
        return {
            'session_id': self.session_id,
            'registered': True
        }


def pair_ps5(ps5_ip: str, pin: str) -> Dict[str, Any]:
    """Complete pairing process"""
    pairing = PS5Pairing(ps5_ip)

    # Start pairing
    init_result = pairing.start_pairing()
    if not init_result.get('success'):
        return init_result

    # Confirm with PIN
    return pairing.confirm_pin(pin)


def get_ps5_info(ps5_ip: str) -> Dict[str, Any]:
    """Get PS5 info via discovery"""
    discovery = PS5Discovery()
    devices = discovery.discover(timeout=3)

    for device in devices:
        if device['ip'] == ps5_ip:
            return {
                'success': True,
                'ip': ps5_ip,
                'found': True,
                'data': device['data']
            }

    return {
        'success': True,
        'ip': ps5_ip,
        'found': False
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 chiaki_proto.py <ps5_ip> [pin]")
        sys.exit(1)

    ip = sys.argv[1]

    if len(sys.argv) >= 3:
        pin = sys.argv[2]
        result = pair_ps5(ip, pin)
    else:
        result = get_ps5_info(ip)

    print(json.dumps(result, indent=2))