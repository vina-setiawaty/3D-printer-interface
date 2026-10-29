// Prototype "arch loop" texture: free-standing loops anchored to the bed at BOTH ends.
// One loop = anchor puddle A -> extruded rise -> bridge at apex height -> extruded descent -> anchor puddle B.
//   shape  "staple": straight up, straight across, straight down
//          "arc":    one smooth half-ellipse from A to B
//   H      apex nozzle height above the bed (mm)
//   S      span between the two anchors (mm)
//   dir    "x": loop spans along the row (in line); "y": loop spans across the row (crosswise pile)
//   chain  true: no retract/travel between loops, a short bed-level run joins B to the next A
// Usage: node arch_test.mjs <path to texture_functions.js> <out.gcode> <out-MAP.md> [pla|tpu]
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const lib = await import(pathToFileURL(process.argv[2]).href);
const { Emitter, FIL_AREA, MAX_EXTRUSION_RATE_MM3_S, stripComments, freeformSolid, verifyLayout } = lib;
const outGcode = process.argv[3], outMap = process.argv[4];
// Material presets: TPU = the library defaults; PLA = the 20260925 PLA calibration sheet's header.
const MATERIALS = {
  tpu: { name: "TPU", nozzleTemp: lib.NOZZLE_TEMP, bedTemp: lib.BED_TEMP, flowPercent: lib.FLOW_PERCENT },
  pla: { name: "PLA", nozzleTemp: 205, bedTemp: 60, flowPercent: 100 },
};
const MAT = MATERIALS[process.argv[5] ?? "pla"];
const flow = MAT.flowPercent / 100;

// Strand: a free-hanging strand comes out about nozzle-round (0.4mm dia -> 0.126mm2 -> e/d 0.052).
const STRAND_R = 0.05;   // e per mm of 3D strand length
const RUN_R = 0.08 / FIL_AREA; // reference bead (0.4 x 0.2) for the bed-level run in chain mode
const ANCHOR = { z0: 0.2, z1: 0.6, e: 0.3, F: 60 }; // in-place puddle, rising while it extrudes
const PRESS_Z = 0.3; // descent ends here, just above the bed, then the B puddle builds on it

const vol = (eRate, F) => eRate * FIL_AREA * flow * (F / 60); // mm3/s for e-per-mm at feed F

function anchorPuddle(em, e = ANCHOR.e) {
  em.a(`G1 Z${ANCHOR.z1.toFixed(3)} E${e.toFixed(4)} F${ANCHOR.F}`);
  em.eTotal += e; em.z = ANCHOR.z1;
}

// Extruded straight 3D move split into 0.5mm pieces, e proportional to 3D length.
function strandTo(em, x, y, z, F, rate = STRAND_R) {
  const d = Math.hypot(x - em.x, y - em.y, z - em.z);
  const n = Math.max(1, Math.ceil(d / 0.5));
  const x0 = em.x, y0 = em.y, z0 = em.z;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    em.printMove(x0 + (x - x0) * t, y0 + (y - y0) * t, (rate * d) / n, F, z0 + (z - z0) * t);
  }
}

// Points [s, z] along a curved arch (s = fraction of the span, 0 -> 1; z = nozzle height), A excluded, B included.
function curvePoints(L) {
  const pts = [];
  if (L.shape === "arc") {
    // half-ellipse from A (z1) up to H at mid-span and down to B (PRESS_Z)
    const N = 24;
    for (let i = 1; i <= N; i++) {
      const th = Math.PI * (i / N);
      const s = (1 - Math.cos(th)) / 2;             // 0 -> 1 along the span
      const zBase = ANCHOR.z1 + (PRESS_Z - ANCHOR.z1) * s;
      pts.push([s, zBase + (L.H - ANCHOR.z1) * Math.sin(th)]);
    }
  } else {
    // "parabola": two half-parabolas meeting at the peak (s = peakAt) with zero slope. peakAt < 0.5 leans the
    // peak toward A: a short steep climb from A, then a longer, gentler descent to B.
    const N = 30, p = L.peakAt;
    for (let i = 1; i <= N; i++) {
      const s = i / N;
      const u = s <= p ? (s - p) / p : (s - p) / (1 - p);
      const z0 = s <= p ? ANCHOR.z1 : PRESS_Z;
      pts.push([s, z0 + (L.H - z0) * (1 - u * u)]);
    }
  }
  return pts;
}

