# Sketch studio — feature checklist

Tick (`[x]`) what you want; leave the rest. Add notes after any line.
Items marked **(in)** are already in the bare page.

## Drawing — tools

- [ ] **(in)** Freehand brush (B): drag to draw, simplified to nodes on release
- [ ] **(in)** Pen (P): click to place straight-segment nodes; Enter / Esc / double-click ends the path
- [ ] Pen with Bézier handles: click-drag pulls out handles (smooth curves, like Illustrator's pen)
- [ ] Curvature tool: click points, curves are computed through them
- [ ] Add / delete anchor point on an existing path (+ / − tools)
- [ ] Convert anchor: smooth ↔ corner (Shift+C), break a handle with Alt-drag
- [ ] Continue an existing path from its end point with the pen
- [ ] Close a path (click its first node) — loops and rings
- [ ] Shape tools: line, arc, circle/ellipse, rectangle, polygon, spiral, zigzag/wave
- [ ] Freehand smoothing slider (how much a stroke is simplified / fitted to curves)
- [ ] Fit freehand to Bézier curves instead of straight-segment nodes
- [ ] Pencil "edit by redrawing": redraw over part of a path to replace that part
- [ ] Eraser / scissors: cut a path at a point (makes two paths)
- [ ] Knife: cut along a drawn line

## Drawing — selection and transforms

- [ ] **(in)** Select (V): click a path to select it, drag to move it; drag a node to move that node
- [ ] **(in)** Arrow keys nudge the selected path 0.1 mm (Shift = 1 mm)
- [ ] **(in)** Delete removes the selected node (or the path)
- [ ] Separate selection vs direct-selection tools (whole path vs individual nodes), like V / A
- [ ] Marquee (drag a box) to select several paths or nodes
- [ ] Shift-click to add / remove from the selection
- [ ] Select all / deselect / invert (Ctrl+A, Ctrl+Shift+A)
- [ ] Bounding box with handles: scale, rotate, Shift = keep proportions
- [ ] Rotate / scale / reflect about a chosen origin point, with typed values
- [ ] Transform panel: numeric X, Y, W, H, angle for the selection
- [ ] Align and distribute (left/centre/right, spacing)
- [ ] Group / ungroup, lock / hide paths
- [ ] Layers panel (named, reorderable, visibility)
- [ ] Copy / paste / duplicate (Alt-drag duplicates), paste in place
- [ ] Repeat last transform (Ctrl+D) — e.g. step-and-repeat a rotated copy

## Drawing — path operations

- [ ] Join two end points / join two paths into one
- [ ] Reverse path direction (matters: it is the print order)
- [ ] Simplify path (fewer nodes, keep the shape)
- [ ] Offset path (parallel copy at a distance — e.g. bead width)
- [ ] Smooth / round corners with a radius
- [ ] Average / align selected nodes
- [ ] Outline / boolean operations (union, subtract) — probably only for closed shapes
- [ ] Blend: N in-between paths from path A to path B

## Drawing — precision and view

- [ ] Zoom (wheel / Ctrl+wheel), pan (Space-drag or middle button), fit to drawing
- [ ] Adjustable view size (currently fixed ±10 mm)
- [ ] Snap to grid, with a chosen grid size
- [ ] Snap to nodes / path / centre (smart guides with highlighted hints)
- [ ] Angle constraint: Shift = 0/45/90°
- [ ] Rulers and draggable guides
- [ ] Live measurement readout while drawing (length, angle, Δx Δy)
- [ ] Typed node coordinates (click a node, type exact x, y)
- [ ] Reference image underlay (photo of a texture / sample), with opacity
- [ ] Show bead width to scale vs as a thin centreline (toggle)
- [ ] Reach circle / safe area of the stamp
- [ ] Outline / wireframe view mode

## Drawing — 3D (printing-specific, no Illustrator equivalent)

- [ ] Side view (XZ / YZ) next to the top view, editable
- [ ] Per-node Z height (drag in side view or type)
- [ ] 3D orbit preview of the stamp
- [ ] Per-node or per-segment flow / bead width (a "stroke width profile" like Illustrator's width tool)
- [ ] Width tool: drag along a path to make the bead thicker / thinner there
- [ ] Dry (non-extruding) segments shown dashed

## Timeline — basics

- [ ] **(in)** One clip per path, in print order, length = print time at the path's feed
- [ ] **(in)** Click / drag the ruler or track to move the playhead; nozzle ring follows on the drawing
- [ ] **(in)** Space plays / pauses, Home / End jump
- [ ] **(in)** Clicking a clip selects its path (and vice versa)
- [ ] Zoom the timeline (Ctrl+wheel, zoom slider), scroll horizontally, fit (\\ key)
- [ ] Frame / step-accurate stepping (← → by one node, Shift by one clip)
- [ ] Time display in s and ms, timecode readout of the playhead
- [ ] Playback speed (0.25×, 0.5×, 1×, 2×) and loop
- [ ] Travel moves between paths shown as their own (grey) clips with real time
- [ ] Snapping in the timeline (clip edges, playhead, markers), toggle with S

## Timeline — editing (Premiere-style)

- [ ] Drag clips to reorder the print order
- [ ] Multi-select clips (Shift / Ctrl-click, marquee)
- [ ] Razor / blade (C): split a path into two at the playhead
- [ ] Trim clip ends (shortens the path from either end)
- [ ] Ripple edit / ripple delete (close the gap automatically)
- [ ] Roll edit (move the boundary between two adjacent clips)
- [ ] Slip (shift which part of a path a clip covers) — maybe not meaningful here
- [ ] Rate stretch: drag a clip's length to change its speed (feed)
- [ ] Speed ramp within a clip (feed curve over the clip)
- [ ] Gaps / pauses as their own clips (dwell, nozzle held still)
- [ ] Insert vs overwrite modes when adding a new stroke at the playhead
- [ ] Copy / paste / duplicate clips on the timeline
- [ ] Undo history panel (list of actions, click to jump back)

## Timeline — tracks and keyframes

- [ ] Separate tracks: XY path, Z height, flow, events (retract / prime / dwell / fan)
- [ ] Keyframes on Z, flow and feed with interpolation (linear / ease / hold)
- [ ] Graph editor: value curves you can drag with handles
- [ ] Event markers placed on the timeline (retract, prime, dwell, pause)
- [ ] Named markers / notes at a time
- [ ] Track lock / mute (mute = do not print that channel's change)
- [ ] Waveform-like strip of extrusion rate (volumetric flow over time, with the limit line)

## Linking drawing and timeline

- [ ] Hover a clip → highlight its path, and the reverse
- [ ] Colour each path along its length by time (start → end gradient)
- [ ] Direction arrows and start dots on each path
- [ ] Onion-skin: show only what has printed up to the playhead (rest faded)
- [ ] Draw "at the playhead": new strokes insert at the playhead, not at the end
- [ ] Record mode: drawing speed becomes print speed (live performance of the stroke)

## File and session

- [ ] Autosave in the browser, restore on reload
- [ ] Save / open the sketch as a JSON file
- [ ] Import SVG paths; export SVG
- [ ] Export to the brush-sketch program format (hand over to the existing pipeline)
- [ ] Export test G-code directly
- [ ] Keyboard-shortcut sheet (? key)
