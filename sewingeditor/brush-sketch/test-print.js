// Test G-code for a brush program, following the Task_FineTune.md
// conventions (calibration line first, header/footer, verifyLayout, a
// verification digest) -- plus where the calibration line goes next, read
// from the files already in test_print_gcode/.
//
// Pure ES module: the texture library is passed in (`lib`), so the same
// code runs in the page and under node (tests/brush-sketch/).

// ----------------------------------------------------- calibration position --

const CAL_X0 = 120, CAL_X1 = 180, CAL_LEN = 60;       // normal mode
const STRIPE_START_X = 200, STRIPE_STEP = 3, STRIPE_WRAP_X = 160;
const BANDS = [40, 110];                              // test-mode y-bands (start y)

/** The calibration line a file starts with, read from its first travel
 * move (the calibration line is always the first element printed):
 *   {mode: "normal", y}          horizontal line at x=120
 *   {mode: "test", x, band}      vertical stripe starting at y=40 or 110
 *   null                         the file doesn't follow either convention */
export function parseCalibration(gcodeText) {
  const m = gcodeText.match(/^G0 X(-?\d+(?:\.\d+)?) Y(-?\d+(?:\.\d+)?)/m);
  if (!m) return null;
  const x = parseFloat(m[1]), y = parseFloat(m[2]);
  if (Math.abs(x - CAL_X0) < 1e-6) return { mode: "normal", y };
  const band = BANDS.find((b) => Math.abs(y - b) < 1e-6);
  if (band !== undefined && x > STRIPE_WRAP_X && x <= STRIPE_START_X + 1e-6) return { mode: "test", x, band };
  return null;
}

/** Filenames sort by their yyyymmdd-HHMMSS prefix. Files without one (the
 * older hand-named teddy files) sort first and are effectively ignored. */
export function timestampOf(name) {
  const m = name.match(/(\d{8})-(\d{6})_/);
  return m ? m[1] + m[2] : "";
}

/** Next calibration position for each mode, from the files already there.
 *
 * `files` is [{path, text}] for every .gcode under test_print_gcode/
 * (subfolders included). `changelogText` is CHANGELOG.md. Normal mode goes
 * 5mm below the newest normal file's line -- unless the newest CHANGELOG
 * entry says where to resume ("resume from y=85"), which is how a
 * deliberate exception (a full-bed calibration sheet) records itself.
 * Test mode marches the newest stripe 3mm left, wrapping per
 * Task_FineTune.md SS6. Every value is a PROPOSAL: the page shows it with
 * where it came from, and the author can overwrite it. */
export function proposeCalibration(files, changelogText = "") {
  const dated = files
    .map((f) => ({ ...f, ts: timestampOf(f.path.split("/").pop()), cal: parseCalibration(f.text) }))
    .filter((f) => f.ts && f.cal)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const normal = dated.find((f) => f.cal.mode === "normal");
  const test = dated.find((f) => f.cal.mode === "test");

  const out = { normal: null, test: null };

  const hint = resumeHint(changelogText);
  // A hint only applies until a normal-mode file newer than the ones its
  // own entry names has been printed -- after that, that file is the
  // sequence's latest point.
  if (hint && (!normal || normal.ts <= hint.latestTs)) {
    out.normal = { y: hint.y, source: `CHANGELOG #${hint.entry} says to resume from y=${hint.y}` };
  } else if (normal) {
    out.normal = { y: normal.cal.y - 5, source: `${normal.path} has its calibration line at y=${normal.cal.y}` };
  } else {
    out.normal = { y: 200, source: "no earlier normal-mode file found -- starting at y=200" };
  }

  if (test) {
    let x = test.cal.x - STRIPE_STEP, band = test.cal.band;
    let note = "";
    if (x <= STRIPE_WRAP_X) {
      x = STRIPE_START_X;
      band = band === BANDS[0] ? BANDS[1] : BANDS[0];
      note = " (column wrap)";
    }
    out.test = { x, band, source: `${test.path} has its stripe at x=${test.cal.x}, y=${test.cal.band}${note}` };
  } else {
    out.test = { x: STRIPE_START_X, band: BANDS[0], source: "no earlier test-mode file found -- first stripe" };
  }
  return out;
}

/** The newest CHANGELOG entry that says where the normal-mode sequence
 * resumes ("resume from y=85"), with the newest file timestamp that entry
 * mentions. */
