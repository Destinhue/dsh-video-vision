/**
 * Read a video as text.
 *
 * Rationale: a talking-head lecture, a slide deck, a screen recording or a
 * coding session carries its information as *text on the picture*. For a model
 * that has to then write notes, a summary or an exam set, a timestamped text
 * document is worth far more per token than a contact sheet: the sheet is capped
 * at 1024 vision tokens (unreadable at that size), whereas two hours of slides
 * is roughly 20k characters.
 *
 * The pipeline, cheapest first:
 *   1. decode ONLY keyframes (`-skip_frame nokey`, ~6x cheaper than full decode)
 *      into a 96x54 luma grid, keeping their presentation timestamps;
 *   2. cluster the keyframes by picture change, so a slide that is re-shown is
 *      not OCR'd again;
 *   3. extract the slide area of each cluster representative at full resolution
 *      (one seek per representative, cheap);
 *   4. OCR the batch in one process;
 *   5. clean the text, drop UI chrome, merge near-identical screens, emit a
 *      timestamped document.
 *
 * Everything except `runRead` is a pure function so it can be tested without
 * ffmpeg or an OCR engine.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ocrBackend, ocrDirectory } from './ocr.js';
import { isBilibili, bilibiliFile, bilibiliStream, biliStreamMode, biliStreamLimit, bilibiliView } from './bili.js';
import { probeVideo, netInputArgs, fpsModeArgs, altFpsModeArgs, run } from './media.js';
import { extractSubtitles } from './timeline.js';
import { extractCells } from './frames.js';
import { composeSheet } from './sheet.js';
import { encodePng } from './png.js';
import { planGrid, sheetPixelsFor } from './layout.js';
import { loadTranscriptFile } from './transcript.js';
import { asrAvailable, asrCues } from './asr.js';

export const READ_DEFAULTS = {
  gridWidth: 96,
  gridHeight: 54,
  // share of the 12x7 block grid that must move for two keyframes to count as
  // different screens; a slide that is re-shown moves nothing
  screenChange: 0.055,
  // sampling on the clock (short clips) already guarantees the pictures differ
  // in time, so the gate only has to reject literally identical frames: a
  // 4-line subtitle strip is 2% of the frame and used to be dropped here
  denseChange: 0.004,
  // how much of a pair of screens must share text bigrams to be the same screen
  textSimilarity: 0.55,
  maxScreens: 400,
  // trim only the recorder's top bar, keep the full width and the bottom edge:
  // a slide that starts near the left edge loses its first character under a
  // left crop, and burned-in subtitles live in the last 5% of the frame
  crop: { x: 0.02, y: 0.115, w: 0.96, h: 0.885 },
  // below this length the picture changes faster than the keyframe interval, so
  // sampling follows the clock instead: a 95 s clip has ~20 keyframes but ~80
  // subtitle lines
  denseSeconds: 1.2,
  denseUnder: 900,
  grabWorkers: 8,
  settle: 0.35,
};

/**
 * Say out loud when the reader stopped early.
 *
 * A document that stops at screen 400 reads exactly like a video that only had
 * 400 screens, so the cap and the request it trimmed are both named.
 */
export function capNotes({ askedScreens = 0, maxScreens = READ_DEFAULTS.maxScreens, changed = 0 } = {}) {
  const notes = [];
  if (changed > maxScreens) {
    notes.push(`capped at ${maxScreens} of ${changed} changed frames — raise maxScreens, or read a window`);
  }
  if (askedScreens > READ_DEFAULTS.maxScreens) {
    notes.push(`maxScreens ${askedScreens} capped at ${READ_DEFAULTS.maxScreens}`);
  }
  return notes;
}

export const FALLBACK_CELLS = 6;

/**
 * Where to sample when the file carries no readable text.
 *
 * A keyframe that was already decoded is the cheapest evidence — it is known to
 * exist and it is where the picture changed — so the stamps are preferred when
 * there are enough of them. Otherwise the window is divided evenly, which lands
 * on ordinary frames but never on the very first or last one.
 *
 * @param {object} p
 * @param {number} [p.start]
 * @param {number} [p.end]     known end of the window (0 = unknown)
 * @param {number[]} [p.stamps] presentation times the scan already decoded
 * @param {number} [p.count]
 * @returns {Array<{index:number, frameT:number}>}
 */
export function fallbackTimes({ start = 0, end = 0, stamps = [], count = FALLBACK_CELLS } = {}) {
  const n = Math.max(1, Math.round(count));
  const usable = Array.isArray(stamps) ? stamps.filter((s) => Number.isFinite(s) && s >= 0) : [];
  if (usable.length >= n) {
    const cells = [];
    for (let i = 0; i < n; i++) {
      const s = usable[Math.round((i * (usable.length - 1)) / Math.max(1, n - 1))];
      cells.push({ index: i + 1, frameT: Math.max(0, start + s) });
    }
    return cells;
  }
  const last = usable.length ? Math.max(...usable) + 1 : 0;
  const stop = end > start ? end : start + (last || 1);
  const span = Math.max(0, stop - start);
  if (span <= 0) return [{ index: 1, frameT: Math.max(0, start) }];
  const cells = [];
  for (let i = 0; i < n; i++) {
    // the centre of each equal slice: a window shorter than the count still
    // samples distinct moments, and no cell sits on the boundary frame
    cells.push({ index: i + 1, frameT: Math.max(0, start + ((i + 0.5) / n) * span) });
  }
  return cells;
}

