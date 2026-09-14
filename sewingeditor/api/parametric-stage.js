// The LLM-call endpoint for parametric-with-tool.html (replaces
// generate-parametric-tool.js). The browser orchestrates the pipeline and
// calls this once per call with `stage` in the body; each stage gets its
// own JSON schema and generation settings, and its own 60s function budget:
//
//   route            cheap intent classifier: which stage(s) to run, a
//                    self-contained instruction, target element ids
//   geometry         element definitions (line x(t)/y(t) or point list,
//                    region boundary pieces, points) -- plain generation
//   geometry-check   reviews a just-generated element list against a
//                    DETERMINISTIC report the app computed from that exact
//                    geometry (bbox, closure, chart-role tables); returns
//                    ok, or a patch of just the elements that need fixing
//   texture          per element slot: brush/stamp + fill pattern
//   texture-check    same idea for a free-form fill pattern (stamps/
//                    strokes/curves/family), against the app's stroke/
//                    stamp counts for the compiled pattern
//   parameters       option values + parameter abstractions
//
// The *-check stages replace an earlier design that asked the generation
// call itself to self-verify with Anthropic's server-side code_execution
// tool: that tool loop competes with the JSON answer for the same token
// and time budget, so a long element list could truncate mid-object
// (invalid JSON) or blow the 60s maxDuration. Splitting generation from
// review into two plain (non-tool) calls fixes both: generation gets its
// full budget, and the review call is handed the app's own exact numbers
// instead of asking the model to reconstruct them in a sandbox -- cheaper,
// faster, and provider-agnostic (no Anthropic-only tool).
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
