#!/usr/bin/env node
/**
 * measure.mjs - score a video-understanding plugin result against the
 * ground-truth corpus in ./corpus.
 *
 * The plugin is NOT implemented here. This tool only reads a result JSON that a
 * plugin tool produced and compares it with the ground truth.
 *
 * Expected result shape (see README.md, section "Result contract"):
 *
 *   {
 *     "images": [{ "path": "...", "width": 640, "height": 360, "bytes": 12345,
 *                  "tStart": 1.0, "tEnd": 2.0 }],
 *     "text":   "free text summary, may contain per-cell lines like 't=1.00-2.00s'",
 *     "meta":   { "elapsedMs": 812, "framesDecoded": 750,
 *                 "cells": [{ "index": 1, "tStart": 1.0, "tEnd": 2.0 }] }
 *   }
 *
 * Per-cell time ranges are looked up, in order, from:
 *   1. images[i].tStart/tEnd/t (or start/end/time/from/to/...)
 *   2. meta.cells[i] / meta.frames[i] / meta.grid[i]
 *   3. `text` - a tolerant regex for "1.00-2.50s", "t=1.0s..2.5s", "00:01-00:03"
 * Whatever source was used is reported so a "not computable" result is never
 * silently mistaken for a good one.
 *
 * Usage:
 *   node measure.mjs --result r.json --clip A [--json out.json]
 *   node measure.mjs --result r1.json --result r2.json      # compare
 *   node measure.mjs --result -                            # read stdin
 *
 * Env:
 *   IMG_TOKENS    tokens charged per image (default 384)
 *   ANCHOR_TOKENS fixed prompt/anchor cost added once (default 0)
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = join(HERE, "corpus", "index.json");
const DEFAULT_TOL_MS = 250;

// ---------------------------------------------------------------- utilities

/** Visible width of a string, counting CJK/fullwidth glyphs as 2 columns. */
function dwidth(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += (c >= 0x1100 && (
      c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x20000 && c <= 0x3fffd))) ? 2 : 1;
  }
  return n;
}
function pad(s, n, right = false) {
  const str = String(s ?? "");
  const w = dwidth(str);
  if (w >= n) return str;
  const fill = " ".repeat(n - w);
  return right ? fill + str : str + fill;
}
function trunc(s, n) {
  s = String(s ?? "");
  if (dwidth(s) <= n) return s;
  let out = "", w = 0;
  for (const ch of s) {
    const cw = dwidth(ch);
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)
  ? "n/a" : Number(v).toFixed(d));
const pct = (a, b) => (b ? (100 * a / b) : 0);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** "1.5" | "1.5s" | "00:01.500" | "1:02" -> seconds */
function parseTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^(?:t|at|@)\s*=\s*/, "").replace(/s(?:ec(?:onds?)?)?$/, "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

const START_KEYS = ["tStart", "t_start", "startTime", "start", "from", "t0", "begin"];
const END_KEYS = ["tEnd", "t_end", "endTime", "end", "to", "t1", "stop"];
const POINT_KEYS = ["t", "time", "timestamp", "at", "sec", "seconds", "center",
  "tCenter", "mid"];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) {
      const v = parseTime(obj[k]);
      if (v !== null) return { v, k };
    }
  }
  return { v: null, k: null };
}

/** Locate the array of "cells" a plugin might have put in meta. */
function metaCells(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const k of ["cells", "frames", "grid", "tiles", "samples", "shots"]) {
    if (Array.isArray(meta[k])) return { arr: meta[k], key: `meta.${k}` };
  }
  return null;
}

const TC = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?";
const NUM = "\\d+(?:\\.\\d+)?";

// `00:00.00-00:04.00` (timecode form: the colon already makes it unambiguous,
// so no unit is required - this is the v4video manifest's own cell line format)
const RANGE_TC = new RegExp(`(${TC})\\s*(?:-|–|—|~|to|\\.\\.)\\s*(${TC})`, "g");
// `1.00-2.50s` | `t=1.0s..2.5s` | `1.2 to 3.4 sec` (bare numbers need a unit)
const RANGE_NUM = new RegExp(
  `(${NUM})\\s*(?:s|sec|secs|seconds)?\\s*(?:-|–|—|~|to|\\.\\.)\\s*(${NUM})\\s*` +
  "(?:s|sec|secs|seconds)", "gi");