function resumeHint(text) {
  const heads = [...text.matchAll(/^## (\d+)\./gm)];
  for (let k = heads.length - 1; k >= 0; k--) {
    const body = text.slice(heads[k].index, k + 1 < heads.length ? heads[k + 1].index : undefined);
    const m = body.match(/resume from y\s*=\s*(\d+(?:\.\d+)?)/i);
    if (!m) continue;
    const stamps = [...body.matchAll(/(\d{8})-(\d{6})_/g)].map((x) => x[1] + x[2]).sort();
    return { y: parseFloat(m[1]), entry: heads[k][1], latestTs: stamps.length ? stamps[stamps.length - 1] : "" };
  }
  return null;
}

/** Next `## N.` number in CHANGELOG.md. */
export function nextChangelogNumber(text) {
  const nums = [...text.matchAll(/^## (\d+)\./gm)].map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

// --------------------------------------------------------------- filenames --

export function slugify(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
export function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** `{yyyymmdd-HHMMSS}_{description}[-testmode].gcode`, the description
 * taken from the page's text input. */
export function testFilename(description, { testMode = false, date = new Date() } = {}) {
  let slug = slugify(description) || "sketched-brush";
  if (testMode && !/(^|-)testmode(-|$)/.test(slug)) slug += "-testmode";
  return `${stamp(date)}_${slug}.gcode`;
}

// ---------------------------------------------------------------- build --

const r2 = (v) => +v.toFixed(2);

/** The same stamp positions brushSketchDotted() will use on a straight
 * line of `length` -- for counting and for the layout rectangles. */
function stampCount(length, gap) {
  return Math.floor(length / gap + 1e-6) + 1;
}

/**
 * Builds the whole test file. Returns
 *   { gcode, lines, digest, layout, errors, warnings, rows }
 *
 * opts:
 *   material       "TPU" | "PLA"
 *   calibration    {mode: "normal", y} | {mode: "test", x, band}
 *   texture        {x0, y, length}         where the first row starts
 *   options        the brush's option values (params + azimuthDeg/gap/reverse)
 *   sweep          null | {param, values: [a, b, c]}   one row per value, stacked downward
 *   rowPitch       mm between sweep rows (default: 2 * radiusMm + 4)
 */
export function buildTestPrint(lib, program, opts) {
  const { material = "TPU", calibration, texture, options = {}, sweep = null } = opts;
  const errors = [], warnings = [];
  const radius = Number(program.radiusMm ?? 10);
  const rowPitch = opts.rowPitch ?? Math.max(6, 2 * radius + 4);
  const gap = options.gap ?? program.defaultGap ?? 10;

  const rows = sweep
    ? sweep.values.map((v, k) => ({ label: `${sweep.param}=${v}`, options: { ...options, [sweep.param]: v }, y: texture.y - k * rowPitch }))
    : [{ label: "defaults", options, y: texture.y }];

  // Layout rectangles, for verifyLayout().
  const calRect = calibration.mode === "normal"
    ? { name: "calibration", x0: CAL_X0, y0: calibration.y - 0.5, w: CAL_X1 - CAL_X0, h: 1 }
    : { name: "calibration (test-mode stripe)", x0: calibration.x - 0.5, y0: calibration.band, w: 1, h: CAL_LEN };
  const layout = [calRect, ...rows.map((r) => ({
    name: `texture ${r.label}`, x0: texture.x0 - radius, y0: r.y - radius, w: texture.length + 2 * radius, h: 2 * radius,
  }))];
  const chk = lib.verifyLayout(layout);
  errors.push(...chk.errors);
  warnings.push(...chk.warnings);

  const em = new lib.Emitter();
  em.header(material === "PLA" ? { nozzleTemp: 205, bedTemp: 60, flowPercent: 100 } : {});
  const headerEnd = em.lines.length;   // the prime line at x=10 is deliberately outside the safe area

  // calibration line FIRST, always (Task_FineTune.md SS3 / SS6)
  if (calibration.mode === "normal") lib.freeformSolid(em, (t) => CAL_X0 + t, () => calibration.y, 0, CAL_LEN);
  else lib.freeformSolid(em, () => calibration.x, (t) => calibration.band + t, 0, CAL_LEN);

  const texStart = em.lines.length;
  let expectedNegE = 1 + 2;          // header's establishing retract + 2 calibration layers
  for (const row of rows) {
    try {
      lib.freeformSketchDotted(em, program, (t) => texture.x0 + t, () => row.y, 0, texture.length, row.options);
      const params = lib.resolveSketchParams(program, row.options);
      const steps = lib.expandSketchProgram(program, params);
      const perStamp = steps.filter((s) => s.op === "retract").length;
      const endsUnretracted = endsPrimed(steps);
      row.stamps = stampCount(texture.length, Number(row.options.gap ?? gap));
      // A stamp that ends un-retracted gets retracted by the NEXT goto()
      // (or by the footer after the last one).
      expectedNegE += row.stamps * (perStamp + (endsUnretracted ? 1 : 0));
    } catch (e) {
      errors.push(`${row.label}: ${e.message}`);
    }
  }
  em.footer();

  const lines = em.lines;
  const gcode = lib.stripComments(lines.join("\n") + "\n");
  const negE = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\bE-[0-9]/.test(l));
  const strayE = lines.map((l, i) => [i + 1, l]).filter(([, l]) => /\bE-?[0-9]/.test(l) && !/^G1 /.test(l) && !/^G92\b/.test(l));
  const scan = scanBounds(lines, headerEnd);
  for (const o of scan.outOfBounds.slice(0, 5)) errors.push(`coordinate out of bed bounds: ${o}`);
  if (scan.outsideSafe.length) warnings.push(`${scan.outsideSafe.length} printed coordinate(s) outside the 15-205mm safe area, e.g. ${scan.outsideSafe[0]}`);
  if (strayE.length) errors.push(`${strayE.length} E term(s) on a non-G1 line, e.g. L${strayE[0][0]}: ${strayE[0][1]}`);

  const digest = {
    lineCount: lines.length,
    negE: negE.length,
    expectedNegE,
    negEOk: negE.length === expectedNegE,
    eTotal: r2(em.eTotal),
    textureHead: lines.slice(texStart, Math.min(texStart + 55, lines.length)).map((l, k) => `L${texStart + k + 1}: ${l}`),
    footerTail: lines.slice(Math.max(0, lines.length - 12)),
    stamps: rows.reduce((s, r) => s + (r.stamps || 0), 0),
  };
  if (!digest.negEOk) warnings.push(`negative-E count ${negE.length} does not match the expected ${expectedNegE} -- check the retract steps`);
  return { gcode, lines, digest, layout, errors, warnings, rows };
}

/** True when the prime/retract steps leave the nozzle un-retracted at the
 * end of a stamp. */
export function endsPrimed(steps) {
  let primed = false;
  for (const s of steps) {
    if (s.op === "prime") primed = true;
    if (s.op === "retract") primed = false;
  }
  return primed;
}

/** Absolute-position bounds scan over emitted lines (handles the footer's
 * G91 section). Printing moves (with a positive E) from line `safeFrom`
 * on are also checked against the safe area -- the header's prime line
 * sits outside it on purpose. */
export function scanBounds(lines, safeFrom = 0) {
  let abs = true, px = null, py = null;
  const outOfBounds = [], outsideSafe = [];
  const num = (line, axis) => { const m = line.match(new RegExp(`(?:^|\\s)${axis}(-?\\d+(?:\\.\\d+)?)`)); return m ? parseFloat(m[1]) : null; };
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const cmd = line.split(/\s+/)[0];
    if (cmd === "G90") { abs = true; return; }
    if (cmd === "G91") { abs = false; return; }
    if (cmd === "G28") { px = 0; py = 0; return; }
    if (cmd !== "G0" && cmd !== "G1") return;
    const mx = num(line, "X"), my = num(line, "Y"), e = num(line, "E");
    if (abs) { if (mx !== null) px = mx; if (my !== null) py = my; }
    else { if (mx !== null && px !== null) px += mx; if (my !== null && py !== null) py += my; }
    if (px !== null && (px < 0 || px > 220)) outOfBounds.push(`X${px.toFixed(2)} (${line})`);
    if (py !== null && (py < 0 || py > 220)) outOfBounds.push(`Y${py.toFixed(2)} (${line})`);
    if (idx >= safeFrom && e !== null && e > 0 && px !== null && py !== null && (mx !== null || my !== null) && (px < 15 || px > 205 || py < 15 || py > 205)) {
      outsideSafe.push(`X${px.toFixed(2)} Y${py.toFixed(2)}`);
    }
  });
  return { outOfBounds, outsideSafe };
}

/** The digest as plain text, for the page and for the CHANGELOG entry. */
export function digestText(res, filename = "") {
  const d = res.digest;
  return [
    `file: ${filename || "(not saved)"}`,
    `lines: ${d.lineCount}   stamps: ${d.stamps}   eTotal (informational): ${d.eTotal}mm`,
    `negative-E: ${d.negE} (expected ${d.expectedNegE}) ${d.negEOk ? "OK" : "*** MISMATCH ***"}`,
    `verifyLayout: ${res.errors.some((e) => /OVERLAP|outside/i.test(e)) ? "FAILED" : "ok"}`,
  ].join("\n");
}
