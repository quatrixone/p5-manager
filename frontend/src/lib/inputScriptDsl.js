// Shared parsing for the Script Runner DSL:
//   <button> [duration_ms] [Nx]
//   wait <ms>
//   text <string>
//   // comment
//
// Used by ScriptRunner.jsx's auto "▶ Run" AND RemotePlay.jsx's step-by-step
// "Input Scripts" tab (see its "👣 Step" hand-off). Pulled out to its own
// module so the two execution paths can never silently drift apart on what
// a given line actually does - they both call parseLine() and get back the
// exact same parsed shape.

export const AVAILABLE_COMMANDS = [
  { cmd: 'left', desc: 'D-pad left' },
  { cmd: 'right', desc: 'D-pad right' },
  { cmd: 'up', desc: 'D-pad up' },
  { cmd: 'down', desc: 'D-pad down' },
  { cmd: 'x', desc: 'X button' },
  { cmd: 'cross', desc: 'Cross button' },
  { cmd: 'circle', desc: 'Circle button' },
  { cmd: 'square', desc: 'Square button' },
  { cmd: 'triangle', desc: 'Triangle button' },
  { cmd: 'ps', desc: 'PS button' },
  { cmd: 'options', desc: 'Options button' },
  { cmd: 'touchpad', desc: 'Touchpad click' },
  { cmd: 'L1', desc: 'L1 trigger' },
  { cmd: 'R1', desc: 'R1 trigger' },
  { cmd: 'L2', desc: 'L2 trigger' },
  { cmd: 'R2', desc: 'R2 trigger' },
  { cmd: 'L3', desc: 'L3 stick press' },
  { cmd: 'R3', desc: 'R3 stick press' },
  { cmd: 'wait', desc: 'Wait X ms (e.g. wait 1000)' },
  { cmd: 'text', desc: 'Type text on PS5 on-screen keyboard (e.g. text Revenge)' },
];

// Note: append "Nx" / "xN" / "*N" to any button line to repeat it N times.
//   e.g. `left 10x`  -> presses left 10 times
//   e.g. `cross 5x 120` -> 5 taps, each 120 ms long
//
// `text <string>` simulates typing on the PS5 software keyboard by walking
// the d-pad and tapping cross for each letter (a-z, space).

const OSK_KEY_COORDS = (() => {
  const map = {};
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) map[row[c]] = [c, r];
  });
  map[' '] = [3, 3];
  return map;
})();

export function buildOskInputs(text) {
  const events = [];
  let curCol = 0, curRow = 0;
  for (let i = 0; i < 4; i++) events.push({ button: 'up' });
  for (let i = 0; i < 10; i++) events.push({ button: 'left' });
  events.push({ button: 'down' });
  for (const ch0 of String(text)) {
    const ch = ch0.toLowerCase();
    const coords = OSK_KEY_COORDS[ch];
    if (!coords) continue;
    const [tc, tr] = coords;
    const dr = tr - curRow;
    const dc = tc - curCol;
    if (dr > 0) for (let i = 0; i < dr; i++) events.push({ button: 'down' });
    else if (dr < 0) for (let i = 0; i < -dr; i++) events.push({ button: 'up' });
    if (dc > 0) for (let i = 0; i < dc; i++) events.push({ button: 'right' });
    else if (dc < 0) for (let i = 0; i < -dc; i++) events.push({ button: 'left' });
    events.push({ button: 'cross', commit: true });
    curCol = tc; curRow = tr;
  }
  return events;
}

export function parseRepeatToken(tok) {
  if (!tok) return null;
  const m = /^(?:x(\d+)|(\d+)x|\*(\d+))$/i.exec(tok);
  if (!m) return null;
  const n = parseInt(m[1] || m[2] || m[3], 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : null;
}

export function parseLine(line) {
  line = line.trim();
  if (!line || line.startsWith('//') || line.startsWith('#')) return null;

  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === 'wait' || cmd === 'sleep') {
    const ms = parseInt(parts[1]) || 1000;
    return { cmd: 'wait', params: ms };
  }

  if (cmd === 'text' || cmd === 'type') {
    return { cmd: 'text', text: line.replace(/^\S+\s+/, '') };
  }

  // Case-insensitive match: `cmd` is already lowercased above, but
  // AVAILABLE_COMMANDS stores the trigger buttons as 'L1'/'R1'/'L2'/'R2'/
  // 'L3'/'R3' (uppercase, for readability in the UI). A strict `===`
  // here made every recorded L1/L2/R1/R2/L3/R3 press unparseable on
  // playback ("Unknown command") even though the backend itself treats
  // button names as case-insensitive (see remoteplay.js's
  // `button.toLowerCase()` normalisation).
  if (AVAILABLE_COMMANDS.find(c => c.cmd.toLowerCase() === cmd)) {
    // Extract optional repeat token (10x / x10 / *10) and remaining
    // params (typically a duration in ms).
    let count = 1;
    const rest = [];
    for (let i = 1; i < parts.length; i++) {
      const rep = parseRepeatToken(parts[i]);
      if (rep != null) { count = rep; continue; }
      rest.push(parts[i]);
    }
    return { cmd, params: rest.join(' '), count };
  }

  return null;
}
