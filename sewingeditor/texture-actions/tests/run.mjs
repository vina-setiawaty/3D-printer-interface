/**
 * Offline checks for the texture-actions panel. Run from sewingeditor/:
 *   node texture-actions/tests/run.mjs
 *
 *  1. texture list    -- the textures are read from BRUSHES: each one's
 *                        stroke + brush parse, every option has a default,
 *                        PARAMS choices are valid; adding a new texture
 *                        (blank or a copy) gives a file that imports, runs
 *                        and lists it, and bad additions are refused
 *  2. patch roundtrip -- changing a default rewrites only that literal,
 *                        and changing it back restores the file byte for
 *                        byte
 *  3. parity          -- at signature defaults, the panel's body G-code
 *                        equals calling the library directly with no
 *                        options
 *  4. valid G-code    -- every emitted line passes script.js's allow-list
 *                        and stays on the bed
 *  5. function swap    -- the editor's whole-function read / replace keeps
 *                        every other byte, rejects renamed / extra code,
 *                        and an edited copy of the file imports and runs
 *  6. edit states      -- edit-state.js through every transition
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as TF from "../texture_functions.js";
import { PARAMS } from "../spec.js";
import {
  parseDefaults, parseAllDefaults, patchAllDefaults, defaultsObject, patchDefaults,
  functionText, functionRange, replaceFunction, functionStartLine,
  tableFunction, relatedFunctions, groupText, replaceGroup,
  listTextures, addTexture, newTextureText,
} from "../signature.js";
import { editStatus } from "../edit-state.js";
import { buildGcode, findOutOfBounds } from "../generate.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = readFileSync(here("../texture_functions.js"), "utf8").replace(/\r\n/g, "\n");
const TEXTURES = listTextures(src);
const scriptJs = readFileSync(here("../../script.js"), "utf8");
const gcodeCheck = JSON.parse(/let gcodeCheck = (\[[\s\S]*?\]);/.exec(scriptJs)[1]);

let failures = 0;
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const check = (cond, msg) => {
  if (!cond) { failures++; console.log(`  FAIL ${msg}`); }
};

const PLACEMENT = { x0: 80, y0: 100, x1: 110, y1: 100 };
const SETTINGS = { flowPercent: 100, zOffset: 0, liftMm: 2, startZ: 10 };

function fullValues(t) {
  const out = {};
  for (const p of parseAllDefaults(src, t.sigs)) if (!p.required) out[p.key] = p.value;
  return out;
}

console.log("1. texture list");
check(TEXTURES.length >= 9, `only ${TEXTURES.length} textures listed from BRUSHES`);
for (const t of TEXTURES) {
  check(typeof TF.BRUSHES[t.fn] === "function", `${t.name}: BRUSHES "${t.fn}" not exported`);
  check(TF.BRUSHES[t.fn]?.name === t.sigs[0], `${t.name}: BRUSHES.${t.fn} is not its stroke ${t.sigs[0]}`);
  check(/^stroke/.test(t.sigs[0]) && /^brush/.test(t.sigs[1]), `${t.name}: sigs should be [stroke*, brush*]`);
  let params;
  try { params = parseAllDefaults(src, t.sigs); } catch (e) { check(false, `${t.name}: ${e.message}`); continue; }
  check(params.length > 0, `${t.name}: no options parsed from ${t.sigs.join(" / ")}`);
  const keys = params.map((p) => p.key);
  for (const p of params) {
    check(p.literal, `${t.name}: default of "${p.key}" is not a plain literal`);
    check(!p.required, `${t.name}: "${p.key}" has no default -- every option needs one`);
    const meta = PARAMS[p.key];
    if (meta?.options && !p.required) check(meta.options.includes(p.value), `${t.name}: default "${p.value}" not in ${p.key} options`);
  }
  check(keys.length === new Set(keys).size, `${t.name}: an option listed twice`);
  check(t.description, `${t.name}: no doc comment above ${t.sigs[0]} for the card's description`);
}
// a new texture: blank, or a copy of every existing one
for (const from of [null, ...TEXTURES]) {
  const label = from ? `copy of ${from.name}` : "blank";
  let out;
  try { out = addTexture(src, "zzNew", newTextureText(src, "zzNew", from)); } catch (e) { check(false, `new texture (${label}): ${e.message}`); continue; }
  const t = listTextures(out).find((x) => x.name === "zzNew");
  check(t && t.sigs[0] === "strokeZzNew" && (t.sigs.length === 1 || t.sigs[1] === "brushZzNew"), `new texture (${label}): listed as ${JSON.stringify(t?.sigs)}`);
  check(out.startsWith(src.slice(0, src.indexOf("/** Texture name -> its stroke"))), `new texture (${label}): bytes before the insert changed`);
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out).toString("base64")}`);
  const values = {};
  for (const p of parseAllDefaults(out, t.sigs)) values[p.key] = p.value;
  try {
    const { bodyLines } = buildGcode(mod, t, values, PLACEMENT, SETTINGS);
    check(bodyLines.length > 0, `new texture (${label}): no gcode`);
    if (from) {
      const orig = buildGcode(TF, from, fullValues(from), PLACEMENT, SETTINGS).bodyLines;
      check(bodyLines.join("\n") === orig.join("\n"), `new texture (${label}): copy prints differently from the original`);
    }
  } catch (e) { check(false, `new texture (${label}): ${e.message}`); }
}
{
  const blank = newTextureText(src, "zzNew");
  check(throws(() => addTexture(src, "solid", newTextureText(src, "solid"))), "a taken texture name accepted");
  check(throws(() => addTexture(src, "zzNew", blank + "\n\n" + functionText(src, "brushSolid"))), "a function already in the file accepted");
  check(throws(() => addTexture(src, "zzNew", blank.replace("export function", "function"))), "a texture without an exported stroke accepted");
  check(throws(() => addTexture(src, "zzNew", blank + "\n\nconst x = 1;")), "code outside functions accepted");
  check(throws(() => addTexture(src, "9bad", blank)), "a bad texture name accepted");
}

console.log("2. patch roundtrip");
for (const t of TEXTURES) {
  for (const p of parseAllDefaults(src, t.sigs)) {
    if (p.required) continue;
    const newValue = typeof p.value === "number" ? p.value + (p.raw.includes(".") ? 1.5 : 1)
      : p.value === null ? 3 : typeof p.value === "string" ? `${p.value}x` : !p.value;
    const patched = patchAllDefaults(src, t.sigs, { [p.key]: newValue });
    const reparsed = defaultsObject(patched, p.fn);
    check(reparsed[p.key] === newValue, `${t.name}.${p.key}: patched to ${newValue}, reads ${reparsed[p.key]}`);
    const before = src.slice(0, p.valueStart), after = src.slice(p.valueEnd);
    check(patched.startsWith(before) && patched.endsWith(after), `${t.name}.${p.key}: bytes outside the literal changed`);
    const restored = patchAllDefaults(patched, t.sigs, { [p.key]: p.value });
    check(restored === src, `${t.name}.${p.key}: patching back did not restore the file`);
  }
}
check(patchDefaults(src, "strokeSolid", { nLayers: 3 }).includes("nLayers = 3,"), "integer literal stays integer");
check(patchDefaults(src, "strokeDotted", { gap: 6 }).includes("gap = 6.0,"), "float-style literal stays float-style");
check(!parseDefaults(src, "strokeDotted").some((p) => p.key.startsWith(".")), "...brush read as an option");
{
  // a brush option lands in the brush, a walk option in the stroke
  const t = TEXTURES.find((x) => x.name === "dotted");
  const out = patchAllDefaults(src, t.sigs, { gap: 7, dotRadius: 1.2 });
  check(defaultsObject(out, "strokeDotted").gap === 7 && defaultsObject(out, "brushSpiralDot").dotRadius === 1.2,
    "patchAllDefaults wrote to the wrong function");
  const d = TEXTURES.find((x) => x.name === "directionalBlobDotted");
  check(parseAllDefaults(src, d.sigs).filter((p) => p.key === "azimuthDeg").map((p) => p.fn).join() === "strokeDirectionalBlobDotted",
    "a key in both functions should belong to the stroke");
}

console.log("3. parity with direct library calls");
for (const t of TEXTURES) {
  const values = fullValues(t);
  const { bodyLines } = buildGcode(TF, t, values, PLACEMENT, SETTINGS);

  const em = new TF.Emitter();
  em.z = SETTINGS.startZ; em.retracted = true; em.newPattern();
  const direct = {};
  const { x0, y0, x1, y1 } = PLACEMENT;
  TF.BRUSHES[t.fn](em, TF.polylineToPts([[x0, y0], [x1, y1]], 0.1), direct);
  em.retract();
  check(bodyLines.join("\n") === em.lines.join("\n"), `${t.name}: panel output differs from direct call`);
}

console.log("4. valid G-code");
for (const t of TEXTURES) {
  const { lines } = buildGcode(TF, t, fullValues(t), PLACEMENT,
    { ...SETTINGS, flowPercent: 180, zOffset: 1.2 });
  const bad = lines.find((l) => !gcodeCheck.includes(l.split(";")[0].trim().split(" ")[0]));
  check(!bad, `${t.name}: "${bad}" fails checkGcode`);
  const oob = findOutOfBounds(lines, TF.BED_X, TF.BED_Y);
  check(!oob, `${t.name}: off the bed: ${oob}`);
  check(lines.at(-1) === "M221 S100", `${t.name}: flow not restored`);
}

console.log("5. function swap");
for (const t of TEXTURES) for (const sig of t.sigs) {
  const text = functionText(src, sig);
  const r = functionRange(src, sig);
  check(text.trimEnd().endsWith("}"), `${t.name}: ${sig} text does not end at its closing brace`);
  check(replaceFunction(src, sig, text) === src, `${t.name}: replacing ${sig} with itself changed the file`);
  check(replaceFunction(src, sig, `\n  ${text}\n\n`) === src, `${t.name}: surrounding whitespace leaked into the file`);
  const edited = `${text.slice(0, -1)}  // edited\n}`;
  const out = replaceFunction(src, sig, edited);
  check(out.startsWith(src.slice(0, r.start)) && out.endsWith(src.slice(r.end)), `${t.name}: bytes outside ${sig} changed`);
  check(functionText(out, sig) === edited, `${t.name}: edited text did not round-trip`);
  check(src.split("\n")[functionStartLine(src, sig) - 1].includes(`function ${sig}`), `${t.name}: start line wrong`);
}
const dotted = functionText(src, "strokeDotted");
check(throws(() => replaceFunction(src, "strokeDotted", dotted.replace("strokeDotted", "strokeDotted2"))), "renamed function accepted");
check(throws(() => replaceFunction(src, "strokeDotted", dotted + "\nconst x = 1;")), "extra code after the function accepted");
check(throws(() => replaceFunction(src, "strokeDotted", dotted.replace(/^export\s+/, ""))), "dropping export accepted");
check(throws(() => replaceFunction(src, "brushBlobDot", "export " + functionText(src, "brushBlobDot"))), "adding export accepted");
check(!throws(() => replaceFunction(src, "strokeDotted", "// note\n" + dotted)), "leading comment rejected");

// function groups: what the editor shows -- the sig, its table entry, and every helper they call
const groupFor = (t) => relatedFunctions(src, [...new Set([tableFunction(src, "BRUSHES", t.fn), ...t.sigs])]);
for (const t of TEXTURES) {
  const names = groupFor(t);
  check(names[0] === t.sigs[0] && names[1] === t.sigs[1], `${t.name}: group does not start with ${t.sigs.join(", ")}`);
  const text = groupText(src, names);
  check(replaceGroup(src, names, text) === src, `${t.name}: replacing the group with itself changed the file`);
  const last = names.at(-1);
  const edited = text.replace(/\}$/, "  // edited\n}");
  const out = replaceGroup(src, names, edited);
  check(functionText(out, last).endsWith("// edited\n}"), `${t.name}: edit to helper ${last} did not reach the file`);
}
{
  const hd = TEXTURES.find((x) => x.name === "hairyDotted");
  const names = groupFor(hd);
  check(names.includes("brushHairyDot") && names.includes("resolveHairDir"), "hairyDotted group misses brushHairyDot / resolveHairDir");
  check(!names.includes("brushSolid") && !names.includes("Emitter"), "hairyDotted group has unrelated functions");
  const text = groupText(src, names);
  check(throws(() => replaceGroup(src, names, text.replace(/\n\n[^]*?function brushHairyDot[^]*$/, ""))), "dropping a helper accepted");
  check(throws(() => replaceGroup(src, names, text + "\n\nfunction notInFile() {}")), "unknown function accepted");
  check(throws(() => replaceGroup(src, names, text + "\n\nconst x = 1;")), "code outside functions accepted");
  check(throws(() => replaceGroup(src, names, text + "\n\n" + functionText(src, "brushHairyDot"))), "duplicate function accepted");
  check(throws(() => replaceGroup(src, names, text.replace("export function strokeHairyDotted", "function strokeHairyDotted"))), "dropping export in a group accepted");
  check(!throws(() => replaceGroup(src, names, text.replace("function brushHairyDot", "// helper\nfunction brushHairyDot"))), "comment between functions rejected");
}
{
  // an edited copy of the whole file imports, and its edit changes the output
  const t = TEXTURES.find((x) => x.name === "dotted");
  const patched = patchDefaults(src, "strokeDotted", { gap: 9 });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(patched).toString("base64")}`);
  const a = buildGcode(TF, t, {}, PLACEMENT, SETTINGS).lines;
  const b = buildGcode(mod, t, {}, PLACEMENT, SETTINGS).lines;
  const c = buildGcode(TF, t, { gap: 9 }, PLACEMENT, SETTINGS).lines;
  check(a.join("\n") !== b.join("\n"), "edited copy produced the same gcode as the original");
  check(b.join("\n") === c.join("\n"), "edited copy's new default not used");
}

console.log("6. edit states");
{
  const F = "function f() { return 1; }", E = "function f() { return 2; }", E2 = "function f() { return 3; }";
  const st = (buf, d, file = F) => editStatus(buf, d, file);
  const can = (s) => Object.entries(s.can).filter(([, v]) => v).map(([k]) => k).sort().join(",");
  let s = st(undefined, undefined);
  check(s.step === 0 && s.label === "unchanged" && can(s) === "", `fresh: ${s.label} [${can(s)}]`);
  s = st(E, undefined);
  check(s.dirty && s.step === 1 && can(s) === "discard,revert,save", `edited: ${s.label} [${can(s)}]`);
  const saved = { base: F, saved: E, savedOk: true };
  s = st(E, saved);
  check(!s.dirty && s.step === 2 && s.label === "saved · not printed" && can(s) === "revert,run", `saved: ${s.label} [${can(s)}]`);
  s = st(E, { ...saved, savedOk: false, savedError: "x" });
  check(s.draft.key === "error" && !s.can.run && !s.can.push && s.can.revert, `error: ${s.label} [${can(s)}]`);
  const printed = { ...saved, printed: E };
  s = st(E, printed);
  check(s.step === 3 && s.label === "printed · not pushed" && can(s) === "push,revert,run", `printed: ${s.label} [${can(s)}]`);
  s = st(E2, printed);
  check(s.dirty && s.step === 1 && !s.can.run && !s.can.push && s.draft.key === "printed", `edit after print: ${s.label} [${can(s)}]`);
  s = st(E2, { ...printed, saved: E2, savedOk: true });
  check(s.step === 2 && !s.can.push, `re-saved after print needs a new print: ${s.label} [${can(s)}]`);
  s = st(E, printed, "function f() { return 0; }");
  check(s.draft.stale && !s.can.push && s.can.run, `stale: push must be blocked [${can(s)}]`);
  s = st(E, { pushedText: E, pushedAt: 1 }, E);
  check(s.step === 4 && s.label === "pushed" && can(s) === "", `pushed: ${s.label} [${can(s)}]`);
  s = st(E2, { pushedText: E, pushedAt: 1 }, E);
  check(s.dirty && s.step === 1 && s.can.save, `edit after push: ${s.label} [${can(s)}]`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
