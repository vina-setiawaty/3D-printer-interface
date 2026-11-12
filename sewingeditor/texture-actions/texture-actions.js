/**
 * texture-actions.js -- renders one Actions-style card per texture
 * function (see spec.js) into #textures, and runs them on the printer.
 *
 * Loaded as a module from index.html. It uses the classic-script globals
 * `fab`, `pushMessage` and `checkGcode` from script.js, only inside click
 * handlers, after p5's setup() has run.
 *
 * Defaults come from texture_functions.js itself (fetched as text and read
 * by signature.js). By default that is the copy served with the page; "link
 * texture_functions.js" above the cards reads your local file instead (the
 * folder is remembered across reloads), so a deployed copy (Vercel) can
 * edit and push to the checkout on your disk. The page holds the text as
 * LF and writes back in the disk file's own line endings.
 * "save as default" rewrites those literals in that file:
 * directly through the File System Access API (Chrome/Edge -- you pick the
 * texture-actions folder once per session), or as a download otherwise.
 *
 * "edit code" on a card opens the function editor (editor.js): edit the
 * function itself, save (test-runs it), run the saved draft on the
 * printer, then push it into texture_functions.js.
 *
 * Cards generate G-code through runner.js from the current `source` text,
 * not from the module imported at load, so pushed code takes effect
 * without a reload.
 *
 * Inputs here have no `id`, on purpose: script.js's storeLocalData() /
 * loadLocalData() persist every input WITH an id, and would fight this
 * module's own storage (localStorage "textureActions", which keeps only
 * values that differ from the source default).
 */
import * as TF from "./texture_functions.js";
import { PARAMS } from "./spec.js?v=2";
import { parseAllDefaults, patchAllDefaults, optionsText, listTextures } from "./signature.js?v=4";
import { runInWorker } from "./runner.js";
import { initEditor } from "./editor.js?v=8";

const SOURCE_URL = new URL("./texture_functions.js", import.meta.url);
const SOURCE_NAME = "texture_functions.js";
const STORE_KEY = "textureActions";
const SETTINGS = [
  { key: "flowPercent", label: "flow", unit: "%", value: 100, step: 5, min: 1 },
  { key: "zOffset", label: "Z offset", unit: "mm", value: 0, step: 0.1 },
  { key: "liftMm", label: "lift after", unit: "mm", value: 2, step: 0.5, min: 0 },
];

let source = "";       // texture_functions.js text the defaults were read from (always LF)
// The textures: one per BRUSHES entry in `source` (listTextures), plus the
// function editor's new textures that aren't pushed yet. The objects stay
// the same across refreshes (syncTextures), since the editor holds on to them.
const TEXTURES = [];
let defaults = {};     // texture name -> parseAllDefaults() list (each param tagged with its fn)
let dirHandle = null;  // picked texture-actions folder (File System Access), remembered in IndexedDB
let linked = false;    // `source` was read from that folder, not from the served copy
let store = loadStore();
let editor = null;     // initEditor() result

// ---------------------------------------------------------------- storage --
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.cards && s.settings) {
      // stampOrder was renamed brushOrder: keep a value saved under the old name
      for (const c of Object.values(s.cards)) {
        if (c?.values && "stampOrder" in c.values) {
          c.values.brushOrder ??= c.values.stampOrder;
          delete c.values.stampOrder;
        }
      }
      return s;
    }
  } catch { /* private window / blocked storage */ }
  return { cards: {}, settings: {} };
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* ignore */ }
}

function cardStore(name) {
  store.cards[name] ??= { values: {}, placement: null };
  return store.cards[name];
}

function message(text, color) {
  if (typeof pushMessage === "function") pushMessage(text, color);
  else console.log(text);
}

// ---------------------------------------------------------------- helpers --
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e[k] = v;
  }
  for (const c of [].concat(children)) e.append(c);
  return e;
}

/** Rebuild TEXTURES from the file and the editor's unpushed new textures,
 * keeping each texture's object. */