// a bare `@00:02.00` marker = the sampled instant for that line
const POINT_TC = new RegExp(`@\\s*(${TC})`, "g");
// `2x5 grid` and the sheet size that follows: `grid · 942x1328`
const GRID_RE = /(\d+)\s*x\s*(\d+)\s+grid/i;
const SHEET_RE = /grid\s*[·|]\s*(\d+)\s*x\s*(\d+)/i;

/**
 * Last resort: scrape per-cell time ranges out of the free text, one cell per
 * line. Handles both `1.00-2.50s` prose and the v4video manifest's
 * `1 r1c1 00:00.00-00:04.00 @00:02.00` lines.
 */
function cellsFromText(text) {
  if (!text) return [];
  const out = [];
  // header lines describe the sheet or the window, they are not cells
  const HEADER = /\b(grid|sheet|window|cols:|duration|resolution)\b/i;
  for (const line of String(text).split(/\r?\n/)) {
    if (HEADER.test(line) && !/^\s*\d+\s+r\d+c\d+/.test(line)) continue;
    let got = null;
    const tc = [...line.matchAll(RANGE_TC)];
    if (tc.length) {
      got = { tStart: parseTime(tc[0][1]), tEnd: parseTime(tc[0][2]) };
    } else {
      const num = [...line.matchAll(RANGE_NUM)];
      if (num.length) {
        got = { tStart: parseTime(num[0][1]), tEnd: parseTime(num[0][2]) };
      }
    }
    if (got && got.tStart !== null && got.tEnd !== null && got.tEnd >= got.tStart) {
      const pt = [...line.matchAll(POINT_TC)];
      if (pt.length) got.t = parseTime(pt[0][1]);
      const cellTag = line.match(/^\s*#?\s*(\d{1,3})\b/);
      if (cellTag) got.index = Number(cellTag[1]);
      out.push(got);
    }
  }
  return out;
}

/** Derive the per-cell pixel size from a contact-sheet grid header. */
function gridTile(text) {
  if (!text) return null;
  const s = String(text);
  const g = s.match(GRID_RE), sh = s.match(SHEET_RE);
  if (!g) return null;
  const cols = Number(g[1]), rows = Number(g[2]);
  if (!cols || !rows) return null;
  if (!sh) return null;
  const sw = Number(sh[1]), sheight = Number(sh[2]);
  if (!sw || !sheight) return null;
  return { cols, rows, sheetW: sw, sheetH: sheight,
    width: Math.round(sw / cols), height: Math.round(sheight / rows),
    note: "derived from the grid header (sheet/cols x sheet/rows, gutters not "
      + "subtracted)" };
}

// ---------------------------------------------------------------- loading

function loadIndex(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`corpus index not found: ${abs}`);
  return { ...JSON.parse(readFileSync(abs, "utf8")), __path: abs };
}

function findClip(index, want) {
  if (!want) return null;
  const w = String(want).trim().toLowerCase();
  return index.clips.find((c) => c.name.toLowerCase() === w) ||
    index.clips.find((c) => c.name.toLowerCase().startsWith(w)) ||
    index.clips.find((c) => c.name.split("_")[0].toLowerCase() === w) ||
    index.clips.find((c) => c.category.toLowerCase().startsWith(w)) ||
    null;
}

