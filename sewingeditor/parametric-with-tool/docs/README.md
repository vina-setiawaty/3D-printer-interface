# parametric-with-tool docs

Reference set for the **4-stage pipeline page**
(`../parametric-with-tool.html`) — route → geometry [→ geometry-check] →
texture [→ texture-check] → parameters, over a scene model (elements,
per-slot textures, weighted parameter knobs). Fully separate from
`../../parametric/` (the older single-call prototype): different HTML/JS,
different endpoint (`api/parametric-stage.js` vs `api/generate-parametric.js`),
different `localStorage` key, and its own copy of the texture library below
— editing one page's files never touches the other's.

| File | What it is |
|---|---|
| `texture_functions-with-tool.js` | The texture library restructured as brushes / patterns / stamps (every texture is "what happens between two points"). Verified byte-identical to the original library's output by `tests/parametric/golden-brushes.mjs`. |
| `stage-route.md` | System prompt for the **route** call — the only one that sees the full chat history; picks the entry stage and rewrites the request as a self-contained instruction. |
| `stage-geometry.md` | System prompt for **geometry** — defines or changes elements (lines, regions, points) and the global transform. |
| `stage-geometry-check.md` | System prompt for the optional **geometry-check** pass — reviews a just-proposed element list against a report the app computes deterministically and can return a patch. |
| `stage-texture.md` | System prompt for **texture** — assigns a brush/stamp and, for a region's fill, a pattern to each element slot. |
| `stage-texture-check.md` | System prompt for the optional **texture-check** pass — same idea as geometry-check, for hand-placed fill coordinates only. |
| `stage-parameters.md` | System prompt for **parameters** — sets option values and defines the weighted high-level knobs (abstractions). Has a marker for a future fuller abstraction guide. |
| `reference-machine.md` | Shared facts: bed/material, the expression syntax, the piece/element geometry language, worked examples (grouping repeated features, a region between two curves). |
| `reference-brushes.md` | Shared facts: the brush/stamp/pattern menu, their options, and the physically-enforced limits. |

## Keeping things in sync

- Prompt text changes → update the matching `stage-*.md` / `reference-*.md`
  file **and** the matching section of `../../docs/llm-api-data-flow.md`.
- Enforced-limit changes → `reference-brushes.md` **and**
  `../parametric-catalog-with-tool.js`'s `CONSTRAINTS`/`checkBrushRules`
  together.
- Library changes → run `node tests/parametric/golden-brushes.mjs` (must
  stay byte-identical) and `node tests/parametric/compile-fixtures.mjs`.
