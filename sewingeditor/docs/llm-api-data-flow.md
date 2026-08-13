# LLM API Data Flow

How a click on "generate with AI" turns into a saved action. There are two chained API calls: browser → proxy, then proxy → LLM provider.

## Hop 1: Browser → proxy (`POST /api/generate`)

**Request** — built by `buildRequestBody()` in `sewingeditor/llm.js`:

| Field | Type | Content |
|---|---|---|
| `provider` | `string` | `"openai"` or `"anthropic"` |
| `model` | `string` | e.g. `"gpt-5.6-terra"` or `"claude-sonnet-5"` |
| `systemPrompt` | `string` | the whole instruction block from `buildSystemPrompt()` — the g-code whitelist + syntax rules + the `simple-up-down` few-shot example; full text in [llm-system-prompt.md](llm-system-prompt.md) |
| `userMessage` | `string` | `buildUserMessage()` — a stringified JSON snapshot of the current Manual-tab form, followed by the typed instruction |

Header: `x-app-secret: <app password>`.

The `userMessage` string embeds this object (from `collectManualFormState()`):
```ts
{
  name: string,
  description: string,
  variables: { key: string, default: number }[],
  gcode: string[]   // current lines in the GCode textarea
}
```

**Response** — on success, the proxy relays the *entire raw upstream response* back verbatim (`api/generate.js`, `res.status(200).json(data)`) — so what the browser gets here is literally whatever OpenAI or Anthropic returned (see Hop 2's output below). On failure, it's `{ error: string }` with a matching HTTP status.

## Hop 2: Proxy → the LLM provider

### If `provider === "openai"` → `POST https://api.openai.com/v1/responses`

**Input:**
```json
{
  "model": "gpt-5.6-terra",
  "instructions": "<systemPrompt — see llm-system-prompt.md>",
  "input": "<userMessage>",
  "max_output_tokens": 8192,
  "reasoning": { "effort": "medium" },
  "text": {
    "format": { "type": "json_schema", "name": "action", "schema": ACTION_SCHEMA, "strict": true }
  }
}
```
Auth: `authorization: Bearer <OPENAI_API_KEY>`.

**Output** (fields the app reads, per `extractResponseOutput()`):
- `output: []` — array of items; walked for one with `type: "message"`, then its `content: []` for a block of `type: "output_text"` (→ `.text`, the generated JSON string) or `type: "refusal"` (→ `.refusal`, a string).
- `status` / `incomplete_details.reason` — used by `wasTruncated()` to detect a token-limit cutoff.
- `usage: { input_tokens: number, output_tokens: number, ... }` — feeds the cost tracker.

### If `provider === "anthropic"` → `POST https://api.anthropic.com/v1/messages`

**Input:**
```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 8192,
  "thinking": { "type": "disabled" },
  "output_config": {
    "effort": "medium",
    "format": { "type": "json_schema", "schema": ACTION_SCHEMA }
  },
  "system": "<systemPrompt — see llm-system-prompt.md>",
  "messages": [{ "role": "user", "content": "<userMessage>" }]
}
```
Auth: `x-api-key: <ANTHROPIC_API_KEY>` + `anthropic-version: 2023-06-01`.

**Output:**
- `content: []` — the block with `type: "text"` → `.text` is the generated JSON string.
- `stop_reason` — `"max_tokens"` is what `wasTruncated()` checks for.
- `usage: { input_tokens: number, output_tokens: number, ... }` — same field names as OpenAI.

## The final payload

Both providers are constrained by the same `ACTION_SCHEMA` (defined in `api/generate.js`), so once `extractResponseOutput()`'s `.text` string is `JSON.parse()`d, the result is an identical shape regardless of provider:
```ts
{
  name: string,
  description: string,
  variables: { key: string, default: number }[],
  gcode: string[],
  explanation: string   // chat-style summary of what was generated, why, and any caveats
}
```
`validateGeneratedAction()` checks `variables`/`gcode`, `applyResultToManualForm()` writes `name`/`description`/`variables`/`gcode` into the Manual-tab DOM fields, and `explanation` is rendered as-is into `#llm-explanation`.
