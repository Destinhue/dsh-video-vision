/**
 * bench/ab/run-upstream.mjs
 *
 * Benchmark harness for the UPSTREAM reference implementation
 * (upstream dsh-video-storyboard src/pipeline.js, v0.3.0).
 *
 * The host plugin loader is not available in this environment, so we import the
 * pipeline module directly and call the exported entry point `runStoryboard()`.
 * That is exactly the function the upstream `video_storyboard` tool calls; the
 * tool layer only adds attachment saving and manifest formatting. We therefore
 * also call `formatManifest()` with the tool's default detail ('med',
 * DETAIL_CHARS.med = 120) to record the text length the model would receive.
 *
 * Option set: pipeline defaults, i.e. runStoryboard({ input }) only:
 *   from=0, to=0, cells=0, sheets=0, threshold='auto', minGap=1.2,
 *   adaptive=true, pick='sharp', burn='index', transcript='auto',
 *   audioStrip=true, budget=640000.
 * `transcript:'auto'` cannot reach the network here: upstream returns null when
 * no API key is configured, so ASR is a no-op rather than a timeout.
 *
 * Timing: one measured call per clip, in corpus order, in one warm process.
 * The module import / process start is NOT inside the timer. We deliberately do
 * not add a warm-up call: bench/accuracy.mjs (ours) also runs one cold call per
 * clip in a fresh process, so both sides pay the same first-call costs.
 * A private, emptied DSH_VIDEO_CACHE_DIR guarantees the upstream disk cache
 * cannot make this side look faster due to an earlier run.
 *
 * Requires a checkout of the reference implementation (v0.3.0):
 *   git clone https://github.com/SAOS-3624/dsh-video-storyboard .upstream/dsh-video-storyboard
 * or point UPSTREAM_DIR at an existing one.
 *
 * Run from the repository root:
 *   node bench/ab/run-upstream.mjs
 * Optional: --clips=A_hardcuts_720p,B_montage_360p
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPSTREAM = process.env.UPSTREAM_DIR
  ? path.resolve(process.env.UPSTREAM_DIR)
  : path.join(ROOT, '.upstream', 'dsh-video-storyboard');
const AB = path.join(ROOT, 'bench', 'out');
const SHEETS = path.join(AB, 'upstream-run-sheets');
const CACHE = path.join(AB, '.cache-upstream-run');

// Upstream's probe module reads DSH_FFMPEG_PATH / DSH_FFPROBE_PATH into module
// constants at evaluation time, so they must be set before the import below.
// Leave them unset to use whatever `ffmpeg`/`ffprobe` are on PATH.
if (process.env.FFMPEG_PATH && !process.env.DSH_FFMPEG_PATH) process.env.DSH_FFMPEG_PATH = process.env.FFMPEG_PATH;
if (process.env.FFPROBE_PATH && !process.env.DSH_FFPROBE_PATH) process.env.DSH_FFPROBE_PATH = process.env.FFPROBE_PATH;
process.env.DSH_VIDEO_CACHE_DIR = CACHE;

const { runStoryboard, formatManifest, DETAIL_CHARS } = await import(
  pathToFileURL(path.join(UPSTREAM, 'src', 'pipeline.js')).href
);

const DETAIL = 'med';                 // upstream tool default detail
const CELL_CHARS = DETAIL_CHARS[DETAIL]; // 120

const argClips = (process.argv.find((a) => a.startsWith('--clips=')) ?? '').slice('--clips='.length);
const only = argClips ? new Set(argClips.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const corpus = JSON.parse(await readFile(path.join(ROOT, 'bench', 'corpus', 'index.json'), 'utf8'));

await rm(CACHE, { recursive: true, force: true });
await mkdir(CACHE, { recursive: true });
await mkdir(SHEETS, { recursive: true });

/* ------------------------------------------------------------------ helpers */

/**
 * Vision-token formula from the benchmark brief, i.e. the host accounting:
 *   cells are 3x14 = 42 px (14 px patch, 3x downsample)
 *   images below 544x544 are upscaled to 544*544 total pixels, aspect kept
 *   tokens = gridH * (gridW + 1) + 2, capped at 1024
 * gridW = ceil((w/3)/14) == ceil(w/42); we compute it literally as the brief writes it.
 */
