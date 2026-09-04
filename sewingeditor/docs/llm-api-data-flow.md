# LLM API Data Flow

> **Keep this current:** whenever a system prompt (`buildSystemPrompt()` in `llm.js`, `buildGcodeSystemPrompt()` in `llm-gcode.js`, `buildGcodeSessionSystemPrompt()` in `gcode-session.js`, or `buildParametricSystemPrompt()` in `parametric.js`) or an endpoint's generation settings change, update the matching section here and in the linked system-prompt doc in the same change.

There are **four** independent generation flows in the app, each a click on its own "generate"/"send" button. All follow the same two-hop shape — browser → proxy → LLM provider — via shared proxy logic, but each has its own frontend and system prompt:

| Flow | Frontend | Endpoint | Schema | System prompt |
|---|---|---|---|---|
| Action generation | `llm.js`, action editor's LLM panel | `POST /api/generate` | `ACTION_SCHEMA` in `api/generate.js` | [llm-system-prompt.md](../main/llm-system-prompt.md) |
| Raw gcode generation | `llm-gcode.js`, "Raw gcode" panel (`index.html`) | `POST /api/generate-gcode` | `GCODE_SCHEMA` in `api/generate-gcode.js` | [gcode-system-prompt.md](../main/gcode-system-prompt.md) |
| Raw gcode, multi-turn session | `gcode-session.js`, "Raw gcode — printing session" panel (`gcode-session.html`) | `POST /api/generate-gcode` (same endpoint/schema as above) | `GCODE_SCHEMA` in `api/generate-gcode.js` | [gcode-session-system-prompt.md](../gcode-session/gcode-session-system-prompt.md) |
| Parametric tactile graphic | `parametric.js`, 3-column page (`parametric.html`) | `POST /api/generate-parametric` | `PARAMETRIC_SCHEMA` in `api/generate-parametric.js` | [../parametric/parametric_docs/system-prompt.md](../parametric/parametric_docs/system-prompt.md) (concatenated with `catalog.md` / `path-spec.md` / `hardware.md` / `PARAMETER_CONSTRAINTS.md`) |
| Parametric tactile graphic, **+ tool execution (experimental)** | `parametric-with-tool.js`, same 3-column page (`parametric-with-tool.html`) | `POST /api/generate-parametric-tool` | same `PARAMETRIC_SCHEMA` as above | same docs, plus a `CHECK APPROPRIATENESS` block appended client-side in `buildParametricSystemPrompt()` |

**The parametric flow is structurally different from the other three:**
- It is **multi-turn**: the request body carries `messages` (a `{role, content}[]` transcript) instead of a single `userMessage`. `handleGenerateRequest()` accepts either — a `userMessage` string is wrapped as a one-element array; a `messages` array is validated (roles `user`/`assistant`, non-empty string content, last turn must be `user`) and passed through. `callOpenAI()` maps it to Responses `input` items (`input_text` for user turns, `output_text` for assistant turns); `callAnthropic()` passes it straight to `messages`.
- The model returns **no G-code** — it returns `{ chat, calls[] }`, where each call names a `texture_functions.js` function plus a JSON-string `geometry` and `options`. `parametric-catalog.js` executes the call list locally against `parametric_docs/texture_functions.js` (a pinned copy) to produce the G-code; editing a parameter in column 2 re-runs that locally with no API call.

All endpoints call into the same `handleGenerateRequest()` in `api/_lib/llm-proxy.js` (app-secret gate, input validation, `userMessage`-or-`messages` normalization, calling the chosen provider, relaying the response) — each just supplies its own schema and generation settings:

| Setting | Action generation | Raw gcode generation | Parametric graphic | Why they differ |
|---|---|---|---|---|
| `max_output_tokens` / `max_tokens` | 8192 | 32768 | 32768 | A tactile graphic can expand into hundreds/thousands of gcode lines / many calls; an action macro is a handful of lines. |
| `reasoning.effort` / `output_config.effort` | `medium` | `medium` (client-selectable) | `medium` (client-selectable) | Gcode/graphic generation involves real spatial reasoning; actions are short parameterized templates. |
| Anthropic `thinking` | `disabled` | `adaptive` (gated on the client toggle) | `adaptive` (gated on the client toggle) | Same reasoning-load difference as above. |

## Hop 1: Browser → proxy

**Action generation** (`POST /api/generate`) — request built by `buildRequestBody()` in `llm.js`:

| Field | Type | Content |
|---|---|---|
| `provider` | `string` | `"openai"` or `"anthropic"` |
| `model` | `string` | e.g. `"gpt-5.6-terra"` or `"claude-sonnet-5"` |
| `systemPrompt` | `string` | `buildSystemPrompt()` — full text in [llm-system-prompt.md](../main/llm-system-prompt.md) |
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
| `systemPrompt` | `string` | `buildGcodeSystemPrompt()` — full text in [gcode-system-prompt.md](../main/gcode-system-prompt.md) |
| `userMessage` | `string` | `buildGcodeUserMessage()` — a stringified JSON snapshot of the current raw-gcode box, followed by the typed instruction |