/**
 * A small contact sheet for a video that had no text to quote.
 *
 * Handwriting, a camera pointed at a screen and a whiteboard with no heading all
 * reach OCR as loose strokes. An empty document makes the caller spend a second
 * round trip to discover that the picture itself is the evidence, so a few
 * frames are decoded here and attached to the same answer.
 *
 * @param {object} p
 * @returns {Promise<{png:Buffer, grid:object, cells:Array<{index:number, frameT:number}>} | null>}
 */
export async function pictureFallback({
  input, ffmpegPath, start = 0, end = 0, stamps = [], aspect = 16 / 9, signal, count = FALLBACK_CELLS,
}) {
  const cells = fallbackTimes({ start, end, stamps, count });
  const grid = planGrid(cells.length, aspect, { pixels: sheetPixelsFor(cells.length, 'auto') });
  const extraction = await extractCells({
    input, ffmpegPath, cells, cellW: grid.cellW, cellH: grid.cellH, signal, oversample: 1, measure: false,
  });
  const kept = cells.filter((c) => extraction.frames.has(c.index));
  if (!kept.length) return null;
  const pixels = composeSheet({
    grid,
    cells: kept.map((c) => {
      const f = extraction.frames.get(c.index);
      return { index: c.index, frame: f.data, width: f.width, height: f.height };
    }),
  });
  const png = encodePng(pixels.data, pixels.width, pixels.height);
  return { png, grid, cells: kept };
}

/** strings that belong to the recorder or the meeting app, not the lecture */
const CHROME = [
  '您正在共享屏幕', '停止共享', '共享设备音频', '说点什么', '录制中', '屏幕共享',
  '腾讯会议', '钉钉', '会议结束后', '个人中心', '我的录制', '成员限制', '入会',
  'cooanotes', 'ooanotes', 'goodnotes', '会议设置', '麦克风浮窗', '讲义 ·',
];

/**
 * OCR output arrives with a space between every CJK character and stray marks
 * from icons. Put the prose back together; leave latin words alone.
 * @param {string} raw
 */
