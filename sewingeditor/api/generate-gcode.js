// Vercel serverless function for generating raw, ready-to-run G-code for
// the "Raw gcode" box (see sewingeditor/script.js) — a plain list of gcode
// lines plus an explanation. Unlike actions (generate.js), this has no
// __variable placeholders or {} expressions: every value must be a
// concrete literal, since the raw-gcode runner (#run-gcode-btn) does no
// substitution at all. Shared provider-calling logic lives in
// ./_lib/llm-proxy.js — this file only owns the schema and generation
// settings for this endpoint.
//
// This endpoint is tuned for generating whole tactile-graphic print jobs
// (many geometric strokes, each expanded into several gcode lines with
// real extrusion math), which is both much longer output and a much more
// arithmetic/spatial-reasoning-heavy task than the short action-macro
// endpoint — hence the larger token budget and higher reasoning effort.
//
// Required Vercel project environment variables: see generate.js.

import { handleGenerateRequest } from "./_lib/llm-proxy.js";

// This endpoint's max token budget + effort/thinking settings make it the
// slowest generation call in the app, and Vercel's default function timeout
// (10s on Hobby, 15s on Pro) is nowhere near enough for it — that mismatch
// is what FUNCTION_INVOCATION_TIMEOUT means when it shows up in the raw
// proxy-response preview in llm-gcode.js. 60s is the highest value the
// Hobby plan allows; raise it further here if still timing out on a paid
// plan with a higher cap.
export const config = {
  maxDuration: 60,
};

const GCODE_SCHEMA = {
  type: "object",
  properties: {
    gcode: {
      type: "array",
      items: { type: "string" },
      description: "one complete, ready-to-run G/M/T-code command per line — concrete literal values only, no __variable placeholders or {} expressions",
    },
    explanation: {
      type: "string",
      description: "a short, conversational explanation (a few hundred words max): what this gcode physically does, the one or two things most likely to go wrong on real hardware and which technique already mitigates them, and any technique deliberately skipped and why",
    },
  },
  required: ["gcode", "explanation"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  // Complex multi-feature tactile graphics can run to hundreds or low
  // thousands of gcode lines — raise this further if generation still gets
  // truncated (see wasTruncated() in llm-gcode.js) on very large graphics.
  return handleGenerateRequest(req, res, GCODE_SCHEMA, "gcode", {
    maxOutputTokens: 32768,
    effort: "medium",
    thinking: true,
  });
}
