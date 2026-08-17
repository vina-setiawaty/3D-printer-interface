# LLM API Data Flow

> **Keep this current:** whenever a system prompt (`buildSystemPrompt()` in `llm.js`, `buildGcodeSystemPrompt()` in `llm-gcode.js`, or `buildGcodeSessionSystemPrompt()` in `gcode-session.js`) or an endpoint's generation settings change, update the matching section here and in the linked system-prompt doc in the same change.

There are three independent generation flows in the app, each a click on its own "generate with AI" button. All follow the same two-hop shape — browser → proxy → LLM provider — via shared proxy logic, but each has its own frontend and system prompt (the first two also have their own endpoint/schema; the third reuses the raw-gcode endpoint/schema unchanged):

| Flow | Frontend | Endpoint | Schema | System prompt |
|---|---|---|---|---|
| Action generation | `llm.js`, action editor's LLM panel | `POST /api/generate` | `ACTION_SCHEMA` in `api/generate.js` | [llm-system-prompt.md](llm-system-prompt.md) |
| Raw gcode generation | `llm-gcode.js`, "Raw gcode" panel (`index.html`) | `POST /api/generate-gcode` | `GCODE_SCHEMA` in `api/generate-gcode.js` | [gcode-system-prompt.md](gcode-system-prompt.md) |
| Raw gcode, multi-turn session | `gcode-session.js`, "Raw gcode — printing session" panel (`gcode-session.html`) | `POST /api/generate-gcode` (same endpoint/schema as above — no backend changes for this flow) | `GCODE_SCHEMA` in `api/generate-gcode.js` | [gcode-session-system-prompt.md](gcode-session-system-prompt.md) |

Both endpoints call into the same `handleGenerateRequest()` in `api/_lib/llm-proxy.js` (app-secret gate, input validation, calling the chosen provider, relaying the response) — each just supplies its own schema and generation settings:

| Setting | Action generation | Raw gcode generation | Why they differ |
|---|---|---|---|
| `max_output_tokens` / `max_tokens` | 8192 | 32768 | A tactile graphic can expand into hundreds/thousands of gcode lines; an action macro is a handful of lines. |
| `reasoning.effort` / `output_config.effort` | `medium` | `high` | Gcode generation involves real extrusion-math/spatial reasoning per stroke; actions are short parameterized templates. |
| Anthropic `thinking` | `disabled` | `adaptive` | Same reasoning-load difference as above. |

## Hop 1: Browser → proxy

**Action generation** (`POST /api/generate`) — request built by `buildRequestBody()` in `llm.js`:

| Field | Type | Content |
|---|---|---|
| `provider` | `string` | `"openai"` or `"anthropic"` |
| `model` | `string` | e.g. `"gpt-5.6-terra"` or `"claude-sonnet-5"` |
| `systemPrompt` | `string` | `buildSystemPrompt()` — full text in [llm-system-prompt.md](llm-system-prompt.md) |
| `userMessage` | `string` | `buildUserMessage()` — a stringified JSON snapshot of the current Manual-tab form, followed by the typed instruction |

The `userMessage` string embeds this object (from `collectManualFormState()`):
```ts
{
  name: string,
  description: string,
  variables: { key: string, default: number }[],
  gcode: string[]   // current lines in the action editor's GCode textarea
}
```

**Raw gcode generation** (`POST /api/generate-gcode`) — request built by `buildGcodeRequestBody()` in `llm-gcode.js`, same `provider`/`model` shape, but:

| Field | Type | Content |
|---|---|---|
| `systemPrompt` | `string` | `buildGcodeSystemPrompt()` — full text in [gcode-system-prompt.md](gcode-system-prompt.md) |
| `userMessage` | `string` | `buildGcodeUserMessage()` — a stringified JSON snapshot of the current raw-gcode box, followed by the typed instruction |

The `userMessage` string embeds this object (from `collectGcodeBoxState()`):
```ts
{
  gcode: string[]   // current lines in the "Raw gcode" textarea
}
```

