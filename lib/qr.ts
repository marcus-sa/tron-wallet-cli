import QRCode from "qrcode";

// QR rendering for receive addresses.
//
// The terminal output is drawn from the raw module matrix rather than
// QRCode.toString({ type: "terminal" }) because that renderer hardcodes a
// 1-module quiet zone; the spec asks for 4, and phone cameras are noticeably
// more reliable with it. Two module rows are packed into each character row
// using half blocks, so a 29x29 address QR fits in ~19 terminal lines.

const ESC = "[";
const INK = ESC + "47m" + ESC + "30m"; // black on white — scanners expect dark-on-light
const RESET = ESC + "0m";

const QUIET_ZONE = 4;

export function renderQrToTerminal(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = qr.modules.data;

  const isDark = (row: number, col: number): boolean => {
    if (row < 0 || row >= size || col < 0 || col >= size) return false; // quiet zone
    return data[row * size + col] === 1;
  };

  const first = -QUIET_ZONE;
  const last = size + QUIET_ZONE - 1;
  const lines: string[] = [];

  for (let row = first; row <= last; row += 2) {
    let line = "";
    for (let col = first; col <= last; col++) {
      const top = isDark(row, col);
      const bottom = isDark(row + 1, col);
      if (top && bottom) line += "█"; // full block
      else if (top) line += "▀"; // upper half
      else if (bottom) line += "▄"; // lower half
      else line += " ";
    }
    lines.push(INK + line + RESET);
  }

  return lines.join("\n");
}
