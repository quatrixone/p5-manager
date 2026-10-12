import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Public catalog encoding, not a secret vault: distributed clients need this
// shared key to resolve download links. Never use it for credentials.
const KEY = createHash('sha256').update('p5-manager/catalog-links/v1').digest();
const PREFIX = 'p5enc:v1:';

export function encryptLink(value) {
  if (value.startsWith(PREFIX)) { decryptLink(value); return value; }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

export function decryptLink(value) {
  if (!value.startsWith(PREFIX)) return value;
  const packed = Buffer.from(value.slice(PREFIX.length), 'base64url');
  if (packed.length < 29) throw new Error('Invalid encrypted catalog link');
  const cipher = createDecipheriv('aes-256-gcm', KEY, packed.subarray(0, 12));
  cipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString('utf8');
}

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map(v => mapStrings(v, transform));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, transform)]));
  return value;
}

// Encrypt the whole string if it contains a URL (also URLs inside scripts,
// notes and nested template steps). Plain legacy catalogs remain readable.
export const encodeCatalog = value => mapStrings(value, s => /https?:\/\//i.test(s) ? encryptLink(s) : s);
export const decodeCatalog = value => mapStrings(value, decryptLink);
export const hasPlainLinks = value => /https?:\/\//i.test(JSON.stringify(value));