export function cleanOcr(raw) {
  if (!raw) return '';
  let text = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  // space between two CJK characters is never meaningful
  text = text.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
  text = text.replace(/([\u3400-\u9fff])\s+(?=[，。、；：？！）】”’])/g, '$1');
  text = text.replace(/([（【“‘])\s+(?=[\u3400-\u9fff])/g, '$1');
  // icon debris: a short run of numbers/symbols in front of Chinese prose
  text = stripLeadingJunk(text);
  return text.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Screen recordings put the toolbar's residue at the top of the crop, so OCR
 * often returns `00 00 囗 山 夕 例题 4 …`. Drop that prefix, but never a prefix
 * that could be real language (`Note:`, `Step 2`, `a)`).
 */
function stripLeadingJunk(text) {
  const m = text.match(/^([^\u3400-\u9fff]{1,40})(?=[\u3400-\u9fff])/);
  if (!m) return text;
  const junk = m[1];
  if (/[A-Za-z]{3,}/.test(junk)) return text;
  if (/\d[.,]\d/.test(junk)) return text;
  return text.slice(m[0].length);
}

/**
 * Is this screen mostly the recorder's own UI rather than content?
 * @param {string} text cleaned text
 */
export function isChrome(text) {
  const bare = (text || '').replace(/\s+/g, '');
  if (!bare) return true;
  if (bare.length < 4) return true;
  const han = (bare.match(/\p{Script=Han}/gu) || []).length;
  if (han + (bare.match(/\p{L}/gu) || []).length < 4) return true;
  if (isChatter(text)) return true;
  const lowered = bare.toLowerCase();
  for (const phrase of CHROME) {
    if (lowered.includes(phrase.toLowerCase())) return true;
  }
  return false;
}

export function isChatter(text) {
  const lines = text.split('\n').map((l) => l.replace(/[\s·.。,，、:：;；!！?？'"()（）[\]【】<>-]/g, '')).filter(Boolean);
  if (lines.length < 6) return false;
  const tiny = lines.filter((l) => l.length <= 3).length;
  return tiny / lines.length > 0.45;
}

/**
 * Text of one recognised screen, minus the window furniture. A tab strip or a
 * title bar is a SHORT line near the TOP edge; a status bar is short and at the
 * bottom. Both rules are geometric, so they hold for any app the user recorded.
 * @param {{text:string, lines:{text:string,x0:number,y0:number,x1:number,y1:number}[], width:number, height:number}} rec
 */
export function screenLines(rec) {
  if (!rec) return [];
  const H = rec.height || 0;
  const W = rec.width || 0;
  const kept = [];
  for (const line of rec.lines ?? []) {
    const bare = line.text.replace(/\s+/g, '');
    if (bare.length < 3) continue;
    const wide = W ? (line.x1 - line.x0) / W : 1;
    const top = H ? line.y1 / H : 1;
    const bottom = H ? line.y0 / H : 0;
    if (top < 0.13 && wide < 0.55) continue;
    if (bottom > 0.94 && wide < 0.35) continue;
    kept.push(line.text);
  }
  return kept;
}

/**
 * Text of one recognised screen, minus the window furniture. A tab strip or a
 * title bar is a SHORT line near the TOP edge; a status bar is short and at the
 * bottom. Both rules are geometric, so they hold for any app the user recorded.
 * @param {{text:string, lines:{text:string,x0:number,y0:number,x1:number,y1:number}[], width:number, height:number}} rec
 */
export function screenText(rec) {
  return cleanOcr(screenLines(rec).join(String.fromCharCode(10)));
}

/** how many characters of actual content a string carries */
export function contentChars(text) {
  if (!text) return 0;
  const m = text.match(/[\p{Script=Han}\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

/**
 * Characters that read as language: Han ideographs plus latin runs of three or
 * more letters. Single letters and lone digits are what a handwritten page and
 * an icon both degrade into ("h < m", "z-r"), so they do not count here.
 */
export function wordChars(text) {
  if (!text) return 0;
  let n = 0;
  for (const ch of text) if (/\p{Script=Han}/u.test(ch)) n += 1;
  for (const run of text.match(/[A-Za-z]{3,}/g) || []) n += run.length;
  return n;
}

/** punctuation that only appears in prose, formulas and example numbering */
const PROSE_MARKS = /[，。：；、！？（）()《》〈〉「」【】,.?!:;=+\-\u00d7\u00f7<>\[\]{}]/u;

/**
 * True when a screen's lines carry enough real text to be worth quoting.
 *
 * The hard case is handwriting: a page of scribbled formulas reaches OCR as
 * strings of unrelated characters ("亿天小釒一 0 立去千凸到") that are eight to ten
 * characters long and therefore look like text. What separates invented
 * characters from read ones is shape, not length -- real text arrives with
 * punctuation, decimal points, brackets or an "=" in it.
 *
 * @param {string[]} lines
 */
export function readableScreen(lines) {
  if (!lines || !lines.length) return false;
  let total = 0;
  for (const line of lines) {
    const words = wordChars(line);
    total += words;
    if (words >= 12) return true;
    if (words >= 8 && PROSE_MARKS.test(line)) return true;
  }
  // a bulleted page can be many short lines that only add up together
  return total >= 24;
}

/** the shape a line has to keep to count as "the same line" across screens */
function lineKey(text) {
  return text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '').slice(0, 24);
}

/**
 * The same key with the digits gone. A recorder's clock reads 11:24 on one
 * frame and 11:36 on the next, so an exact key never repeats; a lecture's
 * "例题 1" would also collapse into "例题", which is why this looser key is only
 * allowed to delete SHORT lines that appear on nearly every screen.
 */
function fuzzyKey(text) {
  return text.replace(/[^\p{Script=Han}\p{L}]/gu, '').slice(0, 24);
}

/**
 * Drop the lines the recording tool paints on every single frame.
 *
 * A hard-coded list of app names cannot cover every recorder in the world, and
 * a lecture's own title is often what such a list would eat. Frequency is the
 * honest test: a line that appears on most screens is furniture, a line that
 * appears on one screen is content.
 *
 * @param {{t:number, lines:string[]}[]} screens in time order
 * @param {{share?: number}} [opts]
 */
export function dropBoilerplate(screens, opts = {}) {
  const share = opts.share ?? 0.5;
  if (screens.length < 3) return { screens, dropped: [] };
  const seen = new Map();
  for (const s of screens) {
    const uniq = new Set();
    for (const line of s.lines) {
      const k = lineKey(line);
      if (k) uniq.add(k);
    }
    for (const k of uniq) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const floor = Math.max(3, Math.ceil(screens.length * share));

  // second tier: a clock or a page counter changes every frame, so match it
  // with the digits removed, but only for SHORT lines and only when they are
  // almost everywhere -- otherwise "例题 1" and "例题 2" would vanish together
  const fuzzyFloor = Math.max(4, Math.ceil(screens.length * 0.8));
  const fuzzy = new Map();
  for (const s of screens) {
    const uniq = new Set();
    for (const line of s.lines) {
      if (lineKey(line).length > 16) continue;
      const k = fuzzyKey(line);
      if (k.length >= 2) uniq.add(k);
    }
    for (const k of uniq) fuzzy.set(k, (fuzzy.get(k) ?? 0) + 1);
  }
  const furnitureFuzzy = new Set();
  for (const [k, n] of fuzzy) if (n >= fuzzyFloor) furnitureFuzzy.add(k);

  const furniture = new Set();
  for (const [k, n] of seen) if (n >= floor) furniture.add(k);
  const isFurniture = (line) => furniture.has(lineKey(line))
    || (lineKey(line).length <= 16 && furnitureFuzzy.has(fuzzyKey(line)));
  const out = screens.map((s) => ({ ...s, lines: s.lines.filter((line) => !isFurniture(line)) }));
  return { screens: out, dropped: [...furniture].concat([...furnitureFuzzy]) };
}

/** character bigram set, ignoring punctuation and whitespace */
function bigrams(text) {
  const bare = text.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
  const set = new Set();
  for (let i = 0; i < bare.length - 1; i++) set.add(bare.slice(i, i + 2));
  return set;
}

/** Jaccard similarity of two strings by character bigrams */
export function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * Collapse screens that say the same thing. OCR noise makes exact matching
 * useless, so this is a similarity test, and the longest text of a run wins.
 *
 * @param {{t:number,text:string}[]} screens in time order
 * @param {{similarity?: number}} [opts]
 */
export function mergeScreens(screens, opts = {}) {
  const threshold = opts.similarity ?? READ_DEFAULTS.textSimilarity;
  const novelLine = Boolean(opts.novelLine);
  const out = [];
  for (const s of screens) {
    const prev = out[out.length - 1];
    // A fixed layout whose only change is the subtitle line has near-identical
    // text, so similarity alone would merge it away and the reader would quote
    // one line of a four-line clip. In dense mode, a screen that contributes a
    // line the previous one does not have is a new screen, not a duplicate.
    const adds = novelLine && prev ? novelLines(prev.lines, s.lines) : 0;
    if (prev && adds === 0 && textSimilarity(prev.text, s.text) >= threshold) {
      prev.tEnd = s.t;
      if (s.text.length > prev.text.length) prev.text = s.text;
      continue;
    }
    out.push({ t: s.t, tEnd: s.t, text: s.text, lines: s.lines });
  }
  for (let i = 0; i < out.length - 1; i++) out[i].tEnd = out[i + 1].t;
  if (out.length) out[out.length - 1].tEnd = out[out.length - 1].t;
  return out;
}

/** how many lines of `next` say something the previous screen did not */
function novelLines(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return 0;
  let n = 0;
  for (const line of next) {
    if (wordChars(line) < 6) continue;
    let seen = false;
    for (const old of prev) {
      if (textSimilarity(old, line) >= 0.72) { seen = true; break; }
    }
    if (!seen) n += 1;
  }
  return n;
}

/**
 * Is there enough readable text to be worth quoting?
 *
 * Three screens was the old rule and it was wrong twice over: a 25 s clip can
 * honestly hold four subtitle lines, and a handwritten page can produce three
 * fragments of noise. Content, not count, is the test.
 */
export function usableScreens(screens, { minScreens = 3, minChars = 40 } = {}) {
  const chars = screens.reduce((n, s) => n + contentChars(s.text), 0);
  const enough = screens.length >= minScreens || chars >= minChars;
  return { usable: enough ? screens : [], chars };
}

/** headings worth pulling out so the document can be skimmed */
export function outline(screens) {
  const lines = [];
  let last = null;
  for (const s of screens) {
    let head = null;
    const example = s.text.replace(/\s+/g, '').match(/例题(\d+)/);
    const section = s.text.replace(/\s+/g, '').match(/(\d)\.(\d)(?![0-9])/);
    if (example) head = `例题${example[1]}`;
    else if (section) head = `${section[1]}.${section[2]}`;
    if (!head || head === last) continue;
    last = head;
    lines.push({ t: s.t, head });
  }
  return lines;
}

const tc = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

/** average luma of each 12x7 block of a 96x54 rgb24 frame */
function blockMeans(buf, w, h, bw = 12, bh = 7) {
  const out = new Int16Array(bw * bh);
  const cw = w / bw;
  const ch = h / bh;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(by * ch); y < Math.floor((by + 1) * ch); y++) {
        for (let x = Math.floor(bx * cw); x < Math.floor((bx + 1) * cw); x++) {
          const i = (y * w + x) * 3;
          sum += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
          n += 1;
        }
      }
      out[by * bw + bx] = n ? sum / n : 0;
    }
  }
  return out;
}

/** share of the grid that moved, skipping blocks that are black in both */
export function gridChange(a, b, delta = 10, dark = 12) {
  let active = 0;
  let moved = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < dark && b[i] < dark) continue;
    active += 1;
    if (Math.abs(a[i] - b[i]) > delta) moved += 1;
  }
  return active ? moved / active : 0;
}

/**
 * Decode keyframes (or, on a short clip, one frame every `dense` seconds) into
 * 96x54 block grids with their presentation timestamps.
 *
 * The fps flag is chosen per binary and retried with the other spelling, because
 * ffmpeg 8 removed `-vsync` while older builds reject `-fps_mode`.
 */
async function decodeKeyframes(ffmpegPath, input, { start = 0, end = 0, signal, dense = 0 } = {}) {
  const { gridWidth: w, gridHeight: h } = READ_DEFAULTS;
  const base = ['-hide_banner', '-nostdin'];
  if (!dense) base.push('-skip_frame', 'nokey');
  if (start) base.push('-ss', String(start));
  base.push(...netInputArgs(input), '-i', input);
  if (end) base.push('-t', String(end - start));
  const pre = dense ? `fps=1/${dense},` : '';
  const tail = ['-vf', `${pre}scale=${w}:${h}:flags=fast_bilinear,showinfo,format=rgb24`, '-f', 'rawvideo', '-'];

  const attempt = (fpsArgs) => new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [...base, ...fpsArgs, ...tail], {
      stdio: ['ignore', 'pipe', 'pipe'], signal,
    });
    const grids = [];
    let buf = Buffer.alloc(0);
    let err = '';
    const size = w * h * 3;
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= size) {
        grids.push(blockMeans(buf.subarray(0, size), w, h));
        buf = buf.subarray(size);
      }
    });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !grids.length) {
        reject(new Error(`keyframe decode failed (${code}): ${err.slice(-300)}`));
        return;
      }
      const stamps = [];
      for (const m of err.matchAll(/pts_time:([0-9.]+)/g)) stamps.push(Number(m[1]));
      resolve({ grids, stamps, err });
    });
  });

  let fpsArgs = await fpsModeArgs(ffmpegPath);
  try {
    const out = await attempt(fpsArgs);
    return { grids: out.grids, stamps: out.stamps, fpsMode: fpsArgs[0] };
  } catch (error) {
    if (!/Unrecognized option/i.test(error.message)) throw error;
    fpsArgs = altFpsModeArgs(fpsArgs);
    const out = await attempt(fpsArgs);
    return { grids: out.grids, stamps: out.stamps, fpsMode: fpsArgs[0] };
  }
}

