// Prototype "chain" brush: a stroke = list of segments {h, e, d, F, mode, dwellMs}.
//   h    nozzle Z above bed at the END of the segment (mm)
//   e    commanded filament for the segment (mm, before the M221 flow multiplier)
//   d    XY travel along the path (mm); d = 0 means extrude in place
//   F    feed rate (mm/min); for d = 0 it's the Z/E move rate
//   mode "step": change Z first, then travel at constant h; "ramp": Z changes linearly over the segment
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const lib = await import(pathToFileURL(process.argv[2]).href);
const { Emitter, FIL_AREA, MAX_EXTRUSION_RATE_MM3_S, stripComments } = lib;
const outGcode = process.argv[3], outMap = process.argv[4];
// Material presets: TPU = the library defaults; PLA = the 20260925 PLA calibration sheet's header.
const MATERIALS = {
  tpu: { name: "TPU", nozzleTemp: lib.NOZZLE_TEMP, bedTemp: lib.BED_TEMP, flowPercent: lib.FLOW_PERCENT },
  pla: { name: "PLA", nozzleTemp: 205, bedTemp: 60, flowPercent: 100 },
};
const MAT = MATERIALS[process.argv[5] ?? "tpu"];
const FLOW_PERCENT = MAT.flowPercent;

const SUB = 0.5; // split moves into 0.5mm pieces so ramps are smooth

function brushChain(em, x0, y, segs, { repeat = false, lineLen }) {
  em.newPattern();
  em.goto(x0, y, segs[0].h);
  em.unretract();
  let x = x0, z = segs[0].h, k = 0;
  const report = [];
  while (true) {
    let sg = segs[k % segs.length];
    const d = Math.min(sg.d, x0 + lineLen - x);
    if (sg.d > 0 && d < 1e-6) break;
    const mode = sg.mode ?? "step";
    if (d === 0) {
      sg = { ...sg, dz: Math.abs(sg.h - z) };
      em.a(`G1 Z${sg.h.toFixed(3)} E${sg.e.toFixed(4)} F${sg.F}`);
      em.eTotal += sg.e; z = sg.h; em.z = z;
    } else {
      if (mode === "step" && Math.abs(sg.h - z) > 1e-9) {
        em.a(`G1 Z${sg.h.toFixed(3)} F600`); z = sg.h; em.z = z;
      }
      const n = Math.max(1, Math.ceil(d / SUB));
      const eTot = sg.e * (d / sg.d); // shortened last segment gets proportional e
      const z0 = z;
      for (let i = 1; i <= n; i++) {
        const xi = x + (d * i) / n;
        const zi = mode === "ramp" ? z0 + ((sg.h - z0) * i) / n : z;
        em.printMove(xi, y, eTot / n, sg.F, zi);
      }
      x += d; z = sg.h;
    }
    if (sg.dwellMs) em.dwell(sg.dwellMs);
    if (k < segs.length) report.push(sg);
    k++;
    if (!repeat && k >= segs.length) break;
    if (x >= x0 + lineLen - 1e-6 && sg.d > 0 && (repeat || k >= segs.length)) break;
  }
  em.retract();
  return report;
}

// reference bead (0.4 wide x 0.2 high): e/d = 0.08 / FIL_AREA
const REF = 0.08 / FIL_AREA; // ~0.0333
const seg = (h, r, d, F, extra = {}) => ({ h, e: r * d, d, F, ...extra });
const LEN = 60;

// Ramps built from 10 sub-segments
const hRamp = Array.from({ length: 10 }, (_, i) => seg(0.2 + (2.8 * (i + 1)) / 10, 0.08, 6, 300, { mode: "ramp" }));
const eSweep = Array.from({ length: 10 }, (_, i) => seg(1.5, 0.01 + (0.24 * i) / 9, 6, 200));

