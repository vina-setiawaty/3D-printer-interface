// Compatibility shim so `script.js` (shared with index.html) can be reused
// unmodified on gcode-session.html, which has no Actions panel and no
// Action-editor LLM tab. `script.js`'s setup() unconditionally calls
// loadActions()/initActionEditor() (actions.js) and initLlmEditor() (llm.js)
// *before* wiring the Main/Motion controller and #run-gcode-btn/#save-gcode-btn
// — each of those does `document.querySelector("#some-id").addEventListener(...)`
// with no null check, so on a page missing that DOM they throw and abort the
// rest of setup(), silently breaking every other control. Loading this file
// after llm.js (so its no-op wins over the real initLlmEditor) and before p5
// invokes setup() prevents that.
//
// draw() also reads `activeAction` on every frame, declared only in
// actions.js — declaring it here as an inert value avoids that separate
// per-frame crash without pulling in the rest of actions.js (which would
// collide with this same top-level `let`).
function loadActions() {}
function initActionEditor() {}
function initLlmEditor() {}
function initGcodeLlmEditor() {
  initGcodeSessionEditor();
}
let activeAction = "";