/**
 * Dense pass: write the sampled frames at slide resolution, in the same order
 * the grid pass saw them.
 *
 * Why this exists: `stamps[i]` names the moment a 96x54 grid was compared, but a
 * seek to `stamps[i]` decodes a slightly different frame -- the `fps` filter
 * hands out the frame at or before the tick, while the seek lands on the tick.
 * On a fixed layout whose only change is a subtitle line those two are different
 * sentences, so a stamp-based grab quoted one screen and skipped the next. The
 * same `fps=1/step` filter over the same input yields the same frames in the
 * same order, so frame N of this pass IS the frame the grid pass measured.
 */
async function extractDenseFrames(ffmpegPath, input, { start = 0, end = 0, step = 1.2, crop, dir, signal } = {}) {
  const cw = Math.max(2, Math.round(crop.w * 1000)) / 1000;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (start) args.push('-ss', String(start));
  args.push(...netInputArgs(input), '-i', input);
  if (end) args.push('-t', String(end - start));
  args.push('-vf', `fps=1/${step},crop=iw*${cw}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`,
    '-q:v', '2', '-y', join(dir, 'd%05d.png'));
  const res = await run(ffmpegPath, args, { signal, timeoutMs: 0 });
  if (res.code !== 0) throw new Error(`dense frame extract failed (${res.code}): ${String(res.stderr).slice(-200)}`);
  return { dir };
}

