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

import { handleGenerateRequest } from "./_lib/llm-proxy.js";

export const config = {
  maxDuration: 60,
};

const chat = (what) => ({ type: "string", description: `conversational reply: ${what}` });

// Shared by "geometry" (the full ordered list) and "geometry-check" (a
// patch of just the elements that need fixing) -- same per-element shape.
const GEOMETRY_ELEMENT_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "el_N; reuse the existing id for an element you keep, modify, or fix, empty for a brand-new one" },
    label: { type: "string", description: "short human label, e.g. 'x axis', 'bar 2', 'shaded area'" },
    kind: { type: "string", enum: ["line", "region", "point"] },
    role: { type: "string", description: "chart role for the report: axis | tick | curve | bar | marker | label | other" },
    geometry: { type: "string", description: "JSON string. line, ONE stroke: {\"path\": <piece>}. line, a GROUP of several disconnected strokes sharing this one element's texture (e.g. all the axis's tick marks as one element): {\"paths\": [<piece>, <piece>, ...]}. region: {\"boundary\": [<piece>, ...]} concatenated in order and closed. point, ONE stamp: {\"at\": [x, y]}. point, a GROUP of several stamps sharing this one element's texture (e.g. a row of data markers): {\"at\": [[x,y], [x,y], ...]}. A piece is {\"x\": \"<expr in t>\", \"y\": \"<expr in t>\", \"tEnd\": n} OR {\"points\": [[x,y], ...]} OR {\"ref\": \"<line element id>\", \"tFrom\": n, \"tTo\": n, \"reverse\": bool} (ref only targets a single-stroke \"path\" line, not a \"paths\" group)." },
  },
  required: ["id", "label", "kind", "role", "geometry"],
  additionalProperties: false,
};

// Shared by "texture" (one entry per slot set/cleared) and "texture-check"
// (a patch of just the slots that need fixing).
const TEXTURE_ITEM = {
  type: "object",
  properties: {
    elementId: { type: "string" },
    slot: { type: "string", enum: ["brush", "outline", "fill"], description: "line/point: brush. region: outline (a line brush along the boundary) and/or fill (a pattern + brush)" },
    fn: { type: "string", description: "brush or stamp name from the reference; empty string clears the slot" },
    pattern: { type: "string", description: "fill slot only: JSON string of the pattern spec, e.g. {\"kind\": \"hatch\", \"angleDeg\": 45, \"gap\": 4}; empty otherwise" },
  },
  required: ["elementId", "slot", "fn", "pattern"],
  additionalProperties: false,
};

const STAGES = {
  route: {
    schemaName: "parametric_route",
    schema: {
      type: "object",
      properties: {
        route: { type: "string", enum: ["geometry", "texture", "parameters", "chat"], description: "which stage the request enters (geometry runs texture and parameters after it; texture runs parameters after it); 'chat' answers without changing the scene" },
        instruction: { type: "string", description: "the user's request rewritten so it is self-contained: resolve 'this', 'the second bar', 'again' into element ids and concrete asks; empty when route is chat" },
        targets: { type: "array", items: { type: "string" }, description: "element ids the request is about (empty = the whole scene)" },
        reply: { type: "string", description: "when route is chat: the answer or clarifying question; otherwise a one-line note of what will be done" },
      },
      required: ["route", "instruction", "targets", "reply"],
      additionalProperties: false,
    },
    maxOutputTokens: 2048, effort: "low", thinking: false, codeExecution: false,
  },
  geometry: {
    schemaName: "parametric_geometry",
    schema: {
      type: "object",
      properties: {
        chat: chat("what was built or changed, assumptions, anything the user should check"),
        elements: {
          type: "array",
          description: "the FULL ordered element list (print order), not a diff; keep ids of unchanged elements",
          items: GEOMETRY_ELEMENT_ITEM,
        },
        transform: { type: "string", description: "JSON string {\"scale\": n, \"origin\": [x, y] | null} to change the global placement, or empty to leave it" },
      },
      required: ["chat", "elements", "transform"],
      additionalProperties: false,
    },
    maxOutputTokens: 32768, effort: "medium", thinking: true, codeExecution: false,
  },
  "geometry-check": {
    schemaName: "parametric_geometry_check",
    schema: {
      type: "object",
      properties: {
        chat: chat("what you checked, and what (if anything) you fixed"),
        ok: { type: "boolean", description: "true if the proposed elements are correct and printable as given" },
        elements: {
          type: "array",
          description: "ONLY the elements that need a fix, each a full corrected replacement (same id) -- empty array when ok is true",
          items: GEOMETRY_ELEMENT_ITEM,
        },
      },
      required: ["chat", "ok", "elements"],
      additionalProperties: false,
    },
    maxOutputTokens: 8192, effort: "low", thinking: false, codeExecution: false,
  },
  texture: {
    schemaName: "parametric_texture",
    schema: {
      type: "object",
      properties: {
        chat: chat("which texture and fill each element got and why it will feel distinct"),
        textures: {
          type: "array",
          description: "one entry per element slot you set or clear; omit slots you leave as they are",
          items: TEXTURE_ITEM,
        },
      },
      required: ["chat", "textures"],
      additionalProperties: false,
    },
    maxOutputTokens: 16384, effort: "medium", thinking: true, codeExecution: false,
  },
  "texture-check": {
    schemaName: "parametric_texture_check",
    schema: {
      type: "object",
      properties: {
        chat: chat("what you checked, and what (if anything) you fixed"),
        ok: { type: "boolean", description: "true if every free-form fill actually covers its region as intended" },
        textures: {
          type: "array",
          description: "ONLY the slots that need a fix, each a full corrected replacement -- empty array when ok is true",
          items: TEXTURE_ITEM,
        },
      },
      required: ["chat", "ok", "textures"],
      additionalProperties: false,
    },
    maxOutputTokens: 6144, effort: "low", thinking: false, codeExecution: false,
  },
  parameters: {
    schemaName: "parametric_parameters",
    schema: {
      type: "object",
      properties: {
        chat: chat("what the numbers do and which high-level knobs now exist"),
        options: {
          type: "array",
          description: "option values per element slot (only names listed for that brush/stamp; omit to keep the current value)",
          items: {
            type: "object",
            properties: {
              elementId: { type: "string" },
              slot: { type: "string", enum: ["brush", "outline", "fill"] },
              options: { type: "string", description: "JSON string { optionName: value, ... }" },
            },
            required: ["elementId", "slot", "options"],
            additionalProperties: false,
          },
        },
        abstractions: {
          type: "array",
          description: "the FULL list of high-level parameters (replaces the previous list; keep ids of ones you retain)",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "ab_N; reuse an existing id, empty for a new one" },
              name: { type: "string", description: "short knob name, e.g. hairiness, density, softness" },
              description: { type: "string", description: "one line: what moving it up does" },
              value: { type: "number", description: "current position 0..1 (0.5 = as currently set)" },
              targets: { type: "string", description: "JSON string [{\"elementId\", \"slot\", \"option\", \"weight\": 0..1, \"direction\": 1 | -1}, ...] -- weights should sum to 1; direction +1 = the option rises with the knob" },
            },
            required: ["id", "name", "description", "value", "targets"],
            additionalProperties: false,
          },
        },
      },
      required: ["chat", "options", "abstractions"],
      additionalProperties: false,
    },
    maxOutputTokens: 16384, effort: "medium", thinking: true, codeExecution: false,
  },
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
