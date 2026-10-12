// The address of this P5 Manager as a QR code the phone app can read.
// Drawn as one SVG path so it stays sharp and costs nothing to render.
import qrcode from 'qrcode-generator';

export function qrSvg(text, { size = 160, margin = 2 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / (count + margin * 2);
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * cell;
      const y = (row + margin) * cell;
      path += `M${x.toFixed(2)},${y.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    }
  }
  return { path, size };
}
