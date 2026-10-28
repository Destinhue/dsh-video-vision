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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ocrBackend, ocrDirectory } from './ocr.js';

export const READ_DEFAULTS = {
  gridWidth: 96,
  gridHeight: 54,
  // share of the 12x7 block grid that must move for two keyframes to count as
  // different screens; a slide that is re-shown moves nothing
  screenChange: 0.055,
  // how much of a pair of screens must share text bigrams to be the same screen
  textSimilarity: 0.62,
  maxScreens: 400,
  crop: { x: 0.094, y: 0.115, w: 0.812, h: 0.800 },
  grabWorkers: 8,
};

/** strings that belong to the recorder or the meeting app, not the lecture */
const CHROME = [
  '您正在共享屏幕', '停止共享', '共享设备音频', '说点什么', '录制中', '屏幕共享',
  '腾讯会议', '钉钉', '会议结束后', '个人中心', '我的录制', '成员限制', '入会',
  'cooanotes', 'ooanotes', '会议设置', '麦克风浮窗', '第二次讲义',
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
  if (!text) return true;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  if (han < 10) return true;
  if (han / text.length < 0.3) return true;
  let hits = 0;
  for (const phrase of CHROME) if (text.includes(phrase)) hits += 1;
  return hits >= 2 || (hits >= 1 && text.length < 40);
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
  const out = [];
  for (const s of screens) {
    const prev = out[out.length - 1];
    if (prev && textSimilarity(prev.text, s.text) >= threshold) {
      prev.tEnd = s.t;
      if (s.text.length > prev.text.length) prev.text = s.text;
      continue;
    }
    out.push({ t: s.t, tEnd: s.t, text: s.text });
  }
  return out;
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

/** decode keyframes only, returning their block grids and timestamps */
function decodeKeyframes(ffmpegPath, input, { start = 0, end = 0, signal } = {}) {
  const { gridWidth: w, gridHeight: h } = READ_DEFAULTS;
  const args = ['-hide_banner', '-nostdin', '-skip_frame', 'nokey'];
  if (start) args.push('-ss', String(start));
  args.push('-i', input);
  if (end) args.push('-t', String(end - start));
  args.push('-vf', `scale=${w}:${h}:flags=fast_bilinear,showinfo,format=rgb24`,
    '-vsync', '0', '-f', 'rawvideo', '-');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const grids = [];
    let stamps = [];
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
      stamps = [];
      for (const m of err.matchAll(/pts_time:([0-9.]+)/g)) stamps.push(Number(m[1]));
      resolve({ grids, stamps });
    });
  });
}

/**
 * Read a video as a timestamped text document.
 *
 * @param {{input:string, ffmpegPath:string, start?:number, end?:number,
 *          signal?:AbortSignal, maxScreens?:number,
 *          crop?:{x:number,y:number,w:number,h:number}}} opts
 */
export async function runRead(opts) {
  const {
    input, ffmpegPath, start = 0, end = 0, signal,
  } = opts;
  const maxScreens = Math.min(opts.maxScreens ?? READ_DEFAULTS.maxScreens, READ_DEFAULTS.maxScreens);
  const crop = opts.crop ?? READ_DEFAULTS.crop;
  const backend = ocrBackend();
  if (!backend.ok) throw new Error(`cannot read text: ${backend.reason}`);
  const timings = {};
  const wall = Date.now();

  const t0 = Date.now();
  const { grids, stamps } = await decodeKeyframes(ffmpegPath, input, { start, end, signal });
  timings.scan = Date.now() - t0;

  const picked = [];
  let last = -1;
  for (let i = 0; i < grids.length; i++) {
    if (last < 0 || gridChange(grids[last], grids[i]) >= READ_DEFAULTS.screenChange) {
      picked.push(i);
      last = i;
      if (picked.length >= maxScreens) break;
    }
  }
  if (!picked.length) throw new Error('no frames could be decoded from this input');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-read-'));
  try {
    const t1 = Date.now();
    const names = new Map();
    const queue = [...picked];
    const cw = Math.max(2, Math.round(crop.w * 1000)) / 1000;
    const cropFilter = `crop=iw*${cw}:ih*${crop.h}:iw*${crop.x}:ih*${crop.y}`;
    await Promise.all(Array.from({ length: READ_DEFAULTS.grabWorkers }, async () => {
      while (queue.length) {
        const i = queue.shift();
        const t = start + (stamps[i] ?? 0);
        const name = `f${String(Math.round(t * 10)).padStart(6, '0')}`;
        names.set(i, name);
        await new Promise((resolve, reject) => {
          const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin',
            '-ss', t.toFixed(3), '-i', input, '-frames:v', '1', '-vf', cropFilter,
            '-y', join(dir, `${name}.png`)], { stdio: 'ignore', signal });
          child.on('error', reject);
          child.on('close', resolve);
        });
      }
    }));
    timings.grab = Date.now() - t1;

    const t2 = Date.now();
    const recognised = await ocrDirectory(dir, { signal });
    timings.ocr = Date.now() - t2;

    const screens = [];
    for (const i of picked) {
      const text = cleanOcr(recognised.get(names.get(i)) ?? '');
      if (!text || isChrome(text)) continue;
      screens.push({ t: start + (stamps[i] ?? 0), text });
    }
    screens.sort((a, b) => a.t - b.t);
    const merged = mergeScreens(screens);
    timings.total = Date.now() - wall;

    const heads = outline(merged);
    const head = `# ${input.split(/[\\/]/).pop()} — read as text · ${merged.length} screens · `
      + `${stamps.length} keyframes · ${timings.total} ms`;
    const body = [head];
    if (heads.length > 2) {
      body.push('', '## outline');
      for (const h of heads) body.push(`${tc(h.t)} ${h.head}`);
    }
    body.push('');
    for (const s of merged) {
      const span = s.tEnd > s.t + 2 ? `${tc(s.t)}–${tc(s.tEnd)}` : tc(s.t);
      body.push(`[${span}] ${s.text}`);
    }
    const text = body.join('\n');
    return {
      text,
      screens: merged,
      outline: heads,
      stats: {
        keyframes: stamps.length,
        clustered: picked.length,
        screens: merged.length,
        chars: text.length,
        fromScreen: Math.round(text.length / Math.max(1, merged.length)),
      },
      timings,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