// "hairBend": the nozzle's swing from the top of the hair (s 0, z H) down onto B (s 1, z PRESS_Z), quarter-ellipse.
function bendPoints(L) {
  const N = 20, pts = [];
  for (let i = 1; i <= N; i++) {
    const th = (Math.PI / 2) * (i / N);
    pts.push([Math.sin(th), PRESS_Z + (L.H - PRESS_Z) * Math.cos(th)]);
  }
  return pts;
}

// 3D length of a path of [s, z] points starting from `start`.
function pathLength(L, pts, start) {
  let len = 0, prev = start;
  for (const pt of pts) { len += Math.hypot((pt[0] - prev[0]) * L.S, pt[1] - prev[1]); prev = pt; }
  return len;
}
const curveLength = (L) => pathLength(L, curvePoints(L), [0, ANCHOR.z1]);

function archLoop(em, ax, ay, L) {
  const [bx, by] = L.dir === "y" ? [ax, ay + L.S] : [ax + L.S, ay];
  anchorPuddle(em);
  if (L.anchorDwellMs) em.dwell(L.anchorDwellMs);
  if (L.shape === "hairBend") {
    strandTo(em, ax, ay, L.H, L.Frise, L.rate);               // pull a straight vertical hair, H tall
    if (L.topDwellMs) em.dwell(L.topDwellMs);
    // then swing the nozzle (still attached to the hair's tip) over and down onto B along a quarter-ellipse,
    // without extruding: the nozzle never gets further from A than the hair is long, so the hair bends over into the arc
    for (const [s, z] of bendPoints(L)) strandTo(em, ax + (bx - ax) * s, ay + (by - ay) * s, z, L.Fbend, L.bendRate);
  } else if (L.shape !== "staple") {
    for (const [s, z] of curvePoints(L)) strandTo(em, ax + (bx - ax) * s, ay + (by - ay) * s, z, L.Farc, L.rate);
  } else {
    strandTo(em, ax, ay, L.H, L.Frise, L.rate);               // rise
    if (L.topDwellMs) em.dwell(L.topDwellMs);                 // let the leg set before bridging off it
    strandTo(em, bx, by, L.H, L.Fbridge, L.rate);             // bridge
    if (L.topDwellMs) em.dwell(L.topDwellMs);
    strandTo(em, bx, by, PRESS_Z, L.Fdown, L.rate);           // descend onto B
  }
  anchorPuddle(em);
  if (L.anchorDwellMs) em.dwell(L.anchorDwellMs);
  return [bx, by];
}

function archRow(em, x0, y, L) {
  em.newPattern();
  let x = x0;
  for (let k = 0; k < L.count; k++) {
    const startNew = !L.chain || k === 0;
    if (startNew) {
      em.goto(x, y, ANCHOR.z0);
      em.unretract();
    }
    const [bx] = archLoop(em, x, y, L);
    const nextX = (L.dir === "y" ? x : bx) + L.pitchGap;
    if (L.chain && k < L.count - 1) {
      strandTo(em, em.x, em.y, ANCHOR.z0, 600, 0);              // settle onto the bed
      strandTo(em, nextX, y, ANCHOR.z0, 400, RUN_R);            // bed-level run to the next A
    } else {
      em.retract();
      // straight up clear of the loop before any travel
      const clear = L.H + 1.0;
      em.a(`G1 Z${clear.toFixed(3)} F1500`); em.z = clear;
    }
    x = nextX;
  }
}

const bridgeF = 300, riseF = 300, downF = 400;
const base = { shape: "staple", dir: "x", count: 6, pitchGap: 3, Frise: riseF, Fbridge: bridgeF, Fdown: downF, Farc: 300, fan: true, rate: STRAND_R };
const ROWS = [
  { ...base, id: "A", H: 2, S: 3, note: "staple, low and short -- the easiest case" },
  { ...base, id: "B", H: 3, S: 3, note: "staple, taller -- does a 3mm leg stand?" },
  { ...base, id: "C", H: 3, S: 3, fan: false, note: "same as B with the part fan OFF -- isolates cooling" },
  { ...base, id: "D", H: 3, S: 5, note: "staple, long 5mm bridge -- where does it start to sag?" },
  { ...base, id: "E", H: 3, S: 4, shape: "arc", note: "smooth half-ellipse instead of a staple" },
  { ...base, id: "F", H: 3, S: 4, topDwellMs: 1500, Fbridge: 200, note: "staple, 1.5s dwell at each top corner + slower bridge" },
  { ...base, id: "G", H: 2.5, S: 3, chain: true, pitchGap: 1.5, note: "continuous chain: no retracts, a 1.5mm bed run joins loops" },
  { ...base, id: "H", H: 3, S: 4, dir: "y", pitchGap: 3, count: 8, note: "crosswise loops (span along Y), 3mm pitch -- a pile row" },
];

