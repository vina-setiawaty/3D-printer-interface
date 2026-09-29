# Brush programs

A brush program describes what the nozzle does at ONE stamp point. The
page repeats it along a line (at arc-length `gap` spacing) or places it at
single points. The program is JSON:

```json
{
  "name": "commaDot",
  "version": 1,
  "orientation": "tangent",
  "radiusMm": 8,
  "defaultGap": 6,
  "params": {
    "diameter": { "def": 2.0, "min": 0.8, "max": 6, "level": "brush",  "desc": "head dome diameter, mm" },
    "tailLen":  { "def": 3.0, "min": 0,   "max": 6, "level": "brush",  "desc": "length of the dragged tail, mm" }
  },
  "steps": [
    { "op": "travel",  "to": [0, 0, 0.2] },
    { "op": "prime",   "mm": 4 },
    { "op": "move",    "to": [0, 0, "0.2 + diameter/2"], "e": "0.05*diameter^3", "f": 120 },
    { "op": "dwell",   "ms": 1500 },
    { "op": "move",    "to": ["-tailLen", 0, 0.3], "bead": { "w": 0.8, "h": 0.3 }, "f": 200 },
    { "op": "retract", "mm": 4 },
    { "op": "move",    "to": ["-tailLen - 1", 0, 1.0], "f": 600 }
  ]
}
```

## Frame and units

- **Local frame.** The origin is the stamp point on the bed. x and y are in
  mm around it, and z is the nozzle height above the bed in mm.
- **Orientation.**
  - `"fixed"`: local +x is the bed's +x.
  - `"tangent"`: local +x follows the direction the line is travelling at
    each stamp, so every stamp on a curve turns with it.

  The built-in option `azimuthDeg` rotates the frame further (CCW degrees).
- **Units.** Feeds `f` are mm/min. `e`, `mm` and prime/retract amounts are
  mm of filament. `ms` is milliseconds.
- **Reach.** Every coordinate at every param setting must stay within
  `radiusMm` of the origin.
- **`defaultGap`** is the stamp spacing along a line when no `gap` option is
  given.

## Steps

| op | fields | what it emits |
|---|---|---|
| `travel` | `to` [x,y,z] | Z-hop, retract if needed, travel, lower. **Must be the first step, and only there.** The filament is retracted afterwards. |
| `move` | `to` [x,y,z] or `by` [dx,dy,dz]; `f`; optionally `e` or `bead` {w,h} | `G1 X Y Z [E] F`: one straight move. With `e`, it extrudes that much filament over the move. With `bead`, it extrudes a bead of that width × height: `e = w·h / filamentArea × 3D length`. With neither, it is a dry move. |
| `dwell` | `ms` | `G4 P<ms>`. Nothing moves or extrudes. |
| `retract` | `mm`, optional `f` (default 900) | `G1 E-<mm>`: pulls filament back while the nozzle stands still. |
| `prime` | `mm`, optional `f` (default 900) | `G1 E+<mm>`: pushes it forward again (un-retract). The first prime of a printed element also gets the library's 0.3 mm start bonus. |
| `extrudeHere` | `e`, `ms` | `G1 E<e>` at the feed that takes `ms`: deliberate extrusion **without moving** (a puddle). |
| `repeat` | `n`, `steps` | Runs `steps` `n` times. Inside, `i` (0 … n−1) and `n` can be used in expressions, e.g. an orbit: `{"op":"repeat","n":16,"steps":[{"op":"move","to":["r*cos(2*pi*(i+1)/n)","r*sin(2*pi*(i+1)/n)",1.2],"f":600}]}` |

Any step may also carry `"movement": "<name>"`, which marks where a new
movement starts. The page's editor uses it to decide what a TOP or SIDE
stroke reshapes; printing ignores it. Keep existing labels where they are.

Extrusion is **relative** (`M83`): every E is a delta. A stamp starts
retracted (after its travel). To extrude properly it first needs a `prime`
of about what was retracted: the previous stamp's own retract, or 1.3 mm.

## Numbers and expressions

Any number can instead be a string expression over:
- the program's param names;
- `i` and `n` (inside a `repeat`);
- `pi`.

Operators: `+ - * / ^` and parentheses. Functions: `sin cos tan sqrt abs
exp log floor round min max pow`. Anything else is rejected.

## Params

Each param is `{def, min, max, level, desc}`.
- `def` must lie within `min … max`.
- `level` is `"brush"` for the local deposit (sizes, heights, speeds,
  timings) and `"stroke"` for how the stamp is walked along a line.
- The names `azimuthDeg`, `gap`, `reverse`, `step`, `i`, `n` and `pi` are
  reserved.

The page checks the program at the default of every param and at the
corners of their ranges. The ranges you give must therefore describe
settings that still print.

## Built-in options

Every sketched brush also accepts these, without declaring them:
- `azimuthDeg`: a rotation, as an offset from the tangent when orientation
  is `"tangent"`.
- `gap`: spacing along a line.
- `reverse`: stamp the line end-to-start.