**Raw gcode, multi-turn session** (`POST /api/generate-gcode`, same endpoint as above) — request built by `buildGcodeSessionRequestBody()` in `gcode-session.js`. The wire shape sent to the proxy is **identical** to plain raw-gcode generation (`provider`/`model`/`effort`/`thinking`/`systemPrompt`/`userMessage`, all strings) — no backend change was needed for this flow. `userMessage` itself is also the same shape as above (current textarea content + typed instruction, via `collectGcodeSessionBoxState()`). All of the session-specific context — filament, print temp, Z-start offset, continuity mode, whether the substrate is fresh, the app-chosen prime coordinate for this turn, and a short summary of prior turns — lives entirely in `systemPrompt` instead, rebuilt fresh from client-side session state (`gcodeSession`, persisted to `localStorage["gcodeSessionState"]`) on every call. See [gcode-session-system-prompt.md](gcode-session-system-prompt.md) for how that state shapes the prompt.

Both endpoints require header `x-app-secret: <app password>`, and on success relay the *entire raw upstream response* back verbatim (`res.status(200).json(data)`) — so what the browser gets is literally whatever OpenAI or Anthropic returned (see Hop 2's output below). On failure, both return `{ error: string }` with a matching HTTP status.

## Hop 2: Proxy → the LLM provider

### If `provider === "openai"` → `POST https://api.openai.com/v1/responses`

**Input** (values shown are the action-generation defaults; see the settings table above for the gcode endpoint's values):
```json
{
  "model": "gpt-5.6-terra",
  "instructions": "<systemPrompt>",
  "input": "<userMessage>",
  "max_output_tokens": 8192,
  "reasoning": { "effort": "medium" },
  "text": {
    "format": { "type": "json_schema", "name": "action", "schema": ACTION_SCHEMA, "strict": true }
  }
}
```
`name` is `"action"` for the action endpoint and `"gcode"` for the raw-gcode endpoint. Auth: `authorization: Bearer <OPENAI_API_KEY>`.

**Output** (fields the app reads, per `extractResponseOutput()` in `llm.js`, shared by both flows):
- `output: []` — array of items; walked for one with `type: "message"`, then its `content: []` for a block of `type: "output_text"` (→ `.text`, the generated JSON string) or `type: "refusal"` (→ `.refusal`, a string).
- `status` / `incomplete_details.reason` — used by `wasTruncated()` to detect a token-limit cutoff.
- `usage: { input_tokens: number, output_tokens: number, ... }` — feeds the cost tracker.

### If `provider === "anthropic"` → `POST https://api.anthropic.com/v1/messages`

**Input** (action-generation defaults; see the settings table above for the gcode endpoint's values):
```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 8192,
  "thinking": { "type": "disabled" },
  "output_config": {
    "effort": "medium",
    "format": { "type": "json_schema", "schema": ACTION_SCHEMA }
  },
  "system": "<systemPrompt>",
  "messages": [{ "role": "user", "content": "<userMessage>" }]
}
```
Auth: `x-api-key: <ANTHROPIC_API_KEY>` + `anthropic-version: 2023-06-01`.

**Output:**
- `content: []` — the block with `type: "text"` → `.text` is the generated JSON string.
- `stop_reason` — `"max_tokens"` is what `wasTruncated()` checks for.
- `usage: { input_tokens: number, output_tokens: number, ... }` — same field names as OpenAI.

## The final payload

**Action generation** — `ACTION_SCHEMA` constrains both providers, so once `extractResponseOutput()`'s `.text` string is `JSON.parse()`d, the result is:
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

**Raw gcode generation** — `GCODE_SCHEMA` constrains both providers:
```ts
{
  gcode: string[],
  explanation: string
}
```
No `name`/`description`/`variables` — raw gcode has no action-style templating. `validateGeneratedGcode()` checks `gcode` (including flagging any accidental `__`/`{}` syntax, which isn't supported here), `applyResultToGcodeBox()` writes `gcode` into `#raw-gcode-textarea`, and `explanation` is rendered into `#gcode-llm-explanation`.

**Raw gcode, multi-turn session** — same `GCODE_SCHEMA` shape, `{gcode: string[], explanation: string}` (a fresh-turn `gcode` is a full job; a continuation-turn `gcode` is only that turn's new lines, per the SESSION CONTINUITY branch used — see [gcode-session-system-prompt.md](gcode-session-system-prompt.md)). `validateGeneratedSessionGcode()` runs the same checks as the single-turn flow. `applyResultToSessionGcodeBox()` writes `gcode` into `#raw-gcode-textarea` and stashes the result as `pendingTurn` (not yet committed to session history). Only clicking `#run-gcode-btn` — which both streams the gcode to the printer *and* triggers `commitPendingTurnIfMatches()` — appends `pendingTurn` to `gcodeSession.turns` and renders it into the Session History panel; a Generate that's never run leaves history untouched.