/* ----------------------------------------------------------------- audio */

/** Ceiling on one audio document; a two-hour talk is ~30k characters. */
export const AUDIO_DOC_MAX_CHARS = 40_000;

/**
 * The document `video_read` returns for a file that has no picture.
 *
 * Pure: the cues are already in hand (a transcript file, the container's
 * subtitle track, or an ASR engine). What this decides is only how they read —
 * a header that states what was quoted and by what, one `[mm:ss–mm:ss] text`
 * line per cue, and a counted note when the document had to be cut. The
 * alternative, returning "no video stream", is true and useless: the speech is
 * still there and is exactly what video_read exists to turn into text.
 */
export function audioDocument({
  title = '', duration = 0, cues = [], quotedBy = null, start = 0, end = 0,
  maxChars = AUDIO_DOC_MAX_CHARS,
} = {}) {
  const from = Math.max(0, Number(start) || 0);
  const asked = Number(end);
  const to = asked > from ? asked : (duration > 0 ? duration : Infinity);
  const inWindow = (cues ?? [])
    .filter((c) => Number.isFinite(c.t0) && Number.isFinite(c.t1) && c.t1 > from && c.t0 < to)
    .sort((a, b) => a.t0 - b.t0);
  const lines = [];
  let chars = 0;
  for (const c of inWindow) {
    const span = c.t1 > c.t0 + 1 ? `${tc(c.t0)}–${tc(c.t1)}` : tc(c.t0);
    const line = `[${span}] ${String(c.text ?? '').replace(/\s+/g, ' ').trim()}`;
    // Cut on a cue boundary, never inside one: a half sentence reads as a
    // transcription error, while a document that stops between two lines does not.
    if (lines.length && chars + line.length + 1 > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const capped = inWindow.length - lines.length;
  const body = [`# ${title || 'audio'} — read as text · audio only · ${inWindow.length} lines · ${tc(duration || 0)}`];
  body.push('note: audio only — there is no picture, so this document quotes the speech, not the screen');
  if (quotedBy) body.push(`note: quoted by ${quotedBy}`);
  if (duration > 0 && (from > 0 || asked > 0)) {
    body.push(`note: window ${tc(from)}–${tc(Math.min(to, duration))} of ${tc(duration)}`);
  }
  if (!inWindow.length) body.push('', 'note: no speech was found in this window');
  if (capped > 0) {
    body.push('', `note: capped at ${lines.length} of ${inWindow.length} lines (${chars} characters) — `
      + 'read a window for the rest');
  }
  body.push('');
  for (const line of lines) body.push(line);
  body.push('');
  const text = body.join('\n');
  return { text, lines: lines.length, cues: inWindow.length, capped: capped > 0 ? capped : 0 };
}

/**
 * Read a file that carries sound and no picture: transcript file first, then the
 * container's subtitle track, then the configured ASR engine. Whichever wins,
 * the result is the same shape as a screen read, so callers do not branch.
 */
async function readAudio({ input, source, meta, start, end, signal, sourceTitle, opts }) {
  const duration = meta.duration || 0;
  const title = sourceTitle || input.split(/[\\/]/).pop();
  const from = Math.max(0, Number(start) || 0);
  const asked = Number(end);
  const to = asked > from ? asked : 0;
  const codec = meta.audioCodec ? ` · ${meta.audioCodec}` : '';
  // Tests inject an empty env to pin the "no engine configured" path; the tool
  // never passes one, so this is process.env in production.
  const env = opts.env;
  let cues = [];
  let quotedBy = null;
  if (opts.transcriptFile) {
    const loaded = loadTranscriptFile(opts.transcriptFile);
    cues = loaded.cues;
    quotedBy = `the transcript file you passed (${loaded.source})`;
  }
  if (!cues.length) {
    const subs = await extractSubtitles({ input: source, ffmpegPath: opts.ffmpegPath, signal, run, probe: meta });
    if (subs.cues.length) { cues = subs.cues; quotedBy = 'the subtitle track in the container'; }
  }
  if (!cues.length) {
    if (!asrAvailable(env)) {
      throw new Error(`no picture and no text: "${input}" is audio only (${tc(duration)}${codec}) and there is no `
        + 'transcript — set DSH_ASR_CMD (or write ~/.dsh/asr.json {"cmd": "..."}) to transcribe it, or pass transcriptFile');
    }
    const asr = await asrCues({
      ffmpegPath: opts.ffmpegPath, input: source, start: from, end: to || null,
      duration: duration || null, signal, env,
    });
    if (!asr.cues.length) {
      throw new Error(`audio only, and transcription returned nothing${asr.reason ? ` (${asr.reason})` : ''} — "${input}"`);
    }
    cues = asr.cues;
    const pieces = asr.chunked && asr.chunks > 1 ? `, ${asr.chunks} chunks cut on silence` : '';
    quotedBy = asr.engine ? `speech recognition (${asr.engine}${pieces})` : 'speech recognition';
  }
  const doc = audioDocument({ title, duration, cues, quotedBy, start: from, end: to });
  const written = withExport(doc.text, cues, opts.out, {
    empty: 'nothing to write — no speech was found in this window',
  });
  return {
    text: written.text,
    screens: [],
    outline: [],
    cues,
    wrote: written.wrote,
    stats: {
      audio: true,
      lines: doc.lines,
      cues: doc.cues,
      capped: doc.capped,
      chars: written.text.length,
      duration,
      audioCodec: meta.audioCodec ?? null,
      quotedBy,
    },
    timings: {},
    audio: true,
  };
}

/**
 * Read a video as a timestamped text document.
 *
 * @param {{input:string, ffmpegPath:string, start?:number, end?:number,
 *          signal?:AbortSignal, maxScreens?:number,
 *          crop?:{x:number,y:number,w:number,h:number}}} opts
 */

/* --------------------------------------------------------------- export out */

/** `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT) from seconds. */
function stamp(seconds, sep = ',') {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}${sep}${pad(ms, 3)}`;
}

/** One `[mm:ss] text` line per screen or cue — the shape a chat window reads. */
export function transcriptLines(items) {
  const out = [];
  for (const it of items ?? []) {
    const text = String(it.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t = it.t ?? it.t0 ?? 0;
    out.push(`[${tc(t)}] ${text}`);
  }
  return out;
}

/** Subtitle file body. `vtt` keeps the same cues with a WebVTT header. */
export function subtitleFile(items, { format = 'srt' } = {}) {
  const sep = format === 'vtt' ? '.' : ',';
  const blocks = [];
  let n = 0;
  for (const it of items ?? []) {
    const text = String(it.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const t0 = Number(it.t ?? it.t0 ?? 0) || 0;
    // A cue with no end would produce an empty subtitle: give it two seconds.
    const t1 = Math.max(t0 + 0.2, Number(it.tEnd ?? it.t1 ?? 0) || t0 + 2);
    n += 1;
    blocks.push(`${n}\n${stamp(t0, sep)} --> ${stamp(t1, sep)}\n${text}`);
  }
  if (format === 'vtt') return `WEBVTT\n\n${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
  return `${blocks.join('\n\n')}${blocks.length ? '\n' : ''}`;
}

/**
 * Write the read result where the caller asked for it.
 *
 * The document in the reply is for the model; a file is for the person who asked
 * for captions, notes or an exam set and now wants to keep them. Extension
 * decides the shape: `.srt` / `.vtt` are subtitles, anything else is one
 * `[mm:ss] text` line per screen.
 */
export function writeReadExport(outPath, items, { format = 'text' } = {}) {
  const target = resolve(String(outPath));
  mkdirSync(dirname(target), { recursive: true });
  const body = format === 'text' ? transcriptLines(items).join('\n') + (items?.length ? '\n' : '')
    : subtitleFile(items, { format });
  writeFileSync(target, body, 'utf8');
  const lines = format === 'text' ? (body ? body.trimEnd().split('\n').length : 0) : (items?.length ?? 0);
  return { path: target, format, lines, bytes: Buffer.byteLength(body, 'utf8') };
}

/** `.srt` and `.vtt` ask for subtitles; every other extension is plain lines. */
export function exportFormat(outPath) {
  const ext = String(outPath ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'srt') return 'srt';
  if (ext === 'vtt') return 'vtt';
  return 'text';
}

/**
 * Append the one line that tells the reader a file was written, and carry the
 * field the tool returns. Same shape for screens and for cues, so a caller that
 * asked for `out` never has to parse the prose to find the path.
 */
function withExport(text, items, out, { empty = 'nothing to write — no text was read from this window' } = {}) {
  if (!out) return { text, wrote: null };
  const target = resolve(String(out));
  if (!items?.length) return { text: `${text.trimEnd()}\n\nnote: ${empty} (not written: ${target})\n`, wrote: null };
  try {
    const wrote = writeReadExport(target, items, { format: exportFormat(target) });
    const what = wrote.format === 'text'
      ? `${wrote.lines} line(s)`
      : `${wrote.lines} cue(s) as ${wrote.format.toUpperCase()}`;
    return { text: `${text.trimEnd()}\n\nnote: wrote ${what} to ${wrote.path}\n`, wrote };
  } catch (error) {
    return {
      text: `${text.trimEnd()}\n\nnote: could not write ${target}: ${error.message}\n`,
      wrote: { path: target, error: error.message },
    };
  }
}

/** The screens of a video read, in the shape the exporter wants. */
export function screensAsItems(screens) {
  return (screens ?? []).map((s) => ({
    t: s.t, tEnd: s.tEnd ?? s.t, text: s.text ?? (Array.isArray(s.lines) ? s.lines.join(' ') : ''),
  }));
}

export async function runRead(opts) {
  const {
    input, ffmpegPath, start = 0, end = 0, signal,
  } = opts;
  const askedScreens = Number(opts.maxScreens) || READ_DEFAULTS.maxScreens;
  const maxScreens = Math.min(askedScreens, READ_DEFAULTS.maxScreens);
  // a B站 link has to become a file first; everything below works on a path
  let source = input;
  let sourceTitle = null;
  if (isBilibili(input)) {
    let streamed = null;
    const mode = biliStreamMode();
    if (mode !== 'off') {
      try {
        const view = await bilibiliView(input, { signal });
        if (mode === 'on' || Number(view.duration || 0) <= biliStreamLimit()) {
          streamed = await bilibiliStream(view, { signal });
        }
      } catch (error) {
        if (opts.log) opts.log(`stream unavailable (${error.message}); downloading instead`);
      }
    }
    if (streamed) {
      source = streamed.url;
      sourceTitle = streamed.meta?.title ?? null;
    } else {
      const file = await bilibiliFile(input, { ffmpegPath, signal, log: opts.log });
      source = file.path;
      sourceTitle = file.meta?.title ?? null;
    }
  }
  const crop = opts.crop ?? READ_DEFAULTS.crop;

  // One probe, before the OCR check: a file with no picture has nothing to OCR,
  // and answering "cannot read text" about it would be wrong — video_read can
  // transcribe it perfectly well once it knows to take the audio path.
  let meta = null;
  try {
    meta = await probeVideo(source, { ffmpegPath, allowAudioOnly: true });
  } catch { meta = null; }
  if (meta && meta.hasVideo === false) {
    const at = Date.now();
    const out = await readAudio({ input, source, meta, start, end, signal, sourceTitle, opts });
    out.timings.total = Date.now() - at;
    return out;
  }

  const backend = ocrBackend();
  if (!backend.ok) throw new Error(`cannot read text: ${backend.reason}`);
  const timings = {};
  const wall = Date.now();

  const t0 = Date.now();
  // a short clip changes faster than its keyframes do, so sample on the clock
  let dense = 0;
  let knownEnd = end || 0;
  if (!end) {
    const span = ((meta?.duration) || 0) - start;
    if (span > 0) knownEnd = start + span;
    if (span > 1 && span <= READ_DEFAULTS.denseUnder) dense = READ_DEFAULTS.denseSeconds;
  }
  const { grids, stamps } = await decodeKeyframes(ffmpegPath, source, { start, end, signal, dense });
  timings.scan = Date.now() - t0;
  timings.dense = dense;

  const picked = [];
  let last = -1;
  for (let i = 0; i < grids.length; i++) {
    const gate = dense ? READ_DEFAULTS.denseChange : READ_DEFAULTS.screenChange;
    if (last < 0 || gridChange(grids[last], grids[i]) >= gate) {
      picked.push(i);
      last = i;
    }
  }
  if (!picked.length) {
    // A window that starts past the end decodes nothing; say which unit is
    // out of range instead of implying the file is broken.
    let dur = meta?.duration || 0;
    if (!dur) {
      try { dur = (await probeVideo(source, { ffmpegPath })).duration || 0; } catch { /* no duration */ }
    }
    if (dur > 0 && start >= dur - 0.05) {
      throw new Error(`window starts at ${tc(start)} but the file is ${tc(dur)} long`);
    }
    throw new Error('no frames could be decoded from this input');
  }
  // The cap is applied after the whole selection has run, so the header can
  // report how many screens were actually there. Walking the rest of the grids
  // costs one 84-block comparison per frame, which is nothing beside the decode.
  const changed = picked.length;
  const capped = changed > maxScreens;
  if (capped) picked.length = maxScreens;

  const dir = mkdtempSync(join(tmpdir(), 'dsh-read-'));
  try {
    const t1 = Date.now();
    const names = new Map();
    const cw = Math.max(2, Math.round(crop.w * 1000)) / 1000;
    const cropFilter = `crop=iw*${cw}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`;
    mkdirSync(dir, { recursive: true });
    const ocrDir = join(dir, 'ocr');
    mkdirSync(ocrDir, { recursive: true });

    let exact = null;
    if (dense) {
      try {
        const rawDir = join(dir, 'raw');
        mkdirSync(rawDir, { recursive: true });
        await extractDenseFrames(ffmpegPath, source, { start, end, step: dense, crop, dir: rawDir, signal });
        exact = rawDir;
      } catch { exact = null; }   // fall back to seeking by timestamp
    }

    if (exact) {
      // The measured frame and the read frame are the same file: copy the chosen
      // ones by index, so no timestamp arithmetic can drift by a tick.
      for (const i of picked) {
        if (i >= grids.length) continue;
        const name = `d${String(i + 1).padStart(5, '0')}`;
        try { copyFileSync(join(exact, `${name}.png`), join(ocrDir, `${name}.png`)); } catch { continue; }
        names.set(i, name);
      }
    } else {
      const queue = [...picked];
      await Promise.all(Array.from({ length: READ_DEFAULTS.grabWorkers }, async () => {
        while (queue.length) {
          const i = queue.shift();
          // A keyframe can land mid-scroll or mid-dissolve; go a beat later, when
          // the page has settled, or the OCR reads a half-drawn screen.
          const t = start + (stamps[i] ?? 0) + READ_DEFAULTS.settle;
          const name = `f${String(Math.round(t * 10)).padStart(6, '0')}`;
          names.set(i, name);
          await new Promise((resolve, reject) => {
            const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin',
              '-ss', t.toFixed(3), ...netInputArgs(source), '-i', source,
              '-frames:v', '1', '-vf', cropFilter,
              '-y', join(ocrDir, `${name}.png`)], { stdio: 'ignore', signal });
            child.on('error', reject);
            child.on('close', resolve);
          });
        }
      }));
    }
    timings.grab = Date.now() - t1;

    const t2 = Date.now();
    const recognised = await ocrDirectory(ocrDir, { signal });
    if (process.env.DSH_READ_DEBUG) { const k0=[...recognised.keys()][0]; const r0=recognised.get(k0); console.error('[dbg] rec0=%s lines=%d text0=%s', k0, (r0.lines||[]).length, JSON.stringify((r0.lines||[]).slice(0,2))); }
    timings.ocr = Date.now() - t2;

    const raw = [];
    for (const i of picked) {
      const lines = screenLines(recognised.get(names.get(i)));
      if (!lines.length) continue;
      raw.push({ t: start + (stamps[i] ?? 0), lines });
    }
    raw.sort((a, b) => a.t - b.t);
    const cleaned = dropBoilerplate(raw);
    const screens = [];
    for (const s of cleaned.screens) {
      const text = cleanOcr(s.lines.join(String.fromCharCode(10)));
      if (isChrome(text)) continue;
      // A handwritten page reaches OCR as a handful of fragments. A page that
      // still yields a heading or an example number is worth its few tokens;
      // a frame of loose strokes is not. The header says when little was found.
      if (!readableScreen(s.lines)) continue;
      screens.push({ t: s.t, text, lines: s.lines });
    }
    const merged = mergeScreens(screens, { novelLine: Boolean(dense) });
    // a second pass at a looser threshold: the leftover duplicates are the ones
    // whose OCR came out degraded, so their bigrams overlap less
    const deduped = mergeScreens(merged, { similarity: 0.40, novelLine: Boolean(dense) });
    timings.total = Date.now() - wall;

    // One array, one count: the header, the note, the outline and every quoted
    // line come from the same list, so the numbers cannot disagree with the body.
    const { usable } = usableScreens(deduped);
    const name = sourceTitle || input.split(/[\\/]/).pop();

    if (!usable.length) {
      // No text anywhere in the window: the information is a picture, not words.
      // Decode a few frames and hand them over with the same answer instead of an
      // empty document that forces the caller into a second round trip.
      const t3 = Date.now();
      const aspect = meta && meta.width && meta.height ? meta.width / meta.height : 16 / 9;
      let shot = null;
      try {
        shot = await pictureFallback({
          input: source, ffmpegPath, start, end: knownEnd, stamps, aspect, signal,
        });
      } catch { shot = null; }
      timings.pictures = Date.now() - t3;
      timings.total = Date.now() - wall;
      const lines = [
        `# ${name} — read as text · no readable text · ${stamps.length} keyframes · ${timings.total} ms`,
        '',
        `note: no readable text in ${changed} changed frames of ${stamps.length} sampled `
          + `(${Math.round((timings.total / 1000) * 10) / 10} s) — handwriting, a camera pointed at a `
          + 'screen rather than a capture, or no slides at all',
      ];
      if (shot) {
        const first = shot.cells[0].frameT;
        const lastOne = shot.cells[shot.cells.length - 1].frameT;
        lines.push(`note: showing ${shot.cells.length} pictures instead (${tc(first)}–${tc(lastOne)}): `
          + 'these frames are the evidence the file carries, so read them as a storyboard');
      } else {
        lines.push('note: the frames could not be decoded either — video_storyboard reports why');
      }
      lines.push('note: for words, pass transcriptFile (SRT, VTT or JSON) or set DSH_ASR_CMD '
        + '— a file with an audio track is then read as a transcript');
      const written = withExport(lines.join('\n'), [], opts.out);
      const text = written.text;
      return {
        text,
        screens: [],
        outline: [],
        wrote: written.wrote,
        pictures: shot ? shot.cells.map((c) => ({ index: c.index, t: c.frameT })) : [],
        png: shot ? shot.png : null,
        sheet: shot ? { grid: shot.grid, bytes: shot.png.length } : null,
        stats: {
          keyframes: stamps.length,
          changed,
          capped,
          maxScreens,
          clustered: picked.length,
          screens: 0,
          pictures: shot ? shot.cells.length : 0,
          chars: text.length,
          furniture: cleaned.dropped.length,
        },
        timings,
      };
    }
    if (usable.length) {
      const last = usable[usable.length - 1];
      if (!(last.tEnd > last.t)) last.tEnd = knownEnd > last.t ? knownEnd : last.t + (dense || 1);
    }
    const heads = outline(usable);
    const head = `# ${sourceTitle || input.split(/[\\/]/).pop()} — read as text · ${usable.length} screens · ${stamps.length} keyframes · ${timings.total} ms`;
    const body = [head];
    // Report the cap, not just its effect: a document that silently stops at
    // screen 400 reads exactly like a video that had 400 screens.
    for (const n of capNotes({ askedScreens, maxScreens, changed })) body.push('', `note: ${n}`);
    if (usable.length < 5) {
      // Say what was found and name the alternatives; do not tell the reader
      // their video is broken. Under three screens the old code also threw away
      // four honest subtitle lines, so few screens is reported, not discarded.
      const found = usable.length === 1 ? 'one screen' : `${usable.length} screens`;
      body.push('', `note: ${found} carried readable text out of ${raw.length} sampled `
        + `(${Math.round((timings.total / 1000) * 10) / 10} s). Few screens usually means one of: `
        + 'handwriting, a camera pointed at a screen rather than a capture, no slides at all, '
        + 'or a fixed layout whose only change is a subtitle line -- video_storyboard shows the '
        + 'pictures, and the audio summary still applies.');
    }
    if (heads.length > 2) {
      body.push('', '## outline');
      for (const h of heads) body.push(`${tc(h.t)} ${h.head}`);
    }
    body.push('');
    for (const s of usable) {
      const span = s.tEnd > s.t + 2 ? `${tc(s.t)}–${tc(s.tEnd)}` : tc(s.t);
      body.push(`[${span}] ${s.text}`);
    }
    const written = withExport(body.join('\n'), screensAsItems(usable), opts.out);
    const text = written.text;
    return {
      text,
      screens: usable,
      outline: usable.length ? heads : [],
      wrote: written.wrote,
      stats: {
        keyframes: stamps.length,
        changed,
        capped,
        maxScreens,
        clustered: picked.length,
        screens: usable.length,
        chars: text.length,
        fromScreen: Math.round(text.length / Math.max(1, usable.length)),
        furniture: cleaned.dropped.length,
      },
      timings,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
