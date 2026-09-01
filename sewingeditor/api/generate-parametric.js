// Vercel serverless function for the parametric tactile-graphic page
// (parametric.html / parametric.js). Unlike the other two gcode flows, the
// model here does NOT return G-code — it returns an ordered list of
// `texture_functions.js` CALLS (function name + geometry + options), which
// the browser executes locally against a pinned copy of that library to
// produce the G-code. Editing a parameter in the UI re-runs the call list
// with no round-trip; only a chat message hits this endpoint.
//
// This flow is multi-turn: the request body carries `messages` (the whole
// transcript) instead of a single `userMessage`. `handleGenerateRequest`
// in ./_lib/llm-proxy.js accepts either shape.
//
// Required Vercel project environment variables: see generate.js.

import { handleGenerateRequest } from "./_lib/llm-proxy.js";

// Same reasoning as generate-gcode.js: reasoning-heavy task, well past
// Vercel's default function timeout. 60s is the Hobby-plan ceiling.
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
            description: "an allowlisted texture_functions.js name from catalog.md (a freeform* line style, a *Dot, or 'fill')",
          },
          geometry: {
            type: "string",
            description: "JSON string. Line style: {\"path\": <path spec>}. Dot: {\"at\": [cx,cy]}. Fill: {\"region\": {x0,y0,w,h}, \"fillStyle\": \"<name>\"}.",
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
  });
}