// Follow-up rows: one per file, printed on the SAME bed as the 8 rows above, continuing upward from row H.
// Generate one with: node arch_test.mjs <lib> <out.gcode> <out-MAP.md> pla <id>
const FOLLOWUPS = [
  { ...ROWS[1], id: "I", from: "B", y: 137, calY: 40, rate: 0.075, Frise: 150, Fbridge: 150, Fdown: 200,
    note: "row B with the arch strand at +50% extrusion (e/d 0.05 -> 0.075) and every arch move at half speed -- a thicker, slower strand so the bridge hangs",
    why: "More plastic per mm of strand (a thicker, stiffer strand) delivered more slowly, so the fan has longer to set it before the nozzle moves on. " +
      "Note the melt flow per second actually goes DOWN, because the speed drops more than the extrusion rises.",
    look: "Does the bridge stay level instead of sagging? Is the strand visibly thicker? Any blobs at the top corners from the slower moves?" },
  { ...ROWS[1], id: "J", from: "I", y: 151, calY: 35, rate: 0.075, Frise: 75, Fbridge: 75, Fdown: 100, noPurge: true,
    note: "row I's strand (e/d 0.075) with every arch move at half of row I's speed again (a quarter of row B's)",
    why: "Same strand thickness as row I, but each part of the strand now spends twice as long under the fan before the nozzle moves away. " +
      "Melt flow per second halves again.",
    look: "Does the bridge stay level instead of sagging? Does the extra time under the fan make the bridge straighter than row I's, or has it stopped improving? " +
      "At this low flow, does the strand stay continuous, or does it thin out or break mid-bridge? Any blobs where the nozzle sits at the top corners?" },
  // Farc 110: row J's 75 printed too slow (user, 2026-10-29), so between I (150) and J (75)
  { ...ROWS[1], id: "K", from: "J", y: 165, calY: 30, rate: 0.075, shape: "parabola", peakAt: 0.3, Farc: 110, noPurge: true,
    note: "row J's strand on a lopsided parabola (peak 30% of the way across, nearer the start anchor), at 110mm/min -- between row I (150) and row J (75)",
    why: "No corners and no straight bridge: the nozzle climbs steeply from the start anchor (0.6 -> 3.0mm over the first 0.9mm), " +
      "rounds the peak, then comes down over the remaining 2.1mm -- flat just after the peak and steepening into the end anchor, like a " +
      "thrown ball's path. The strand is never dragged level through the air. Strand thickness is row J's; the speed is back up to 110mm/min " +
      "because row J (75) printed too slow -- between row J and row I (150).",
    look: "Did the loops keep the lopsided shape, with the high point near the start, or did they slump into a symmetric hump? " +
      "Is the descending side smooth, or did it sag onto the bed before the end anchor? Compare stiffness with row J's square-cornered loops, " +
      "and whether 110mm/min fixed what was wrong with row J's speed." },
  { ...ROWS[1], id: "L", from: "K", y: 179, calY: 25, rate: 0.075, shape: "hairBend", H: 5, Frise: 110, Fbend: 600, bendRate: 0, noPurge: true,
    note: "straight 5mm hair pulled up from A (e/d 0.075, 110mm/min), then the nozzle swings over and down onto B without extruding (600mm/min), bending the hair into the arc",
    why: "Instead of drawing the arc with the nozzle, the arc is made by bending: first a straight vertical hair 5mm tall (row K's strand and speed), " +
      "then the nozzle -- still holding the hair's tip -- swings along a quarter-ellipse from the top of the hair down onto B, 3mm away, without extruding. " +
      "Along that swing the nozzle is never further from A than the hair is long, so the hair is never stretched; it has slack and bends over into an arch. " +
      "The swing is fast (600mm/min, about 0.6s) so the hair bends while it is still warm instead of setting straight under the fan. " +
      "Rough expected shape: a 5mm hair over a 3mm span gives an arch somewhat taller than a semicircle (~2mm high).",
    look: "Did the hair stand straight before the bend? Did it bend into a rounded arch, kink sharply at one point, or snap off the nozzle during the swing? " +
      "Is the tip glued down at B? Compare height and roundness with rows J and K." },
];
const followup = process.argv[6] ? FOLLOWUPS.find((r) => r.id === process.argv[6]) : null;
if (process.argv[6] && !followup) { console.error(`no follow-up row "${process.argv[6]}"`); process.exit(1); }

