// Shared logic for the /api/generate* serverless functions. Files under
// api/_lib/ are excluded from Vercel's routing (the leading underscore),
// so this can be imported without becoming its own endpoint.

export const ALLOWED_MODELS = {
  openai: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
  anthropic: ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"],
};

export const ALLOWED_EFFORTS = ["low", "medium", "high"];

async function callOpenAI(apiKey, model, systemPrompt, messages, schema, schemaName, maxOutputTokens, effort) {
  return fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      // A lone user turn (the single-turn flows) is passed as a bare string,
      // exactly as before. A real transcript (the multi-turn parametric
      // flow) is passed as Responses `input` items with typed content parts
      // — `input_text` for user turns, `output_text` for replayed assistant
      // turns.
      input: (messages.length === 1 && messages[0].role === "user")
        ? messages[0].content
        : messages.map(m => ({
            role: m.role,
            content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
          })),
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

async function callAnthropic(apiKey, model, systemPrompt, messages, schema, maxOutputTokens, effort, thinking, codeExecution) {
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
      messages,
      ...(codeExecution ? { tools: [{ type: "code_execution_20260120", name: "code_execution" }] } : {}),
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
    effort: defaultEffort = "medium",
    thinking: thinkingCapable = false,
    codeExecution = false,
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

  const { provider, model, systemPrompt, userMessage, messages: requestedMessages, effort: requestedEffort, thinking: requestedThinking } = req.body || {};
  if (provider !== "openai" && provider !== "anthropic") {
    res.status(400).json({ error: "provider must be 'openai' or 'anthropic'" });
    return;
  }
  if (!ALLOWED_MODELS[provider].includes(model)) {
    res.status(400).json({ error: `model must be one of: ${ALLOWED_MODELS[provider].join(", ")}` });
    return;
  }
  if (requestedEffort !== undefined && !ALLOWED_EFFORTS.includes(requestedEffort)) {
    res.status(400).json({ error: `effort must be one of: ${ALLOWED_EFFORTS.join(", ")}` });
    return;
  }
  if (requestedThinking !== undefined && typeof requestedThinking !== "boolean") {
    res.status(400).json({ error: "thinking must be a boolean" });
    return;
  }
  const effort = requestedEffort || defaultEffort;
  // Extended thinking is the largest single latency cost on a slow endpoint
  // like generate-gcode. A caller that exposes its own thinking toggle sends
  // an explicit boolean; one that doesn't (or omits it) falls back to only
  // paying for it at "high" effort, so effort alone still buys a faster
  // response on its own. Either way it's gated on thinkingCapable, since an
  // endpoint that never asked for it (e.g. generate.js) shouldn't have a
  // client be able to turn it on.
  const thinking = thinkingCapable && (requestedThinking !== undefined ? requestedThinking : effort === "high");
  if (typeof systemPrompt !== "string") {
    res.status(400).json({ error: "systemPrompt is a required string" });
    return;
  }

  // A caller supplies EITHER a `userMessage` string (single-turn flows) or a
  // `messages` array of {role, content} turns (multi-turn flows). Normalize
  // both to the array the provider callers now expect.
  let messages;
  if (Array.isArray(requestedMessages)) {
    const roleOk = (r) => r === "user" || r === "assistant";
    if (requestedMessages.length === 0 ||
        !requestedMessages.every(m => m && roleOk(m.role) && typeof m.content === "string" && m.content.trim())) {
      res.status(400).json({ error: "messages must be a non-empty array of {role: 'user'|'assistant', content: non-empty string}" });
      return;
    }
    if (requestedMessages[requestedMessages.length - 1].role !== "user") {
      res.status(400).json({ error: "the last message must have role 'user'" });
      return;
    }
    messages = requestedMessages.map(m => ({ role: m.role, content: m.content }));
  } else if (typeof userMessage === "string" && userMessage.trim()) {
    messages = [{ role: "user", content: userMessage }];
  } else {
    res.status(400).json({ error: "either userMessage (string) or messages (array) is required" });
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
      ? await callOpenAI(apiKey, model, systemPrompt, messages, schema, schemaName, maxOutputTokens, effort)
      : await callAnthropic(apiKey, model, systemPrompt, messages, schema, maxOutputTokens, effort, thinking, codeExecution);
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

  // Server-side tool loops (code_execution) cap at 10 internal iterations
  // before pausing; resuming means another full round trip, which this
  // endpoint's maxDuration budget almost certainly can't absorb on top of
  // what already ran. Fail clearly instead of relaying a response with no
  // finished answer in it.
  if (provider === "anthropic" && data.stop_reason === "pause_turn") {
    res.status(502).json({ error: "verification step didn't finish in time — try a simpler request" });
    return;
  }

  res.status(200).json(data);
}
