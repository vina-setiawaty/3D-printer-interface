/**
 * signature.js -- read and rewrite the default values of a function's
 * options object, straight from the texture_functions.js source text.
 *
 * The source file is the single source of truth for defaults: the panel
 * reads them from here at load time, and "save as default" writes them
 * back here. Only the default literals inside one function's
 * `{ key = value, ... } = {}` parameter are touched; every other byte of
 * the file is preserved.
 *
 * Pure string functions, no DOM -- shared by the browser panel and the
 * offline tests.
 */

/** Copy of `src` with comment text replaced by spaces (same length, so
 * indices still line up with the original). Strings are kept as-is. */
function maskComments(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) if (src[i] !== "\n") out[i] = " ";
    } else if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
    } else {
      i++;
    }
  }
  return out.join("");
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `start` in masked text. */
function matchBracket(masked, start) {
  const stack = [];
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < masked.length && masked[i] !== c) i += masked[i] === "\\" ? 2 : 1;
      continue;
    }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) throw new Error(`unbalanced "${c}" at ${i}`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`no closing bracket for ${start}`);
}

/** {start, end} of the text INSIDE the braces of `fnName`'s last
 * destructured options parameter. */
function findOptionsObject(src, fnName) {
  const masked = maskComments(src);
  const re = new RegExp(`\\bfunction\\s+${fnName}\\s*\\(`, "g");
  const m = re.exec(masked);
  if (!m) throw new Error(`function ${fnName} not found`);
  const open = m.index + m[0].length - 1;
  const close = matchBracket(masked, open);
  // the last top-level `{` that is a pattern, not the `= {}` default after it
  let brace = -1;
  for (let i = open + 1; i < close; i++) {
    if (masked[i] === "{") {
      if (!/=\s*$/.test(masked.slice(open + 1, i))) brace = i;
      i = matchBracket(masked, i);
    }
  }
  if (brace === -1) throw new Error(`function ${fnName} has no options object`);
  return { masked, start: brace + 1, end: matchBracket(masked, brace) };
}

function parseLiteral(raw) {
  if (raw === "null") return { ok: true, value: null };
  if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { ok: true, value: Number(raw) };
  const s = /^"([^"\\]*)"$/.exec(raw) || /^'([^'\\]*)'$/.exec(raw);
  if (s) return { ok: true, value: s[1] };
  return { ok: false };
}

/**
 * Parse `fnName`'s option defaults. Returns an ordered list of
 * `{ key, value, raw, required, literal, valueStart, valueEnd }`:
 *   required -- the key has no default (e.g. dashed's segLen)
 *   literal  -- false when the default is an expression this module can't
 *               read or rewrite (none in the current file)
 */
export function parseDefaults(src, fnName) {
  const { masked, start, end } = findOptionsObject(src, fnName);
  const params = [];
  let pieceStart = start;
  const flush = (pieceEnd) => {
    const text = masked.slice(pieceStart, pieceEnd);
    const lead = text.length - text.trimStart().length;
    const body = text.trim();
    // `...brush` -- a stroke passing every other option on to its brush
    if (body && !body.startsWith("...")) {
      const eq = /^([A-Za-z_$][\w$]*)\s*(=\s*)?/.exec(body);
      if (!eq) throw new Error(`can't parse "${body}" in ${fnName}`);
      const key = eq[1];
      if (!eq[2]) {
        params.push({ key, value: undefined, raw: null, required: true, literal: true });
      } else {
        const valueStart = pieceStart + lead + eq[0].length;
        const valueEnd = pieceStart + lead + body.length;
        const raw = src.slice(valueStart, valueEnd);
        const lit = parseLiteral(raw);
        params.push({
          key, value: lit.ok ? lit.value : undefined, raw, required: false,
          literal: lit.ok, valueStart, valueEnd,
        });
      }
    }
    pieceStart = pieceEnd + 1;
  };
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < end && masked[i] !== c) i += masked[i] === "\\" ? 2 : 1;
    } else if (OPEN[c]) {
      i = matchBracket(masked, i);
    } else if (c === ",") {
      flush(i);
    }
  }
  flush(end);
  return params;
}

/**
 * A texture's options are spread over its stroke and its brush: parse
 * each of `fnNames` in order and tag every param with the `fn` it lives
 * in. A key in more than one keeps the first (the stroke's -- e.g.
 * directionalBlobDotted's azimuthDeg is the stroke's offset, which it
 * turns into the brush's own). A function without an options object adds
 * nothing.
 */
