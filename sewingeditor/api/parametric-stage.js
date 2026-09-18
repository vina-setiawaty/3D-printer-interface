// The LLM-call endpoint for parametric-with-tool.html (replaces
// generate-parametric-tool.js). The browser orchestrates the pipeline and
// calls this once per call with `stage` in the body; each stage gets its
// own JSON schema and generation settings, and its own 60s function budget:
//
//   route      the manager: which specialist runs, a self-contained
//              instruction, target element ids, acceptance criteria. Also
//              runs in "refine" mode after a failed evaluation, to pick
//              which specialist should try again.
//   geometry   element definitions (line x(t)/y(t) or point list, region
//              boundary pieces or a solved `between` region, points)
//   texture    per element slot: brush/stamp, fill pattern, option values
//   ui         which parameters the panel surfaces, grouped by the tactile
//              attribute they affect
//   judge      reads the finished scene against the acceptance criteria
//              and the app's DETERMINISTIC report, and says which criteria
//              are unmet and which specialist can fix each
//
// An earlier design had the generation call self-verify with Anthropic's
// server-side code_execution tool. That tool loop competes with the JSON
// answer for the same token and time budget, so a long element list could
// truncate mid-object (invalid JSON) or blow the 60s maxDuration. It was
// replaced by per-stage *-check calls, and those in turn by the current
// split: a deterministic gate the app runs itself (schema, ranges, a real
// compile) between calls, and one judge call at the end whose failures go
// back to the manager. No stage requests a tool.
//
// Nested variable shapes (geometry, pattern, options, targets) travel as
// JSON *strings* and are parsed + validated client-side against
// parametric-catalog-with-tool.js, so every schema stays flat and strict-
// mode friendly on both providers. See ./_lib/llm-proxy.js for the proxy
// itself. Required Vercel project environment variables: see generate.js.
//
// LEGACY / FALLBACK PATH: parametric-with-tool.js now calls the providers
// directly from the browser (see its stage-schemas.js import and
// callLlmDirect() in ../llm.js) and no longer hits this endpoint. This file
// is kept working in case a caller wants a server-proxied path again, and
// imports its schemas from ../parametric-with-tool/stage-schemas.js so the
// two can't drift.

import { handleGenerateRequest } from "./_lib/llm-proxy.js";
import { STAGES } from "../parametric-with-tool/stage-schemas.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const stage = req.body && req.body.stage;
  const cfg = STAGES[stage];
  if (!cfg) {
    res.status(400).json({ error: `stage must be one of: ${Object.keys(STAGES).join(", ")}` });
    return;
  }
  return handleGenerateRequest(req, res, cfg.schema, cfg.schemaName, {
    maxOutputTokens: cfg.maxOutputTokens,
    effort: cfg.effort,
    thinking: cfg.thinking,
    codeExecution: cfg.codeExecution,
  });
}