function visionTokens(width, height) {
  let w = width;
  let h = height;
  let upscaled = false;
  const px = w * h;
  if (px > 0 && px < 544 * 544) {
    const k = Math.sqrt((544 * 544) / px);
    // round instead of trunc so the upscaled area is >= 544*544
    w = Math.round(w * k);
    h = Math.round(h * k);
    upscaled = true;
  }
  const gridW = Math.ceil((w / 3) / 14);
  const gridH = Math.ceil((h / 3) / 14);
  const raw = gridH * (gridW + 1) + 2;
  return {
    gridW, gridH, raw, tokens: Math.min(1024, raw),
    fedW: w, fedH: h, upscaled,
    formula: `gridH*(gridW+1)+2 = ${gridH}*(${gridW}+1)+2 = ${raw}`,
  };
}

/** PNG IHDR: 8-byte signature, 4-byte length, "IHDR", w at 16, h at 20 (big endian). */
function pngDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) throw new Error('not a PNG buffer');
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') throw new Error(`bad PNG signature ${sig}`);
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('missing IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

/** Same greedy matcher as bench/accuracy.mjs so both sides are scored identically. */
function match(found, truth, tol = 0.5) {
  const used = new Set();
  let hit = 0;
  for (const t of found) {
    let bi = -1;
    let bd = Infinity;
    truth.forEach((g, i) => {
      if (!used.has(i)) {
        const d = Math.abs(g - t);
        if (d < bd) { bd = d; bi = i; }
      }
    });
    if (bi >= 0 && bd <= tol) { used.add(bi); hit++; }
  }
  const p = found.length ? hit / found.length : (truth.length ? 0 : 1);
  const r = truth.length ? hit / truth.length : 1;
  return { hit, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/* -------------------------------------------------------------------- run */

const rows = [];
let fatal = null;

for (const clip of corpus.clips) {
  if (only && !only.has(clip.name)) continue;
  const file = path.join(ROOT, 'bench', clip.file);
  const gt = JSON.parse(await readFile(path.join(ROOT, 'bench', clip.gt_file), 'utf8'));
  const row = {
    clip: clip.name,
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    detail: DETAIL,
    cellCharsInManifest: CELL_CHARS,
    durationS: clip.duration_s,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    ok: false,
    error: null,
  };

  const started = performance.now();
  let res;
  try {
    res = await runStoryboard({ input: file });
  } catch (error) {
    row.wallMs = r2(performance.now() - started);
    row.error = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
    if (error?.stack) row.errorStack = String(error.stack).split('\n').slice(0, 6).join('\n');
    rows.push(row);
    fatal = fatal ?? row.error;
    console.error(`[FAIL] ${clip.name}: ${row.error}`);
    continue;
  }
  row.wallMs = Math.round(performance.now() - started);

  const sheets = [];
  const cellTimes = [];
  let cells = 0;
  let tokens = 0;
  for (const [i, sheet] of (res.sheets ?? []).entries()) {
    const png = pngDims(sheet.png);
    const tok = visionTokens(sheet.width, sheet.height);
    tokens += tok.tokens;
    cells += sheet.cells.length;
    for (const c of sheet.cells) cellTimes.push(Number.isFinite(c.t_frame) ? c.t_frame : (c.t_start + c.t_end) / 2);
    const pngPath = path.join(SHEETS, `${clip.name}-${i + 1}.png`);
    await writeFile(pngPath, sheet.png);
    sheets.push({
      index: sheet.sheet ?? i + 1,
      rawWidth: sheet.width,
      rawHeight: sheet.height,
      rawBytes: Buffer.isBuffer(sheet.buffer) ? sheet.buffer.length : null,
      rawBytesExpected: sheet.width * sheet.height * 3,
      pngWidth: png.width,
      pngHeight: png.height,
      dimsMatch: png.width === sheet.width && png.height === sheet.height,
      pngBytes: png.bytes,
      cols: sheet.cols,
      rows: sheet.rows,
      slots: sheet.cols * sheet.rows,
      cellW: sheet.cellW,
      cellH: sheet.cellH,
      cellCount: sheet.cells.length,
      stripH: sheet.stripH ?? 0,
      pngPath: path.relative(ROOT, pngPath).split(path.sep).join('/'),
      visionTokens: tok.tokens,
      tokenDetail: tok,
      cells: sheet.cells.map((c) => ({
        i: c.i, sheet: c.sheet, t_start: c.t_start, t_end: c.t_end, t_frame: c.t_frame, cuts: c.cuts ?? 0,
      })),
    });
  }

  const manifest = formatManifest(res, { maxCellChars: CELL_CHARS });
  const found = (res.cuts ?? []).map((c) => r2(c.t));
  const truth = (gt.cuts ?? []).map((t) => r2(t));
  const m = match(found, truth);
  const shots = gt.shots ?? [];
  const covered = shots.filter((s) => cellTimes.some((t) => t >= s.start - 0.05 && t < s.end + 1e-6)).length;

  Object.assign(row, {
    ok: true,
    wallMsInternalTimings: res.timings ?? null,
    cached: res.cached ?? null,
    sheetCount: sheets.length,
    sheets,
    sheetCountTimesTokens: sheets.length * tokens,
    tokens,
    totalPixels: sheets.reduce((n, s) => n + s.rawWidth * s.rawHeight, 0),
    cellCount: cells,
    grid: sheets.length === 1 ? { cols: sheets[0].cols, rows: sheets[0].rows } : sheets.map((s) => ({ cols: s.cols, rows: s.rows })),
    cellTimes: cellTimes.map(r3),
    cutCount: found.length,
    cuts: found,
    cutsTruth: truth,
    cutPrecision: r2(m.p),
    cutRecall: r2(m.r),
    cutF1: r2(m.f1),
    cutMatchesAtHalfSecond: m.hit,
    gtShotCount: shots.length,
    coveredShotCount: covered,
    coverage: shots.length ? r3(covered / shots.length) : 1,
    manifestChars: manifest.length,
    manifestLines: manifest.split('\n').length,
    manifestHead: manifest.split('\n').slice(0, 3),
    infoDurationS: res.info?.duration ?? null,
    transcriptSource: res.transcript?.source ?? null,
    planReason: res.plan?.reason ?? null,
    planAdaptive: res.plan?.adaptive ?? null,
    planSheets: res.plan?.sheets ?? null,
    planCells: res.plan?.cells ?? null,
    audioStrip: Boolean(res.audio),
  });
  rows.push(row);
  console.log(
    `${clip.name.padEnd(24)} ${String(row.wallMs).padStart(5)}ms  ${sheets.length} img ${sheets[0]?.rawWidth}x${sheets[0]?.rawHeight}`
    + `  cells ${String(cells).padStart(2)}  cuts ${found.length}/${truth.length} F1 ${m.f1.toFixed(2)}`
    + `  cov ${row.coverage.toFixed(2)}  ${tokens} tok  manifest ${manifest.length} ch`,
  );
}

const mean = (k) => (rows.length ? rows.reduce((a, x) => a + (x[k] ?? 0), 0) / rows.length : 0);
const out = {
  schema: 1,
  generator: 'bench/ab/run-upstream.mjs',
  implementation: 'dsh-video-storyboard v0.3.0 src/pipeline.js (git clone of SAOS-3624/dsh-video-storyboard)',
  entryPoint: 'runStoryboard({ input })',
  manifest: `formatManifest(result, { maxCellChars: DETAIL_CHARS.med = ${CELL_CHARS} })`,
  options: {
    detail: DETAIL, from: 0, to: 0, cells: 0, sheets: 0, threshold: 'auto', minGap: 1.2,
    adaptive: true, pick: 'sharp', burn: 'index', transcript: 'auto', audioStrip: true, budget: 640000,
  },
  env: {
    DSH_FFMPEG_PATH: process.env.DSH_FFMPEG_PATH,
    DSH_FFPROBE_PATH: process.env.DSH_FFPROBE_PATH,
    DSH_VIDEO_CACHE_DIR: CACHE,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  },
  timestampUtc: new Date().toISOString(),
  corpusClips: corpus.clips.length,
  clipsRun: rows.length,
  meanWallMs: Math.round(mean('wallMs')),
  meanCells: r2(mean('cellCount')),
  meanTokens: Math.round(mean('tokens')),
  meanCutF1: r2(mean('cutF1')),
  meanCoverage: r3(mean('coverage')),
  fatalError: fatal,
  rows,
};

await writeFile(path.join(AB, 'upstream.json'), JSON.stringify(out, null, 2));
console.log(`\nwrote ${path.join(AB, 'upstream.json')} (${rows.length} clips)`);
if (fatal) console.error(`FATAL: ${fatal}`);