export function parseAllDefaults(src, fnNames) {
  const seen = new Set(), out = [];
  for (const fn of fnNames) {
    let params;
    try { params = parseDefaults(src, fn); } catch (e) {
      if (/has no options object/.test(e.message)) continue;
      throw e;
    }
    for (const p of params) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      out.push({ ...p, fn });
    }
  }
  return out;
}

/** patchDefaults() across a texture's functions: each changed key is
 * written into the function parseAllDefaults() found it in. */
export function patchAllDefaults(src, fnNames, changes) {
  const owner = Object.fromEntries(parseAllDefaults(src, fnNames).map((p) => [p.key, p.fn]));
  const byFn = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!owner[key]) throw new Error(`${fnNames.join(" / ")} has no option "${key}"`);
    (byFn[owner[key]] ??= {})[key] = value;
  }
  let out = src;
  for (const [fn, ch] of Object.entries(byFn)) out = patchDefaults(out, fn, ch);
  return out;
}

/** Defaults as a plain `{key: value}` object (required keys omitted). */
export function defaultsObject(src, fnName) {
  const out = {};
  for (const p of parseDefaults(src, fnName)) if (!p.required) out[p.key] = p.value;
  return out;
}

/** The raw text of `fnName`'s options object, braces included -- for the
 * before/after preview. */
export function optionsText(src, fnName) {
  const { start, end } = findOptionsObject(src, fnName);
  return src.slice(start - 1, end + 1);
}

/** Source literal for `value`, keeping a float-looking old literal
 * float-looking (10.0 stays "10.0", not "10"). */
export function formatLiteral(value, oldRaw = "") {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  const v = parseFloat(value.toFixed(6));
  if (Number.isInteger(v) && /\./.test(oldRaw ?? "")) return v.toFixed(1);
  return String(v);
}

/**
 * Return `src` with `fnName`'s defaults replaced by `changes`
 * ({key: newValue}). Only existing, literal, non-required keys can be
 * changed; anything else throws, so a bad save never half-writes.
 */
export function patchDefaults(src, fnName, changes) {
  const params = parseDefaults(src, fnName);
  const edits = [];
  for (const [key, value] of Object.entries(changes)) {
    const p = params.find((q) => q.key === key);
    if (!p) throw new Error(`${fnName} has no option "${key}"`);
    if (p.required) throw new Error(`${fnName}.${key} has no default to change`);
    if (!p.literal) throw new Error(`${fnName}.${key} default is not a plain literal`);
    edits.push({ start: p.valueStart, end: p.valueEnd, text: formatLiteral(value, p.raw) });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// ------------------------------------------------------ whole functions --
// Used by the function editor (editor.js): read one function's full text,
// and swap it for an edited version without touching any other byte.

/** {start, end} of `fnName`'s whole declaration in `src`: from `export`
 * (or `function`) through the body's closing brace, end exclusive.
 * `exported` says whether it started with `export`. */
export function functionRange(src, fnName) {
  const masked = maskComments(src);
  const re = new RegExp(`(\\bexport\\s+)?\\bfunction\\s+${fnName}\\s*\\(`, "g");
  const m = re.exec(masked);
  if (!m) throw new Error(`function ${fnName} not found`);
  const open = m.index + m[0].length - 1;
  const close = matchBracket(masked, open);
  const body = masked.indexOf("{", close);
  if (body === -1 || masked.slice(close + 1, body).trim() !== "") {
    throw new Error(`function ${fnName} has no body`);
  }
  return { start: m.index, end: matchBracket(masked, body) + 1, exported: !!m[1] };
}

/** The full text of `fnName`'s declaration. */
export function functionText(src, fnName) {
  const { start, end } = functionRange(src, fnName);
  return src.slice(start, end);
}

/** Throw unless `text` is exactly one declaration of `fnName` (nothing
 * before or after it but whitespace and comments), exported only if the
 * original was -- renaming it or dropping `export` would break the
 * BRUSHES / STAMPS tables that call it. */
export function checkFunctionText(text, fnName, exported) {
  let r;
  try { r = functionRange(text, fnName); } catch (e) {
    throw new Error(`the editor must hold one "function ${fnName}(...) { ... }" (${e.message})`);
  }
  const masked = maskComments(text);
  if (masked.slice(0, r.start).trim() !== "" || masked.slice(r.end).trim() !== "") {
    throw new Error(`only the ${fnName} function can be in the editor -- move other code into the file directly`);
  }
  if (r.exported !== exported) {
    throw new Error(exported ? `keep "export" in front of function ${fnName}` : `${fnName} is not exported in the file -- remove "export"`);
  }
}

/** `src` with `fnName`'s declaration replaced by `text` (checked first). */
export function replaceFunction(src, fnName, text) {
  const r = functionRange(src, fnName);
  checkFunctionText(text, fnName, r.exported);
  return src.slice(0, r.start) + text.trim() + src.slice(r.end);
}

/** 1-based line on which `fnName`'s declaration starts in `src`. */
export function functionStartLine(src, fnName) {
  return src.slice(0, functionRange(src, fnName).start).split("\n").length;
}

// ---------------------------------------------------- function groups --
// The editor shows a texture's stroke and brush together with every
// helper they call, as one block of text. These read and
// replace such a group.

const IDENT = "[A-Za-z_$][\\w$]*";

/** Names of the top-level function declarations in `src`, in file order
 * (class methods are not included). */
export function topLevelFunctions(src) {
  const masked = maskComments(src);
  const re = new RegExp(`^(?:export\\s+)?function\\s+(${IDENT})\\s*\\(`, "gm");
  return [...masked.matchAll(re)].map((m) => m[1]);
}

/** The function a BRUSHES / STAMPS table maps `key` to, or null. */
export function tableFunction(src, table, key) {
  const masked = maskComments(src);
  const m = new RegExp(`\\bconst\\s+${table}\\s*=\\s*\\{`).exec(masked);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const body = masked.slice(open, matchBracket(masked, open));
  return new RegExp(`\\b${key}\\s*:\\s*(${IDENT})`).exec(body)?.[1] ?? null;
}

/** `roots` plus every top-level function they use, directly or through
 * another one. The roots come first (in the given order), the rest in
 * file order. */
export function relatedFunctions(src, roots) {
  const masked = maskComments(src);
  const all = topLevelFunctions(src);
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const r = functionRange(src, queue.shift());
    const body = masked.slice(r.start, r.end);
    for (const name of all) {
      if (!seen.has(name) && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body)) {
        seen.add(name);
        queue.push(name);
      }
    }
  }
  return [...roots, ...all.filter((n) => seen.has(n) && !roots.includes(n))];
}

