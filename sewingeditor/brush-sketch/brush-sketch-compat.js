// Compatibility shim for brush-sketch.html so `script.js` (shared with
// index.html) can be reused unmodified -- same pattern as
// parametric-with-tool-compat.js. script.js's setup() unconditionally calls
// loadActions()/initActionEditor()/initLlmEditor() before wiring the
// printer controls and #run-gcode-btn/#save-gcode-btn; on a page without
// that DOM they would throw and abort the rest of setup().
//
// Loaded AFTER llm.js (so this no-op initLlmEditor wins over the real one)
// and BEFORE p5 invokes setup(). initGcodeLlmEditor is repurposed as the
// entry point for this page, which brush-sketch.js (an ES module) exposes
// as window.initBrushSketch. A module may finish loading after p5's
// setup(), so the entry point waits for it if needed.
function loadActions() {}
function initActionEditor() {}
function initLlmEditor() {}
function initGcodeLlmEditor() {
  if (window.initBrushSketch) window.initBrushSketch();
  else window.addEventListener("brush-sketch-ready", () => window.initBrushSketch(), { once: true });
}
let activeAction = "";
