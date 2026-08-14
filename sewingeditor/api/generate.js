// Vercel serverless function for generating full "actions" (see
// sewingeditor/actions.js): name/description/variables/gcode/explanation.
// Shared provider-calling logic lives in ./_lib/llm-proxy.js — this file
// only owns the schema for this endpoint.
//
// Required Vercel project environment variables:
//   APP_SECRET        - a password of your choosing; gates this public
//                        endpoint so only your frontend can spend your budget
//   OPENAI_API_KEY    - required if you use the OpenAI provider
//   ANTHROPIC_API_KEY - required if you use the Anthropic provider
// You only need to set the key(s) for the provider(s) you actually use.

import { handleGenerateRequest } from "./_lib/llm-proxy.js";

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "short lowercase alphanumeric identifier, no spaces or symbols" },
    description: { type: "string" },
    variables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "must start with __ and contain only letters/digits, e.g. __z" },
          default: { type: "number" },
        },
        required: ["key", "default"],
        additionalProperties: false,
      },
    },
    gcode: {
      type: "array",
      items: { type: "string" },
      description: "one G/M/T-code command per line",
    },
    explanation: {
      type: "string",
      description: "a short, conversational explanation (a few hundred words max) of what this action does, why it was designed this way, and any warnings the user should know before running it on hardware",
    },
  },
  required: ["name", "description", "variables", "gcode", "explanation"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  return handleGenerateRequest(req, res, ACTION_SCHEMA, "action");
}
