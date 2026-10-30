/**
 * pipeline.js — the orchestration: probe → analyse → choose → decode → draw →
 * text.
 *
 * The shape of the work is chosen for wall-clock time, because a video tool
 * that takes 40 s to answer does not get used:
 *
 *   probe      ffprobe JSON (or the ffmpeg banner when ffprobe is absent)
 *   audio  ┐   decoded to 8 kHz mono and analysed here
 *   scan   ┘   one rawvideo pass at 96x54; cut detection, frame vectors
 *   plan       cells chosen from the scan, no extra decode
 *   decode     one ffmpeg process per group of cells, concurrent
 *   draw       pure JS compositing, no image library
 *
 * Both ffmpeg passes run at the same time, so a 5-minute film costs roughly one
 * decode of its own length rather than two.
 */

import { run, probeVideo, findFfmpeg, findFfprobe, displayAspect, uprightSize } from './media.js';
import { scanShots } from './scan.js';
import { planCells, planGrid, cellReadability, sheetPixelsFor, DETAIL_PRESETS, suggestDetail, bestFrameIndex } from './layout.js';
import { extractCells, extractFrame } from './frames.js';
import { composeSheet } from './sheet.js';
import { encodePng } from './png.js';
import { analyzeAudio, extractSubtitles, groupCues, timecode } from './timeline.js';
import { formatManifest } from './manifest.js';
import { asrAvailable, asrCues } from './asr.js';
import { isBilibili, bilibiliFile, bilibiliView, bilibiliPlay, bilibiliSubtitles, describeBilibili } from './bili.js';

export { DETAIL_PRESETS };

const MAX_CELLS_HARD = 24;

/**
 * A B站 link is not a path, so anything that decodes has to wait for the
 * download. `video_probe` deliberately does not call this: asking what a video
 * is should cost one HTTP request, not a hundred megabytes.
 */
async function resolveSource(rawInput, { ffmpegPath, signal, log } = {}) {
  if (!isBilibili(rawInput)) return { path: rawInput, meta: null, download: null };
  const file = await bilibiliFile(rawInput, { ffmpegPath, signal, log, maxHeight: biliMaxHeight() });
  return { path: file.path, meta: file.meta, download: file };
}

/** Highest quality worth downloading; 1080p by default, override with the env. */
export function biliMaxHeight(env = process.env) {
  const n = Number(env.DSH_BILIBILI_MAX_HEIGHT);
  return Number.isFinite(n) && n >= 144 ? Math.floor(n) : 1080;
}

function sourceTitle(meta) {
  if (!meta) return '';
  const part = meta.pages > 1 && meta.partTitle ? ` · P${meta.page} ${meta.partTitle}` : '';
  return `${meta.title || meta.bvid}${part}`;
}

/**
 * Analysis cache. A long film is scanned once and re-used by every later call
 * in the session — a textOnly page-through then costs nothing but formatting,
 * and a zoom over a window the storyboard already covered skips its scan.
 * Keyed by identity (path, size, mtime) plus the window, so an edited or
 * replaced file never returns a stale plan.
 */
const CACHE_LIMIT = 6;
const analysisCache = new Map();

