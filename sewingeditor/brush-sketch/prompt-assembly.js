// Prompt assembly for brush-sketch. DOM-free, so tests/brush-sketch/ can
// build every stage's real prompt under node.
//
// Same file rule as parametric-with-tool/prompt-assembly.js: a stage-*.md
// contributes only its ``` fenced block, a ref-*.md is used whole. Limits
// are generated from checks.js, never written into a doc.

import { sketchLimitsText } from "./checks.js";

export const STAGE_DOCS = {
  interpret: ["docs/stage-interpret.md", "docs/ref-brush-program.md", "docs/ref-print-physics.md"],
  parameterize: ["docs/stage-parameterize.md", "docs/ref-brush-program.md"],
  review: ["docs/stage-review.md", "docs/ref-brush-program.md", "docs/ref-print-physics.md"],
  document: ["docs/stage-document.md", "docs/ref-brush-program.md"],
  feedback: ["docs/stage-feedback.md", "docs/ref-brush-program.md", "docs/ref-print-physics.md"],
};
const WITH_LIMITS = new Set(["interpret", "parameterize", "review", "feedback"]);

export const DOC_PATHS = [...new Set(Object.values(STAGE_DOCS).flat())];

export function docText(path, raw) {
  if (!/(^|\/)stage-[^/]*\.md$/.test(path)) return raw;
  const fenced = raw.match(/```([\s\S]*?)```/);
  if (!fenced) throw new Error(`stage doc "${path}" has no \`\`\` fenced prompt block`);
  return fenced[1].trim();
}

const SEP = "\n\n---\n\n";

export function materialText(material) {
  return `SESSION: material = ${material}.` + (material === "PLA"
    ? " PLA: 205C / 60C / 100% flow; retract feeds up to 2400mm/min."
    : " TPU (the library default): 220C / 50C / 180% firmware flow; retract feeds <= 1000mm/min.");
}

export function composeSystemPrompt(stage, { docs, material = "TPU" }) {
  const paths = STAGE_DOCS[stage];
  if (!paths) throw new Error(`no docs configured for stage "${stage}"`);
  const parts = paths.map((p) => {
    if (docs[p] == null) throw new Error(`prompt doc "${p}" was not loaded`);
    return docs[p];
  });
  if (WITH_LIMITS.has(stage)) parts.push(sketchLimitsText());
  parts.push(materialText(material));
  return parts.join(SEP);
}

const J = (v) => JSON.stringify(v, null, 1);

export function checkReportText(check) {
  if (!check) return "(not checked)";
  const out = [];
  out.push(check.errors?.length ? `ERRORS:\n${check.errors.map((e) => `  - ${e}`).join("\n")}` : "No errors.");
  if (check.warnings?.length) out.push(`WARNINGS:\n${check.warnings.map((w) => `  - ${w}`).join("\n")}`);
  if (check.stats) out.push(`PER STAMP at the current params: ${check.stats.seconds}s, ${check.stats.filamentMm}mm filament, ${check.stats.retracts} retract(s)`);
  return out.join("\n");
}

function repairBlock(repair) {
  if (!repair) return null;
  return "REPAIR: your previous answer was rejected by the page. Fix exactly what is listed and return the whole output again in the same shape.\n\n" +
    `WHAT WAS WRONG:\n${repair.errors.map((e) => `  - ${e}`).join("\n")}` +
    (repair.previous ? `\n\nYOUR PREVIOUS OUTPUT:\n${repair.previous}` : "");
}

/** The user message for a stage. `ctx` fields by stage:
 *   interpret:    intent, draft (program), strokes (summary), check
 *   parameterize: intent, program, check
 *   review:       intent, program, check
 *   document:     intent, program, previous {program, docs} | null, notes, check, digest, version
 *   feedback:     report, program, testFile, docsSoFar */
export function composeUserMessage(stage, ctx, repair = null) {
  const parts = [];
  const r = repairBlock(repair);
  if (r) parts.push(r);
  const intent = `AUTHOR'S INTENT:\n${ctx.intent?.trim() || "(none given)"}`;
  if (stage === "interpret") {
    parts.push(intent);
    parts.push(`LITERAL DRAFT (the sketch, step for step):\n${J(ctx.draft)}`);
    parts.push(`RAW STROKES (resampled; each point is [ms from stroke start, x, y, z, flow 0-5]):\n${J(ctx.strokes)}`);
    parts.push(`PAGE CHECK OF THE LITERAL DRAFT:\n${checkReportText(ctx.check)}`);
  } else if (stage === "parameterize" || stage === "review") {
    parts.push(intent);
    parts.push(`PROGRAM:\n${J(ctx.program)}`);
    parts.push(`PAGE CHECK:\n${checkReportText(ctx.check)}`);
  } else if (stage === "document") {
    parts.push(intent);
    parts.push(`VERSION: ${ctx.version}`);
    parts.push(`PROGRAM:\n${J(ctx.program)}`);
    parts.push(`HOW THE SKETCH WAS INTERPRETED (notes):\n${ctx.notes?.length ? ctx.notes.map((n) => `  - ${n.change} -- ${n.why}`).join("\n") : "  (drawn directly, not interpreted)"}`);
    parts.push(`PAGE CHECK:\n${checkReportText(ctx.check)}`);
    parts.push(`TEST PRINT DIGEST:\n${ctx.digest || "(none)"}`);
    if (ctx.previous) {
      parts.push(`PREVIOUS VERSION'S PROGRAM:\n${J(ctx.previous.program)}`);
      parts.push(`DOCUMENTATION SO FAR:\n${ctx.previous.docs || "(none)"}`);
    }
  } else if (stage === "feedback") {
    parts.push(`AUTHOR'S REPORT, VERBATIM:\n${ctx.report}`);
    parts.push(`PROGRAM THAT WAS PRINTED (version ${ctx.program?.version ?? "?"}):\n${J(ctx.program)}`);
    parts.push(`TEST FILE: ${ctx.testFile || "(unknown)"}`);
    parts.push(`DOCUMENTATION SO FAR:\n${ctx.docsSoFar || "(none)"}`);
  } else {
    throw new Error(`unknown stage "${stage}"`);
  }
  return parts.join("\n\n");
}
