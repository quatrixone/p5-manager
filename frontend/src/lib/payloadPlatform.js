export function inferPayloadPlatform(payload) {
  const explicit = String(payload?.console_type || '').toLowerCase();
  if (explicit === 'ps4' || explicit === 'ps5') return explicit;

  const filename = String(payload?.filename || payload?.name || '').toLowerCase();
  const source = String(payload?.source_url || '').toLowerCase();
  const hints = `${filename} ${source}`;

  if (filename.endsWith('.bin')
    || /(^|[^a-z])(goldhen|mira|gold_hen|jkpatch)([^a-z]|$)/.test(hints)
    || /\b(ps4|fw9\.00|fw5\.05|fw7\.55|fw6\.72)\b/.test(hints)) return 'ps4';
  if (/ps5-payload-dev|ps5_payload|byepervisor|kstuff|backpork|p2jb|\bps5\b/.test(hints)
    || filename.endsWith('.lua')) return 'ps5';
  // The existing catalogue is PS5-first; its PS4 exceptions are the two
  // PS4-specific PIN/offline-activation payloads (normally .bin files).
  return 'ps5';
}

export function payloadMatchesPlatform(payload, mode) {
  return mode === 'all' || inferPayloadPlatform(payload) === mode;
}
