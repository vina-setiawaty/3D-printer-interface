import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const [, , inp, out] = process.argv;
const W = 700, X0 = 110, Y0 = 163, SC = 12.5; // 56 mm view
const px = new Uint8Array(W * W * 3).fill(255);
const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= W) return; const i = (y * W + x) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; };
const line = (a, b, c, th = 1) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * SC * 2) + 1;
  for (let i = 0; i <= n; i++) { const x = (a[0] + (b[0] - a[0]) * i / n - X0) * SC, y = W - (a[1] + (b[1] - a[1]) * i / n - Y0) * SC;
    for (let dx = -th; dx <= th; dx++) for (let dy = -th; dy <= th; dy++) put(Math.round(x + dx), Math.round(y + dy), c); } };
let x = null, y = null, z = null; const dr = [];
for (const l of readFileSync(inp, "utf8").split("\n")) {
  if (!/^G[01] /.test(l)) continue;
  const m = Object.fromEntries([...l.matchAll(/([XYZE])(-?[\d.]+)/g)].map((r) => [r[1], +r[2]]));
  const nx = m.X ?? x, ny = m.Y ?? y, nz = m.Z ?? z;
  if (x != null && (m.E ?? 0) > 0 && (nx !== x || ny !== y)) line([x, y], [nx, ny], nz > 0.3 ? [200, 30, 30] : [60, 110, 200], nz > 0.3 ? 1 : 0);
  if (x != null && (m.E ?? 0) > 0 && nx === x && ny === y && /F150/.test(l)) for (let r = 0; r < 19; r++) for (let t = 0; t < 64; t++) put(Math.round((x + r / 12.5 * Math.cos(t / 10) - X0) * SC), Math.round(W - (y + r / 12.5 * Math.sin(t / 10) - Y0) * SC), [240, 170, 0]);
  if (l.startsWith("G0") && l.includes("Z0.000")) dr.push([[x, y], [nx, ny]]);
  x = nx; y = ny; z = nz;
}
for (const [a, b] of dr) line(a, b, [0, 150, 0], 1);
const raw = Buffer.alloc((W * 3 + 1) * W); for (let r = 0; r < W; r++) { raw[r * (W * 3 + 1)] = 0; Buffer.from(px.buffer, r * W * 3, W * 3).copy(raw, r * (W * 3 + 1) + 1); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
