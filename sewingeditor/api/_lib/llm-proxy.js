// Shared logic for the /api/generate* serverless functions. Files under
// api/_lib/ are excluded from Vercel's routing (the leading underscore),
// so this can be imported without becoming its own endpoint.

export const ALLOWED_MODELS = {
  openai: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
};

async function callOpenAI(apiKey, model, systemPrompt, userMessage, schema, schemaName, maxOutputTokens, effort) {
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
      max_output_tokens: maxOutputTokens,
      reasoning: { effort },
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema,
          strict: true,
        },
      },
    }),
  });
}

async function callAnthropic(apiKey, model, systemPrompt, userMessage, schema, maxOutputTokens, effort, thinking) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      thinking: { type: thinking ? "adaptive" : "disabled" },
      output_config: {
        effort,
        format: { type: "json_schema", schema },
      },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
}

// Handles the full request/response cycle for a generation endpoint: app
// secret gate, input validation, calling the right provider, and relaying
// the response (or a clean error) back to the browser. Callers supply their
// own JSON schema (and its name, used only by OpenAI's structured output
// format) plus optional per-endpoint generation settings — the gcode
// endpoint needs a much larger token budget and more reasoning effort than
// the short, simple action-macro endpoint.
export async function handleGenerateRequest(req, res, schema, schemaName, options = {}) {
  const {
    maxOutputTokens = 8192,
    effort = "medium",
    thinking = false,
  } = options;

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
      ? await callOpenAI(apiKey, model, systemPrompt, userMessage, schema, schemaName, maxOutputTokens, effort)
      : await callAnthropic(apiKey, model, systemPrompt, userMessage, schema, maxOutputTokens, effort, thinking);
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