function syncTextures() {
  let found = [];
  try { found = listTextures(source); } catch (e) { message(`textures: ${e.message}`, "red"); }
  const names = new Set(found.map((t) => t.name));
  for (const t of editor?.pendingTextures() ?? []) if (!names.has(t.name)) found.push(t);
  const old = new Map(TEXTURES.map((t) => [t.name, t]));
  TEXTURES.length = 0;
  for (const f of found) {
    const t = old.get(f.name) ?? f;
    if (t !== f) { for (const k of Object.keys(t)) delete t[k]; Object.assign(t, f); }
    TEXTURES.push(t);
  }
}

/** The textures changed (one created, pushed or thrown away): rebuild the
 * list, the defaults and the cards. */
function refreshTextures() {
  syncTextures();
  readDefaults();
  renderCards();
}

/** The code t's card reads its options from and runs: the file, with t's
 * saved draft from the function editor swapped in when there is one. */
function codeFor(t) {
  return editor?.savedSource(t) ?? source;
}

function readDefaults(only = TEXTURES) {
  for (const t of only) {
    try { defaults[t.name] = parseAllDefaults(codeFor(t), t.sigs); } catch { defaults[t.name] ??= []; }
  }
  // drop stored overrides that now equal the default
  for (const t of only) {
    const values = cardStore(t.name).values;
    for (const p of defaults[t.name]) {
      if (!p.required && p.key in values && values[p.key] === p.value) delete values[p.key];
    }
  }
  saveStore();
}

function startXY() {
  const x = Number(document.querySelector("#start-x")?.value ?? 100);
  const y = Number(document.querySelector("#start-y")?.value ?? 100);
  return [Number.isFinite(x) ? x : 100, Number.isFinite(y) ? y : 100];
}

/** The value a param's input should show: stored override, else the
 * source default (none for an option without one). */
function shownValue(t, p) {
  const values = cardStore(t.name).values;
  if (p.key in values) return values[p.key];
  return p.required ? undefined : p.value;
}

// ------------------------------------------------------------------ input --
function paramInput(t, p, box) {
  const meta = PARAMS[p.key] ?? { step: 0.1 };
  const value = shownValue(t, p);
  let input;
  if (meta.options) {
    input = el("select", {}, meta.options.map((o) => el("option", { value: o, textContent: o })));
    input.value = value;
  } else {
    input = el("input", { type: "number", step: meta.step ?? 0.1 });
    if (meta.min !== undefined) input.min = meta.min;
    if (meta.max !== undefined) input.max = meta.max;
    if (p.value === null) input.placeholder = "auto";
    input.value = value === null || value === undefined ? "" : value;
  }
  input.dataset.key = p.key;
  input.addEventListener("change", () => onParamChange(t, p, input, box));
  markModified(p, input, value);
  const label = el("span", { class: "label", textContent: p.key });
  if (meta.unit) label.append(el("span", { class: "texture-unit", textContent: ` ${meta.unit}` }));
  label.title = p.required ? "no default in the source" : `default: ${p.value === null ? "auto (null)" : p.value}`;
  return [label, input];
}

