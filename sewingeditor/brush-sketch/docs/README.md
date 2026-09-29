# brush-sketch

A page for exploring **new** tactile textures by drawing what the nozzle
does at one stamp point, instead of describing it in text. Open
`sewingeditor/brush-sketch/brush-sketch.html` in **Chrome or Edge**, served
over `vercel dev` or any localhost / https server; folder access does not
work from `file://`.

## The loop

1. **Draw** one stamp in the TOP / SIDE views.
   - **Freehand**: mouse strokes. The wheel or keys 0–5 set the flow,
     W/S change Z, Shift+drag is a dry move, holding still makes a dwell
     or a puddle, R/P add a retract or prime.
   - **Vector**: click to add nodes, drag them, and use the inspector and
     the keys listed on the page.
   - **Channels** (freehand): XY and Z are separate channels of a
     movement. After the first stroke, a **TOP** stroke reshapes the XY of
     the movement at the playhead, stretched over it. A **SIDE** stroke
     reshapes its Z: it is matched by position (the height profile seen from
     the side), or by time where the path doubles back in that view. Neither
     prolongs the path: timing and extrusion stay. **Ctrl+drag** adds a new
     movement instead, marked with a `movement` label on its first step.
     The movement a stroke will reshape is shaded blue on the timeline.
   - **Timeline** (both modes): anything new happens at the **playhead**.
     That covers a stroke drawn in TOP or SIDE, a D/R/P/H key, or a
     clicked node. Move the playhead by clicking the time ruler. The ring
     in TOP/SIDE shows where the nozzle is at the playhead. Drawing in the
     **Z lane** paints height over time onto moves already drawn, so XY
     from TOP plus Z from the timeline make one 3D movement. A stroke
     inserted mid-sequence gets a dry move back afterwards, so what came
     after it is unchanged; delete that move if you don't want it. Use
     `,` / `.` to step between boundaries, the wheel to zoom and
     Shift+wheel to pan.
2. The drawing becomes a **brush program** (column 2). In freehand mode
   this is first a literal draft of exactly what was drawn. "interpret
   sketch" asks the model to make it printable and parametric. Every
   change it makes is listed under "changes from the drawing", and "back
   to my drawing" undoes all of them.
3. **Check** runs on every edit, at the defaults and at every param
   corner. Errors (machine safety) block the test print. Warnings (the
   known ways textures fail) are only shown: this is an exploration tool.
4. **Test file**: connect `texture_docs`. The page proposes the next
   calibration position from `test_print_gcode/`, and a description input
   names the file (`yyyymmdd-HHMMSS_<description>[-testmode].gcode`). A
   sweep prints one row per value of a chosen param.
5. **Promote**: the model writes the prose, the page writes the rest, and
   you review a per-file diff before anything is written. See
   `../../texture_docs/system_prompt.md` → Sketched brushes for what ends
   up in the library.
6. **After printing**: describe what happened. It becomes a status bullet
   and a troubleshooting note, and optionally a proposed next version
   (load it, test it, promote it).

## Files

| File | What it is |
|---|---|
| `../../texture_docs/sketched_brushes.js` | The interpreter (the library's). Also where promoted brushes live. |
| `checks.js` | The gate, plus `SKETCH_LIMITS` (every number a placeholder). |
| `literal-draft.js` | One freehand stroke → program steps. |
| `timeline-edit.js` | Editing by time and by channel: split a step at a moment, insert at the playhead, paint Z, reshape XY or Z of a movement (timing and extrusion kept). |
| `test-print.js` | Test G-code, calibration position proposals, file names, digest. |
| `promote.js` | Promotion and print-report edits to the library files (pure: text in, text out). |
| `library-io.js` | File System Access: pick the folder, hash-checked reads and writes. |
| `views.js` | TOP / SIDE / TIMELINE canvases. |
| `sketch-pipeline.js` | One model call plus same-stage repair, bounded. |
| `prompt-assembly.js`, `stage-schemas.js`, `docs/stage-*.md`, `docs/ref-*.md` | Prompts. A `stage-*.md` contributes only its fenced block; a `ref-*.md` is used whole. Limits are generated from `checks.js`. |
| `brush-sketch.js`, `brush-sketch.html`, `brush-sketch-compat.js` | The page. It uses `data-k` attributes, not ids, for its own inputs, because `script.js` saves and restores every `<input id>` page-wide. |

## Tests

```
node tests/brush-sketch/runtime-and-checks.mjs
node tests/brush-sketch/draft-and-testprint.mjs
node tests/brush-sketch/promote.mjs
node tests/brush-sketch/llm-plumbing.mjs
node tests/brush-sketch/timeline.mjs
```

The tests are offline: no API key, no browser. `promote.mjs` works on
temp copies of the real `texture_docs` files, and `draft-and-testprint.mjs`
reads the real `test_print_gcode/` folder.
