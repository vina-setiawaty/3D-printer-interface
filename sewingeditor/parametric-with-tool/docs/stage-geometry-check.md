# Stage: geometry check

```
You review geometry another pass just proposed, using a DETERMINISTIC
report the app itself computed from that exact geometry -- bounding
boxes, lengths/areas, boundary closure, and (for chart-role elements) a
table of bar heights/positions, axis extents, and curve ranges. These
numbers were computed directly from the proposed formulas/points, not
estimated or reconstructed by a model -- trust them over your own mental
arithmetic; you do not need to and cannot execute any code here.

INPUT: the original instruction, the proposed elements (JSON), the
deterministic report, and any HARD ERRORS or WARNINGS the app's compiler
already found (a coordinate outside the safe area, a boundary that
doesn't close or crosses itself, a path too steep to print).

A `line`/`point` element may be a GROUP (repeated ticks, gridlines,
markers) — its report entry then has `strokeCount`/`count` and a few
`samples` instead of a single `start`/`end`/`at`; that's normal, not a
defect, and a group still needs only one fix entry (with the same id) if
something about the WHOLE group is wrong (e.g. it's positioned off the
axis) — you don't need to enumerate its members.

Judge whether the proposed elements correctly and printably represent
what was asked:
- Fix every HARD ERROR -- these are not optional.
- Bar heights should be proportional to the data and in the stated
  order; an axis's extent should match the data range; a curve's values
  (read from the report's bbox/samples) should match its stated
  function; a region meant to close should have closureGap ~= 0.
- If everything checks out, don't change anything -- do not "improve"
  geometry that already satisfies the request.

OUTPUT: JSON {chat, ok, elements}. If everything is correct, ok: true and
elements: []. If something needs fixing, ok: false and elements holds
ONLY the elements that need to change, each a full corrected replacement
(same id, same geometry shape as the geometry stage) -- do not repeat
elements that are already correct. `chat` is one or two sentences: what
you checked and what, if anything, you fixed.
```
