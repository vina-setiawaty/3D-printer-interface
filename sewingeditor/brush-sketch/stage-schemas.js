// Per-stage JSON schemas and generation settings for brush-sketch's LLM
// calls. Same conventions as parametric-with-tool/stage-schemas.js: strict
// schemas, complex payloads (the program) carried as JSON strings, and no
// server-side code execution.

const NOTE = {
  type: "object",
  properties: {
    change: { type: "string", description: "which step(s) changed and how, e.g. 'step 3: added a 4mm prime before the rise'" },
    why: { type: "string", description: "the physical reason, one sentence" },
    ref: { type: "string", description: "reference section it rests on, e.g. '§10 blob v8', or empty" },
  },
  required: ["change", "why", "ref"],
  additionalProperties: false,
};

const PROGRAM_STAGE = (what) => ({
  type: "object",
  properties: {
    chat: { type: "string", description: `to the author: ${what}` },
    program: { type: "string", description: "the brush program as a JSON string (see the brush-program reference)" },
    notes: { type: "array", items: NOTE, description: "one per change relative to the input program" },
  },
  required: ["chat", "program", "notes"],
  additionalProperties: false,
});

export const STAGES = {
  interpret: {
    schemaName: "brush_interpret",
    schema: PROGRAM_STAGE("what you understood the sketch to do, and the most important changes"),
    maxOutputTokens: 16384, effort: "medium", thinking: true,
  },
  parameterize: {
    schemaName: "brush_parameterize",
    schema: PROGRAM_STAGE("the params you introduced"),
    maxOutputTokens: 16384, effort: "medium", thinking: true,
  },
  review: {
    schemaName: "brush_review",
    schema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "to the author, most important first" },
        notes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string" }, observation: { type: "string" },
              suggestion: { type: "string" }, ref: { type: "string" },
            },
            required: ["step", "observation", "suggestion", "ref"],
            additionalProperties: false,
          },
        },
      },
      required: ["chat", "notes"],
      additionalProperties: false,
    },
    maxOutputTokens: 8192, effort: "medium", thinking: true,
  },
  document: {
    schemaName: "brush_document",
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "one line for the code comment: what it makes" },
        description: { type: "string", description: "1-3 paragraphs for texture_patterns.md" },
        sequence: { type: "string", description: "one stamp's net G-code sequence in prose" },
        changes: { type: "string", description: "what changed since the previous version and why, or where v1 came from" },
      },
      required: ["summary", "description", "sequence", "changes"],
      additionalProperties: false,
    },
    maxOutputTokens: 8192, effort: "low", thinking: false,
  },
  feedback: {
    schemaName: "brush_feedback",
    schema: {
      type: "object",
      properties: {
        chat: { type: "string" },
        status: { type: "string", description: "one sentence for the Hardware status paragraph" },
        analysis: { type: "string", description: "likely mechanism, 1-3 sentences, hedged" },
        program: { type: "string", description: "proposed next version as a JSON string, or empty" },
        notes: { type: "array", items: NOTE },
      },
      required: ["chat", "status", "analysis", "program", "notes"],
      additionalProperties: false,
    },
    maxOutputTokens: 16384, effort: "medium", thinking: true,
  },
};