The `userMessage` string embeds this object (from `collectGcodeBoxState()`):
```ts
{
  gcode: string[]   // current lines in the "Raw gcode" textarea
}
```

**Raw gcode, multi-turn session** (`POST /api/generate-gcode`, same endpoint as above) — request built by `buildGcodeSessionRequestBody()` in `gcode-session.js`. The wire shape sent to the proxy is **identical** to plain raw-gcode generation (`provider`/`model`/`effort`/`thinking`/`systemPrompt`/`userMessage`, all strings) — no backend change was needed for this flow. `userMessage` itself is also the same shape as above (current textarea content + typed instruction, via `collectGcodeSessionBoxState()`). All of the session-specific context — filament, print temp, Z-start offset, continuity mode, whether the substrate is fresh, the app-chosen prime coordinate for this turn, and a short summary of prior turns — lives entirely in `systemPrompt` instead, rebuilt fresh from client-side session state (`gcodeSession`, persisted to `localStorage["gcodeSessionState"]`) on every call. See [gcode-session-system-prompt.md](../gcode-session/gcode-session-system-prompt.md) for how that state shapes the prompt.

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

**Raw gcode, multi-turn session** — same `GCODE_SCHEMA` shape, `{gcode: string[], explanation: string}` (a fresh-turn `gcode` is a full job; a continuation-turn `gcode` is only that turn's new lines, per the SESSION CONTINUITY branch used — see [gcode-session-system-prompt.md](../gcode-session/gcode-session-system-prompt.md)). `validateGeneratedSessionGcode()` runs the same checks as the single-turn flow. `applyResultToSessionGcodeBox()` writes `gcode` into `#raw-gcode-textarea` and stashes the result as `pendingTurn` (not yet committed to session history). Only clicking `#run-gcode-btn` — which both streams the gcode to the printer *and* triggers `commitPendingTurnIfMatches()` — appends `pendingTurn` to `gcodeSession.turns` and renders it into the Session History panel; a Generate that's never run leaves history untouched.

**Parametric tactile graphic** — `PARAMETRIC_SCHEMA` constrains both providers to:
```ts
{
  chat: string,          // conversational reply, appended to the column-1 transcript
  calls: {
    fn: string,          // allowlisted texture_functions.js name
    geometry: string,    // JSON string: {"path": <spec>} | {"at": [x,y]} | {"region": {...}, "fillStyle": "..."}
    options: string,     // JSON string: { optionName: value }
    label: string,
  }[]
}
```
`parametric.js` `applyModelResult()` parses each `geometry`/`options` string to an object, replaces `pstate.calls`, and persists to `localStorage["parametricSessionState"]` (transcript + calls + material). `parametric-catalog.js` `runCalls()` then executes the list against the pinned `parametric_docs/texture_functions.js`: builds `xFunc`/`yFunc` from each path spec (a `polyline` is expanded to one library call per segment, since the sampler rejects sharp turns), wraps the whole list in `em.header()`/`em.footer()`, and runs verification (bed bounds with G90/G91 tracking, `verifyLayout` — bbox overlap downgraded to a warning here — net-E tripwire, `verifyCheckerboard` after any `DIAMOND` fill, `PathTooSteepError` surfaced per call). The G-code goes into the shared `#raw-gcode-textarea`; run/save reuse `script.js`. Editing any field in column 2 re-runs `runCalls()` locally — no API call. Enforced limits live in `parametric-catalog.js`'s `CONSTRAINTS`, mirroring `parametric_docs/PARAMETER_CONSTRAINTS.md` (currently placeholder numbers pending hardware calibration).

**Parametric tactile graphic, + tool execution (experimental)** — same output shape and client-side handling as above. The only difference is upstream: `generate-parametric-tool.js` sets `codeExecution: true`, which makes `callAnthropic()` add `tools: [{ type: "code_execution_20260120", name: "code_execution" }]` to the request (Anthropic only — OpenAI requests through this endpoint get no self-check). This is a **server-side** tool: Anthropic runs Python in its own sandbox and Claude reads back stdout only, never a rendered image, so the appended system-prompt instructions ask it to numerically reconstruct its planned geometry and judge whether the result is an *appropriate* representation of the request (right chart/shape type, correct proportions/ordering, sensible composition) — not just whether one measurement hits an exact number — before finalizing `{chat, calls[]}`. This exists alongside (not instead of) `runCalls()`'s printability checks, which still run client-side afterward exactly as above. `extractResponseOutput()` in `llm.js` reads the **last** `type: "text"` block in the response rather than the first, since a tool-using turn can emit narration text before the schema-constrained final answer; this fix is shared by all flows but only changes behavior for a response with more than one text block, which today only this flow can produce. If Anthropic's server-side tool loop needs more than its internal iteration cap and returns `stop_reason: "pause_turn"`, `handleGenerateRequest()` returns a clear error rather than attempting to resume — this endpoint already runs close to Vercel's `maxDuration`, so a second round trip isn't attempted.
