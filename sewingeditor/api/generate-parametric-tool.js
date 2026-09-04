// EXPERIMENTAL variant of generate-parametric.js for
// parametric-with-tool.html. Identical except codeExecution:true, which
// hands the model Anthropic's server-side code_execution tool so it can
// numerically self-check its planned geometry (does the reconstructed shape
// actually read as what was asked for — right chart type, proportions,
// ordering) before finalizing its answer. See ./_lib/llm-proxy.js for how
// the flag is wired, and sewingeditor/parametric/parametric_docs/
// system-prompt.md's "CHECK APPROPRIATENESS" section (appended by
// parametric-with-tool.js) for what the model is told to do with it.
//
// OpenAI requests through this endpoint get no self-check — code_execution
// here is Anthropic-only.
//
// Required Vercel project environment variables: see generate.js.

import { handleGenerateRequest } from "./_lib/llm-proxy.js";

// Same reasoning as generate-parametric.js: reasoning-heavy task, well past
// Vercel's default function timeout. 60s is the Hobby-plan ceiling — the
// code_execution self-check adds real latency risk on top of that; see the
// pause_turn handling in llm-proxy.js.
export const config = {
  maxDuration: 60,
};

// geometry and options travel as JSON *strings* (parsed + validated
// client-side against parametric-catalog.js), so the schema stays flat and
// provider-agnostic — no discriminated union, no open-ended object, nothing
// a strict json_schema mode can choke on.
const PARAMETRIC_SCHEMA = {
  type: "object",
  properties: {
    chat: {
      type: "string",
      description: "conversational reply: what was built or changed, assumptions made, and anything to check on real hardware",
    },
    calls: {
      type: "array",
      description: "the FULL ordered list of texture_functions.js calls composing the graphic (not a diff); may be empty",
      items: {
        type: "object",
        properties: {
          fn: {
            type: "string",
            description: "an allowlisted texture_functions.js name from reference-distilled.md (a freeform* line style, a *Dot, or 'fill')",
          },
          geometry: {
            type: "string",
            description: "JSON string. Line style: {\"path\": {\"x\": \"<expr in t>\", \"y\": \"<expr in t>\", \"tEnd\": <number>}} -- x(t)/y(t) over t in [0,tEnd]. Dot: {\"at\": [cx,cy]}. Fill: {\"region\": {x0,y0,w,h}, \"fillStyle\": \"<name>\"} OR {\"boundary\": {\"x\":..., \"y\":..., \"tEnd\":...} (must be a CLOSED curve), \"fillStyle\": \"<name>\"} (DIAMOND requires \"region\", not \"boundary\").",
          },
          options: {
            type: "string",
            description: "JSON string: { optionName: value } using only names listed for this fn in catalog.md; omit any left at default. Use \"{}\" for none.",
          },
          label: {
            type: "string",
            description: "short human label for the parameter panel, e.g. 'top edge - solid line' or 'dot 3'",
          },
        },
        required: ["fn", "geometry", "options", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["chat", "calls"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  return handleGenerateRequest(req, res, PARAMETRIC_SCHEMA, "parametric_graphic", {
    maxOutputTokens: 32768,
    effort: "medium",
    thinking: true,
    codeExecution: true,
  });
}
