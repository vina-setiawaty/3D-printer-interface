/**
 * Offline checks for the texture-actions panel. Run from sewingeditor/:
 *   node texture-actions/tests/run.mjs
 *
 *  1. spec coverage   -- every texture's fn exists, its signature parses,
 *                        every option has display metadata in PARAMS,
 *                        every `basic` / `initial` key is a real option,
 *                        and every required option has an `initial`
 *  2. patch roundtrip -- changing a default rewrites only that literal,
 *                        and changing it back restores the file byte for
 *                        byte
 *  3. parity          -- at signature defaults, the panel's body G-code
 *                        equals calling the library directly with no
 *                        options
 *  4. valid G-code    -- every emitted line passes script.js's allow-list
 *                        and stays on the bed
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as TF from "../texture_functions.js";
import { TEXTURES, PARAMS } from "../spec.js";
import { parseDefaults, defaultsObject, patchDefaults } from "../signature.js";
import { buildGcode, findOutOfBounds } from "../generate.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = readFileSync(here("../texture_functions.js"), "utf8");
const scriptJs = readFileSync(here("../../script.js"), "utf8");
const gcodeCheck = JSON.parse(/let gcodeCheck = (\[[\s\S]*?\]);/.exec(scriptJs)[1]);

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.log(`  FAIL ${msg}`); }
};

const PLACEMENT = {
  brush: { x0: 80, y0: 100, x1: 110, y1: 100 },
  stamp: { x: 100, y: 100 },
};
const SETTINGS = { flowPercent: 100, zOffset: 0, liftMm: 2, startZ: 10 };

function fullValues(t) {
  return { ...defaultsObject(src, t.sig), ...(t.initial ?? {}) };
}

console.log("1. spec coverage");
for (const t of TEXTURES) {
  const table = t.kind === "brush" ? TF.BRUSHES : TF.STAMPS;
  check(typeof table[t.fn] === "function", `${t.name}: ${t.kind} "${t.fn}" not exported`);
  let params;
  try { params = parseDefaults(src, t.sig); } catch (e) { check(false, `${t.name}: ${e.message}`); continue; }
  check(params.length > 0, `${t.name}: no options parsed from ${t.sig}`);
  const keys = params.map((p) => p.key);
  for (const p of params) {
    check(PARAMS[p.key], `${t.name}: option "${p.key}" missing from PARAMS`);
    check(p.literal, `${t.name}: default of "${p.key}" is not a plain literal`);
    if (p.required) check(t.initial && p.key in t.initial, `${t.name}: required "${p.key}" needs an initial value`);
    const meta = PARAMS[p.key];
    if (meta?.options && !p.required) check(meta.options.includes(p.value), `${t.name}: default "${p.value}" not in ${p.key} options`);
  }
  for (const k of t.basic) check(keys.includes(k), `${t.name}: basic "${k}" is not an option of ${t.sig}`);
  for (const k of Object.keys(t.initial ?? {})) check(keys.includes(k), `${t.name}: initial "${k}" is not an option`);
}

console.log("2. patch roundtrip");
for (const t of TEXTURES) {
  for (const p of parseDefaults(src, t.sig)) {
    if (p.required) continue;
    const newValue = typeof p.value === "number" ? p.value + (p.raw.includes(".") ? 1.5 : 1)
      : p.value === null ? 3 : typeof p.value === "string" ? `${p.value}x` : !p.value;
    const patched = patchDefaults(src, t.sig, { [p.key]: newValue });
    const reparsed = defaultsObject(patched, t.sig);
    check(reparsed[p.key] === newValue, `${t.name}.${p.key}: patched to ${newValue}, reads ${reparsed[p.key]}`);
    const before = src.slice(0, p.valueStart), after = src.slice(p.valueEnd);
    check(patched.startsWith(before) && patched.endsWith(after), `${t.name}.${p.key}: bytes outside the literal changed`);
    const restored = patchDefaults(patched, t.sig, { [p.key]: p.value });
    check(restored === src, `${t.name}.${p.key}: patching back did not restore the file`);
  }
}
check(patchDefaults(src, "brushSolid", { nLayers: 3 }).includes("nLayers = 3,"), "integer literal stays integer");
check(patchDefaults(src, "brushDotted", { gap: 6 }).includes("gap = 6.0,"), "float-style literal stays float-style");

console.log("3. parity with direct library calls");
for (const t of TEXTURES) {
  const values = fullValues(t);
  const { bodyLines } = buildGcode(TF, t, values, PLACEMENT[t.kind], SETTINGS);

  const em = new TF.Emitter();
  em.z = SETTINGS.startZ; em.retracted = true; em.newPattern();
  const direct = t.initial ?? {};
  if (t.kind === "brush") {
    const { x0, y0, x1, y1 } = PLACEMENT.brush;
    TF.BRUSHES[t.fn](em, TF.polylineToPts([[x0, y0], [x1, y1]], 0.1), direct);
  } else {
    TF.STAMPS[t.fn](em, PLACEMENT.stamp.x, PLACEMENT.stamp.y, direct);
  }
  em.retract();
  check(bodyLines.join("\n") === em.lines.join("\n"), `${t.name}: panel output differs from direct call`);
}

console.log("4. valid G-code");
for (const t of TEXTURES) {
  const { lines } = buildGcode(TF, t, fullValues(t), PLACEMENT[t.kind],
    { ...SETTINGS, flowPercent: 180, zOffset: 1.2 });
  const bad = lines.find((l) => !gcodeCheck.includes(l.split(";")[0].trim().split(" ")[0]));
  check(!bad, `${t.name}: "${bad}" fails checkGcode`);
  const oob = findOutOfBounds(lines, TF.BED_X, TF.BED_Y);
  check(!oob, `${t.name}: off the bed: ${oob}`);
  check(lines.at(-1) === "M221 S100", `${t.name}: flow not restored`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
