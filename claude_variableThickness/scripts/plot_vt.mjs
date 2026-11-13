// Top-view preview of a variable-thickness G-code file: every extruding move
// is drawn at its real bead width (W = E x filament area / (L x H)) and
// shaded by its height H (light = low, dark = high). Travel is not drawn.
// Usage: node plot_vt.mjs <in.gcode> <out.png> [x0 y0 sizeMm pixels]
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [, , inp, out, ax0 = "0", ay0 = "0", asize = "220", apx = "1100"] = process.argv;
const X0 = +ax0, Y0 = +ay0, SIZE = +asize, W = +apx, SC = W / SIZE;
const FIL_AREA = Math.PI * 0.875 * 0.875, HMAX = 1.4;
const px = new Uint8Array(W * W * 3).fill(250);
const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= W) return; const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
const color = (h) => { const t = Math.max(0, Math.min(1, h / HMAX)); return [Math.round(255 - 70 * t), Math.round(232 - 150 * t), Math.round(150 - 150 * t)]; };
const disc = (x, y, r, c) => {
  const cx = (x - X0) * SC, cy = W - (y - Y0) * SC, rr = Math.max(0.6, r * SC);
  for (let dy = -Math.ceil(rr); dy <= Math.ceil(rr); dy++) for (let dx = -Math.ceil(rr); dx <= Math.ceil(rr); dx++) {
    if (dx * dx + dy * dy <= rr * rr) put(Math.round(cx + dx), Math.round(cy + dy), c);
  }
};
let x = null, y = null, z = 0;
for (const l of readFileSync(inp, "utf8").split("\n")) {
  if (!/^G[01] /.test(l)) continue;
  const m = Object.fromEntries([...l.matchAll(/([XYZE])(-?[\d.]+)/g)].map((r) => [r[1], +r[2]]));
  const nx = m.X ?? x, ny = m.Y ?? y, nz = m.Z ?? z;
  if (x != null && (m.E ?? 0) > 0 && m.X != null && nx === x && ny === y) {
    // petal dot: blob extruded in place, 3/4 of a cylinder r^2 * h
    disc(x, y, Math.sqrt((m.E * FIL_AREA) / (0.75 * Math.PI * Math.max(0.3, z))), color(z));
  } else if (x != null && l.startsWith("G0") && m.Z === 0 && (nx !== x || ny !== y)) {
    // petal drag: a thin tail falling from the blob to the bed
    const L = Math.hypot(nx - x, ny - y), n = Math.max(1, Math.ceil(L * SC));
    for (let i = 0; i <= n; i++) disc(x + ((nx - x) * i) / n, y + ((ny - y) * i) / n, 0.45 * (1 - i / n) + 0.2, color(z * (1 - i / n)));
  } else if (x != null && (m.E ?? 0) > 0 && (nx !== x || ny !== y)) {
    const L = Math.hypot(nx - x, ny - y), h = Math.max(0.05, (z + nz) / 2);
    const bw = Math.min(4, (m.E * FIL_AREA) / (L * h));
    const n = Math.max(1, Math.ceil(L * SC));
    for (let i = 0; i <= n; i++) disc(x + ((nx - x) * i) / n, y + ((ny - y) * i) / n, bw / 2, color(lerpZ(z, nz, i / n)));
  }
  x = nx; y = ny; z = nz;
}
function lerpZ(a, b, t) { return a + (b - a) * t; }
// height key along the bottom edge
for (let i = 0; i < 200; i++) for (let j = 0; j < 12; j++) put(10 + i, W - 20 + j, color((HMAX * i) / 199));
const raw = Buffer.alloc((W * 3 + 1) * W);
for (let r = 0; r < W; r++) { raw[r * (W * 3 + 1)] = 0; Buffer.from(px.buffer, r * W * 3, W * 3).copy(raw, r * (W * 3 + 1) + 1); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