/** Parse one input; returns {ok, value} or {ok:false, error}. */
function readInput(p, input) {
  const meta = PARAMS[p.key] ?? {};
  if (meta.options) return { ok: true, value: input.value };
  const raw = input.value.trim();
  if (raw === "") {
    return p.value === null ? { ok: true, value: null } : { ok: false, error: `${p.key} needs a value` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${p.key} is not a number` };
  if (meta.min !== undefined && n < meta.min) return { ok: false, error: `${p.key} must be >= ${meta.min}` };
  if (meta.max !== undefined && n > meta.max) return { ok: false, error: `${p.key} must be <= ${meta.max}` };
  return { ok: true, value: n };
}

function markModified(p, input, value) {
  input.classList.toggle("texture-modified", !p.required && value !== p.value);
}

function onParamChange(t, p, input, box) {
  const r = readInput(p, input);
  if (!r.ok) { message(`${t.name}: ${r.error}`, "red"); return; }
  const values = cardStore(t.name).values;
  if (!p.required && r.value === p.value) delete values[p.key];
  else values[p.key] = r.value;
  markModified(p, input, r.value);
  saveStore();
  syncViews(t, box);
}

// ------------------------------------------------------------ param boxes --
// A texture's placement + option inputs are shown twice: on its card and in
// the function editor. Both are built here from the same store, and a change
// in one rebuilds the other.
const views = {}; // texture name -> Set of param boxes currently showing it

function renderParams(t) {
  const box = el("div", { class: "texture-params" });
  (views[t.name] ??= new Set()).add(box);
  fillParams(box, t);
  return box;
}

/** Rebuild every connected param box of t, except `except`. */
function syncViews(t, except = null) {
  for (const box of views[t.name] ?? []) {
    if (!box.isConnected) views[t.name].delete(box);
    else if (box !== except) fillParams(box, t);
  }
}

/** t's saved draft changed (saved, reverted, cleared): re-read its options
 * and redraw its card and the editor's param box. */
function onDraftChange(t) {
  readDefaults([t]);
  document.querySelector(`#texture-${t.name}`)?.replaceWith(renderCard(t));
  syncViews(t);
}

// ------------------------------------------------------------------- card --
// The card's line: a shape, and the fields that shape needs (buildPath in
// generate.js turns them into the point list the stroke walks).
const PLACEMENT_DEFAULTS = {
  shape: "straight", corners: "", curveMode: "preset",
  bend: 8, waveHeight: 0, waveLength: 10,
  fx: "x0 + t", fy: "y0 + 5*sin(t/4)", t0: 0, t1: 40,
};
const SHAPES = [["straight", "straight line"], ["polyline", "polyline with corners"], ["curve", "smooth curve"]];
const CURVE_MODES = [["preset", "arc + wave"], ["formula", "formula x(t), y(t)"]];

/** [key, label, kind ("number" | "text" | "select"), options] for each
 * line field the card's current shape uses. */
function placementFields(t) {
  const cs = cardStore(t.name);
  if (!cs.placement) {
    const [x, y] = startXY();
    cs.placement = { x0: x - 15, y0: y, x1: x + 15, y1: y };
  }
  for (const [k, v] of Object.entries(PLACEMENT_DEFAULTS)) if (!(k in cs.placement)) cs.placement[k] = v;
  const p = cs.placement;
  const formula = p.shape === "curve" && p.curveMode === "formula";
  const fields = [["shape", "shape", "select", SHAPES]];
  if (p.shape === "curve") fields.push(["curveMode", "curve", "select", CURVE_MODES]);
  fields.push(["x0", "x0 mm", "number"], ["y0", "y0 mm", "number"]);
  if (!formula) fields.push(["x1", "x1 mm", "number"], ["y1", "y1 mm", "number"]);
  if (p.shape === "polyline") fields.push(["corners", "corners x,y; x,y", "text"]);
  if (p.shape === "curve" && !formula) {
    fields.push(["bend", "bend mm", "number"], ["waveHeight", "wave height mm", "number"], ["waveLength", "wave length mm", "number"]);
  }
  if (formula) fields.push(["fx", "x(t) =", "text"], ["fy", "y(t) =", "text"], ["t0", "t from", "number"], ["t1", "t to", "number"]);
  return fields;
}

/** Three corners zigzagging 5 mm either side of the straight line -- a
 * starting point when a card switches to "polyline". */
function defaultCorners({ x0, y0, x1, y1 }) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * 5, ny = (dx / L) * 5;
  return [[0.25, 1], [0.5, -1], [0.75, 1]]
    .map(([f, side]) => `${+(x0 + dx * f + nx * side).toFixed(1)},${+(y0 + dy * f + ny * side).toFixed(1)}`)
    .join("; ");
}

function renderCard(t) {
  const card = el("div", { class: "action-item texture-item", id: `texture-${t.name}` });
  const cs = cardStore(t.name);

  const resetBtn = el("span", { class: "action-modify-btn", textContent: "reset" });
  resetBtn.addEventListener("click", () => {
    cs.values = {};
    saveStore();
    card.replaceWith(renderCard(t));
    syncViews(t);
    message(`${t.name}: reset to source defaults`, "black");
  });
  const saveBtn = el("span", { class: "action-modify-btn", textContent: "save as default" });
  saveBtn.addEventListener("click", () => openSaveModal(t, card));
  const editBtn = el("span", { class: "action-modify-btn", textContent: "edit code" });
  editBtn.addEventListener("click", () => editor.open(t));
  card.append(
    el("div", { class: "action-meta-menu" }, [resetBtn, saveBtn, editBtn]),
    el("h1", { textContent: t.name }),
    editor.badge(t),
    el("p", { textContent: t.description }),
  );

  card.append(renderParams(t));

  const previewBtn = el("div", { class: "btn", textContent: "preview in raw gcode" });
  previewBtn.addEventListener("click", () => preview(t, card));
  const runBtn = el("div", { class: "btn", textContent: "run once", id: `texture-${t.name}-run` });
  runBtn.addEventListener("click", () => run(t, card, runBtn));
  card.append(previewBtn, runBtn);
  return card;
}

/** Fill `box` with t's placement and option inputs (from the store and
 * the options of codeFor(t)). */
function fillParams(box, t) {
  const cs = cardStore(t.name);
  box.replaceChildren();

  // placement
  const place = el("div", { class: "texture-grid" });
  for (const [k, label, kind, options] of placementFields(t)) {
    let input;
    if (kind === "select") {
      input = el("select", {}, options.map(([v, text]) => el("option", { value: v, textContent: text })));
      input.value = cs.placement[k];
    } else if (kind === "text") {
      input = el("input", { type: "text", value: cs.placement[k] ?? "", spellcheck: false });
    } else {
      input = el("input", { type: "number", step: 0.5, value: cs.placement[k] });
    }
    input.dataset.place = k;
    input.dataset.kind = kind;
    input.addEventListener("change", () => {
      if (kind === "number") {
        const n = Number(input.value);
        if (!Number.isFinite(n)) return;
        cs.placement[k] = n;
      } else {
        cs.placement[k] = input.value;
      }
      if (k === "shape" && input.value === "polyline" && !String(cs.placement.corners ?? "").trim()) {
        cs.placement.corners = defaultCorners(cs.placement);
      }
      saveStore();
      // a shape / curve choice changes which fields there are: redraw this box too
      syncViews(t, kind === "select" ? null : box);
    });
    place.append(el("span", { class: "label", textContent: label }), input);
  }
  box.append(el("div", { class: "texture-group-title", textContent: "line (where it prints)" }));
  box.append(el("div", { class: "ui-group texture-placement" }, place));

  // options, grouped by the function they belong to: the stroke's (how the
  // path is walked), then the brush's (the mark it lays)
  const params = defaults[t.name] ?? [];
  for (const fn of t.sigs) {
    const own = params.filter((p) => p.fn === fn);
    if (!own.length) continue;
    const role = /^stroke/.test(fn) ? "stroke" : /^brush/.test(fn) ? "brush" : "options";
    const grid = el("div", { class: "texture-grid" });
    for (const p of own) grid.append(...paramInput(t, p, box));
    box.append(el("div", { class: "texture-group-title", textContent: `${role} -- ${fn}()` }));
    box.append(el("div", { class: "ui-group" }, grid));
  }
  if (editor?.savedSource(t) != null) {
    box.append(el("div", { class: "texture-sig", textContent: "defaults from the saved draft (not pushed yet)" }));
  }
}

/** Current option values of a card, or throws with every input error. */
function cardValues(t, card) {
  const values = {}, errors = [];
  for (const p of defaults[t.name]) {
    const input = card.querySelector(`[data-key="${p.key}"]`);
    const r = readInput(p, input);
    if (r.ok) values[p.key] = r.value; else errors.push(r.error);
  }
  if (errors.length) throw new Error(errors.join("; "));
  return values;
}

function cardPlacement(t, card) {
  const placement = {};
  for (const input of card.querySelectorAll("[data-place]")) {
    const k = input.dataset.place;
    if (input.dataset.kind !== "number") { placement[k] = input.value; continue; }
    const n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) throw new Error(`${k} is not a number`);
    placement[k] = n;
  }
  return placement;
}

