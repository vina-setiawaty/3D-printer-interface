# Raw Gcode Session System Prompt

> **Keep this current:** update this file (and the settings table in [llm-api-data-flow.md](llm-api-data-flow.md)) in the same change whenever `buildGcodeSessionSystemPrompt()` changes.

The `systemPrompt` string sent as `instructions` (OpenAI) / `system` (Anthropic) on every `/api/generate-gcode` call made from `gcode-session.html`. Built by `buildGcodeSessionSystemPrompt(config, primeLocation, fresh, turns)` in `sewingeditor/gcode-session.js`. It is a parallel, diverging copy of [gcode-system-prompt.md](gcode-system-prompt.md)'s single-turn prompt (`buildGcodeSystemPrompt()` in `llm-gcode.js`) — not shared code, since this flow's "current state" is a whole multi-turn physical print session rather than just the textarea, and it asks for different output on a continuation turn (only the new incremental gcode, not a full restatement).

Most sections are identical to the single-turn prompt (FORMAT RULES, EXTRUSION MATH, POSITIONING AND EXTRUSION MODE, TEXTURE PRIMITIVES, FILLING A LARGER CLOSED SHAPE, ANTI-STRINGING, MULTI-FEATURE GRAPHICS, EXPLANATION FIELD) — see that doc for the full text and the hands-on tuning rationale behind those numbers. This doc covers only the two sections that are new or parameterized here: **HARDWARE PROFILE** and **SESSION CONTINUITY**.

## HARDWARE PROFILE — parameterized by `config.filament`

The nozzle temp line is always the literal `config.printTemp` value the user typed into the session panel ("use exactly this value, do not deviate") — the single-turn prompt's fixed "205-220C" range doesn't apply here, since temperature is a direct per-session input, not something the model infers.

**PLA branch** — identical numbers to the single-turn prompt's hardware profile (retraction 0.4-0.6mm, direct-drive warning, 300-600mm/min feeds), which came from a real hands-on tuning session on this exact printer (Ender 3 V2 + Creality Sprite direct-drive extruder, 0.4mm nozzle) — see `tests/260811/gcode_action_system_prompt.md`.

**TPU branch** (new): much shorter retraction (0-1.5mm, slower 1200-1800mm/min or skipped entirely for short travels — flexible filament buckles in a direct-drive hobbed-gear feed path rather than retracting cleanly at PLA-style distances), and slower travel/print feeds (1500-2400mm/min travel, 150-350mm/min print) to give the elastic filament time to feed consistently.

**CAVEAT, stated explicitly in-prompt:** the TPU numbers are best-effort defaults only — unlike the PLA numbers, they do **not** come from a hands-on tuning session on this hardware. The prompt tells the model to flag anything that looks like it's underperforming (stringing, under-extrusion, grinding) in the explanation field, and this doc flags the same thing here: treat TPU output cautiously until it's been validated against a real print, the same way the PLA numbers once were.

## SESSION CONTINUITY — replaces the single-turn prompt's "STARTING AND ENDING A JOB"

The single-turn prompt infers fresh-vs-continuation purely from whether the gcode box's text is empty. This flow instead derives it explicitly from app-tracked session state (`turns.length === 0` = fresh), and additionally branches on the user-facing **Continuity** setting (`config.continuityMode`, `"stay-hot"` or `"full-reset"`). Only the one applicable branch is included in a given call — the model is never shown the other three.

**1. Fresh turn** (first turn on a substrate, either mode): full heat/home/prime sequence, e.g.
```
G21 / G90 / M83 / M104 S{printTemp} / M140 S60 / M190 S60 / M109 S{printTemp} / G28 / G92 E0 / G1 Z{zStartOffset} F3000
```
then a short prime line at the app-chosen prime coordinate (see below). `stay-hot` mode omits the closing cooldown/park sequence (nozzle stays hot/positioned for the next turn); `full-reset` mode keeps it.

**2. Continuation + `stay-hot`:** no re-home/re-heat/`G92` — the model is told the nozzle is still hot and homed from the prior turn. It travels to a new prime spot, primes, then must return **only this turn's new gcode**, nothing already printed — an explicit, stated exception to "always return the full result," since the app's Session History panel (not the gcode box) carries the running record. No cooldown at the end; the job is still ongoing.

**3. Continuation + `full-reset`:** same "only new geometry" instruction, but wrapped in a full self-contained job (heat/home/prime…cooldown/park) every single run, even though the physical substrate itself isn't being reset — only the machine-state boilerplate resets each time, not the geometry already on the bed.

**4. A short PRIOR TURNS list** (last 5 entries: instruction + truncated explanation) is appended in continuation branches for narrative context, built by `summarizePriorTurns()`.

**Prime location:** the app deterministically cycles through 8 fixed perimeter spots on the 220x220 bed (`PRIME_CANDIDATES` in `gcode-session.js`), advancing one slot per *committed* (actually run) turn — `getPrimeLocation(turns.length)`. The chosen coordinate is stated literally in the prompt ("use it as given, do not choose your own") rather than left for the model to infer or remember from history, since that would be unreliable. Sessions longer than 8 committed turns wrap around and can reuse a spot near earlier artwork — a known limitation, not yet worth a longer list.
