/**
 * edit-state.js -- where an edited texture function stands, as one place
 * both the editor panel and the card badges read from. Pure, no DOM;
 * tests/run.mjs walks it through every transition.
 *
 * Two layers:
 *   editor buffer  the text in the textarea (memory only)
 *   saved draft    the last text you pressed "save" on (localStorage)
 * Run and push only ever use the saved draft, and are disabled while the
 * buffer has unsaved edits, so what gets printed and pushed is always
 * exactly what the status line names.
 *
 * Steps:  1 edited -> 2 saved -> 3 printed -> 4 pushed
 *
 * A draft entry (all fields optional):
 *   base        the file's function text when this draft started -- push
 *               refuses if the file no longer has it ("stale")
 *   saved       saved draft text
 *   savedAt     ms timestamp
 *   savedOk     the saved text test-ran without errors
 *   savedError  why it didn't
 *   printed     the draft text that last finished streaming to the printer
 *   printedAt   ms timestamp
 *   pushedText  the text last written to the file by push
 *   pushedAt    ms timestamp
 */

export const STEPS = ["edited", "saved", "printed", "pushed"];

/** Status of the saved-draft layer against the file's current text. */
export function draftStatus(draft, fileText) {
  if (!draft || draft.saved == null || draft.saved === fileText) {
    if (draft?.pushedText != null && draft.pushedText === fileText) {
      return { key: "pushed", step: 4, label: "pushed", at: draft.pushedAt };
    }
    return { key: "unchanged", step: 0, label: "unchanged" };
  }
  const stale = draft.base !== fileText;
  if (!draft.savedOk) return { key: "error", step: 1, label: "saved · has errors", at: draft.savedAt, stale };
  if (draft.printed === draft.saved) return { key: "printed", step: 3, label: "printed · not pushed", at: draft.printedAt, stale };
  return { key: "saved", step: 2, label: "saved · not printed", at: draft.savedAt, stale };
}

/**
 * Everything the panel shows for one function.
 * @param buffer   editor text (or undefined if never opened)
 * @param draft    stored entry or undefined
 * @param fileText the function's text in texture_functions.js now
 * @returns {dirty, draft: draftStatus, step, label, next, can, why}
 *   step  -- how far along the tracker is (0..4)
 *   can   -- {save, run, push, discard, revert}
 *   why   -- {run, push}: reason when disabled ("" when enabled)
 */
export function editStatus(buffer, draft, fileText) {
  const d = draftStatus(draft, fileText);
  const reference = draft?.saved ?? fileText;
  const dirty = buffer != null && buffer !== reference;
  const hasDraft = d.key !== "unchanged" && d.key !== "pushed";

  let step, label, next;
  if (dirty) {
    step = 1; label = "edited · unsaved";
    next = "save -- saving test-runs the code and previews its gcode";
  } else {
    step = d.step; label = d.label;
    next = {
      unchanged: "edit the code",
      error: "fix the error and save again",
      saved: "run on printer -- a finished print unlocks push",
      printed: "push to file",
      pushed: "nothing -- texture_functions.js has this code",
    }[d.key];
  }

  const why = { run: "", push: "" };
  if (dirty) why.run = why.push = "save or discard your unsaved edits first";
  else if (d.key === "unchanged" || d.key === "pushed") why.run = why.push = "nothing saved to run -- edit and save first";
  else if (d.key === "error") why.run = why.push = "the saved draft has errors";
  else {
    if (d.key === "saved") why.push = "run the saved draft on the printer first";
    if (d.stale) why.push = "texture_functions.js changed since this draft started -- revert to file, or copy your code out first";
  }

  return {
    dirty, draft: d, step, label, next, why,
    can: {
      save: dirty,
      run: why.run === "",
      push: why.push === "",
      discard: dirty,
      revert: dirty ? buffer !== fileText || hasDraft : hasDraft,
    },
  };
}
