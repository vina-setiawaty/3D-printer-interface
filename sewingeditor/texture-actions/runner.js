/**
 * runner.js -- generate a card's G-code from a given texture_functions.js
 * text, in a throwaway worker (edit-worker.js) with a time limit.
 *
 * Both the cards and the function editor go through here, so the cards
 * always run the file's *current* text (including code just pushed),
 * not the copy the page imported at load.
 */
const WORKER_URL = new URL("./edit-worker.js", import.meta.url);
export const TIMEOUT_MS = 4000;

/** @returns Promise<{lines, filamentMm}>; rejects with an Error whose
 * `line` (if set) is the 1-based line in `job.source`. */
export function runInWorker(job, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { type: "module" });
    const done = () => { clearTimeout(timer); w.terminate(); };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`still running after ${timeoutMs / 1000} s, stopped -- an endless loop?`));
    }, timeoutMs);
    w.onmessage = ({ data }) => {
      done();
      if (data.ok) resolve(data);
      else reject(Object.assign(new Error(data.error), { line: data.line }));
    };
    w.onerror = (e) => {
      done();
      e.preventDefault?.();
      reject(new Error(e.message || "the code runner failed to start"));
    };
    w.postMessage(job);
  });
}