function readSettings() {
  const s = {};
  for (const def of SETTINGS) {
    const n = Number(document.querySelector(`[data-setting="${def.key}"]`).value);
    if (!Number.isFinite(n)) throw new Error(`${def.label} is not a number`);
    s[def.key] = n;
  }
  const startZ = Number(document.querySelector("#start-z")?.value ?? 10);
  s.startZ = Number.isFinite(startZ) ? startZ : 10;
  return s;
}

/** {values, placement, settings} of t's card; throws on bad input. */
function cardInputs(t, card = document.querySelector(`#texture-${t.name}`)) {
  return { values: cardValues(t, card), placement: cardPlacement(t, card), settings: readSettings() };
}

/** G-code for a card from the file's current text, with t's saved draft
 * swapped in if it has one (see runner.js). */
function generate(t, card) {
  return runInWorker({ source: codeFor(t), texture: t, ...cardInputs(t, card) });
}

function showGcode(lines) {
  const text = lines.join("\n");
  const box = document.querySelector("#raw-gcode-textarea");
  if (box) box.value = text;
  window.gcodeViewer?.setGcode(text);
}

async function preview(t, card) {
  try {
    const { lines, filamentMm } = await generate(t, card);
    showGcode(lines);
    message(`${t.name}: ${lines.length} lines, ${filamentMm.toFixed(1)} mm filament -> raw gcode box`, "blue");
  } catch (e) {
    message(`${t.name}: ${e.message}`, "red");
  }
}

