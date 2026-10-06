// Control Center's bottom icon row remembers which icon was last focused
// between opens (confirmed by testing against a real PS5: open it,
// navigate, close it, reopen - the cursor is still where it was left).
// That makes a fixed "press left N times" macro unreliable for reaching
// Home: the row is also a closed loop (pressing left past Home wraps to
// Power, not stop there - also confirmed by testing), so no fixed count
// works for every starting position.
//
// Instead: grab the current video frame, find which icon is focused right
// now (it gets a wider white ring around it than the plain icons), and
// compute the shortest path from there to Home.
//
// Calibrated against a 1280x720 frame from a real session; coordinates are
// stored as fractions of width/height so they scale to any resolution at
// the same 16:9 aspect ratio. The exact icon set (order/count) is this
// console's PS5 Control Center layout - Home, Library, Notifications,
// Friends, Music (or whatever's "now playing"), Quick Menu, Volume, Mic
// mute, Controllers, Profile, Power - and may need adjusting for a
// different firmware version, region, or enabled feature set.
export const CONTROL_CENTER_SLOT_COUNT = 11;
export const CONTROL_CENTER_HOME_INDEX = 0;

const SLOT_X_FRACTIONS = [266, 341, 418, 490, 565, 639, 716, 789, 863, 938, 1013].map(x => x / 1280);
const ROW_Y0_FRACTION = 655 / 720;
const ROW_Y1_FRACTION = 700 / 720;
const BRIGHTNESS_THRESHOLD = 40;

// Returns the 0-based slot index of the currently-focused icon, or null if
// nothing looked confidently focused (e.g. Control Center isn't open, or
// the frame didn't decode). `imageData` is a canvas ImageData (RGBA).
export function detectFocusedControlCenterIcon(imageData, width, height) {
  const { data } = imageData;
  const y0 = Math.round(ROW_Y0_FRACTION * height);
  const y1 = Math.round(ROW_Y1_FRACTION * height);
  if (y1 <= y0) return null;

  const colBrightness = new Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    colBrightness[x] = sum / (y1 - y0);
  }

  const gapPx = Math.max(1, Math.round(20 * (width / 1280)));
  const runs = [];
  let start = -1;
  for (let x = 0; x < width; x++) {
    const bright = colBrightness[x] > BRIGHTNESS_THRESHOLD;
    if (bright && start === -1) start = x;
    else if (!bright && start !== -1) { runs.push([start, x - 1]); start = -1; }
  }
  if (start !== -1) runs.push([start, width - 1]);
  if (runs.length === 0) return null;

  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= gapPx) last[1] = r[1];
    else merged.push([...r]);
  }

  let widest = merged[0];
  for (const m of merged) {
    if ((m[1] - m[0]) > (widest[1] - widest[0])) widest = m;
  }
  const centerFrac = ((widest[0] + widest[1]) / 2) / width;

  let bestIdx = 0;
  let bestDist = Infinity;
  SLOT_X_FRACTIONS.forEach((frac, i) => {
    const d = Math.abs(frac - centerFrac);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  });
  return bestIdx;
}

// Shortest way from `fromIdx` to `toIdx` around a closed loop of `count`
// slots. Left presses decrement the index (mod count); right increments.
// Returns { steps, direction } - direction is 'left' or 'right'.
export function shortestPathOnRing(fromIdx, toIdx, count) {
  const stepsLeft = ((fromIdx - toIdx) % count + count) % count;
  const stepsRight = count - stepsLeft;
  return stepsRight < stepsLeft
    ? { steps: stepsRight, direction: 'right' }
    : { steps: stepsLeft, direction: 'left' };
}
