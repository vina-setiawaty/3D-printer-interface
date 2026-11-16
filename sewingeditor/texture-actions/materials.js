/**
 * materials.js -- filament profiles, kept the way a slicer keeps them:
 *   built-in   texture_functions.js FILAMENT; read-only ("save as" to change it)
 *   yours      saved in this browser (localStorage PROFILES_KEY)
 *   files      one profile per .json file (export / import), to move a
 *              profile to another browser or share it
 * Editing a field makes an unsaved draft of the selected profile (kept
 * across reloads, marked "modified"); prints use what is on screen, draft
 * included, like a slicer slicing with modified settings. "save" writes the
 * draft into the profile, "save as" makes a new one.
 *
 * Pure: no DOM; storage is passed in. A profile's keys and units come from
 * texture_functions.js FILAMENT_FIELDS, so a new filament value added there
 * shows up here without changes.
 */

export const PROFILES_KEY = "textureActions.filaments";
export const FILE_TYPE = "texture-actions filament profile";
export const BUILTIN_ID = "builtin";

/** Lowest allowed value per key (inclusive unless listed in POSITIVE). */
const POSITIVE = new Set(["diameter", "flowPercent", "retractSpeed", "maxVolRate"]);

/** The built-in profile, from the library's FILAMENT. */
export function builtinProfile(TF) {
  return { id: BUILTIN_ID, name: `${TF.FILAMENT.name} (built-in)`, builtin: true, values: pickValues(TF.FILAMENT, TF.FILAMENT_FIELDS) };
}

function pickValues(obj, fields) {
  return Object.fromEntries(fields.map(([k]) => [k, obj[k]]));
}

/** `values` checked against `fields`: every key present and a number in
 * range. Returns a clean copy; throws naming the first bad key. */
export function checkValues(values, fields) {
  const out = {};
  for (const [k] of fields) {
    const v = Number(values?.[k]);
    if (values?.[k] === "" || values?.[k] == null || !Number.isFinite(v)) throw new Error(`${k} is not a number`);
    if (POSITIVE.has(k) ? !(v > 0) : !(v >= 0)) throw new Error(`${k} must be ${POSITIVE.has(k) ? "> 0" : ">= 0"} (got ${v})`);
    out[k] = v;
  }
  return out;
}

/** {selected, profiles: [user profiles], draft: {id, values} | null} */
export function loadState(storage) {
  try {
    const s = JSON.parse(storage.getItem(PROFILES_KEY));
    if (s && Array.isArray(s.profiles)) {
      return { selected: s.selected ?? BUILTIN_ID, profiles: s.profiles, draft: s.draft ?? null };
    }
  } catch { /* private window / blocked storage / bad JSON */ }
  return { selected: BUILTIN_ID, profiles: [], draft: null };
}

export function saveState(storage, state) {
  try { storage.setItem(PROFILES_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

/** Every profile, built-in first. */
export function allProfiles(TF, state) {
  return [builtinProfile(TF), ...state.profiles];
}

/** The selected profile (falls back to the built-in one if it is gone). */
export function selectedProfile(TF, state) {
  return allProfiles(TF, state).find((p) => p.id === state.selected) ?? builtinProfile(TF);
}

/** What prints use: the selected profile's values with the draft over
 * them. Missing keys (a profile saved before a key existed) come from the
 * built-in profile. */
export function activeValues(TF, state) {
  const p = selectedProfile(TF, state);
  const draft = state.draft?.id === p.id ? state.draft.values : {};
  return { ...builtinProfile(TF).values, ...p.values, ...draft };
}

/** Keys whose active value differs from the selected profile's saved one. */
export function modifiedKeys(TF, state) {
  const saved = { ...builtinProfile(TF).values, ...selectedProfile(TF, state).values };
  const now = activeValues(TF, state);
  return Object.keys(now).filter((k) => now[k] !== saved[k]);
}

/** `name`, or `name (2)`, `name (3)` ... -- whichever no profile has yet. */
export function uniqueName(name, profiles) {
  const taken = new Set(profiles.map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Add a user profile; returns it (not selected). */
export function addProfile(TF, state, name, values) {
  const clean = checkValues(values, TF.FILAMENT_FIELDS);
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("profile name is empty");
  const p = { id: newId(), name: uniqueName(trimmed, allProfiles(TF, state)), values: clean };
  state.profiles.push(p);
  return p;
}

/** The profile as a .json file's text. */
export function toFile(profile, fields) {
  return JSON.stringify({ type: FILE_TYPE, version: 1, name: profile.name, values: pickValues(profile.values, fields) }, null, 2) + "\n";
}

/** {name, values} from a .json file's text; throws if it isn't one. */
export function fromFile(text, fields) {
  let o;
  try { o = JSON.parse(text); } catch { throw new Error("not a JSON file"); }
  if (o?.type !== FILE_TYPE || typeof o.values !== "object") throw new Error("not a filament profile file");
  return { name: String(o.name ?? "imported"), values: checkValues(o.values, fields) };
}