async function identityOf(input) {
  try {
    const { stat } = await import('node:fs/promises');
    const st = await stat(input);
    return `${input}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return `${input}|remote`;
  }
}

function cacheGet(key) {
  const hit = analysisCache.get(key);
  if (!hit) return null;
  analysisCache.delete(key);
  analysisCache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  analysisCache.set(key, value);
  while (analysisCache.size > CACHE_LIMIT) {
    const oldest = analysisCache.keys().next().value;
    analysisCache.delete(oldest);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.input          local path or ffmpeg-readable URL
 * @param {string} [opts.detail]       low | auto | high
 * @param {number} [opts.maxCells]
 * @param {number} [opts.start]
 * @param {number} [opts.end]
 * @param {number} [opts.duration]
 * @param {boolean} [opts.textOnly]    text index only: no decode, no image
 * @param {number[]} [opts.cellRange]  [first,last] 1-based cells to list
 * @param {boolean} [opts.transcript]  pull an embedded subtitle track (default true)
 * @param {boolean} [opts.band]        draw the audio band under the grid
 * @param {AbortSignal} [opts.signal]
 */
export async function runStoryboard(opts) {
  const t = {};
  const started = Date.now();
  let clock = started;
  const mark = (k) => { t[k] = Date.now() - clock; clock = Date.now(); };

  const ffmpegPath = opts.ffmpegPath ?? await findFfmpeg();
  if (!ffmpegPath) throw new Error('ffmpeg not found — set DSH_FFMPEG_PATH or install ffmpeg');
  const ffprobePath = opts.ffprobePath ?? await findFfprobe();

  // ---- 0. source: a B站 link becomes a local file before anything else
  const source = await resolveSource(opts.input, { ffmpegPath, signal: opts.signal, log: opts.log });
  const input = source.path;
  mark('source');

  // ---- 1. probe
  const probe = await probeVideo(input, { ffmpegPath, ffprobePath });
  mark('probe');
  const dur = probe.duration || 0;
  const start = clamp(Number(opts.start) || 0, 0, Math.max(0, dur - 0.2));
  const endAsked = Number(opts.end);
  const end = Number.isFinite(endAsked) && endAsked > start
    ? clamp(endAsked, start + 0.2, dur)
    : (Number(opts.duration) > 0 ? Math.min(dur, start + Number(opts.duration)) : dur);
  const window = Math.max(0.2, end - start);

  const aspect = Number.isFinite(probe.aspect) && probe.aspect > 0
    ? probe.aspect
    : displayAspect(probe.coded.width, probe.coded.height, probe.sar, probe.rotation);
  const upright = uprightSize(probe.coded.width, probe.coded.height, probe.rotation);

  // ---- 2. analysis, reused across calls when the file has not changed
  const identity = await identityOf(input);
  const key = `${identity}|${start.toFixed(2)}|${window.toFixed(2)}|${opts.detail ?? 'auto'}|${opts.maxCells ?? ''}|${opts.pick ?? 'sharp'}`;
  let analysis = cacheGet(key);
  const fromCache = Boolean(analysis);

  if (!analysis) {
    const [scan, audio] = await Promise.all([
      scanShots({
        input, ffmpegPath, fps: probe.fps || 25, aspect,
        start, duration: window, signal: opts.signal,
      }),
      probe.hasAudio
        ? analyzeAudio({ input, ffmpegPath, signal: opts.signal, duration: window, run })
          .catch((error) => ({ hasAudio: false, error: String(error?.message ?? error) }))
        : Promise.resolve({ hasAudio: false, skipped: true }),
    ]);
    analysis = { scan, audio, start, window, at: Date.now() };
    cacheSet(key, analysis);
  }
  const { scan, audio } = analysis;
  mark('analyse');

  // ---- 3. subtitles (container metadata, no decode)
  let transcript = analysis.transcript ?? { cues: [], segments: [], source: null };
  let asrNote = null;
  if (opts.transcript !== false && probe.hasSubtitle && !analysis.transcript) {
    try {
      const subs = await extractSubtitles({ input, ffmpegPath, signal: opts.signal, run, probe });
      // Keep the RAW cues: the manifest attributes each line to the cell that
      // contains its midpoint, so one line is quoted once. `groupCues` merges
      // neighbouring lines into sentences and is only good for a summary count.
      if (subs.cues.length) {
        transcript = { cues: subs.cues, segments: groupCues(subs.cues), source: 'subtitle-track' };
      }
    } catch { /* a broken subtitle track must not fail the tool */ }
    analysis.transcript = transcript;
  }
  // ---- 3b. speech to text, only when nobody else already said it
  //
  // A subtitle track is a transcript someone else paid for: cheaper and far more
  // accurate than any recogniser. ASR is the fallback for the file that has
  // audio and no captions, and it is off unless `DSH_ASR_CMD` names an engine
  // (see src/asr.js for why the engine is not bundled).
  if (opts.transcript !== false && opts.asr !== false
    && !(transcript.cues && transcript.cues.length)
    && probe.hasAudio && asrAvailable()) {
    try {
      const heard = await asrCues({ ffmpegPath, input, start, end: start + window, signal: opts.signal });
      if (heard.cues.length) {
        transcript = { cues: heard.cues, segments: groupCues(heard.cues), source: 'asr' };
        analysis.transcript = transcript;
      }
      if (heard.reason) asrNote = heard.reason;
    } catch (error) {
      asrNote = String(error?.message ?? error);
    }
  }
  mark('subtitle');

  // ---- 4. choose cells
  const detail = DETAIL_PRESETS[opts.detail] ? opts.detail : 'auto';
  // Leave `maxCells` unset unless the caller asked: the plan then decides from
  // the pixel cap and the picture's aspect how many moments still stay legible.
  const maxCells = opts.maxCells
    ? clamp(Math.round(Number(opts.maxCells)), 1, MAX_CELLS_HARD)
    : undefined;
  const plan = planCells({ scan, audio, detail, maxCells, aspect: probe.aspect });
  if ((opts.pick ?? 'sharp') === 'middle') {
    const startT = scan.start ?? 0;
    for (const c of plan.cells) {
      const mid = (c.t0 + c.t1) / 2;
      c.frameIndex = Math.max(0, Math.min(scan.frames - 1, Math.round((mid - startT) * scan.effFps)));
      c.frameT = +(startT + (c.frameIndex + 0.5) / scan.effFps).toFixed(3);
    }
  }
  // Cell spans come out of the planner on the window's clock (0 = the first
  // frame we scanned). Everything downstream — the manifest, the cut counts and
  // the dialogue quotes — speaks the file's clock, so shift once here rather
  // than remembering to add `start` in three places.
  const shift = scan.start ?? 0;
  if (shift) {
    for (const c of plan.cells) {
      c.t0 = +(c.t0 + shift).toFixed(3);
      c.t1 = +(c.t1 + shift).toFixed(3);
    }
  }
  if (plan.cells.length === 0) {
    return { empty: true, probe, scan, reason: scan.degraded ?? 'no cells' };
  }

  const only = Array.isArray(opts.cellRange) && opts.cellRange.length >= 2
    ? { from: Math.max(1, Math.round(opts.cellRange[0])), to: Math.round(opts.cellRange[1]) }
    : null;
  const listed = only
    ? plan.cells.filter((c) => c.index >= only.from && c.index <= only.to)
    : plan.cells;

  const grid = planGrid(plan.cells.length, aspect, { pixels: sheetPixelsFor(plan.cells.length, detail) });
  mark('plan');

  const base = {
    name: source.meta ? sourceTitle(source.meta) : basename(input),
    probe: { ...probe, width: upright.width, height: upright.height },
    scan, plan, audio, transcript,
    asrNote: asrNote ?? undefined,
  };

  // ---- 5. textOnly: skip every pixel, keep every timestamp
  if (opts.textOnly) {
    const manifest = formatManifest({ ...base, sheet: null, only: listed.map((c) => c.index) });
    return {
      empty: false, textOnly: true, png: null,
      sheet: { grid, cells: plan.cells.length },
      manifest: `${shotHeader(scan, plan, start, window)}\n${manifest.text}`,
      scan, plan, probe, audio, transcript, fromCache,
      timings: { ...t, total: Date.now() - started },
    };
  }

  // ---- 6. decode the chosen frames
  const extraction = await extractCells({
    input, ffmpegPath, cells: plan.cells,
    cellW: grid.cellW, cellH: grid.cellH, signal: opts.signal,
  });
  mark('decode');

  // ---- 7. draw and encode
  const band = opts.band ?? (detail !== 'low' && audio?.envelope?.length > 0);
  const sheetPixels = composeSheet({
    grid,
    cells: plan.cells.map((c) => {
      const f = extraction.frames.get(c.index);
      return { index: c.index, frame: f?.data, width: f?.width, height: f?.height, dupOf: c.dupOf };
    }),
    audio: band
      ? {
        envelope: audio.envelope,
        speech: audio.speech ?? [],
        cuts: scan.cuts ?? [],
        t0: 0,
        t1: (audio.envelope.length / audio.binsPerSecond) || window,
      }
      : null,
  });
  const png = encodePng(sheetPixels.data, sheetPixels.width, sheetPixels.height);
  mark('draw');

  const manifest = formatManifest({
    ...base,
    sheet: { pages: [{ grid }] },
    only: only ? listed.map((c) => c.index) : null,
  });

  return {
    empty: false,
    png,
    sheet: { grid, width: sheetPixels.width, height: sheetPixels.height, bytes: png.length },
    manifest: manifest.text,
    truncated: manifest.truncated,
    scan, plan, probe, audio, transcript, extraction, fromCache,
    readability: cellReadability(grid.cellW, grid.cellH, upright.height),
    timings: { ...t, total: Date.now() - started },
    visionTokens: estimateVisionTokens(sheetPixels.width, sheetPixels.height),
  };
}

/** A one-line "where am I in the film" header for text-only pages. */
function shotHeader(scan, plan, start, window) {
  const s = scan.summary ?? {};
  return `${plan.cells.length} cells · ${s.shots ?? 0} shots over ${timecode(start)}-${timecode(start + window)} · median shot ${(s.medianShot ?? 0).toFixed(2)}s`;
}

/* ------------------------------------------------------------------- zoom */

/** Zoom: one window, few cells, everything bigger. */
export async function runZoom(opts) {
  const started = Date.now();
  const ffmpegPath = opts.ffmpegPath ?? await findFfmpeg();
  if (!ffmpegPath) throw new Error('ffmpeg not found — set DSH_FFMPEG_PATH or install ffmpeg');
  const ffprobePath = opts.ffprobePath ?? await findFfprobe();
  const source = await resolveSource(opts.input, { ffmpegPath, signal: opts.signal, log: opts.log });
  const input = source.path;
  const probe = await probeVideo(input, { ffmpegPath, ffprobePath });
  const dur = probe.duration || 0;
  const start = clamp(Number(opts.start) || 0, 0, Math.max(0, dur - 0.1));
  const endAsked = Number(opts.end);
  const end = Number.isFinite(endAsked) && endAsked > start
    ? clamp(endAsked, start + 0.2, dur)
    : (Number(opts.duration) > 0 ? Math.min(dur, start + Number(opts.duration)) : Math.min(dur, start + 20));
  const window = Math.max(0.2, end - start);
  const aspect = displayAspect(probe.coded.width, probe.coded.height, probe.sar, probe.rotation);
  const uprightH = uprightSize(probe.coded.width, probe.coded.height, probe.rotation).height;
  const wanted = clamp(Math.round(Number(opts.cells) || 3), 1, 9);
  const pixels = sheetPixelsFor(wanted, 'ultra');
  let grid;
  let scan = null;
  let frames;

  if (wanted === 1) {
    grid = planGrid(1, aspect, { pixels });
    const at = opts.at != null ? clamp(Number(opts.at), start, start + window) : start + window / 2;
    const f = await extractFrame({
      input, ffmpegPath, t: at, width: grid.cellW, height: grid.cellH, signal: opts.signal,
    });
    frames = [{ index: 1, at, t0: null, t1: null, data: f.data, width: grid.cellW, height: grid.cellH }];
  } else {
    const key = `${await identityOf(input)}|${start.toFixed(2)}|${window.toFixed(2)}|zoom`;
    const cached = cacheGet(key);
    scan = cached?.scan ?? await scanShots({
      input, ffmpegPath, fps: probe.fps || 25, aspect,
      start, duration: window, signal: opts.signal, fullRate: true,
    });
    if (!cached) cacheSet(key, { scan, audio: { hasAudio: false }, start, window, at: Date.now() });
    // A zoom is not a storyboard: it means "show me N moments of this window",
    // so the window is cut into N equal slices and each slice contributes its
    // sharpest frame. Semantic planning would happily answer with one cell for
    // a single-shot window, which defeats the purpose.
    const effFps = scan.effFps || probe.fps || 25;
    const slice = window / wanted;
    const last = Math.max(0, scan.frames - 1);
    const use = [];
    for (let k = 0; k < wanted; k += 1) {
      const rel0 = slice * k;
      const rel1 = Math.min(window, rel0 + slice);
      const i0 = clamp(Math.round(rel0 * effFps), 0, last);
      const i1 = clamp(Math.round(rel1 * effFps) - 1, i0, last);
      const pick = bestFrameIndex(i0, i1, scan.vectors);
      use.push({
        index: k + 1,
        t0: rel0,
        t1: rel1,
        frameIndex: pick.i,
        frameT: +(start + (pick.i + 0.5) / effFps).toFixed(3),
      });
    }
    grid = planGrid(use.length, aspect, { pixels });
    const ex = await extractCells({
      input, ffmpegPath, cells: use, cellW: grid.cellW, cellH: grid.cellH, signal: opts.signal,
    });
    frames = use.map((c) => {
      const f = ex.frames.get(c.index);
      return {
        index: c.index, at: c.frameT,
        t0: c.t0 == null ? null : start + c.t0,
        t1: c.t1 == null ? null : start + c.t1,
        frame: f?.data, width: f?.width, height: f?.height,
      };
    });
  }

  const sheetPixels = composeSheet({ grid, cells: frames, audio: null });
  const png = encodePng(sheetPixels.data, sheetPixels.width, sheetPixels.height);

  const lines = [
    `${source.meta ? sourceTitle(source.meta) : basename(input)} · window ${timecode(start)}-${timecode(start + window)} · ${grid.cols}x${grid.rows} ${grid.cellW}x${grid.cellH}${scan ? ` · ${scan.summary.shots} shots` : ''}`,
    'cols: cell · frame@ · span',
  ];
  for (const f of frames) {
    lines.push(`${f.index} @${timecode(f.at)}${f.t0 != null ? ` ${timecode(f.t0)}-${timecode(f.t1)}` : ''}`);
  }

  return {
    png,
    sheet: { grid, width: sheetPixels.width, height: sheetPixels.height, bytes: png.length },
    manifest: lines.join('\n'),
    probe,
    readability: cellReadability(grid.cellW, grid.cellH, uprightH),
    timings: { total: Date.now() - started },
    visionTokens: estimateVisionTokens(sheetPixels.width, sheetPixels.height),
  };
}

/* ------------------------------------------------------------------ probe */

/** Metadata plus a reading plan. No decode, no image. */
export async function runProbe(opts) {
  const started = Date.now();
  if (isBilibili(opts.input)) return await probeBilibili(opts.input, started);
  const ffmpegPath = opts.ffmpegPath ?? await findFfmpeg();
  const ffprobePath = opts.ffprobePath ?? await findFfprobe();
  if (!ffmpegPath && !ffprobePath) throw new Error('no ffmpeg and no ffprobe found');
  const probe = await probeVideo(opts.input, { ffmpegPath, ffprobePath });
  const upright = uprightSize(probe.coded.width, probe.coded.height, probe.rotation);
  const plan = suggestDetail({
    duration: probe.duration,
    aspect: probe.aspect || (upright.width / upright.height),
    hasAudio: probe.hasAudio,
    hasSubtitle: probe.hasSubtitle,
  });

  const lines = [
    `${basename(opts.input)} · ${timecode(probe.duration, { hours: true })} · ${upright.width}x${upright.height} · ${Math.round(probe.fps)}fps · ${probe.videoCodec}`,
  ];
  const bits = [];
  if (probe.rotation) bits.push(`rotation ${probe.rotation}°`);
  if (probe.bitrate) bits.push(`${(probe.bitrate / 1e6).toFixed(1)} Mbps`);
  bits.push(probe.hasAudio ? `audio ${probe.audioCodec ?? 'yes'}` : 'no audio');
  if (probe.hasSubtitle) bits.push('subtitle track present');
  lines.push(bits.join(' · '));
  lines.push(`plan: ${plan.detail} detail · ${plan.cells} cells · ~${plan.tokens} vision tokens · ${plan.windows} call${plan.windows > 1 ? 's' : ''}`);
  if (plan.note) lines.push(plan.note);
  lines.push(`elapsed ${Date.now() - started}ms`);

  return { text: lines.join('\n'), probe, plan };
}

/**
 * What a B站 link is, before any byte of video is fetched: title, part, length,
 * the quality we are allowed to download, and whether there is a subtitle track
 * to quote from. Costs three HTTP calls and no decode, so the model can decide
 * what to do next with a link in under a second.
 */
async function probeBilibili(rawInput, started) {
  const meta = await bilibiliView(rawInput);
  let play = null;
  try {
    play = await bilibiliPlay(meta);
  } catch (error) {
    play = { error: String(error?.message ?? error) };
  }
  const subs = meta.cid ? await bilibiliSubtitles(meta) : { cues: [], available: [], language: null };
  const subtitleLabel = subs.cues.length
    ? `${subs.cues.length} 条${subs.language ? `（${subs.language}）` : ''}`
    : (subs.available.length ? `未下载（可用 ${subs.available.join(' / ')}）` : '不可用');
  const plan = suggestDetail({
    duration: meta.duration,
    aspect: 16 / 9,
    hasAudio: true,
    hasSubtitle: subs.cues.length > 0,
  });
  const lines = [
    describeBilibili(meta, {
      qualityLabel: play?.label ? `${play.label}${play.size ? ` · ${(play.size / 1048576).toFixed(1)} MB` : ''}` : null,
      subtitles: subtitleLabel,
    }),
  ];
  if (play?.error) lines.push(`playurl: ${play.error}`);
  lines.push(`plan: ${plan.detail} detail · ${plan.cells} cells · ~${plan.tokens} vision tokens · ${plan.windows} call${plan.windows > 1 ? 's' : ''}`);
  if (plan.note) lines.push(plan.note);
  lines.push('next: video_storyboard (one sheet) · video_read (text of every screen) · video_zoom (one window, bigger)');
  lines.push(`elapsed ${Date.now() - started}ms`);
  return {
    text: lines.join('\n'),
    probe: {
      path: meta.url,
      duration: meta.duration,
      bvid: meta.bvid,
      page: meta.page,
      pages: meta.pages,
      title: meta.title,
      quality: play?.quality ?? null,
    },
    plan,
  };
}

/* ------------------------------------------------------------------ utils */

/**
 * Vision tokens for an image, mirroring the host's accounting: 42 px cells
 * (14 px patch, 3x downsample), a 544x544 minimum, and a 1024-token cap.
 * Used to report cost and to keep the sheet inside the cap.
 */
export function estimateVisionTokens(width, height) {
  const PATCH = 14;
  const CELL = PATCH * 3;
  const MIN_PIXELS = 544 * 544;
  const MAX_TOKENS = 1024;
  let w = width;
  let h = height;
  const px = w * h;
  if (px > 0 && px < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / px);
    w = Math.trunc(w * scale);
    h = Math.trunc(h * scale);
  }
  const gw = Math.ceil(Math.ceil(w / PATCH) * PATCH / CELL);
  const gh = Math.ceil(Math.ceil(h / PATCH) * PATCH / CELL);
  const tokens = gh * (gw + 1) + 2;
  return tokens > MAX_TOKENS ? MAX_TOKENS : tokens;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function basename(p) {
  const s = String(p ?? '');
  const clean = s.split(/[?#]/)[0];
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

export { MAX_CELLS_HARD };