function loadGt(index, clip) {
  const p = resolve(HERE, clip.gt_file);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------- cells

function extractCells(result, gt) {
  const images = Array.isArray(result.images) ? result.images : [];
  const cells = [];
  let source = "none";
  const warnings = [];

  const mc = metaCells(result.meta);

  // Pass 1: the images themselves
  for (let i = 0; i < images.length; i++) {
    const im = images[i] || {};
    const sp = pick(im, START_KEYS);
    const ep = pick(im, END_KEYS);
    const pp = pick(im, POINT_KEYS);
    let tStart = sp.v, tEnd = ep.v, t = pp.v;
    if (tStart !== null && tEnd !== null) { /* ok */ }
    else if (tStart !== null) tEnd = tStart;
    else if (tEnd !== null) tStart = tEnd;
    else if (t !== null) { tStart = t; tEnd = t; }
    cells.push({
      index: i + 1,
      tStart, tEnd, t,
      path: im.path ?? im.file ?? im.src ?? null,
      // NOTE: width/height are deliberately NOT taken from the image here. For
      // a contact sheet one file covers N cells, and copying the sheet's size
      // onto cell 1 reports the whole sheet as a "tile". Per-cell pixels are
      // resolved later, only when images.length === cells.length or from the
      // grid header.
      width: null,
      height: null,
      bytes: im.bytes ?? im.size ?? null,
      source: tStart !== null ? "image" : null,
    });
  }
  if (cells.some((c) => c.tStart !== null)) source = "image";

  // Pass 2: meta.cells (fills gaps, or supplies everything when images lack time)
  if (mc) {
    for (let i = 0; i < Math.max(cells.length, mc.arr.length); i++) {
      const m = mc.arr[i] || {};
      const sp = pick(m, START_KEYS), ep = pick(m, END_KEYS), pp = pick(m, POINT_KEYS);
      let tStart = sp.v, tEnd = ep.v, t = pp.v;
      if (tStart !== null && tEnd !== null) { /* ok */ }
      else if (tStart !== null) tEnd = tStart;
      else if (tEnd !== null) tStart = tEnd;
      else if (t !== null) { tStart = t; tEnd = t; }
      if (tStart === null) continue;
      if (!cells[i]) {
        cells[i] = { index: i + 1, path: m.path ?? null, width: m.width ?? null,
          height: m.height ?? null, bytes: m.bytes ?? null, t: null };
      }
      if (cells[i].tStart === null) {
        cells[i].tStart = tStart; cells[i].tEnd = tEnd; cells[i].t = t;
        cells[i].source = mc.key;
      }
    }
    if (cells.some((c) => c.source === mc.key) && source === "none") source = mc.key;
  }

  // Pass 3: scrape the text
  if (!cells.some((c) => c.tStart !== null)) {
    const tc = cellsFromText(result.text);
    for (let i = 0; i < tc.length; i++) {
      if (!cells[i]) cells[i] = { index: i + 1, path: null, width: null,
        height: null, bytes: null, t: null };
      cells[i].tStart = tc[i].tStart;
      cells[i].tEnd = tc[i].tEnd;
      cells[i].source = "text";
    }
    if (tc.length) source = "text";
  }

  // Tile pixel size: prefer the cell's own, else the image's, else infer from
  // GT aspect at a common tile width when the plugin declared nothing.
  // A contact-sheet result has ONE image for N cells, so image[i] is not the
  // cell; the grid header is the only honest source of per-cell pixels.
  let tileNote = null;
  const grid = gridTile(`${result.text ?? ""}\n${result.meta?.sheet ?? ""}`);
  for (const c of cells) {
    if (c.width && c.height) continue;
    const im = images[c.index - 1];
    if (images.length === cells.length && im && im.width && im.height) {
      c.width = im.width; c.height = im.height;
    } else if (grid) {
      c.width = grid.width; c.height = grid.height; c.tileFromGrid = true;
    }
  }
  if (grid && cells.some((c) => c.tileFromGrid)) tileNote = grid.note;

  const withTime = cells.filter((c) => c.tStart !== null);
  if (!withTime.length) {
    warnings.push("no per-cell time ranges found (images[].tStart/tEnd, "
      + "meta.cells[], and the result text all came up empty) - shot coverage "
      + "and cut alignment cannot be computed");
  }
  if (withTime.length && withTime.length < cells.length) {
    warnings.push(`${cells.length - withTime.length} of ${cells.length} cells have `
      + "no time range and are ignored by the time-based metrics");
  }
  return { cells, source, warnings, tileNote, grid };
}

// ---------------------------------------------------------------- metrics

function metrics(result, clip, gt, opts) {
  const tol = opts.tolMs;
  const { cells, source, warnings, tileNote, grid } = extractCells(result, gt);
  const images = Array.isArray(result.images) ? result.images : [];
  const dur = Number(gt?.duration ?? clip?.duration_s ?? 0);
  const fps = Number(gt?.fps ?? clip?.fps ?? 0);

  // --- normalise + sanity ---
  let timed = cells.filter((c) => c.tStart !== null && Number.isFinite(c.tStart))
    .map((c) => ({ ...c, tStart: +c.tStart, tEnd: +(c.tEnd ?? c.tStart) }))
    .sort((a, b) => a.tStart - b.tStart);
  for (const c of timed) if (c.tEnd < c.tStart) c.tEnd = c.tStart;
  if (dur > 0) {
    const bad = timed.filter((c) => c.tEnd > dur + 0.5 || c.tStart < -0.5);
    if (bad.length) {
      warnings.push(`${bad.length} cell(s) fall outside [0, ${dur.toFixed(2)}]s `
        + `(first: ${bad[0].tStart.toFixed(2)}-${bad[0].tEnd.toFixed(2)}s)`);
    }
  }
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].tStart < timed[i - 1].tEnd - 1e-6) {
      warnings.push(`cells ${timed[i - 1].index} and ${timed[i].index} overlap in `
        + `time (${timed[i - 1].tEnd.toFixed(2)}s > ${timed[i].tStart.toFixed(2)}s)`);
      break;
    }
  }

  // --- 1. shot coverage ---
  const shots = gt?.shots ?? [];
  let coverage = null;
  if (shots.length && timed.length) {
    const rows = shots.map((s) => {
      const inside = timed.filter((c) => c.tEnd >= s.start - 1e-6 && c.tStart <= s.end + 1e-6);
      const centred = inside.filter((c) => {
        const mid = (c.tStart + c.tEnd) / 2;
        return mid >= s.start && mid < s.end;
      });
      const best = inside
        .map((c) => ({ c, ov: Math.min(c.tEnd, s.end) - Math.max(c.tStart, s.start) }))
        .sort((a, b) => b.ov - a.ov)[0] ?? null;
      return { shot: s, inside, centred, best };
    });
    const hit = rows.filter((r) => r.inside.length).length;
    coverage = {
      shots: rows.length,
      covered: hit,
      fraction: hit / rows.length,
      centreCovered: rows.filter((r) => r.centred.length).length,
      rows,
    };
  }

  // --- 2. cut alignment ---
  const cuts = (gt?.cuts ?? []).map(Number).sort((a, b) => a - b);
  let alignment = null;
  if (cuts.length && timed.length >= 2) {
    const bounds = [];
    for (let i = 1; i < timed.length; i++) {
      const a = timed[i - 1], b = timed[i];
      // boundary = first moment of the next cell; if the two cells nearly touch,
      // the midpoint of the gap is the better estimate of the intended boundary
      let t = b.tStart;
      const gap = b.tStart - a.tEnd;
      if (gap >= 0 && gap <= 0.5 * (b.tEnd - b.tStart || 1)) t = (a.tEnd + b.tStart) / 2;
      const nearest = cuts.reduce((p, c) => (Math.abs(c - t) < Math.abs(p - t) ? c : p),
        cuts[0]);
      bounds.push({
        after: a.index, before: b.index, t,
        nearest, errMs: Math.abs(nearest - t) * 1000,
      });
    }
    const errs = bounds.map((x) => x.errMs);
    alignment = {
      cuts: cuts.length,
      boundaries: bounds,
      meanMs: mean(errs), medianMs: median(errs), maxMs: Math.max(...errs),
      within: bounds.filter((x) => x.errMs <= tol).length,
      tol,
    };
  }

  // --- 3. text cards ---
  const cards = gt?.text_cards ?? [];
  let textCards = null;
  if (cards.length) {
    const rows = cards.map((card, i) => {
      const inside = timed.filter((c) => c.tEnd >= card.start && c.tStart <= card.end);
      const full = inside.filter((c) => c.tStart >= card.start - 1e-6
        && c.tEnd <= card.end + 1e-6);
      const best = inside
        .map((c) => ({ c, ov: Math.min(c.tEnd, card.end) - Math.max(c.tStart, card.start) }))
        .sort((a, b) => b.ov - a.ov)[0] ?? null;
      return {
        index: card.index ?? i + 1,
        start: card.start, end: card.end,
        text: card.text ?? card.detail ?? "", card,
        hit: inside.length > 0, fullyInside: full.length > 0, best,
      };
    });
    const hit = rows.filter((r) => r.hit).length;
    const tiles = rows.filter((r) => r.best).map((r) => r.best.c)
      .filter((c) => c.width && c.height);
    textCards = {
      cards: rows.length, covered: hit, fraction: hit / rows.length,
      rows,
      tilePx: tiles.length
        ? { min: Math.min(...tiles.map((c) => c.width * c.height)),
            max: Math.max(...tiles.map((c) => c.width * c.height)),
            median: median(tiles.map((c) => c.width * c.height)) }
        : null,
      pluses: rows.filter((r) => r.fullyInside).length,
    };
  }

  // --- 4. cost ---
  const T = Number(process.env.IMG_TOKENS ?? 384);
  const ANCHOR = Number(process.env.ANCHOR_TOKENS ?? 0);
  const text = typeof result.text === "string" ? result.text : "";
  const textChars = [...text].length;
  const imageTokens = images.length * T;
  const textTokens = Math.ceil(textChars / 3.5);
  const cost = {
    images: images.length,
    imgTokensPerImage: T,
    imageTokens,
    textChars,
    textBytes: Buffer.byteLength(text, "utf8"),
    textTokens,
    anchor: ANCHOR,
    totalTokens: ANCHOR + imageTokens + textTokens,
    // the literal formula from the brief: ANCHOR - images*T
    anchorMinusImages: ANCHOR - imageTokens,
  };

  // --- 5. size / time ---
  let mp = 0, bytes = 0, missingBytes = 0;
  const dims = [];
  for (const im of images) {
    if (im.width && im.height) { mp += (im.width * im.height) / 1e6; dims.push(`${im.width}x${im.height}`); }
    if (Number.isFinite(im.bytes)) bytes += im.bytes;
    else if (im.path && existsSync(im.path)) bytes += statSync(im.path).size;
    else missingBytes++;
  }
  // "tile sizes" means the pixel size of one sampled cell, not of one file: for
  // a contact sheet the file is the whole sheet and the cell is much smaller.
  const cellDims = [...new Set(cells.filter((c) => c.width && c.height)
    .map((c) => `${c.width}x${c.height}`))];
  const meta = result.meta ?? {};
  const size = {
    megapixels: mp,
    bytesOnWire: bytes,
    megapixelsPerByte: bytes ? mp * 1e6 / bytes : null,
    dims: cellDims.length ? cellDims : [...new Set(dims)],
    imageDims: [...new Set(dims)],
    missingBytes,
  };

  const timing = {
    elapsedMs: Number(meta.elapsedMs ?? meta.elapsed ?? meta.ms ?? NaN),
    framesDecoded: Number(meta.framesDecoded ?? meta.frames ?? NaN),
    durationS: dur, fps,
  };
  if (Number.isFinite(timing.framesDecoded) && dur > 0) {
    timing.decodeRatio = timing.framesDecoded / (dur * fps);
  }
  if (Number.isFinite(timing.elapsedMs) && dur > 0) {
    timing.msPerVideoSecond = timing.elapsedMs / dur;
    timing.realtimeFactor = (dur * 1000) / timing.elapsedMs;
  }

  // --- 6. duplicate / wasted cells ---
  const dupes = [];
  const seen = new Map();
  for (const im of images) {
    if (!im.path || !existsSync(im.path)) continue;
    try {
      const h = createHash("sha1").update(readFileSync(im.path)).digest("hex");
      if (seen.has(h)) dupes.push({ a: seen.get(h), b: im.path });
      else seen.set(h, im.path);
    } catch { /* ignore unreadable */ }
  }
  if (dupes.length) {
    warnings.push(`${dupes.length} duplicate image payload(s) - identical bytes `
      + "means a wasted grid cell");
  }

  return { clip: clip?.name ?? null, gt, cells, timed, source, warnings, coverage,
    alignment, textCards, cost, size, timing, dupes, tol, tileNote, grid };
}

