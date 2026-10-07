// A PSN account id as a person has it at hand, turned into the decimal
// number the profile stores: the number itself (what Sony's sign-in and
// lookup sites show), or the base64 form Remote Play clients such as chiaki
// ask for - the same 8 bytes, little endian. Returns null for anything else.
export function parsePsnAccountId(text) {
  const s = String(text || '').trim();
  if (/^\d{1,20}$/.test(s)) {
    const n = BigInt(s);
    return n > 0n && n <= 0xffffffffffffffffn ? n.toString() : null;
  }
  if (/^[A-Za-z0-9+/]{11}=$/.test(s)) {
    const bytes = Buffer.from(s, 'base64');
    if (bytes.length !== 8) return null;
    const n = bytes.readBigUInt64LE(0);
    return n > 0n ? n.toString() : null;
  }
  return null;
}

// The base64 form of an id given in either form: what the console's own
// tools (rp-get-pin, offact) and other Remote Play apps use. Null when the
// text is no account id.
export function psnAccountBase64(text) {
  const dec = parsePsnAccountId(text);
  if (!dec) return null;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(dec));
  return buf.toString('base64');
}
