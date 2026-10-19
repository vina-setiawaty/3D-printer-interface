/**
 * texture-actions.js -- renders one Actions-style card per texture
 * function (see spec.js) into #textures, and runs them on the printer.
 *
 * Loaded as a module from index.html. It uses the classic-script globals
 * `fab`, `pushMessage` and `checkGcode` from script.js, only inside click
 * handlers, after p5's setup() has run.
 *
 * Defaults come from texture_functions.js itself (fetched as text and read
 * by signature.js). "save as default" rewrites those literals in that file:
 * directly through the File System Access API (Chrome/Edge -- you pick the
 * texture-actions folder once per session), or as a download otherwise.
 *
 * Inputs here have no `id`, on purpose: script.js's storeLocalData() /
 * loadLocalData() persist every input WITH an id, and would fight this
 * module's own storage (localStorage "textureActions", which keeps only
 * values that differ from the source default).
 */
import * as TF from "./texture_functions.js";
import { TEXTURES, PARAMS } from "./spec.js";
import { parseDefaults, patchDefaults, optionsText } from "./signature.js";
import { buildGcode, findOutOfBounds } from "./generate.js";

const SOURCE_URL = new URL("./texture_functions.js", import.meta.url);
const SOURCE_NAME = "texture_functions.js";
const STORE_KEY = "textureActions";
const SETTINGS = [
  { key: "flowPercent", label: "flow", unit: "%", value: 100, step: 5, min: 1 },
  { key: "zOffset", label: "Z offset", unit: "mm", value: 0, step: 0.1 },
  { key: "liftMm", label: "lift after", unit: "mm", value: 2, step: 0.5, min: 0 },
];

let source = "";       // texture_functions.js text the defaults were read from
let defaults = {};     // texture name -> parseDefaults() list
let dirHandle = null;  // picked texture-actions folder (File System Access)
let store = loadStore();

// ---------------------------------------------------------------- storage --
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.cards && s.settings) return s;
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

