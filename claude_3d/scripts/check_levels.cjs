// Per-turn height spread of a helix wall, and the largest Z jump between
// consecutive printing moves. Usage: node scripts/check_levels.cjs file.gcode ...
const fs = require("fs");
for (const p of process.argv.slice(2)) {
  const pts = fs.readFileSync(p, "utf8").split("\n").filter((l) => /^G1 X.*Z.*E0/.test(l))
    .map((l) => [+l.match(/X([\d.]+)/)[1] - 110, +l.match(/Y([\d.]+)/)[1] - 110, +l.match(/Z([\d.]+)/)[1]]);
  let turns = [[]], pa = null, maxStep = 0, pz = null;
  for (const [x, y, z] of pts) {
    const a = Math.atan2(y, x);
    if (pa !== null && pa < 0 && a >= 0 && pa > -1) turns.push([]);
    turns.at(-1).push(z); pa = a;
    if (pz != null) maxStep = Math.max(maxStep, Math.abs(z - pz)); pz = z;
  }
  console.log(p, "turns", turns.length, "max Z step", maxStep.toFixed(2), "| spread every 5 turns:",
    turns.filter((t) => t.length > 20).map((t) => (Math.max(...t) - Math.min(...t)).toFixed(2)).filter((_, i) => i % 5 === 0).join(" "));
}
