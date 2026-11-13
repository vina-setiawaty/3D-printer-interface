// 3D preview of a stacked G-code file, seen from the front (-Y) and above.
// Every extruding move is redrawn as short columns: the top of each is the
// nozzle Z, its height is Z minus what was already printed under it (a
// 0.2 mm height field), and its width comes from the extruded volume
// (W = E x filament area / (L x H)). Petal blobs are drawn at the size their
// volume gives, drags as thin tails. Shading: colour by height (pale at the
// bed, dark at the top), side faces darker than tops, distant parts dimmer.
// Usage: node plot_3d.mjs <in.gcode> <out.png> [pixels] [elevationDeg]
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [, , inp, out, apx = "900", aelev = "32"] = process.argv;
const W = +apx, ELEV = (+aelev * Math.PI) / 180, FA = Math.PI * 0.875 ** 2;
const ce = Math.cos(ELEV), se = Math.sin(ELEV);

// ---- pass 1: primitives {x, y, z (top), h, w}
const prims = [], CELL = 0.2, field = new Map(), queue = [];
const key = (x, y) => `${Math.round(x / CELL)},${Math.round(y / CELL)}`;
const baseAt = (x, y) => field.get(key(x, y)) ?? 0;
const raise = (x, y, r, z) => {
  for (let dx = -r; dx <= r + 1e-9; dx += CELL) for (let dy = -r; dy <= r + 1e-9; dy += CELL)
    if (dx * dx + dy * dy <= r * r) { const k = key(x + dx, y + dy); if ((field.get(k) ?? 0) < z) field.set(k, z); }
};
let dist = 0;
const flush = (upto) => { while (queue.length && queue[0].d <= upto) { const q = queue.shift(); raise(q.x, q.y, q.r, q.z); } };
const add = (x, y, z, w, h) => { prims.push({ x, y, z, w, h }); queue.push({ x, y, r: w / 2, z, d: dist }); };

let x = null, y = null, z = 0;
for (const l of readFileSync(inp, "utf8").split("\n")) {
  if (!/^G[01] /.test(l)) continue;
  const m = Object.fromEntries([...l.matchAll(/([XYZE])(-?[\d.]+)/g)].map((r) => [r[1], +r[2]]));
  const nx = m.X ?? x, ny = m.Y ?? y, nz = m.Z ?? z, e = m.E ?? 0;
  if (x != null && e > 0 && m.X != null && nx === x && ny === y) {
    flush(Infinity);
    const base = baseAt(x, y), h = Math.max(0.1, z - base);
    const r = Math.min(2.5, Math.sqrt((e * FA) / (0.75 * Math.PI * h)));
    add(x, y, z, 2 * r, h); flush(Infinity);
  } else if (x != null && l.startsWith("G0") && m.X != null && m.Z != null && nz < z) {
    const L = Math.hypot(nx - x, ny - y), n = Math.max(1, Math.ceil(L / 0.15));
    for (let i = 1; i <= n; i++) { const t = i / n; add(x + (nx - x) * t, y + (ny - y) * t, z + (nz - z) * t, 0.5 * (1 - t) + 0.2, 0.3); }
    flush(Infinity);
  } else if (x != null && e > 0 && m.X != null) {
    const L = Math.hypot(nx - x, ny - y), n = Math.max(1, Math.ceil(L / 0.15));
    const area = (e * FA) / L;
    for (let i = 1; i <= n; i++) {
      const t = i / n, px = x + (nx - x) * t, py = y + (ny - y) * t, pz = z + (nz - z) * t;
      dist += L / n; flush(dist - 3);
      const h = Math.min(2, Math.max(0.08, pz - baseAt(px, py)));
      add(px, py, pz, Math.min(4, Math.max(0.25, area / h)), h);
    }
  } else if (l.startsWith("G0") && m.X != null) flush(Infinity);
  x = nx; y = ny; z = nz;
}
flush(Infinity);

// ---- pass 2: project and paint, far to near
let x0 = Infinity, x1 = -Infinity, v0 = Infinity, v1 = -Infinity, zTop = 0;
const sv = (p, zz) => zz * ce + p.y * se; // screen up
for (const p of prims) {
  x0 = Math.min(x0, p.x - p.w); x1 = Math.max(x1, p.x + p.w);
  v0 = Math.min(v0, sv(p, p.z - p.h) - p.w); v1 = Math.max(v1, sv(p, p.z) + p.w); zTop = Math.max(zTop, p.z);
}
const span = Math.max(x1 - x0, v1 - v0) * 1.08, S = W / span;
const ox = (x0 + x1) / 2, ov = (v0 + v1) / 2;
const px = new Uint8Array(W * W * 3).fill(250);
const put = (i, j, c) => { if (i < 0 || j < 0 || i >= W || j >= W) return; const k = (j * W + i) * 3; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; };
const ramp = (t) => [Math.round(255 - 75 * t), Math.round(225 - 160 * t), Math.round(150 - 140 * t)];
const dim = (c, f) => c.map((v) => Math.round(250 - (250 - v) * 1) * f + 0);
prims.sort((a, b) => (b.y * ce - b.z * se) - (a.y * ce - a.z * se));
const yMin = Math.min(...prims.map((p) => p.y)), yMax = Math.max(...prims.map((p) => p.y));
for (const p of prims) {
  const cx = W / 2 + (p.x - ox) * S, top = W / 2 - (sv(p, p.z) - ov) * S;
  const rx = (p.w / 2) * S, ry = Math.max(0.5, rx * se), hh = p.h * ce * S;
  const depthF = 1 - 0.25 * ((p.y - yMin) / Math.max(1e-6, yMax - yMin));
  const c = ramp(Math.min(1, p.z / Math.max(1, zTop)));
  const side = dim(c, 0.72 * depthF), face = dim(c, 1.0 * depthF);
  for (let j = Math.floor(top); j <= Math.ceil(top + hh); j++)
    for (let i = Math.floor(cx - rx); i <= Math.ceil(cx + rx); i++) put(i, j, side);
  for (let dj = -Math.ceil(ry); dj <= Math.ceil(ry); dj++)
    for (let di = -Math.ceil(rx); di <= Math.ceil(rx); di++)
      if ((di * di) / (rx * rx + 1e-9) + (dj * dj) / (ry * ry + 1e-9) <= 1) put(Math.round(cx + di), Math.round(top + dj), face);
}

// ---- PNG
const raw = Buffer.alloc((W * 3 + 1) * W);
for (let r = 0; r < W; r++) { raw[r * (W * 3 + 1)] = 0; Buffer.from(px.buffer, r * W * 3, W * 3).copy(raw, r * (W * 3 + 1) + 1); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(out, prims.length, "primitives, top", zTop.toFixed(2), "mm");
