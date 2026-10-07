// What a console says about itself over DDP (on, rest mode, which family),
// asked through the Remote Play sidecar's /discover - shared by everything
// that shows a console's status, so one poll cycle sends one search.
//
// A search is one UDP packet each way, and one gets lost now and then -
// more often while the console streams a Remote Play session. A single
// unanswered search therefore does not make a console "offline": the last
// answer stands for one more miss, as long as it is recent (marked `stale`),
// and only the second miss in a row reports nothing.

const SIDECAR_URL = process.env.PYREMOTEPLAY_SIDECAR_URL
  || process.env.CHIAKI_SIDECAR_URL
  || 'http://127.0.0.1:9555';

const FRESH_MS = 6_000;      // an answer this young is reused as it is
const NO_ANSWER_MS = 3_000;  // a miss this young is not asked again
const KEEP_LAST_MS = 45_000; // how old an answer may be to stand for a miss
const MISSES_TO_OFFLINE = 2;
const TIMEOUT_MS = 3_000;    // the sidecar searches three times in 1.5 s

const state = new Map(); // ip -> { answer, answeredAt, misses, missedAt, inFlight }

function entry(ip) {
  let e = state.get(ip);
  if (!e) { e = { answer: null, answeredAt: 0, misses: 0, missedAt: 0, inFlight: null }; state.set(ip, e); }
  return e;
}

async function ask(ip, hostType) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const q = `ip=${encodeURIComponent(ip)}${hostType ? `&host_type=${encodeURIComponent(hostType)}` : ''}`;
    const r = await fetch(`${SIDECAR_URL}/discover?${q}`, { signal: controller.signal });
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    return data && typeof data === 'object' && (data.status || data.status_code) ? data : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function settle(e, now) {
  if (e.answer && now - e.answeredAt < FRESH_MS) return e.answer;
  if (e.misses > 0 && e.misses < MISSES_TO_OFFLINE && e.answer && now - e.answeredAt < KEEP_LAST_MS) {
    return { ...e.answer, stale: true };
  }
  return e.misses > 0 ? null : e.answer;
}

// The console's DDP status (the sidecar's /discover answer), or null when it
// does not answer. `hostType` ("PS5" / "PS4") is a hint for which port to
// ask first; both are asked.
export async function discoverConsole(ip, { hostType = null } = {}) {
  const e = entry(ip);
  const now = Date.now();
  if (e.answer && now - e.answeredAt < FRESH_MS) return e.answer;
  if (e.misses > 0 && now - e.missedAt < NO_ANSWER_MS) return settle(e, now);
  if (!e.inFlight) {
    e.inFlight = ask(ip, hostType).then((answer) => {
      const at = Date.now();
      if (answer) {
        e.answer = answer;
        e.answeredAt = at;
        e.misses = 0;
      } else {
        e.misses += 1;
        e.missedAt = at;
      }
      e.inFlight = null;
    });
  }
  await e.inFlight;
  return settle(e, Date.now());
}

// For tests.
export function _resetConsoleStatus() {
  state.clear();
}
