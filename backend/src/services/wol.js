import dgram from 'dgram';
import { log } from '../db/sqlite.js';

const WOL_PORT = 9;
const WOL_BROADCAST = '255.255.255.255';

export async function wakeOnLan(macAddress) {
  if (!macAddress) {
    throw new Error('MAC address is required');
  }

  const normalizedMac = macAddress.replace(/[:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(normalizedMac)) {
    throw new Error('Invalid MAC address format');
  }

  const macBuffer = Buffer.from(normalizedMac, 'hex');
  const magicPacket = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBuffer)]);

  return new Promise((resolve, reject) => {
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    client.on('error', (err) => {
      client.close();
      log('error', `Wake-on-LAN failed: ${err.message}`);
      reject(new Error(`Wake-on-LAN failed: ${err.message}`));
    });

    client.bind(() => {
      client.setBroadcast(true);
      client.send(magicPacket, 0, magicPacket.length, WOL_PORT, WOL_BROADCAST, (err) => {
        client.close();
        if (err) {
          log('error', `Wake-on-LAN failed: ${err.message}`);
          reject(new Error(`Wake-on-LAN failed: ${err.message}`));
        } else {
          log('info', `Wake-on-LAN sent to ${macAddress}`);
          resolve({ success: true, message: `Magic packet sent to ${macAddress}` });
        }
      });
    });
  });
}