// ---------------------------------------------------------------- printing

function hr(ch = "=", n = 78) { return ch.repeat(n); }

function printReport(m, opts) {
  const { clip, gt } = m;
  console.log(hr());
  console.log(`clip: ${clip ?? "(unknown - pass --clip)"}   `
    + `result: ${opts.label ?? "(inline)"}`);
  if (gt) {
    console.log(`  GT: ${gt.duration}s @ ${gt.fps}fps ${gt.width}x${gt.height}, `
      + `${(gt.shots ?? []).length} shots, ${(gt.cuts ?? []).length} cuts, `
      + `${(gt.text_cards ?? []).length} text cards, `
      + `${(gt.speech ?? []).length} speech segments`);
  }
  console.log(hr("-"));
  const n = m.cells.length;
  console.log(`cells: ${n}   time source: ${m.source}   `
    + `tile sizes: ${m.size.dims.length ? m.size.dims.join(", ") : "n/a"}   `
    + `images: ${m.size.megapixels.toFixed(2)} MP   `
    + `bytes: ${m.size.bytesOnWire.toLocaleString()}`);
  if (m.grid && m.tileNote) {
    console.log(`         sheet ${m.grid.sheetW}x${m.grid.sheetH} in a `
      + `${m.grid.cols}x${m.grid.rows} grid -> cell ~${m.grid.width}x${m.grid.height}`
      + ` px (${m.tileNote})`);
  }

  // --- coverage
  console.log("\n[1] SHOT COVERAGE");
  if (!m.coverage) {
    console.log(`    n/a - ${m.source === "none" ? "no cell time ranges" : "clip has no shots"}`);
  } else {
    const c = m.coverage;
    console.log(`    ${c.covered}/${c.shots} shots touched by >=1 cell `
      + `(${pct(c.covered, c.shots).toFixed(1)}%)   `
      + `centre-inside: ${c.centreCovered}/${c.shots} `
      + `(${pct(c.centreCovered, c.shots).toFixed(1)}%)`);
    const miss = c.rows.filter((r) => !r.inside.length);
    if (miss.length) {
      console.log("    MISSED: " + miss.map((r) => r.shot.label ?? `#${r.shot.index}`).join(", "));
    }
    const thin = c.rows.filter((r) => r.inside.length === 1);
    if (thin.length && opts.verbose) {
      console.log("    single-cell shots: "
        + thin.map((r) => `${r.shot.label ?? "#" + r.shot.index}`
          + `(cell ${r.inside[0].index})`).join(", "));
    }
  }

  // --- cut alignment
  console.log("\n[2] CUT ALIGNMENT (per cell boundary, ms vs nearest GT cut)");
  if (!m.alignment) {
    console.log(`    n/a - ${m.source === "none" ? "no cell time ranges"
      : (m.timed.length < 2 ? "fewer than 2 timed cells" : "clip has no cuts by GT")}`);
  } else {
    const a = m.alignment;
    console.log(`    ${a.boundaries.length} boundaries, ${a.cuts} GT cuts, `
      + `tol ${a.tol}ms -> ${a.within}/${a.boundaries.length} aligned`);
    console.log(`    err ms: mean ${fmt(a.meanMs)}  median ${fmt(a.medianMs)}  `
      + `max ${fmt(a.maxMs)}`);
    if (opts.verbose || opts.showAll) {
      console.log("    " + pad("#", 4) + pad("boundary s", 12, true)
        + pad("nearest cut s", 15, true) + pad("err ms", 10, true) + "  verdict");
      for (const b of a.boundaries) {
        const okv = b.errMs <= a.tol;
        console.log("    " + pad(b.after + ">" + b.before, 4)
          + pad(b.t.toFixed(3), 12, true)
          + pad(b.nearest.toFixed(3), 15, true)
          + pad(b.errMs.toFixed(0), 10, true) + "  " + (okv ? "ok" : "MISS"));
      }
    } else {
      const worst = [...a.boundaries].sort((x, y) => y.errMs - x.errMs).slice(0, 3);
      console.log("    worst: " + worst.map((w) => `${w.t.toFixed(2)}s->`
        + `${w.errMs.toFixed(0)}ms`).join(", "));
    }
  }

  // --- text cards
  console.log("\n[3] TEXT-CARD READABILITY PROXY");
  if (!m.textCards) {
    console.log("    n/a - this clip has no GT text cards");
  } else {
    const t = m.textCards;
    console.log(`    ${t.covered}/${t.cards} cards had a cell inside `
      + `(${pct(t.covered, t.cards).toFixed(1)}%), ${t.pluses} fully contained`);
    if (t.tilePx) {
      console.log(`    tile pixels on covered cards: min ${t.tilePx.min}, `
        + `median ${Math.round(t.tilePx.median)}, max ${t.tilePx.max}`);
    } else {
      console.log("    tile pixel size: n/a (result did not declare width/height)");
    }
    if (opts.verbose || t.covered < t.cards) {
      console.log("    " + pad("card", 6) + pad("window s", 18) + pad("cell", 6)
        + pad("tile", 12) + "text");
      for (const r of t.rows) {
        const cell = r.best ? r.best.c : null;
        console.log("    " + pad(r.index, 6)
          + pad(`${r.start.toFixed(2)}-${r.end.toFixed(2)}`, 18)
          + pad(cell ? cell.index : "-", 6)
          + pad(cell && cell.width ? `${cell.width}x${cell.height}` : "-", 12)
          + trunc(r.text, 34) + (r.hit ? "" : "   <-- NOT COVERED"));
      }
    }
  }

  // --- cost
  console.log("\n[4] COST");
  const c = m.cost;
  console.log(`    tokens ~ ${c.totalTokens.toLocaleString()} `
    + `(anchor ${c.anchor} + images ${c.images}x${c.imgTokensPerImage}=${c.imageTokens}`
    + ` + text ${c.textChars}ch/3.5=${c.textTokens})`);
  console.log(`    ANCHOR - images*T = ${c.anchorMinusImages.toLocaleString()}   `
    + `text: ${c.textChars} chars, ${c.textBytes} bytes`);
  const s = m.size, t = m.timing;
  console.log(`    megapixels ${s.megapixels.toFixed(2)}   `
    + `bytes on wire ${s.bytesOnWire.toLocaleString()}   `
    + `wall ${Number.isFinite(t.elapsedMs) ? t.elapsedMs.toFixed(0) + " ms" : "n/a"}`);
  if (Number.isFinite(t.msPerVideoSecond)) {
    console.log(`    ${t.msPerVideoSecond.toFixed(1)} ms of wall per video second `
      + `(${t.realtimeFactor.toFixed(2)}x realtime)`);
  }
  if (Number.isFinite(t.decodeRatio)) {
    console.log(`    framesDecoded ${t.framesDecoded} = ${(100 * t.decodeRatio).toFixed(1)}% `
      + `of the ${Math.round(t.durationS * t.fps)} frames in the clip`);
  }
  if (c.images && Number.isFinite(t.elapsedMs)) {
    console.log(`    ${(t.elapsedMs / c.images).toFixed(1)} ms per cell, `
      + `${(c.imageTokens / Math.max(1, t.durationS)).toFixed(1)} img-tokens per video second`);
  }

  if (m.warnings.length) {
    console.log("\n[!] WARNINGS");
    for (const w of m.warnings) console.log("    - " + w);
  }
  console.log();
}

