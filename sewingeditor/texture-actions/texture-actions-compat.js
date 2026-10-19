// Compatibility shim so `../script.js` (shared with index.html) can be
// reused unmodified on texture-actions.html, which has no Actions panel and
// no LLM editors -- same approach as gcode-session/gcode-session-compat.js.
// script.js's setup() calls these unconditionally before wiring the Main /
// Motion controller and the raw gcode buttons, and the real versions throw
// on a page without their DOM. draw() reads `activeAction` every frame, a
// global otherwise declared in main/actions.js.
function loadActions() {}
function initActionEditor() {}
function initLlmEditor() {}
function initGcodeLlmEditor() {}
let activeAction = "";
