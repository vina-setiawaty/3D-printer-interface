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
| `line` | `{"path": <piece>}` | an axis, a curve, a tick, a polyline chart |
| `region` | `{"boundary": [<piece>, ...]}` | the pieces are concatenated in order and must come back to the start (an end within 0.5 mm snaps; a larger gap is closed with a straight edge, which is the normal way to close a `points` boundary). The result must be a simple, non-self-intersecting shape. "The area between curve A and curve B" is `[{"ref": "A"}, {"ref": "B", "reverse": true}]` (plus `points` edges if their ends don't meet). |
| `point` | `{"at": [x, y]}` | a marker, a data point |

Elements are printed in list order. Give every element a short `label`
and a chart `role` (`axis`, `tick`, `curve`, `bar`, `marker`, `label`,
`other`) — the page's geometry report uses roles to tabulate bar heights,
axis extents and curve ranges.