async function run(t, card, runBtn) {
  if (typeof fab === "undefined" || !fab.isPrinting) { message("initialize printer first", "red"); return; }
  if (fab.commands.length > 0) { message("wait for gcode stream completion", "red"); return; }
  let lines;
  try { ({ lines } = await generate(t, card)); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }
  if (fab.commands.length > 0) { message("wait for gcode stream completion", "red"); return; }
  const gcode = lines.map((g) => checkGcode(g)).filter((g) => g !== "");
  fab.commands.push(...gcode);
  fab.print();
  runBtn.classList.add("active");
  const poll = setInterval(() => {
    if (fab.commands.length === 0 || !fab.isPrinting) { runBtn.classList.remove("active"); clearInterval(poll); }
  }, 500);
  message(`texture ${t.name} ran (${gcode.length} lines)`, "green");
}

// ------------------------------------------------------- save as default --
let modal = null;

function ensureModal() {
  if (modal) return modal;
  modal = el("div", { class: "modal", id: "texture-save-modal" });
  document.body.append(modal);
  return modal;
}

function openSaveModal(t, card) {
  if (editor.savedSource(t) != null) {
    message(`${t.name}: has a saved draft -- change its defaults in "edit code", or push / revert the draft first`, "orange");
    return;
  }
  let values;
  try { values = cardValues(t, card); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }
  const changes = {};
  for (const p of defaults[t.name]) {
    if (!p.required && values[p.key] !== p.value) changes[p.key] = values[p.key];
  }
  if (Object.keys(changes).length === 0) { message(`${t.name}: no changes from the source defaults`, "black"); return; }

  let patched;
  try { patched = patchAllDefaults(source, t.sigs, changes); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }

  // the functions whose defaults change (a card's options live in its stroke and its brush)
  const touched = [...new Set(Object.keys(changes).map((k) => defaults[t.name].find((p) => p.key === k).fn))];

  const m = ensureModal();
  m.innerHTML = "";
  const close = el("div", { class: "texture-modal-close", textContent: "×" });
  close.addEventListener("click", () => m.classList.remove("active"));
  const list = el("ul", { class: "texture-change-list" });
  for (const [k, v] of Object.entries(changes)) {
    const old = defaults[t.name].find((p) => p.key === k).value;
    list.append(el("li", { textContent: `${k}: ${old === null ? "null" : old} → ${v === null ? "null" : v}` }));
  }

  const buttons = el("div", { class: "actions-editor-group" });
  if ("showDirectoryPicker" in window) {
    const writeBtn = el("div", { class: "btn", textContent: `write to ${SOURCE_NAME}` });
    writeBtn.addEventListener("click", async () => {
      try {
        await writeToDisk(t, changes);
        m.classList.remove("active");
      } catch (e) {
        if (e.name !== "AbortError") message(`save failed: ${e.message}`, "red");
      }
    });
    buttons.append(el("div", { class: "ui-item" }, writeBtn));
  }
  const dlBtn = el("div", { class: "btn", textContent: "download patched file" });
  dlBtn.addEventListener("click", () => {
    download(patched, SOURCE_NAME);
    message(`replace texture-actions/${SOURCE_NAME} with the downloaded file, then reload`, "orange");
    m.classList.remove("active");
  });
  const cancelBtn = el("div", { class: "btn", textContent: "cancel" });
  cancelBtn.addEventListener("click", () => m.classList.remove("active"));
  buttons.append(el("div", { class: "ui-item" }, dlBtn), el("div", { class: "ui-item" }, cancelBtn));

  m.append(
    close,
    el("h1", { textContent: `Save defaults: ${t.name}` }),
    el("p", { class: "texture-sig", textContent: `rewrites the defaults of ${touched.map((n) => `${n}()`).join(" and ")} in texture-actions/${SOURCE_NAME}` }),
    list,
    el("h1", { textContent: "before" }),
    el("pre", { class: "texture-diff", textContent: touched.map((n) => `${n}: ${optionsText(source, n)}`).join("\n\n") }),
    el("h1", { textContent: "after" }),
    el("pre", { class: "texture-diff", textContent: touched.map((n) => `${n}: ${optionsText(patched, n)}`).join("\n\n") }),
    buttons,
  );
  m.classList.add("active");
}

