/**
 * editor.js -- the "Function editor" panel: edit one texture function's
 * code, save it (test-runs it and previews the G-code), run the saved
 * draft on the printer, then push it into texture_functions.js.
 *
 * Status rules live in edit-state.js. This file is the DOM, storage, and
 * the save / run / push actions. Drafts persist in localStorage
 * "textureEdits"; unsaved editor text is memory only (the page warns
 * before closing with unsaved edits).
 *
 * The editor holds a texture's group of functions as one block: its `sig`
 * (spec.js -- the one holding its defaults; for stamps that's the private
 * emit*Dot() the exported stamp*() forwards to), the function its
 * BRUSHES / STAMPS entry names, and every helper they call (emit*() and
 * the rest), found by signature.js relatedFunctions(). Save / run / push
 * replace all of them at once; helpers shared with other textures change
 * those too.
 */
import {
  functionText, functionRange, functionStartLine, parseDefaults,
  tableFunction, relatedFunctions, groupText, replaceGroup, splitFunctions,
} from "./signature.js?v=2";
import { STEPS, editStatus } from "./edit-state.js";
import { runInWorker } from "./runner.js";

const STORE_KEY = "textureEdits";

/**
 * @param ctx {
 *   textures,                    spec.js TEXTURES
 *   getSource(),                 current texture_functions.js text
 *   setSource(text),             adopt new file text (re-reads defaults, re-renders cards)
 *   inputs(t, box?),             {values, placement, settings} from t's card (or the param box `box`); throws on bad input
 *   renderParams(t),             a param box (placement + options) for t, synced with its card
 *   onDraftChange(t),            t's saved draft changed: re-read its options, redraw card + param box
 *   showGcode(lines),            put lines in the raw gcode box + viewer
 *   message(text, color),
 *   readDisk(),                  texture_functions.js as on disk now, line endings as LF
 *   writeDisk(text),             write it back, in the disk file's own line endings
 *   download(text, filename),
 * }
 */