function readDefaults() {
  defaults = {};
  for (const t of TEXTURES) defaults[t.name] = parseDefaults(source, t.sig);
  // drop stored overrides that now equal the default
  for (const t of TEXTURES) {
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
 * source default, else the spec's `initial` for required options. */
function shownValue(t, p) {
  const values = cardStore(t.name).values;
  if (p.key in values) return values[p.key];
  return p.required ? t.initial?.[p.key] : p.value;
}

// ------------------------------------------------------------------ input --
function paramInput(t, p) {
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
  input.addEventListener("change", () => onParamChange(t, p, input));
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

function onParamChange(t, p, input) {
  const r = readInput(p, input);
  if (!r.ok) { message(`${t.name}: ${r.error}`, "red"); return; }
  const values = cardStore(t.name).values;
  if (!p.required && r.value === p.value) delete values[p.key];
  else values[p.key] = r.value;
  markModified(p, input, r.value);
  saveStore();
}

// ------------------------------------------------------------------- card --
function placementFields(t) {
  const cs = cardStore(t.name);
  if (!cs.placement) {
    const [x, y] = startXY();
    cs.placement = t.kind === "brush"
      ? { x0: x - 15, y0: y, x1: x + 15, y1: y }
      : { x, y };
  }
  return t.kind === "brush" ? ["x0", "y0", "x1", "y1"] : ["x", "y"];
}

function renderCard(t) {
  const card = el("div", { class: "action-item texture-item", id: `texture-${t.name}` });
  const cs = cardStore(t.name);

  const resetBtn = el("span", { class: "action-modify-btn", textContent: "reset" });
  resetBtn.addEventListener("click", () => {
    cs.values = {};
    saveStore();
    card.replaceWith(renderCard(t));
    message(`${t.name}: reset to source defaults`, "black");
  });
  const saveBtn = el("span", { class: "action-modify-btn", textContent: "save as default" });
  saveBtn.addEventListener("click", () => openSaveModal(t, card));
  card.append(
    el("div", { class: "action-meta-menu" }, [resetBtn, saveBtn]),
    el("h1", { textContent: t.name }),
    el("p", { textContent: t.description }),
  );

  // placement
  const place = el("div", { class: "texture-grid" });
  for (const k of placementFields(t)) {
    const input = el("input", { type: "number", step: 0.5, value: cs.placement[k] });
    input.dataset.place = k;
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (Number.isFinite(n)) { cs.placement[k] = n; saveStore(); }
    });
    place.append(el("span", { class: "label", textContent: `${k} mm` }), input);
  }
  card.append(el("div", { class: "ui-group texture-placement" }, place));

  // options
  const params = defaults[t.name];
  const basic = el("div", { class: "texture-grid" });
  const advanced = el("div", { class: "texture-grid" });
  for (const key of t.basic) {
    const p = params.find((q) => q.key === key);
    if (p) basic.append(...paramInput(t, p));
  }
  const rest = params.filter((p) => !t.basic.includes(p.key));
  for (const p of rest) advanced.append(...paramInput(t, p));
  card.append(el("div", { class: "ui-group" }, basic));
  if (rest.length) {
    card.append(el("details", { class: "texture-advanced" }, [
      el("summary", { textContent: `advanced (${rest.length})` }), advanced,
    ]));
  }
  card.append(el("div", { class: "texture-sig", textContent: `defaults: ${t.sig}()` }));

  const previewBtn = el("div", { class: "btn", textContent: "preview in raw gcode" });
  previewBtn.addEventListener("click", () => preview(t, card));
  const runBtn = el("div", { class: "btn", textContent: "run once", id: `texture-${t.name}-run` });
  runBtn.addEventListener("click", () => run(t, card, runBtn));
  card.append(previewBtn, runBtn);
  return card;
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
    const n = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(n)) throw new Error(`${input.dataset.place} is not a number`);
    placement[input.dataset.place] = n;
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

function generate(t, card) {
  const { lines, filamentMm } = buildGcode(TF, t, cardValues(t, card), cardPlacement(t, card), readSettings());
  const oob = findOutOfBounds(lines, TF.BED_X, TF.BED_Y);
  if (oob) throw new Error(`moves off the ${TF.BED_X}x${TF.BED_Y} bed: "${oob}"`);
  return { lines, filamentMm };
}

function preview(t, card) {
  try {
    const { lines, filamentMm } = generate(t, card);
    const box = document.querySelector("#raw-gcode-textarea");
    if (box) box.value = lines.join("\n");
    message(`${t.name}: ${lines.length} lines, ${filamentMm.toFixed(1)} mm filament -> raw gcode box`, "blue");
  } catch (e) {
    message(`${t.name}: ${e.message}`, "red");
  }
}

function run(t, card, runBtn) {
  if (typeof fab === "undefined" || !fab.isPrinting) { message("initialize printer first", "red"); return; }
  if (fab.commands.length > 0) { message("wait for gcode stream completion", "red"); return; }
  let lines;
  try { ({ lines } = generate(t, card)); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }
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
  let values;
  try { values = cardValues(t, card); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }
  const changes = {};
  for (const p of defaults[t.name]) {
    if (!p.required && values[p.key] !== p.value) changes[p.key] = values[p.key];
  }
  if (Object.keys(changes).length === 0) { message(`${t.name}: no changes from the source defaults`, "black"); return; }

  let patched;
  try { patched = patchDefaults(source, t.sig, changes); } catch (e) { message(`${t.name}: ${e.message}`, "red"); return; }

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
    el("p", { class: "texture-sig", textContent: `rewrites the defaults of ${t.sig}() in texture-actions/${SOURCE_NAME}` }),
    list,
    el("h1", { textContent: "before" }),
    el("pre", { class: "texture-diff", textContent: optionsText(source, t.sig) }),
    el("h1", { textContent: "after" }),
    el("pre", { class: "texture-diff", textContent: optionsText(patched, t.sig) }),
    buttons,
  );
  m.classList.add("active");
}

async function sourceFileHandle() {
  if (!dirHandle) {
    message(`pick the texture-actions folder (the one containing ${SOURCE_NAME})`, "blue");
    dirHandle = await window.showDirectoryPicker({ id: "texture-actions", mode: "readwrite" });
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

async function writeToDisk(t, changes) {
  const handle = await sourceFileHandle();
  const disk = await (await handle.getFile()).text();

  // Patch what is on disk now (keeps any edits made since page load), but
  // only if the values being replaced are still the ones shown here.
  const diskParams = parseDefaults(disk, t.sig);
  for (const k of Object.keys(changes)) {
    const shown = defaults[t.name].find((p) => p.key === k);
    const onDisk = diskParams.find((p) => p.key === k);
    if (!onDisk || onDisk.value !== shown.value) {
      throw new Error(`${t.sig}.${k} changed on disk since the page loaded -- reload and try again`);
    }
  }
  const patched = patchDefaults(disk, t.sig, changes);

  const w = await handle.createWritable();
  await w.write(patched);
  await w.close();

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
  const box = document.querySelector("#textures");
  box.innerHTML = "";
  for (const t of TEXTURES) box.append(renderCard(t));
}

async function init() {
  try {
    const res = await fetch(SOURCE_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    source = await res.text();
    readDefaults();
  } catch (e) {
    message(`textures: could not read ${SOURCE_NAME} (${e.message})`, "red");
    return;
  }
  renderSettings();
  renderCards();
}

init();
