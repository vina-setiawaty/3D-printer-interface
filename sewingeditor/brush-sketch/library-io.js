// Read/write access to the author's local texture_docs folder through the
// browser's File System Access API (Chrome/Edge, https or localhost). This
// is what lets a web page update texture_functions' library files the way
// the Claude Code fine-tune workflow does -- the files never go to a
// server, the page writes straight into the folder the author picked.
//
// Safety:
//   - The folder must contain texture_functions.js AND sketched_brushes.js,
//     so picking the wrong folder fails loudly instead of scattering files.
//   - Every write of an existing file carries the hash of the text the page
//     READ. The file is re-read and re-hashed just before writing; if
//     anyone changed it in between (Claude Code, the editor, Drive sync),
//     the write is refused and the page asks the author to reload.

const DB = "brush-sketch", STORE = "handles", KEY = "texture_docs";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const supported = () => typeof window !== "undefined" && "showDirectoryPicker" in window;

export async function hashText(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let root = null;

async function checkFolder(dir) {
  for (const f of ["texture_functions.js", "sketched_brushes.js"]) {
    try { await dir.getFileHandle(f); }
    catch { throw new Error(`"${dir.name}" has no ${f} -- pick the texture_docs folder`); }
  }
}

/** Asks the author to pick texture_docs (needs a click). */
export async function connect() {
  if (!supported()) throw new Error("this browser has no folder access -- use Chrome or Edge");
  const dir = await window.showDirectoryPicker({ id: "texture-docs", mode: "readwrite" });
  await checkFolder(dir);
  root = dir;
  await idbSet(KEY, dir);
  return dir.name;
}

/** Re-uses the folder picked in an earlier session. Returns
 * "connected" | "needs-permission" | "none". Permission can only be
 * re-granted from a click, via reconnect(). */
export async function restore() {
  if (!supported()) return "none";
  const dir = await idbGet(KEY).catch(() => null);
  if (!dir) return "none";
  const p = await dir.queryPermission({ mode: "readwrite" });
  root = dir;
  return p === "granted" ? "connected" : "needs-permission";
}

export async function reconnect() {
  if (!root) return connect();
  const p = await root.requestPermission({ mode: "readwrite" });
  if (p !== "granted") throw new Error("folder permission was not granted");
  await checkFolder(root);
  return root.name;
}

export const connected = () => !!root;
export const folderName = () => root?.name || "";

async function dirFor(path, create) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  let dir = root;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

/** Text of a file under texture_docs, or null if it doesn't exist. */
export async function readText(path) {
  if (!root) throw new Error("texture_docs is not connected");
  try {
    const { dir, name } = await dirFor(path, false);
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch (e) {
    if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return null;
    throw e;
  }
}

/** Writes a file. `expectHash`: the hash of the text this page last read
 * (null = the file must NOT exist yet; undefined = no check). */
export async function writeText(path, text, expectHash) {
  if (!root) throw new Error("texture_docs is not connected");
  if (expectHash !== undefined) {
    const current = await readText(path);
    if (expectHash === null && current !== null) throw new Error(`${path} already exists -- refusing to overwrite it`);
    if (expectHash !== null) {
      if (current === null) throw new Error(`${path} has disappeared since the page read it`);
      if ((await hashText(current)) !== expectHash) throw new Error(`${path} changed on disk since the page read it (another editor, Claude Code, or Drive sync) -- reload the library and review again`);
    }
  }
  const { dir, name } = await dirFor(path, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

/** Every .gcode under test_print_gcode/ (subfolders included), with only
 * the first `headBytes` of each read -- enough for the calibration line. */
export async function listTestGcode(headBytes = 8192) {
  if (!root) throw new Error("texture_docs is not connected");
  const out = [];
  let base;
  try { base = await root.getDirectoryHandle("test_print_gcode"); } catch { return out; }
  const walk = async (dir, prefix) => {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === "directory") await walk(h, `${prefix}${name}/`);
      else if (name.endsWith(".gcode")) {
        const file = await h.getFile();
        out.push({ path: `test_print_gcode/${prefix}${name}`, text: await file.slice(0, headBytes).text() });
      }
    }
  };
  await walk(base, "");
  return out;
}