const X0 = 20, Y0 = 25, DY = 14;
const CAL = { x0: 120, x1: 180, y: followup ? followup.calY : 75 };

// layout check: each row's footprint, plus the calibration line(s). A follow-up file is also checked
// against everything already on the bed: the 8 rows, the y=75 calibration line, and earlier follow-ups.
const calRegion = (name, y) => ({ name, x0: CAL.x0, y0: y - 0.5, w: CAL.x1 - CAL.x0, h: 1 });
const rowRegion = (L) => {
  const w = L.dir === "y" ? (L.count - 1) * L.pitchGap : L.count * L.S + (L.count - 1) * L.pitchGap;
  const h = L.dir === "y" ? L.S : 0;
  L.w = w;
  return { name: `row ${L.id}`, x0: X0 - 1, y0: L.y - 1, w: w + 2, h: h + 2 };
};
ROWS.forEach((L, i) => { L.y = Y0 + i * DY; });
const PRINT = followup ? [followup] : ROWS;
const regions = [calRegion("calibration", CAL.y), ...PRINT.map(rowRegion)];
if (followup) {
  const earlier = FOLLOWUPS.slice(0, FOLLOWUPS.indexOf(followup));
  regions.push(calRegion("calibration y=75 (printed)", 75), ...ROWS.map(rowRegion),
    ...earlier.flatMap((r) => [calRegion(`calibration y=${r.calY} (printed)`, r.calY), rowRegion(r)]));
}
const layout = verifyLayout(regions, { minGap: 3 });
if (!layout.ok) { console.error(layout); process.exit(1); }

const em = new Emitter();
em.header({ nozzleTemp: MAT.nozzleTemp, bedTemp: MAT.bedTemp, flowPercent: MAT.flowPercent });
// The header's purge lines (X10/X10.4, Y15-100) land in the same spot in every file, so on a reused sheet they pile up.
// noPurge drops them; the calibration line printed next still primes the nozzle.
const PURGE = /^G1 X10(\.4)? Y(15|100) Z0\.28 /;
if (followup?.noPurge) em.lines = em.lines.filter((l) => !PURGE.test(l));
em.a("; arch-loop exploration -- see MAP.md");
em.a(`; calibration line x=${CAL.x0}-${CAL.x1} y=${CAL.y}`);
freeformSolid(em, (t) => t, () => CAL.y, CAL.x0, CAL.x1);
if (followup) {
  // the travel from the calibration line to the new row crosses the loops already on the bed (up to 3mm tall)
  em.retract();
  em.a("G1 Z5.000 F1500"); em.z = 5;
}
for (const L of PRINT) {
  em.a(`; row ${L.id}: ${L.note}`);
  em.a(L.fan ? "M106 S255" : "M107");
  archRow(em, X0, L.y, L);
}
em.a("M107");
em.footer();
writeFileSync(outGcode, stripComments(em.lines.join("\n")));