// The picked folder handle survives reloads in IndexedDB (localStorage
// can't hold one). Permission doesn't: the browser may ask again once per
// session, and only from a click.
function handleStore(mode, op) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("textureActions", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = op(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveDirHandle = (h) => handleStore("readwrite", (s) => s.put(h, "dir")).catch(() => {});
const loadDirHandle = () => handleStore("readonly", (s) => s.get("dir")).catch(() => null);

async function sourceFileHandle() {
  if (!dirHandle) {
    message(`pick the texture-actions folder (the one containing ${SOURCE_NAME})`, "blue");
    dirHandle = await window.showDirectoryPicker({ id: "texture-actions", mode: "readwrite" });
    saveDirHandle(dirHandle);
  }
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) !== "granted" &&
      (await dirHandle.requestPermission(opts)) !== "granted") {
    throw new Error("write permission was not granted");
  }
  try {
    return await dirHandle.getFileHandle(SOURCE_NAME);
  } catch {
    dirHandle = null;
    throw new Error(`that folder has no ${SOURCE_NAME} -- pick sewingeditor/texture-actions`);
  }
}

// Line endings: the page works in LF throughout. A Windows checkout is
// CRLF while a copy served from git (Vercel) is LF, so text read from disk
// is normalized, and writes go back in whatever the file on disk uses.
const toLF = (text) => text.replace(/\r\n/g, "\n");

async function readDisk() {
  const handle = await sourceFileHandle();
  return toLF(await (await handle.getFile()).text());
}

async function writeDisk(text) {
  const handle = await sourceFileHandle();
  const crlf = (await (await handle.getFile()).text()).includes("\r\n");
  const w = await handle.createWritable();
  await w.write(crlf ? toLF(text).replace(/\n/g, "\r\n") : toLF(text));
  await w.close();
  // every caller adopts what it wrote as `source`, so the page now holds
  // the local file
  linked = true;
  renderLinkBar();
}

/** "link" / "reload from file": read texture_functions.js from the picked
 * folder instead of the copy this page was served with. */
async function linkSource() {
  try {
    const text = await readDisk();
    linked = true;
    setSource(text);
    message(`textures: using ${SOURCE_NAME} from your folder`, "green");
  } catch (e) {
    if (e.name !== "AbortError") message(`textures: ${e.message}`, "red");
  }
  renderLinkBar();
}

/** "new texture": a name and where its code starts from (blank, or a copy
 * of an existing texture); opens it in the function editor. */
function renderNewBar() {
  const bar = document.querySelector("#texture-new");
  if (!bar) return;
  const name = el("input", { type: "text", placeholder: "name, e.g. zigzag", size: 16 });
  const from = el("select", {}, [
    el("option", { value: "", textContent: "blank stroke + brush" }),
    ...TEXTURES.filter((t) => !t.isNew).map((t) => el("option", { value: t.name, textContent: `copy of ${t.name}` })),
  ]);
  const btn = el("button", { textContent: "new texture" });
  btn.addEventListener("click", () => {
    const n = name.value.trim();
    try {
      editor.createTexture(n, TEXTURES.find((t) => t.name === from.value) ?? null);
      name.value = "";
    } catch (e) {
      message(`new texture: ${e.message}`, "red");
    }
  });
  bar.replaceChildren(
    el("div", { class: "ui-item" }, btn), el("div", { class: "ui-item" }, name), el("div", { class: "ui-item" }, from),
    el("span", { class: "label", textContent: "opens in the function editor; save, run, then push to add it to the file" }),
  );
}

