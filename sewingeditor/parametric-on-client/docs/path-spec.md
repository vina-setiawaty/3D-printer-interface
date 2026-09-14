# Path spec — how a line/curve is described

The six line styles in `texture_functions.js` take parametric `xFunc(t)`,
`yFunc(t)` arrow functions. Those cannot travel over the wire as JSON, so
the parametric page uses a small **path spec** instead: a JSON object the
page turns back into `xFunc`/`yFunc` before calling the library. Every path
is parameterised by **arc length in millimetres** — `tStart = 0`,
`tEnd = <path length>`.

A call that uses a line style puts its path spec in `geometry.path`. Dots
use `geometry.at`; fills use `geometry.region`.

## `kind: "segment"` — a straight line

```json
{ "kind": "segment", "from": [x0, y0], "to": [x1, y1] }
```

## `kind: "polyline"` — connected straight runs

```json
{ "kind": "polyline", "points": [[x0,y0], [x1,y1], [x2,y2], ...] }
```

At least 2 points. Use this for an L-shape, a zigzag skeleton, a polygon
outline (repeat the first point at the end to close it), etc.

## `kind: "arc"` — a circular arc

```json
{ "kind": "arc", "center": [cx, cy], "radius": r,
  "startDeg": a0, "endDeg": a1 }
```

Angles are degrees CCW from +X. `endDeg > startDeg` sweeps CCW; a full
circle is `startDeg: 0, endDeg: 360`. Radius must be large enough that the
curve is printable — a tight radius with a wide bead will be rejected by
`samplePath()` as too steep.

## `kind: "sine"` — a wavy line

```json
{ "kind": "sine", "from": [x0,y0], "to": [x1,y1],
  "amplitude": a, "wavelength": w }
```

A straight baseline from `from` to `to` with a sine offset perpendicular to
it. **`amplitude` must be well under `wavelength`** or the shape is too
steep to print at any resolution and will be rejected — reduce `amplitude`
or increase `wavelength` and tell the user why, never retry blindly.

## Bounds

Every point the path visits (including the sine/arc excursions) must stay
inside **X/Y 15–205**. The page checks this and flags any violation.
