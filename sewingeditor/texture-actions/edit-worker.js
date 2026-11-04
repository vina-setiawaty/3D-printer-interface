/**
 * edit-worker.js -- runs one texture card against a given copy of
 * texture_functions.js, off the page's main thread. runner.js terminates
 * the worker if it doesn't answer in time, so an endless loop in edited
 * code can't freeze the page (or the printer stream it is driving).
 *
 * In:  { source, texture, values, placement, settings }
 * Out: { ok: true, lines, filamentMm } or { ok: false, error, line }
 *      `line` is the line in `source` the error was thrown from, if known.
 */
import { buildGcode, findOutOfBounds } from "./generate.js";

self.onmessage = async ({ data }) => {
  const { source, texture, values, placement, settings } = data;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const TF = await import(url);
    const { lines, filamentMm } = buildGcode(TF, texture, values, placement, settings);
    const oob = findOutOfBounds(lines, TF.BED_X, TF.BED_Y);
    if (oob) throw new Error(`moves off the ${TF.BED_X}x${TF.BED_Y} bed: "${oob}"`);
    self.postMessage({ ok: true, lines, filamentMm });
  } catch (e) {
    const m = /blob:[^\s)]*?:(\d+):\d+/.exec(String(e?.stack ?? ""));
    self.postMessage({
      ok: false,
      error: `${e?.name ?? "Error"}: ${e?.message ?? e}`,
      line: m ? Number(m[1]) : null,
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};