function renderLinkBar() {
  const bar = document.querySelector("#texture-link");
  if (!bar) return;
  bar.innerHTML = "";
  if (!("showDirectoryPicker" in window)) {
    bar.append(el("span", { class: "label", textContent: `${SOURCE_NAME}: the copy served with this page (this browser can't open local folders)` }));
    return;
  }
  const btn = el("button", { textContent: linked ? "reload from file" : dirHandle ? `reconnect ${SOURCE_NAME}` : `link ${SOURCE_NAME}` });
  btn.addEventListener("click", linkSource);
  const where = linked
    ? `${SOURCE_NAME}: your local file (${dirHandle?.name ?? "folder"})`
    : `${SOURCE_NAME}: the copy served with this page${dirHandle ? " -- click to read your local file again" : ""}`;
  bar.append(el("div", { class: "ui-item" }, btn), el("span", { class: "label", textContent: where }));
}

async function writeToDisk(t, changes) {
  const disk = await readDisk();

  // Patch what is on disk now (keeps any edits made since page load), but
  // only if the values being replaced are still the ones shown here.
  const diskParams = parseAllDefaults(disk, t.sigs);
  for (const k of Object.keys(changes)) {
    const shown = defaults[t.name].find((p) => p.key === k);
    const onDisk = diskParams.find((p) => p.key === k);
    if (!onDisk || onDisk.value !== shown.value) {
      throw new Error(`${shown.fn}.${k} changed on disk since the page loaded -- reload and try again`);
    }
  }
  const patched = patchAllDefaults(disk, t.sigs, changes);
  await writeDisk(patched);

  source = patched;
  readDefaults();
  renderCards();
  message(`${t.name}: saved ${Object.keys(changes).length} default(s) to ${SOURCE_NAME}`, "green");
}

function download(text, filename) {
  const link = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/javascript" })), download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// ------------------------------------------------------------------- init --
function renderSettings() {
  const box = document.querySelector("#texture-settings");
  box.innerHTML = "";
  for (const def of SETTINGS) {
    const input = el("input", { type: "number", step: def.step, value: store.settings[def.key] ?? def.value });
    if (def.min !== undefined) input.min = def.min;
    input.dataset.setting = def.key;
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) { store.settings[def.key] = n; saveStore(); }
    });
    box.append(el("div", { class: "ui-item" }, [
      el("span", { class: "label", textContent: `${def.label} (${def.unit}) ` }), input,
    ]));
  }
}

function renderCards() {
  renderNewBar();
  const box = document.querySelector("#textures");
  box.innerHTML = "";
  for (const t of TEXTURES) if (!t.isNew) box.append(renderCard(t)); // a new texture gets its card when pushed
  for (const t of TEXTURES) syncViews(t); // the editor's param box too
}

function setSource(text) {
  source = toLF(text);
  refreshTextures();
}

async function init() {
  try {
    const res = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    source = toLF(await res.text());
    syncTextures();
    readDefaults();
  } catch (e) {
    message(`textures: could not read ${SOURCE_NAME} (${e.message})`, "red");
    return;
  }
  // A folder linked on an earlier visit: read from it straight away if the
  // browser still allows it without asking; otherwise the link bar offers
  // a "reconnect" click (a permission prompt needs one).
  if ("showDirectoryPicker" in window) {
    dirHandle = (await loadDirHandle()) ?? null;
    try {
      if (dirHandle && (await dirHandle.queryPermission({ mode: "readwrite" })) === "granted") {
        source = await readDisk();
        linked = true;
        syncTextures();
        readDefaults();
      }
    } catch { /* folder moved or gone: stay on the served copy */ }
  }
  editor = initEditor({
    textures: TEXTURES,
    getSource: () => source,
    setSource,
    inputs: (t, box) => cardInputs(t, box),
    renderParams,
    onDraftChange,
    showGcode,
    message,
    readDisk,
    writeDisk,
    download,
    refreshTextures,
    runOnce: (t, box, btn) => run(t, box, btn),
  });
  syncTextures(); // again, now with the editor's unpushed new textures
  readDefaults(); // again, now with any saved drafts swapped in
  renderLinkBar();
  renderSettings();
  renderCards();
}

init();