const LINES = [
  { name: "L1 Baseline bead", note: "normal print: low nozzle, normal flow", segs: [seg(0.2, REF, LEN, 400)] },
  { name: "L2 Low + overextruded", note: "3x flow at bed height -> wide flat squished bead", segs: [seg(0.2, 0.10, LEN, 300)] },
  { name: "L3 Raised + normal flow", note: "1mm gap, normal flow -> thin stretched/draped string", segs: [seg(1.0, REF, LEN, 400)] },
  { name: "L4 Raised + high flow", note: "1mm gap, 4.5x flow -> wavy/buckled bead", segs: [seg(1.0, 0.15, LEN, 250)] },
  { name: "L5 High + very high flow", note: "3mm gap, 7.5x flow, slow -> coiling loops", segs: [seg(3.0, 0.25, LEN, 200)] },
  { name: "L6 High + very low flow", note: "3mm gap, 0.3x flow -> thin fibre, may break", segs: [seg(3.0, 0.01, LEN, 600)] },
  { name: "L7 Chain: height alternates (step)", note: "0.2mm / 2.0mm every 5mm, same flow -> flat bead / loop clusters", repeat: true,
    segs: [seg(0.2, 0.06, 5, 300), seg(2.0, 0.06, 5, 300)] },
  { name: "L8 Chain: height alternates (ramp)", note: "same as L7 but Z ramps within each segment -> compare with L7", repeat: true,
    segs: [seg(0.2, 0.06, 5, 300, { mode: "ramp" }), seg(2.0, 0.06, 5, 300, { mode: "ramp" })] },
  { name: "L9 Chain: flow alternates", note: "0.6mm height, e/d 0.02 / 0.15 every 5mm -> thin string / beads", repeat: true,
    segs: [seg(0.6, 0.02, 5, 300), seg(0.6, 0.15, 5, 250)] },
  { name: "L10 Chain: beads on a string (d=0)", note: "6mm thin travel (ramping down from the previous bead), then 0.6mm extruded in place while rising to 1.2mm", repeat: true,
    segs: [seg(0.3, 0.02, 6, 400, { mode: "ramp" }), { h: 1.2, e: 0.6, d: 0, F: 60, dwellMs: 500 }] },
  { name: "L11 Height sweep", note: "e/d fixed 0.08, height 0.48 -> 3.0 in 10 ramps of 6mm", segs: hRamp },
  { name: "L12 Flow sweep", note: "height fixed 1.5, e/d 0.01 -> 0.25 in 10 steps of 6mm", segs: eSweep },
];

const em = new Emitter();
em.header({ nozzleTemp: MAT.nozzleTemp, bedTemp: MAT.bedTemp, flowPercent: MAT.flowPercent });
em.a("; chain-brush exploration -- see MAP.md");
const X0 = 40, Y0 = 25, DY = 14;
const flow = FLOW_PERCENT / 100;
const rows = [];
LINES.forEach((L, i) => {
  const y = Y0 + i * DY;
  em.a(`; ${L.name}`);
  const used = brushChain(em, X0, y, L.segs, { repeat: !!L.repeat, lineLen: LEN });
  const segRows = used.map((s) => {
    const r = s.d > 0 ? s.e / s.d : null;
    const vol = s.d > 0 ? r * FIL_AREA * flow * (s.F / 60) : s.e * FIL_AREA * flow / (s.dz / (s.F / 60));
    return { ...s, r, vol };
  });
  rows.push({ ...L, y, segRows });
});
em.footer();
writeFileSync(outGcode, stripComments(em.lines.join("\n")));

const f = (v, n = 3) => (v == null ? "-" : (+v).toFixed(n));
let md = `# Chain-brush exploration (12 lines) -- ${MAT.name}, nozzle ${MAT.nozzleTemp}C, bed ${MAT.bedTemp}C\n\nAll lines run +X from X=${X0} to X=${X0 + LEN}. Y given per line. ` +
  `Heights are nozzle Z above the bed. e is commanded filament; the header sets M221 S${FLOW_PERCENT}, so actual filament = e x ${flow}. ` +
  `Reference bead (0.4 x 0.2): e/d = ${REF.toFixed(4)}. Flow cap (placeholder) = ${MAX_EXTRUSION_RATE_MM3_S} mm3/s.\n\n`;
for (const L of rows) {
  md += `## ${L.name}  (Y=${L.y})\n${L.note}${L.repeat ? " -- pattern repeats to the end of the line" : ""}\n\n`;
  md += `| h (mm) | e (mm) | d (mm) | e/d | F (mm/min) | mode | ~mm3/s | dwell |\n|---|---|---|---|---|---|---|---|\n`;
  for (const s of L.segRows) {
    const over = s.vol > MAX_EXTRUSION_RATE_MM3_S ? " **over cap**" : "";
    md += `| ${f(s.h, 2)} | ${f(s.e)} | ${f(s.d, 1)} | ${f(s.r, 3)} | ${s.F} | ${s.d === 0 ? "in place" : s.mode ?? "step"} | ${f(s.vol, 2)}${over} | ${s.dwellMs ?? "-"} |\n`;
  }
  md += "\n";
}
md += `Totals: ${em.lines.length} G-code lines, ${em.eTotal.toFixed(1)} mm commanded filament.\n`;
writeFileSync(outMap, md);
console.log(md);
