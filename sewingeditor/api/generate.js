// Vercel serverless function. Forwards action-generation requests to the
// OpenAI Responses API, keeping OPENAI_API_KEY server-side.
//
// Required Vercel project environment variables:
//   OPENAI_API_KEY - real OpenAI API key, never sent to the browser
//   APP_SECRET     - a password of your choosing; gates this public
//                    endpoint so only your frontend can spend your key

const ALLOWED_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

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
  },
  required: ["name", "description", "variables", "gcode"],
  additionalProperties: false,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const appSecret = process.env.APP_SECRET;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!appSecret || !apiKey) {
    res.status(500).json({ error: "proxy is not configured (missing APP_SECRET or OPENAI_API_KEY)" });
    return;
  }

  if (req.headers["x-app-secret"] !== appSecret) {
    res.status(401).json({ error: "invalid app password" });
    return;
  }

  const { model, systemPrompt, userMessage } = req.body || {};
  if (!ALLOWED_MODELS.includes(model)) {
    res.status(400).json({ error: `model must be one of: ${ALLOWED_MODELS.join(", ")}` });
    return;
  }
  if (typeof systemPrompt !== "string" || typeof userMessage !== "string" || !userMessage.trim()) {
    res.status(400).json({ error: "systemPrompt and userMessage are required strings" });
    return;
  }

  let openaiResponse;
  try {
    openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions: systemPrompt,
        input: userMessage,
        max_output_tokens: 2048,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "action",
            schema: ACTION_SCHEMA,
            strict: true,
          },
        },
      }),
    });
  } catch (e) {
    res.status(502).json({ error: `could not reach OpenAI: ${e.message}` });
    return;
  }

  let data;
  try {
    data = await openaiResponse.json();
  } catch (e) {
    res.status(502).json({ error: "OpenAI returned a response that wasn't valid JSON" });
    return;
  }

  if (!openaiResponse.ok) {
    const detail = (data && data.error && data.error.message) ? data.error.message : `HTTP ${openaiResponse.status}`;
    res.status(openaiResponse.status).json({ error: detail });
    return;
  }

  res.status(200).json(data);
}