function printCompare(all) {
  console.log(hr());
  console.log("COMPARISON");
  const head = [pad("result", 24), pad("cells", 6, true), pad("cover", 8, true),
    pad("cut med ms", 11, true), pad("cuts ok", 9, true), pad("cards", 7, true),
    pad("tokens", 9, true), pad("MP", 6, true), pad("bytes", 10, true),
    pad("wall ms", 9, true)].join("");
  console.log(head);
  console.log(hr("-"));
  for (const m of all) {
    const cov = m.coverage ? `${(100 * m.coverage.fraction).toFixed(0)}%` : "n/a";
    const cm = m.alignment ? m.alignment.medianMs.toFixed(0) : "n/a";
    const cok = m.alignment ? `${m.alignment.within}/${m.alignment.boundaries.length}` : "n/a";
    const cards = m.textCards ? `${m.textCards.covered}/${m.textCards.cards}` : "n/a";
    console.log(pad(m.__label ?? "-", 24) + pad(m.cells.length, 6, true)
      + pad(cov, 8, true) + pad(cm, 11, true) + pad(cok, 9, true)
      + pad(cards, 7, true) + pad(m.cost.totalTokens, 9, true)
      + pad(m.size.megapixels.toFixed(2), 6, true)
      + pad(m.size.bytesOnWire, 10, true)
      + pad(Number.isFinite(m.timing.elapsedMs) ? m.timing.elapsedMs.toFixed(0) : "n/a", 9, true));
  }
  console.log();
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const a = { results: [], clip: null, index: DEFAULT_INDEX, json: null,
    tolMs: DEFAULT_TOL_MS, verbose: false, showAll: false, labels: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => argv[++i];
    switch (k) {
      case "--result": a.results.push(val()); break;
      case "--clip": a.clip = val(); break;
      case "--index": a.index = val(); break;
      case "--json": a.json = val(); break;
      case "--tolerance-ms": a.tolMs = Number(val()); break;
      case "--verbose": case "-v": a.verbose = true; break;
      case "--show-all": a.showAll = true; break;
      case "--label": a.labels.push(val()); break;
      case "-h": case "--help": a.help = true; break;
      default:
        if (k.startsWith("--result=")) a.results.push(k.slice(9));
        else if (k.startsWith("--clip=")) a.clip = k.slice(7);
        else if (k.startsWith("--json=")) a.json = k.slice(7);
        else throw new Error(`unknown argument: ${k}`);
    }
  }
  return a;
}