const f = (v, n = 2) => (+v).toFixed(n);
const tableHead = `| row | Y | shape | dir | H (mm) | S (mm) | loops | pitch gap | rise / bridge / down F | top dwell | fan | ~mm3/s at bridge | note |\n` +
  `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
const tableRow = (L) => {
  const Fs = L.shape === "hairBend" ? `${L.Frise} hair / ${L.Fbend} bend`
    : L.shape !== "staple" ? `${L.Farc} (whole ${L.shape === "arc" ? "arc" : "curve"})` : `${L.Frise} / ${L.Fbridge} / ${L.Fdown}`;
  const v = vol(L.rate, L.shape === "hairBend" ? L.Frise : L.shape !== "staple" ? L.Farc : L.Fbridge);
  const over = v > MAX_EXTRUSION_RATE_MM3_S ? " **over cap**" : "";
  return `| ${L.id} | ${L.y} | ${L.shape}${L.chain ? " (chain)" : ""} | ${L.dir} | ${f(L.H, 1)} | ${f(L.S, 1)} | ${L.count} | ${f(L.pitchGap, 1)} | ${Fs} | ${L.topDwellMs ?? "-"} | ${L.fan ? "on" : "OFF"} | ${f(v)}${over} | ${L.note} |\n`;
};
// Whole-arch comparison rows (row A vs row B of the comparison table), so a staple and a curve can be compared.
function wholeArchRows(...rows) {
  const c = rows.map((R) => {
    // legs: [nozzle path length, F, e per mm]
    const legs = R.shape === "staple"
      ? [[R.H - ANCHOR.z1, R.Frise, R.rate], [R.S, R.Fbridge, R.rate], [R.H - PRESS_Z, R.Fdown, R.rate]]
      : R.shape === "hairBend"
      ? [[R.H - ANCHOR.z1, R.Frise, R.rate], [pathLength(R, bendPoints(R), [0, R.H]), R.Fbend, R.bendRate]]
      : [[curveLength(R), R.Farc, R.rate]];
    const len = legs.reduce((a, [d]) => a + d, 0);
    const t = legs.reduce((a, [d, F]) => a + d / (F / 60), 0);
    const fil = legs.reduce((a, [d, , r]) => a + d * r, 0);
    return {
      shape: R.shape === "staple" ? "square corners: straight up, across, down"
        : R.shape === "arc" ? "symmetric half-ellipse"
        : R.shape === "hairBend" ? `straight ${f(R.H, 1)}mm hair, then bent over onto B ${f(R.S, 1)}mm away`
        : `lopsided parabola, peak at ${f(R.peakAt * R.S, 1)}mm of ${f(R.S, 1)}mm (${f(R.peakAt * 100, 0)}%)`,
      F: R.shape === "staple" ? `${R.Frise} / ${R.Fbridge} / ${R.Fdown} (rise / bridge / descent)`
        : R.shape === "hairBend" ? `${R.Frise} hair / ${R.Fbend} bend (bend not extruding)` : `${R.Farc} (whole curve)`,
      len: f(len, 1), fil: f(fil, 3), t: f(t, 1), flow: f((fil * FIL_AREA * flow) / t),
    };
  });
  const row = (label, k) => `| ${label} | ${c.map((x) => x[k]).join(" | ")} |\n`;
  return row("path shape", "shape") + row("speed F (mm/min)", "F") + row("arch path length, A to B (mm)", "len") +
    row("filament per arch (mm)", "fil") + row("time for the whole arch (s)", "t") +
    row("average melt flow over the arch (mm3/s)", "flow") + "\n";
}

if (followup) {
  const L = followup, B = [...ROWS, ...FOLLOWUPS].find((r) => r.id === L.from);
  const earlier = FOLLOWUPS.slice(0, FOLLOWUPS.indexOf(L));
  const below = earlier.length ? `row ${earlier.at(-1).id} (Y ${earlier.at(-1).y})` : "row H (Y 123-127)";
  const cals = ["y=75 from the 8-row print", ...earlier.map((r) => `y=${r.calY} from row ${r.id}`)];
  const md = `# Arch-loop follow-up row ${L.id} -- ${MAT.name}, nozzle ${MAT.nozzleTemp}C, bed ${MAT.bedTemp}C, M221 S${MAT.flowPercent}\n\n` +
    `**Not yet print-tested.** Generated by \`arch_test.mjs ... ${L.id}\`. Printed on the **same bed** as \`20261029_arch-loop-8-rows-PLA.gcode\` -- ` +
    `don't clear the sheet. Row ${L.id} sits at Y=${L.y}, above ${below}.\n\n` +
    `Calibration line: \`freeformSolid\` x=${CAL.x0}-${CAL.x1}, y=${CAL.y}, printed first (the next free step in the calibration sequence; ` +
    `${cals.join(" and ")} ${cals.length > 1 ? "are" : "is"} already on this bed). \`verifyLayout\` against everything already on the bed (3mm min gap): ` +
    `ok=${layout.ok}, ${layout.warnings.length} warnings.\n\n` +
    (L.H === B.H
      ? `**Change from row ${B.id}** (everything else identical: H ${B.H}, S ${B.S}, ${B.count} loops, same anchors, fan on):\n\n`
      : `**Change from row ${B.id}** (same S ${B.S}, ${B.count} loops, anchors, fan on; height: ${L.H}mm hair vs row ${B.id}'s ${B.H}mm arch):\n\n`) +
    `| | row ${B.id} | row ${L.id} |\n|---|---|---|\n` +
    `| arch strand e/d (rise, bridge, descent) | ${B.rate} | ${L.rate} ${L.rate === B.rate ? "(same)" : `(+${f((L.rate / B.rate - 1) * 100, 0)}%)`} |\n` +
    (B.shape === "staple" && L.shape === "staple"
      ? `| rise / bridge / descent F (mm/min) | ${B.Frise} / ${B.Fbridge} / ${B.Fdown} | ${L.Frise} / ${L.Fbridge} / ${L.Fdown} |\n` +
        `| filament per loop's bridge (mm) | ${f(B.rate * B.S, 3)} | ${f(L.rate * L.S, 3)} |\n` +
        `| time on the bridge (s) | ${f(B.S / (B.Fbridge / 60), 1)} | ${f(L.S / (L.Fbridge / 60), 1)} |\n` +
        `| melt flow while bridging (mm3/s) | ${f(vol(B.rate, B.Fbridge))} | ${f(vol(L.rate, L.Fbridge))} |\n\n`
      : wholeArchRows(B, L)) +
    `${L.why}\n\n` +
    (L.noPurge ? `**No purge line**: the header's purge lines at X10-10.4, Y15-100 are left out (they would print on top of the ones already there). ` +
      `The calibration line is the first extrusion, so it doubles as the prime -- expect its start to be a little thin.\n\n` : "") +
    tableHead + tableRow(L) +
    `\n**What to look for**: compare directly with row ${B.id} (Y=${B.y}). ` +
    `${L.look}\n\n` +
    `Totals: ${em.lines.length} G-code lines, ${em.eTotal.toFixed(1)} mm commanded filament.\n`;
  writeFileSync(outMap, md);
  console.log(md);
  process.exit(0);
}
let md = `# Arch-loop exploration (8 rows) -- ${MAT.name}, nozzle ${MAT.nozzleTemp}C, bed ${MAT.bedTemp}C, M221 S${MAT.flowPercent}\n\n` +
  `**Not yet print-tested.** Generated by \`arch_test.mjs\`; no library function exists for this texture.\n\n` +
  `Each loop: anchor puddle A (in place, Z ${ANCHOR.z0}->${ANCHOR.z1}, e ${ANCHOR.e}) -> extruded rise to H -> extruded bridge over span S at H -> ` +
  `extruded descent to Z ${PRESS_Z} at B -> anchor puddle B. Strand flow e/d = ${STRAND_R} (about a 0.4mm round strand). ` +
  `Each loop is retracted (${lib.RETRACT_MM}mm) and the nozzle lifts straight up to H+1 before travelling, except in row G.\n\n` +
  `**Part fan**: the library never touches the fan; this file turns it on (\`M106 S255\`) for every row except C, and off at the end. ` +
  `If your printer runs the fan from the slicer only, rows B and C will look the same.\n\n` +
  `Calibration line: \`freeformSolid\` x=${CAL.x0}-${CAL.x1}, y=${CAL.y}, printed first (continues from the y=80 looped-spire-trace print). ` +
  `Loops run +X from X=${X0}. \`verifyLayout\` (3mm min gap): ok=${layout.ok}, ${layout.warnings.length} warnings.\n\n` + tableHead;
for (const L of ROWS) md += tableRow(L);
md += `\n**What to look for**: do the legs stand (A vs B), does the bridge stay level or sag (B vs D, B vs F), does the fan matter (B vs C), ` +
  `does a smooth arc survive better than a staple (E vs B/D), does skipping retracts leave strings or cleaner loops (G), ` +
  `and does a crosswise row read as a pile when you stroke it (H). Squeeze a few loops: do they spring back or snap?\n\n` +
  `Totals: ${em.lines.length} G-code lines, ${em.eTotal.toFixed(1)} mm commanded filament.\n`;
writeFileSync(outMap, md);
console.log(md);
