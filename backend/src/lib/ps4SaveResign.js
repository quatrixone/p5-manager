// Making a PS4 save look like this console's own.
//
// A save carries who it belongs to in sce_sys/param.sfo: the account id,
// and inside the PARAMS field an HMAC of the console's OpenPSID and the
// local user id. A save brought from another PS4 carries that console's
// values, which is why the PS5 finds it and then refuses to load it.
//
// There is no way to compute the HMAC here - it is keyed with Sony's key
// over a console id we cannot read - so it is taken from a save the target
// console made itself, which is the trick MacheteSVG (GPL-3.0) calls
// re-signing against a local save dummy. The layout of PARAMS is from its
// sfo_resigner.hpp; this is our own code.
//
//   PARAMS + 0x08  32 bytes  HMAC of the console's OpenPSID
//   PARAMS + 0x28   4 bytes  local user id
//   PARAMS + 0x2C  16 bytes  title id
//   PARAMS + 0x3C  16 bytes  the same title id again

const SFO_MAGIC = 0x46535000;
const PSID_HMAC = 0x08;
const USER_ID = 0x28;
const TITLE_ID_1 = 0x2c;
const TITLE_ID_2 = 0x3c;
const PARAMS_MIN = 0x4c;

// Where each field's bytes are in the file, by key.
export function sfoFields(buf) {
  const out = {};
  if (!buf || buf.length < 20 || buf.readUInt32LE(0) !== SFO_MAGIC) return out;
  const keys = buf.readUInt32LE(8);
  const data = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  for (let i = 0; i < count; i++) {
    const e = 20 + i * 16;
    if (e + 16 > buf.length) break;
    const keyAt = keys + buf.readUInt16LE(e);
    const length = buf.readUInt32LE(e + 4);
    const offset = data + buf.readUInt32LE(e + 12);
    if (keyAt >= buf.length || offset + length > buf.length) continue;
    const end = buf.indexOf(0, keyAt);
    out[buf.toString('utf8', keyAt, end < 0 ? buf.length : end)] = { offset, length };
  }
  return out;
}

export function hasConsoleIdentity(buf) {
  const f = sfoFields(buf);
  return !!(f.PARAMS && f.PARAMS.length >= PARAMS_MIN && f.ACCOUNT_ID);
}

// Returns `sfo` with the identity of `donor` - a param.sfo the target
// console wrote - and `titleId` as the save's title. Everything else, the
// names the console lists the save by among them, is left alone.
export function resignSfo(sfo, donor, titleId) {
  const mine = sfoFields(sfo);
  const theirs = sfoFields(donor);
  if (!mine.PARAMS || !theirs.PARAMS) throw new Error('param.sfo has no PARAMS field to re-sign');
  if (mine.PARAMS.length < PARAMS_MIN || theirs.PARAMS.length < PARAMS_MIN) throw new Error('param.sfo PARAMS field is too short');
  if (!mine.ACCOUNT_ID || !theirs.ACCOUNT_ID || mine.ACCOUNT_ID.length !== theirs.ACCOUNT_ID.length) {
    throw new Error('param.sfo has no account id to replace');
  }
  const out = Buffer.from(sfo);
  donor.copy(out, mine.ACCOUNT_ID.offset, theirs.ACCOUNT_ID.offset, theirs.ACCOUNT_ID.offset + theirs.ACCOUNT_ID.length);
  donor.copy(out, mine.PARAMS.offset + PSID_HMAC, theirs.PARAMS.offset + PSID_HMAC, theirs.PARAMS.offset + USER_ID);
  donor.copy(out, mine.PARAMS.offset + USER_ID, theirs.PARAMS.offset + USER_ID, theirs.PARAMS.offset + TITLE_ID_1);
  // The title the save is for stays ours - the donor is another game.
  for (const at of [TITLE_ID_1, TITLE_ID_2]) {
    out.fill(0, mine.PARAMS.offset + at, mine.PARAMS.offset + at + 16);
    out.write(titleId.slice(0, 15), mine.PARAMS.offset + at, 'utf8');
  }
  return out;
}