/** The group's text as the editor shows it: each function, blank-line separated. */
export function groupText(src, names) {
  return names.map((n) => functionText(src, n)).join("\n\n");
}

/** Split editor text into its function declarations:
 * [{name, text, exported}]. Comments between functions go with the
 * function after them (trailing ones with the last). Throws on any other
 * code outside a function. */
export function splitFunctions(text) {
  const masked = maskComments(text);
  const re = new RegExp(`(\\bexport\\s+)?\\bfunction\\s+(${IDENT})\\s*\\(`, "g");
  const parts = [];
  let pos = 0, pieceStart = 0;
  while (pos < masked.length) {
    re.lastIndex = pos;
    const m = re.exec(masked);
    if (!m) {
      if (masked.slice(pos).trim() !== "") throw new Error("code after the last function -- only whole functions can be in the editor");
      break;
    }
    if (masked.slice(pos, m.index).trim() !== "") {
      throw new Error(`code outside a function before ${m[2]} -- only whole functions can be in the editor`);
    }
    const close = matchBracket(masked, m.index + m[0].length - 1);
    const body = masked.indexOf("{", close);
    if (body === -1 || masked.slice(close + 1, body).trim() !== "") throw new Error(`function ${m[2]} has no body`);
    const end = matchBracket(masked, body) + 1;
    parts.push({ name: m[2], exported: !!m[1], start: pieceStart, end });
    pos = pieceStart = end;
  }
  if (parts.length) parts.at(-1).end = text.length;
  return parts.map((p) => ({ name: p.name, exported: p.exported, text: text.slice(p.start, p.end).trim() }));
}

/**
 * `src` with each function of the group replaced by its version in
 * `text`. `text` must hold every function in `names`, once each, and
 * nothing else; renaming or changing `export` is refused (the tables and
 * other textures call them by name). All checks run before any change.
 */
export function replaceGroup(src, names, text) {
  const parts = splitFunctions(text);
  const got = parts.map((p) => p.name);
  for (const n of got) {
    if (!names.includes(n)) throw new Error(`${n} is not one of this texture's functions -- add new functions to texture_functions.js directly`);
    if (got.indexOf(n) !== got.lastIndexOf(n)) throw new Error(`function ${n} is in the editor twice`);
  }
  const missing = names.filter((n) => !got.includes(n));
  if (missing.length) throw new Error(`keep every function in the editor -- missing: ${missing.join(", ")}`);

  const edits = parts.map((p) => {
    const r = functionRange(src, p.name);
    if (r.exported !== p.exported) {
      throw new Error(r.exported ? `keep "export" in front of function ${p.name}` : `${p.name} is not exported in the file -- remove "export"`);
    }
    return { ...r, text: p.text };
  }).sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
