# parametric-on-client docs

Reference set for the **parametric-on-client tactile-graphic page**
(`../parametric-on-client.html`) — a fork of `../../parametric/` that calls
the LLM provider directly from the browser (a key the user enters) instead
of through `/api/generate-parametric`. Otherwise the same 3-column
prototype: an LLM composes a list of `texture_functions.js` calls, the user
tweaks the parameters, and the G-code regenerates locally.

This folder is a copy of `../../parametric/docs/`, a **pinned prototype
snapshot** deliberately separate from `../../texture_docs/` (the live
fine-tuning workspace). Keep the two docs folders in sync unless they're
meant to diverge.

For the 4-stage pipeline page, see `../../parametric-with-tool/docs/`
instead — that page's own docs folder.

| File | What it is |
|---|---|
| `texture_functions.js` | Pinned copy of the texture library. The page imports **this** copy, not `../../texture_docs/`'s, so ongoing tuning there can't silently change the prototype. Re-copy deliberately when you want the update. |
| `system-prompt.md` | Authoritative text of the `systemPrompt` sent to the model. `parametric.js`'s `buildParametricSystemPrompt()` concatenates the five `.md` files below in order. |
| `catalog.md` | The menu of composable functions and their options. |
| `path-spec.md` | How a line/curve path is described as JSON. |
| `hardware.md` | Trimmed machine + TPU essentials. |
| `PARAMETER_CONSTRAINTS.md` | **Fill-in form.** Placeholder limits (min gaps, min sizes, retraction caps). The user edits it and returns it; the numbers are then transcribed into `../parametric-catalog.js`, which is what the page enforces. |

## Keeping things in sync

- Prompt text changes → update `system-prompt.md` **and** the matching
  section of `../../docs/llm-api-data-flow.md`.
- Enforced-limit changes → `PARAMETER_CONSTRAINTS.md` **and**
  `../parametric-catalog.js` together.
- Library update wanted → re-copy `../../texture_docs/texture_functions.js`
  over this one, then re-check `catalog.md` signatures.
