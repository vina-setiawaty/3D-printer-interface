// Vercel serverless function. Forwards action-generation requests to either
// the OpenAI Responses API or the Anthropic Messages API, keeping both
// provider keys server-side.
//
// Required Vercel project environment variables:
//   APP_SECRET        - a password of your choosing; gates this public
//                        endpoint so only your frontend can spend your budget
//   OPENAI_API_KEY    - required if you use the OpenAI provider
//   ANTHROPIC_API_KEY - required if you use the Anthropic provider
// You only need to set the key(s) for the provider(s) you actually use.

const ALLOWED_MODELS = {
  openai: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
};

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

async function callOpenAI(apiKey, model, systemPrompt, userMessage) {
  return fetch("https://api.openai.com/v1/responses", {
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
}

async function callAnthropic(apiKey, model, systemPrompt, userMessage) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      thinking: { type: "disabled" },
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: ACTION_SCHEMA },
      },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const appSecret = process.env.APP_SECRET;
  if (!appSecret) {
    res.status(500).json({ error: "proxy is not configured (missing APP_SECRET)" });
    return;
  }
  if (req.headers["x-app-secret"] !== appSecret) {
    res.status(401).json({ error: "invalid app password" });
    return;
  }

  const { provider, model, systemPrompt, userMessage } = req.body || {};
  if (provider !== "openai" && provider !== "anthropic") {
    res.status(400).json({ error: "provider must be 'openai' or 'anthropic'" });
    return;
  }
  if (!ALLOWED_MODELS[provider].includes(model)) {
    res.status(400).json({ error: `model must be one of: ${ALLOWED_MODELS[provider].join(", ")}` });
    return;
  }
  if (typeof systemPrompt !== "string" || typeof userMessage !== "string" || !userMessage.trim()) {
    res.status(400).json({ error: "systemPrompt and userMessage are required strings" });
    return;
  }

  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const envVarName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    res.status(500).json({ error: `proxy is not configured (missing ${envVarName})` });
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = provider === "openai"
      ? await callOpenAI(apiKey, model, systemPrompt, userMessage)
      : await callAnthropic(apiKey, model, systemPrompt, userMessage);
  } catch (e) {
    res.status(502).json({ error: `could not reach ${provider}: ${e.message}` });
    return;
  }

  let data;
  try {
    data = await upstreamResponse.json();
  } catch (e) {
    res.status(502).json({ error: `${provider} returned a response that wasn't valid JSON` });
    return;
  }

  if (!upstreamResponse.ok) {
    const detail = (data && data.error && data.error.message) ? data.error.message : `HTTP ${upstreamResponse.status}`;
    res.status(upstreamResponse.status).json({ error: detail });
    return;
  }

  res.status(200).json(data);
}