function readResult(spec) {
  if (spec === "-") {
    const chunks = [];
    const buf = readFileSync(0);
    chunks.push(buf);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const p = resolve(spec);
  if (!existsSync(p)) throw new Error(`result file not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error("error: " + e.message); process.exit(2); }
  if (args.help || !args.results.length) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8")
      .split("\n").slice(1, 40).filter((l) => l.startsWith(" *") || l.startsWith("/**"))
      .map((l) => l.replace(/^\s*\*?\/?\*?\s?/, "")).join("\n"));
    process.exit(args.results.length ? 0 : 2);
  }

  let index;
  try { index = loadIndex(args.index); }
  catch (e) { console.error("error: " + e.message); process.exit(2); }

  const all = [];
  for (let i = 0; i < args.results.length; i++) {
    const spec = args.results[i];
    let result;
    try { result = readResult(spec); }
    catch (e) { console.error(`error reading ${spec}: ${e.message}`); process.exit(2); }

    // clip resolution: --clip, then meta hints, then a path substring match
    let clip = findClip(index, args.clip);
    if (!clip) {
      for (const k of ["clip", "clipName", "name", "title", "file", "video"]) {
        const v = result.meta?.[k] ?? result[k];
        if (typeof v === "string") { clip = findClip(index, v) ?? clip; if (clip) break; }
      }
    }
    if (!clip) {
      const hay = JSON.stringify(result.meta ?? {}) + JSON.stringify(
        (result.images ?? []).map((x) => x.path ?? ""));
      clip = index.clips.find((c) => hay.includes(c.name.split(".")[0])) ?? null;
    }
    const gt = clip ? loadGt(index, clip) : null;
    if (!clip) {
      console.error(`warning: could not tell which corpus clip this result is for `
        + `(pass --clip <A..I|name>). Metrics that need GT will be n/a.`);
    }
    const m = metrics(result, clip, gt, args);
    m.__label = args.labels[i] ?? (spec === "-" ? "stdin" : basename(spec));
    m.__spec = spec;
    all.push(m);
  }

  for (const m of all) printReport(m, { ...args, label: m.__label });
  if (all.length > 1) printCompare(all);

  if (args.json) {
    const out = {
      tool: "measure.mjs",
      schema: "v4video.bench.measure/1",
      generated: new Date().toISOString(),
      env: { IMG_TOKENS: process.env.IMG_TOKENS ?? "384",
        ANCHOR_TOKENS: process.env.ANCHOR_TOKENS ?? "0" },
      results: all.map((m) => ({
        label: m.__label, spec: m.__spec, clip: m.clip,
        cells: m.cells.length, timeSource: m.source,
        coverage: m.coverage && {
          shots: m.coverage.shots, covered: m.coverage.covered,
          fraction: +m.coverage.fraction.toFixed(4),
          centreCovered: m.coverage.centreCovered,
          missed: m.coverage.rows.filter((r) => !r.inside.length)
            .map((r) => r.shot.label ?? r.shot.index),
        },
        cutAlignment: m.alignment && {
          boundaries: m.alignment.boundaries.length,
          gtCuts: m.alignment.cuts,
          meanMs: +m.alignment.meanMs.toFixed(2),
          medianMs: +m.alignment.medianMs.toFixed(2),
          maxMs: +m.alignment.maxMs.toFixed(2),
          withinTol: m.alignment.within,
          tolMs: m.alignment.tol,
          perBoundary: m.alignment.boundaries.map((b) => ({
            t: +b.t.toFixed(4), nearestCut: b.nearest,
            errMs: +b.errMs.toFixed(2), ok: b.errMs <= m.alignment.tol,
          })),
        },
        textCards: m.textCards && {
          cards: m.textCards.cards, covered: m.textCards.covered,
          fraction: +m.textCards.fraction.toFixed(4),
          fullyContained: m.textCards.pluses,
          tilePx: m.textCards.tilePx,
          rows: m.textCards.rows.map((r) => ({
            index: r.index, start: r.start, end: r.end, hit: r.hit,
            cell: r.best ? r.best.c.index : null,
            tile: r.best && r.best.c.width ? `${r.best.c.width}x${r.best.c.height}` : null,
          })),
        },
        cost: m.cost, size: m.size, timing: m.timing,
        duplicates: m.dupes, warnings: m.warnings,
      })),
    };
    writeFileSync(resolve(args.json), JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`json written to ${resolve(args.json)}`);
  }
}

main();

