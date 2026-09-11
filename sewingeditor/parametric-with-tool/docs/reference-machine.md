# Machine, coordinates and the geometry language

Shared by every stage of the parametric-with-tool page.

## Machine & material

| | |
|---|---|
| Bed | 220 × 220 mm — every printed coordinate must stay inside X/Y **15–205** |
| Layer height | 0.20 mm; relief must be ≥ 0.40 mm (2 layers) to be felt |
| Default bead width | 0.5 mm |
| Material | **TPU** unless the user names PLA (the page sets temperatures and flow itself) |

The page wraps every job in its own start/end sequence (heat, home, prime,
retract; retract, lift, cooldown at the end). Never plan heating, homing,
priming or cooldown.

## Coordinates

Millimetres, X right, Y up (away from the front of the bed). The graphic is
drawn in its own coordinates; the page applies a global **transform**
(`scale`, `origin`) afterwards: the graphic's minimum-x / minimum-y corner
lands on `origin` and everything scales about it. `origin: null` means
"leave the graphic where its coordinates put it". Design a graphic at a
sensible printed size (a chart 60–120 mm wide) inside the safe area; the
user rescales or moves it with the transform, not by asking for new
coordinates.

**Every curve's Y (and X) must land inside 15–205 after whatever data→mm
mapping you chose.** Plugging a function straight through as millimetres
without checking its actual range at the domain you picked is the most
common way to break this — a downward parabola with a wide domain, an
unshifted trig function, a steep line, all commonly swing well past the
bed. Before finalizing, evaluate each formula's own y at its own
endpoints and a midpoint and confirm those numbers land in 15–205; if
not, shift the mapping's offset or shrink the domain until they do.

## Expression syntax (formulas in `t`, or in `t` and `u` for fill families)

`+ - * /`, `^` (power), unary minus, parentheses, the constant `pi`, the
variables, and these functions only: `sin cos tan sqrt abs exp log`
(1 argument), `min max pow` (2 arguments). Anything else is a hard error.
Example: a 30 mm circle centred at (110,110):
`{"x": "110 + 30*cos(t)", "y": "110 + 30*sin(t)", "tEnd": 6.283185}`.

`t` need not be arc length — the page re-parameterises by real arc length,
so brush spacings always mean real mm. A single formula is one smooth
curve: it **cannot have a sharp corner**. A shape with corners uses a
`points` piece instead. A formula too steep to print at any resolution
(an extremely tight spiral, a saw-tooth) is rejected — soften it.

## Pieces

A **piece** is one run of geometry:

| piece | meaning |
|---|---|
| `{"x": "<expr in t>", "y": "<expr in t>", "tEnd": n}` | a formula curve over `t ∈ [0, tEnd]` |
| `{"points": [[x, y], [x, y], ...]}` | straight runs through the points, corners allowed |
| `{"ref": "<line element id>", "tFrom": n, "tTo": n, "reverse": bool}` | a sub-range of another line element's path, optionally walked backwards (`tFrom`/`tTo` only apply to formula paths; omit for the whole path) |

## Elements

