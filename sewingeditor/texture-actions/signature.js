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
    if (body) {
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