export function initEditor(ctx) {
  let drafts = load();
  const buffers = {};   // texture name -> editor text (memory only)
  const results = {};   // texture name -> {text, ok} last action result
  const running = {};   // texture name -> true while its draft is printing
  const badges = {};    // texture name -> badge element on the card
  let current = null;   // texture shown in the panel

  const frame = document.querySelector("#texture-editor-modal");
  const root = document.querySelector("#texture-editor");
  const isOpen = () => frame.classList.contains("active");
  const close = () => { frame.classList.remove("active"); viewer?.stop(); };
  document.querySelector("#texture-editor-close").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && isOpen()) close(); });

  // the modal's own toolpath preview (gcode-viewer.js); the page's viewer behind it still updates too
  const $ = (s) => document.querySelector(s);
  const viewer = window.GcodeViewer ? new window.GcodeViewer({
    canvas: $("#te-toolpath-canvas"),
    slider: $("#te-toolpath-slider"),
    label: $("#te-toolpath-label"),
    buttons: {
      top: $("#te-toolpath-top"), iso: $("#te-toolpath-iso"), fit: $("#te-toolpath-fit"),
      travel: $("#te-toolpath-travel"), play: $("#te-toolpath-play"),
    },
  }) : null;
  // the texture's placement + option inputs (built by the page, kept in sync with its card)
  const paramsHost = $("#te-params");
  const paramsBox = (t) => (current === t ? paramsHost.firstElementChild ?? undefined : undefined);
  const previewByTexture = {}; // texture name -> last gcode text shown in the modal
  function preview(t, lines) {
    ctx.showGcode(lines);
    const text = lines.join("\n");
    previewByTexture[t.name] = text;
    if (viewer && current === t) viewer.setGcode(text);
  }

  // ------------------------------------------------------------ storage --
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}; } catch { return {}; }
  }
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(drafts)); } catch { /* private window */ }
  }

  /** Names of t's functions in `src`: sig, its table entry, then helpers. */
  function groupOf(t, src = ctx.getSource()) {
    const entry = tableFunction(src, t.kind === "brush" ? "BRUSHES" : "STAMPS", t.fn);
    return relatedFunctions(src, [...new Set([t.sig, entry ?? t.sig])]);
  }
  const fileText = (t) => groupText(ctx.getSource(), groupOf(t));

  /** Drafts saved before the editor showed helpers hold only the sig
   * function: append the file's helpers so they match the new block. */
  function migrate() {
    let changed = false;
    for (const t of ctx.textures) {
      const d = drafts[t.name];
      if (!d) continue;
      // the page now holds the file as LF; a draft started from a CRLF copy
      // would otherwise read as stale forever
      for (const k of ["base", "saved", "printed", "pushedText"]) {
        if (typeof d[k] === "string" && d[k].includes("\r")) { d[k] = d[k].replace(/\r\n/g, "\n"); changed = true; }
      }
      let names;
      try { names = groupOf(t); } catch { continue; }
      const extra = names.slice(1);
      const sample = d.saved ?? d.pushedText ?? d.base ?? "";
      if (!extra.length || new RegExp(`\\bfunction\\s+${extra[0]}\\b`).test(sample)) continue;
      const tail = extra.map((n) => functionText(ctx.getSource(), n)).join("\n\n");
      for (const k of ["base", "saved", "printed", "pushedText"]) {
        if (typeof d[k] === "string") d[k] = `${d[k].trimEnd()}\n\n${tail}`;
      }
      changed = true;
    }
    if (changed) persist();
  }
  migrate();
  const status = (t) => {
    let file;
    try { file = fileText(t); } catch { return null; }
    return editStatus(buffers[t.name], drafts[t.name], file);
  };
  const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

  function printerWhy() {
    if (typeof fab === "undefined" || !fab.isPrinting) return "initialize the printer first";
    if (fab.commands.length > 0) return "wait for the current gcode stream to finish";
    return "";
  }

  // ------------------------------------------------------------- render --
  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v; else e[k] = v;
    }
    for (const c of [].concat(children)) e.append(c);
    return e;
  }

  const refs = {};

  function build() {
    root.innerHTML = "";
    const picker = el("select", { class: "te-picker" },
      ctx.textures.map((t) => el("option", { value: t.name, textContent: `${t.name}  (${t.sig})` })));
    picker.addEventListener("change", () => show(ctx.textures.find((t) => t.name === picker.value)));

    // one box per function (setCode); the draft is still one text, the boxes joined
    const code = el("div", { class: "te-codes" });

    const btn = (label, fn) => {
      const b = el("div", { class: "btn", textContent: label });
      b.addEventListener("click", () => {
        if (b.classList.contains("te-disabled")) { ctx.message(`${label}: ${b.title}`, "orange"); return; }
        fn(current);
      });
      return b;
    };
    refs.picker = picker;
    refs.code = code;
    refs.where = el("span", { class: "te-where" });
    refs.steps = el("ol", { class: "te-steps" }, STEPS.map((s, i) => el("li", { textContent: `${i + 1} ${s}` })));
    refs.editorLine = el("div");
    refs.draftLine = el("div");
    refs.nextLine = el("div", { class: "te-next" });
    refs.warn = el("div", { class: "te-warn" });
    refs.save = btn("save", save);
    refs.run = btn("run on printer", runOnPrinter);
    refs.push = btn("push to file", push);
    refs.discard = btn("discard unsaved", discard);
    refs.revert = btn("revert to file", revert);
    refs.result = el("pre", { class: "te-result" });
    refs.note = el("p", { class: "te-note" });

    root.append(
      el("div", { class: "te-head" }, [picker, refs.where]),
      refs.steps,
      el("div", { class: "te-status" }, [refs.editorLine, refs.draftLine, refs.nextLine, refs.warn]),
      code,
      el("div", { class: "te-buttons" }, [refs.save, refs.run, refs.push, el("span", { class: "te-gap" }), refs.discard, refs.revert]),
      refs.result,
      refs.note,
    );
  }

  /** What a function is to the current texture, for its box's heading. */
  function roleOf(t, name) {
    const kind = (/^(stroke|brush|stamp)/.exec(name) || [])[1];
    let entry = null;
    try { entry = tableFunction(ctx.getSource(), t.kind === "brush" ? "BRUSHES" : "STAMPS", t.fn); } catch { /* not in the table */ }
    const roles = [];
    if (name === entry) roles.push("what the card calls");
    if (name === t.sig) roles.push("holds the card's defaults");
    if (!roles.length) roles.push("helper");
    return { kind: kind ? kind.toUpperCase() : "", what: roles.join(" · ") };
  }

  /** Show `text` (a draft or the file's group) as one box per function. */
  function setCode(text) {
    let parts;
    try { parts = splitFunctions(text); } catch { parts = null; }
    if (!parts || !parts.length) parts = [{ name: null, text }]; // can't split: one box, as typed
    refs.code.replaceChildren(...parts.map((p) => {
      const area = el("textarea", { class: "te-code", spellcheck: false, wrap: "off", value: p.text });
      area.rows = Math.min(40, Math.max(6, p.text.split("\n").length + 1));
      area.addEventListener("input", () => {
        buffers[current.name] = [...refs.code.querySelectorAll("textarea")].map((a) => a.value.trim()).join("\n\n");
        refresh();
      });
      area.addEventListener("keydown", (ev) => {
        if (ev.key !== "Tab" || ev.shiftKey) return;
        ev.preventDefault();
        area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
        area.dispatchEvent(new Event("input"));
      });
      const r = p.name ? roleOf(current, p.name) : null;
      const head = el("div", { class: "te-fn-head" }, r
        ? [el("b", { textContent: `${r.kind ? r.kind + " " : ""}${p.name}` }), el("span", { textContent: ` -- ${r.what}` })]
        : [el("b", { textContent: "code" })]);
      return el("div", { class: "te-fn" }, [head, area]);
    }));
  }

  function setBtn(b, enabled, why) {
    b.classList.toggle("te-disabled", !enabled);
    b.title = enabled ? "" : why;
  }

  function refresh() {
    for (const t of ctx.textures) updateBadge(t);
    if (!current || !isOpen()) return;
    const t = current, s = status(t);
    if (!s) { refs.warn.textContent = `${t.sig} or one of its helpers could not be found in texture_functions.js`; return; }
    const d = s.draft;

    refs.steps.querySelectorAll("li").forEach((li, i) => {
      li.className = i + 1 <= s.step ? "done" : i + 1 === s.step + 1 ? "current" : "";
    });
    refs.steps.classList.toggle("te-steps-error", !s.dirty && d.key === "error");

    refs.editorLine.innerHTML = "";
    refs.editorLine.append(el("b", { textContent: "Editor: " }),
      s.dirty ? el("span", { class: "te-dirty", textContent: "● unsaved changes" })
        : el("span", { textContent: drafts[t.name]?.saved != null && d.key !== "pushed" ? "matches the saved draft" : "matches the file" }));

    const draftText = {
      unchanged: "none",
      pushed: `none -- pushed to the file at ${time(d.at)}`,
      error: `has errors (saved ${time(d.at)})`,
      saved: `saved ${time(d.at)} · not printed`,
      printed: `✓ printed ${time(d.at)} · not pushed`,
    }[d.key];
    refs.draftLine.innerHTML = "";
    refs.draftLine.append(el("b", { textContent: "Saved draft: " }),
      el("span", { class: `te-draft-${d.key}`, textContent: running[t.name] ? `${draftText} -- printing now…` : draftText }));
    refs.nextLine.textContent = `Next: ${s.next}`;
    refs.warn.textContent = d.stale
      ? "texture_functions.js changed since this draft started, so it can't be pushed. Revert to file to start over (copy your code out first)."
      : "";

    const pw = printerWhy();
    setBtn(refs.save, s.can.save, "no unsaved edits");
    setBtn(refs.run, s.can.run && !pw && !running[t.name], s.why.run || pw || "already printing");
    setBtn(refs.push, s.can.push, s.why.push);
    setBtn(refs.discard, s.can.discard, "no unsaved edits");
    setBtn(refs.revert, s.can.revert, "already matches the file");

    const r = results[t.name];
    refs.result.textContent = r?.text ?? "";
    refs.result.className = `te-result ${r ? (r.ok ? "te-ok" : "te-err") : ""}`;
  }

  function show(t) {
    current = t;
    if (buffers[t.name] == null) {
      try { buffers[t.name] = drafts[t.name]?.saved ?? fileText(t); } catch (e) { buffers[t.name] = `// ${e.message}`; }
    }
    refs.picker.value = t.name;
    setCode(buffers[t.name]);
    if (viewer) { viewer.fitted = false; viewer.setGcode(previewByTexture[t.name] ?? ""); }
    let names = [t.sig];
    try { names = groupOf(t); } catch { /* refresh() shows the warning */ }
    const helpers = names.slice(1);
    refs.where.textContent = `${t.sig}()` +
      (helpers.length ? ` + ${helpers.length} helper${helpers.length > 1 ? "s" : ""}: ${helpers.join(", ")}` : "") +
      " -- texture_functions.js";
    const shared = names.map((n) => {
      const others = ctx.textures.filter((o) => {
        if (o === t) return false;
        try { return groupOf(o).includes(n); } catch { return false; }
      });
      return others.length ? `${n} (${others.map((o) => o.name).join(", ")})` : null;
    }).filter(Boolean);
    paramsHost.replaceChildren(ctx.renderParams(t));
    refs.note.textContent = `Save and run use the parameters on the right (the same ones as the ${t.name} card), ` +
      `plus the flow / Z offset / lift settings. Saving re-reads the parameters from the saved code, on the card too. ` +
      `Push writes only the functions in the editor; the rest of the file is untouched.` +
      (shared.length ? ` Shared functions -- editing them changes these textures too: ${shared.join("; ")}.` : "");
    refresh();
  }

  function setResult(t, text, ok) {
    results[t.name] = { text, ok };
    refresh();
  }

  /** Error text with the line mapped back into the editor, when known. */
  function errorText(e, patched, t, text) {
    let msg = e.message;
    if (e.line && patched) {
      for (const n of groupOf(t, patched)) {
        const start = functionStartLine(patched, n);
        const end = patched.slice(0, functionRange(patched, n).end).split("\n").length;
        if (e.line < start || e.line > end) continue;
        let at = "";
        try {
          const part = splitFunctions(text).find((p) => p.name === n);
          at = `line ${functionStartLine(part.text, n) + e.line - start} of the ${n} box, `;
        } catch { /* not in the text */ }
        return `${msg}\n(${at}in ${n})`;
      }
      msg += `\n(line ${e.line} of texture_functions.js, outside the editor's functions)`;
    }
    return msg;
  }

  // ------------------------------------------------------------ actions --
  async function save(t) {
    const text = buffers[t.name];
    const file = fileText(t);
    if (text.trim() === file.trim()) {
      // back to the file's text: nothing to keep
      const pushed = drafts[t.name]?.pushedText === file ? drafts[t.name] : null;
      drafts[t.name] = pushed ? { pushedText: pushed.pushedText, pushedAt: pushed.pushedAt } : undefined;
      if (!drafts[t.name]) delete drafts[t.name];
      buffers[t.name] = file;
      setCode(file);
      persist();
      ctx.onDraftChange(t);
      setResult(t, "editor matches the file again -- draft cleared", true);
      return;
    }

    const prev = drafts[t.name];
    const startsNew = !prev || prev.saved == null;
    const draft = {
      ...(prev ?? {}),
      base: startsNew ? file : prev.base,
      saved: text,
      savedAt: Date.now(),
      savedOk: false,
      savedError: null,
    };
    drafts[t.name] = draft;
    persist();
    // the card and the param box re-read their options from the new draft
    // first, so the test-run below uses them
    ctx.onDraftChange(t);
    setResult(t, "saved -- test-running…", true);

    let patched = null;
    try {
      patched = replaceGroup(ctx.getSource(), groupOf(t), text);
      parseDefaults(patched, t.sig); // the card needs to read the options object
      const job = { source: patched, texture: t, ...ctx.inputs(t, paramsBox(t)) };
      const { lines, filamentMm } = await runInWorker(job);
      if (drafts[t.name] !== draft) return; // superseded by a newer save / revert
      draft.savedOk = true;
      preview(t, lines);
      setResult(t, `saved ${time(draft.savedAt)} and test-ran: ${lines.length} lines, ${filamentMm.toFixed(1)} mm filament -> preview + raw gcode box`, true);
    } catch (e) {
      if (drafts[t.name] !== draft) return;
      draft.savedError = errorText(e, patched, t, text);
      setResult(t, `saved, but it doesn't run:\n${draft.savedError}`, false);
    }
    persist();
    refresh();
  }

  async function runOnPrinter(t) {
    const draft = drafts[t.name];
    const runText = draft.saved;
    let lines;
    try {
      const patched = replaceGroup(ctx.getSource(), groupOf(t), runText);
      ({ lines } = await runInWorker({ source: patched, texture: t, ...ctx.inputs(t, paramsBox(t)) }));
    } catch (e) {
      setResult(t, `could not generate the gcode: ${e.message}`, false);
      return;
    }
    const pw = printerWhy();
    if (pw) { setResult(t, pw, false); return; }

    preview(t, lines);
    const gcode = lines.map((g) => checkGcode(g)).filter((g) => g !== "");
    fab.commands.push(...gcode);
    const stream = fab.commands;    // fab.print() streams from this same array
    fab.print();
    running[t.name] = true;
    setResult(t, `printing the saved draft (${gcode.length} lines)…`, true);
    ctx.message(`${t.name}: printing saved draft (${gcode.length} lines)`, "green");

    const poll = setInterval(() => {
      // "stop printing" swaps in a new array and clears isPrinting
      const stopped = fab.commands !== stream || !fab.isPrinting;
      if (!stopped && stream.length > 0) return;
      clearInterval(poll);
      delete running[t.name];
      if (stopped) {
        setResult(t, "print stopped before the end -- not marked as printed", false);
        return;
      }
      const d = drafts[t.name];
      if (d && d.saved === runText) {
        d.printed = runText;
        d.printedAt = Date.now();
        persist();
        setResult(t, `printed ${time(d.printedAt)} -- push to file when you're happy with it`, true);
      } else {
        setResult(t, "print finished, but the draft was saved again meanwhile -- print the new version before pushing", false);
      }
    }, 300);
    refresh();
  }

  async function push(t) {
    const draft = drafts[t.name];
    if (!("showDirectoryPicker" in window)) {
      ctx.download(replaceGroup(ctx.getSource(), groupOf(t), draft.saved), "texture_functions.js");
      setResult(t, "this browser can't write files: replace texture-actions/texture_functions.js with the downloaded file, then reload", false);
      return;
    }
    try {
      // LF on both sides: a Windows checkout is CRLF, a served copy (e.g.
      // Vercel, built from git) is LF -- the same code must compare equal.
      const disk = await ctx.readDisk();
      const names = groupOf(t, disk);
      if (groupText(disk, names) !== draft.base.replace(/\r\n/g, "\n")) {
        throw new Error(`${t.sig} or one of its helpers in texture_functions.js on disk changed since this draft started -- not pushed`);
      }
      const patched = replaceGroup(disk, names, draft.saved);
      parseDefaults(patched, t.sig);
      await ctx.writeDisk(patched);

      const pushedText = groupText(patched, groupOf(t, patched));
      drafts[t.name] = { pushedText, pushedAt: Date.now() };
      buffers[t.name] = pushedText;
      persist();
      ctx.setSource(patched);
      if (current === t) setCode(pushedText);
      setResult(t, `pushed ${time(drafts[t.name].pushedAt)}: ${names.join(", ")} written to texture_functions.js`, true);
      ctx.message(`${t.name}: pushed ${t.sig} and its helpers to texture_functions.js`, "green");
    } catch (e) {
      if (e.name === "AbortError") return;
      setResult(t, `push failed: ${e.message}`, false);
    }
  }

  function discard(t) {
    buffers[t.name] = drafts[t.name]?.saved ?? fileText(t);
    setCode(buffers[t.name]);
    setResult(t, "unsaved edits discarded", true);
  }

  function revert(t) {
    if (!window.confirm(`Throw away the ${t.name} draft and any unsaved edits, and go back to the code in texture_functions.js?`)) return;
    delete drafts[t.name];
    persist();
    ctx.onDraftChange(t);
    buffers[t.name] = fileText(t);
    setCode(buffers[t.name]);
    setResult(t, "reverted to the file", true);
  }

  // -------------------------------------------------------------- badge --
  function updateBadge(t) {
    const b = badges[t.name];
    if (!b) return;
    const s = status(t);
    if (!s || (s.step === 0 && !s.dirty)) { b.textContent = ""; b.className = "te-badge"; return; }
    const key = s.dirty ? "dirty" : s.draft.key;
    b.textContent = running[t.name] ? "● printing draft…" : `● ${s.label}`;
    b.className = `te-badge te-badge-${key}`;
    b.title = s.dirty || s.draft.key !== "pushed" ? `next: ${s.next}` : "";
  }

  window.addEventListener("beforeunload", (ev) => {
    if (ctx.textures.some((t) => status(t)?.dirty)) { ev.preventDefault(); ev.returnValue = ""; }
  });
  setInterval(refresh, 1000); // printer connects / streams finish outside this module

  build();

  return {
    /** Open the panel on texture `t`. */
    open(t) {
      frame.classList.add("active");
      show(t);
      refs.code.querySelector("textarea")?.focus();
    },
    /** A status badge for t's card (kept up to date by refresh()). */
    badge(t) {
      const b = el("span", { class: "te-badge" });
      badges[t.name] = b;
      updateBadge(t);
      return b;
    },
    refresh,
    /** The whole file with t's saved draft swapped in, or null when t has
     * no saved draft (or it can't be swapped in / its options can't be
     * read). The card reads its options from and runs this text. */
    savedSource(t) {
      const saved = drafts[t.name]?.saved;
      if (saved == null) return null;
      try {
        const src = ctx.getSource();
        const names = groupOf(t, src);
        if (saved === groupText(src, names)) return null;
        const patched = replaceGroup(src, names, saved);
        parseDefaults(patched, t.sig);
        return patched;
      } catch {
        return null;
      }
    },
  };
}