| kind | geometry | notes |
|---|---|---|
| `line`, one stroke | `{"path": <piece>}` | an axis, a curve, a polyline chart |
| `line`, a **group** | `{"paths": [<piece>, <piece>, ...]}` | several disconnected strokes, printed as separate strokes but sharing this ONE element's texture — see "Grouping repeated features" below |
| `region` | `{"boundary": [<piece>, ...]}` | the pieces are concatenated in order and must come back to the start (an end within 0.5 mm snaps; a larger gap is closed with a straight edge, which is the normal way to close a `points` boundary). The result must be a simple, non-self-intersecting shape. "The area between curve A and curve B" is `[{"ref": "A"}, {"ref": "B", "reverse": true}]` (plus `points` edges if their ends don't meet). |
| `point`, one stamp | `{"at": [x, y]}` | a single marker or data point |
| `point`, a **group** | `{"at": [[x, y], [x, y], ...]}` | several stamps sharing this ONE element's texture — see below |

Elements are printed in list order. Give every element a short `label`
and a chart `role` (`axis`, `tick`, `curve`, `bar`, `marker`, `label`,
`other`) — the page's geometry report uses roles to tabulate bar heights,
axis extents and curve ranges.

### Grouping repeated features

The texture and parameters stages assign ONE brush/pattern/knob per
ELEMENT, not per stroke or stamp — so a set of identical, repeated marks
must be ONE element (a `paths` or array-`at` group), never N separate
elements. This is not about labeling: it changes how many texture
decisions later stages have to make and keeps them all consistent by
construction.

**Recognize the pattern, don't just follow a keyword list.** Ask: are
these instances of the *same visual feature*, repeated on a regular or
semi-regular basis, that a person would touch and read as ONE kind of
mark (not as N individually meaningful things)? If yes, group them.
Concretely:

- **Axis tick marks** (0 through 10, every 10mm, …) — ONE `line` element
  with `role: "tick"`, `paths` holding one short 2-point piece per tick.
  NOT ten separate `tick` elements.
- **A row of evenly-spaced data markers** on a curve — ONE `point`
  element with `role: "marker"`, `at` holding one `[x, y]` per marker.
  NOT one element per marker.
- **Gridlines** across a chart area — ONE `line` element (`role: "other"`
  or a role you choose), `paths` holding one 2-point piece per line.
- **A dashed border made of many short strokes you're placing by hand**
  (rare — usually `freeformDashed`/`hatch` handle this without any
  grouping at all) — still ONE `paths` group if you do place them.

Do NOT group things that are visually similar but semantically distinct
(three bars with three different heights encoding three different
values) — those stay separate elements so the report's per-element chart
table can list each one's own height. Group only when the individual
instances carry no distinct meaning beyond "one more of these."

Example — an x-axis from 0 to 100 with a tick every 10 units:
```json
{ "id": "", "label": "x axis", "kind": "line", "role": "axis",
  "geometry": "{\"path\": {\"points\": [[40, 150], [140, 150]]}}" }
{ "id": "", "label": "x-axis ticks", "kind": "line", "role": "tick",
  "geometry": "{\"paths\": [
    {\"points\": [[40, 150], [40, 153]]},
    {\"points\": [[50, 150], [50, 153]]},
    {\"points\": [[60, 150], [60, 153]]},
    {\"points\": [[70, 150], [70, 153]]},
    {\"points\": [[80, 150], [80, 153]]},
    {\"points\": [[90, 150], [90, 153]]},
    {\"points\": [[100, 150], [100, 153]]},
    {\"points\": [[110, 150], [110, 153]]},
    {\"points\": [[120, 150], [120, 153]]},
    {\"points\": [[130, 150], [130, 153]]},
    {\"points\": [[140, 150], [140, 153]]}
  ]}" }
```
Two elements total (the axis, the tick group) — not one element per
tick. The texture stage then assigns exactly one brush to `"x-axis
ticks"` and every tick prints identically; the parameters stage exposes
exactly one set of numbers (and can attach one knob, e.g. "tick
boldness") for the whole group.

### Region between two curves — solve the intersections, don't guess a domain

A `ref` boundary only closes when the two curves' pieces span the exact
same real range and **actually meet at both ends** — that means solving
for where they cross, not picking two arbitrary-looking `tEnd`s and
hoping. Skipping this produces exactly the two failures that show up
most: the boundary crosses itself (the two refs don't meet, so the
"closing" edge cuts back across the shape) and/or the curve swings
outside 15–205 (an unbounded domain was used instead of the bounded one
between the crossings).

Worked example — shade the area between `y = 8` and `y = (x-2)^2` (data
units), printed at 8 mm per unit with the origin placed at data (0, 0):

1. **Solve the intersection first, in data units**: `8 = (x-2)^2` →
   `x - 2 = ±2.83` → `x ≈ -0.83` or `x ≈ 4.83`. That real range,
   `x ∈ [-0.83, 4.83]`, is the ONLY valid domain for both curves — not
   the domain either curve would use alone.
2. **Map to mm** with one consistent scale/offset for both curves (say
   8 mm/unit, with x=0 landing at mm 60 and y=0 at mm 150 — chosen so
   the whole shape, `y` up to 8 units = 64 mm above the baseline, stays
   in 15–205): `x_mm = 60 + 8*x`, `y_mm = 150 - 8*y` (mm Y increases
   downward from a data top, so this flips sign — check your own
   orientation choice against the actual numbers, don't assume).
3. **Give both curves the SAME parameter range** across that domain, so
   their `path` pieces meet exactly at both ends:
   ```json
   { "id": "", "label": "y=8", "kind": "line", "role": "curve",
     "geometry": "{\"path\": {\"x\": \"60 + 8*t\", \"y\": \"150 - 64\", \"tEnd\": 5.66}}" }
   { "id": "", "label": "y=(x-2)^2", "kind": "line", "role": "curve",
     "geometry": "{\"path\": {\"x\": \"60 + 8*(t - 0.83)\", \"y\": \"150 - 8*((t - 0.83 - 2)^2)\", \"tEnd\": 5.66}}" }
   { "id": "", "label": "shaded region", "kind": "region",
     "geometry": "{\"boundary\": [{\"ref\": \"<y=8 id>\"}, {\"ref\": \"<parabola id>\", \"reverse\": true}]}" }
   ```
   Here `t` runs 0 to 5.66 (= 4.83 − (−0.83)) on BOTH curves, and each
   curve's own `x` formula shifts `t` so it lands on the real intersection
   x-values at `t=0` and `t=5.66` — that's what makes the two refs meet.
4. **Verify before finalizing**: evaluate both curves' `y` at `t=0` and
   `t=5.66` — they must match each other (that's the closure) and land
   inside 15–205 (here, 150−64=86 at both ends and the parabola's own
   vertex y at its minimum, both comfortably inside range).

The same solve-the-crossing-first approach applies to any "area between
A and B" request, not just this pair of functions.
