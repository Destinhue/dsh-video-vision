/**
 * OCR backend.
 *
 * A video of a lecture, a slide deck or a screen recording carries most of its
 * information as *text on the picture*, and text is the cheapest thing a model
 * can be handed: a 2-hour lecture is ~20k characters, while pictures of the same
 * lecture are capped at 1024 vision tokens and are unreadable at that size.
 *
 * So when the host can read text off an image, prefer text. Three backends, in
 * the order they are tried:
 *
 *   1. `DSH_OCR_CMD` — your own command: it is given one image path and prints
 *      the recognised lines to stdout. For a cloud OCR, a local model, or a
 *      vendor binary this module has never heard of. Append `{image}` to choose
 *      where the path goes, otherwise it is appended.
 *   2. Windows.Media.Ocr (Windows only, no download, ~100 ms per frame).
 *   3. `tesseract` on PATH, driven in TSV mode so line boxes survive.
 *
 * `DSH_OCR_BACKEND=off` switches OCR off, `=tesseract` skips the native engine.
 * Everything else reports "unavailable" and the caller falls back to pictures.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './media.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', 'bin', 'ocr-batch.ps1');
const POWERSHELL = process.env.DSH_POWERSHELL || join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** how many images an external engine is asked about at once */
const ENGINE_CONCURRENCY = 4;
/** one image should never take longer than this */
const IMAGE_TIMEOUT_MS = 120_000;

const BACKENDS = new Map();

/**
 * Find an executable on PATH without asking a shell.
 *
 * `where`/`which` would be one process per lookup and a different one per OS;
 * walking PATH is a handful of stat calls and hands back an absolute path, which
 * is what a spawn wants anyway.
 *
 * @param {string} name e.g. `tesseract` (an extension is optional on Windows)
 * @param {Record<string,string|undefined>} [env]
 */
export function findOnPath(name, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['', '.exe'];
  const candidates = [];
  for (const suffix of suffixes) {
    const full = name.endsWith(suffix) ? name : name + suffix;
    if (!candidates.includes(full)) candidates.push(full);
  }
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch { /* an unreadable PATH entry is not a candidate */ }
    }
  }
  return null;
}

/**
 * Is there an OCR engine we can drive, and which one?
 *
 * @param {Record<string,string|undefined>} [env] read the choice from here so a
 *   test can pin the answer instead of inheriting the host's
 * @returns {{ok:boolean, engine:string|null, kind?:string, reason?:string, bin?:string, cmd?:string}}
 */
export function ocrBackend(env = process.env) {
  const key = [env.DSH_OCR_CMD || '', env.DSH_OCR_BACKEND || '', env.PATH || env.Path || ''].join('|');
  const hit = BACKENDS.get(key);
  if (hit) return hit;
  const backend = pickBackend(env);
  if (BACKENDS.size > 8) BACKENDS.clear();
  BACKENDS.set(key, backend);
  return backend;
}

function pickBackend(env) {
  const asked = String(env.DSH_OCR_BACKEND || '').toLowerCase();
  if (asked === 'off' || asked === 'none') {
    return { ok: false, engine: null, reason: 'OCR is switched off (DSH_OCR_BACKEND=off)' };
  }
  const custom = String(env.DSH_OCR_CMD || '').trim();
  if (custom) return { ok: true, kind: 'cmd', engine: 'custom (DSH_OCR_CMD)', cmd: custom };
  if (asked === 'tesseract') {
    const forced = findOnPath('tesseract', env);
    return forced
      ? { ok: true, kind: 'tesseract', engine: 'tesseract', bin: forced }
      : { ok: false, engine: null, reason: 'DSH_OCR_BACKEND=tesseract but tesseract is not on PATH' };
  }
  // The native engine is faster than tesseract and needs no install, so on
  // Windows it wins whenever it is there.
  if (process.platform === 'win32') {
    if (!existsSync(SCRIPT)) return { ok: false, engine: null, reason: 'missing ' + SCRIPT };
    if (!existsSync(POWERSHELL)) return { ok: false, engine: null, reason: 'missing ' + POWERSHELL };
    return { ok: true, kind: 'windows', engine: 'windows-media-ocr' };
  }
  const found = findOnPath('tesseract', env);
  if (found) return { ok: true, kind: 'tesseract', engine: 'tesseract', bin: found };
  return {
    ok: false, engine: null,
    reason: 'no OCR engine on this host — install tesseract, or set DSH_OCR_CMD to a command '
      + 'that takes one image path and prints its lines',
  };
}

/**
 * OCR every PNG in a directory.
 *
 * All three backends answer the same shape: a stem → recognised screen, so the
 * rest of the pipeline never learns which engine ran.
 *
 * @param {string} dir directory of `*.png` files
 * @param {{signal?: AbortSignal, timeoutMs?: number, env?: Record<string,string|undefined>}} [opts]
 * @returns {Promise<Map<string,{text:string,lines:object[],width:number,height:number}>>}
 */
export async function ocrDirectory(dir, opts = {}) {
  const backend = ocrBackend(opts.env);
  if (!backend.ok) throw new Error('OCR unavailable: ' + backend.reason);
  // any stem: the dense pass writes d#####.png, the keyframe pass f#######.png
  const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  let map;
  if (!pngs.length) map = new Map();
  else if (backend.kind === 'windows') map = await ocrWindows(dir, opts);
  else if (backend.kind === 'tesseract') map = await ocrExternal(dir, pngs, backend, opts);
  else map = await ocrExternal(dir, pngs, backend, opts);
  // anything the engine skipped stays empty rather than missing
  for (const file of pngs) {
    const stem = file.slice(0, -4);
    if (!map.has(stem)) map.set(stem, { text: '', lines: [], width: 0, height: 0 });
  }
  return map;
}

/**
 * OCR every PNG in a directory, in ONE process (engine startup dominates the
 * per-image cost, so batching matters more than concurrency).
 */
async function ocrWindows(dir, opts) {
  const out = join(dir, 'ocr.txt');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-Dir', dir, '-Out', out];
  await new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: opts.signal });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill(); reject(new Error('OCR timed out after ' + opts.timeoutMs + ' ms')); }, opts.timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error('OCR failed (' + code + '): ' + err.slice(-400)));
      else resolve(undefined);
    });
  });
  const text = readFileSync(out, 'utf8');
  const parts = text.split(/^== (.+?) ==\r?\n/gm);
  const map = new Map();
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i], parseOcrSection(parts[i + 1]));
  return map;
}

/**
 * A recognised screen: the raw text, and each line with the box it occupied, so
 * the caller can throw away a tab strip without being told which app drew it.
 * @param {string} section one `== stem ==` block
 */
export function parseOcrSection(section) {
  const lines = [];
  let width = 0;
  let height = 0;
  for (const raw of section.split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith('@@ ')) {
      const [w, h] = raw.slice(3).split(' ').map(Number);
      width = w || 0;
      height = h || 0;
      continue;
    }
    const tab = raw.indexOf('\t');
    if (tab > 0) {
      const [x0, y0, x1, y1] = raw.slice(0, tab).split(' ').map(Number);
      lines.push({ text: raw.slice(tab + 1), x0, y0, x1, y1 });
    } else {
      lines.push({ text: raw, x0: 0, y0: 0, x1: 0, y1: 0 });
    }
  }
  return { text: lines.map((l) => l.text).join('\n'), lines, width, height };
}

/** the union of script ranges that are written without spaces between words */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/**
 * Glue the words of one line back together. A Latin word boundary is a space; a
 * Han character boundary is not, or every Chinese line comes back spaced out.
 * @param {string[]} words
 */
export function joinWords(words) {
  let out = '';
  for (const word of words) {
    const text = String(word ?? '').trim();
    if (!text) continue;
    if (!out) { out = text; continue; }
    const left = out.slice(-1);
    const right = text.slice(0, 1);
    out += CJK.test(left) || CJK.test(right) ? text : ' ' + text;
  }
  return out;
}

/**
 * Group lines into rows and read them left to right, top to bottom. Engine output
 * is ordered by block, which for a slide means the title comes back before the
 * footer at random; a reader needs the picture's own order.
 * @param {{text:string,x0:number,y0:number,x1:number,y1:number}[]} lines
 */
export function readingOrder(lines) {
  const rows = [];
  const byTop = [...lines].sort((a, b) => a.y0 - b.y0);
  let band = null;
  for (const line of byTop) {
    const height = Math.max(1, line.y1 - line.y0);
    if (!band || line.y0 - band.top > height * 0.6) {
      band = { top: line.y0, items: [] };
      rows.push(band);
    }
    band.items.push(line);
  }
  const out = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    for (const item of row.items) out.push(item);
  }
  return out;
}

/**
 * Parse `tesseract <image> stdout tsv`.
 *
 * The TSV has one row per WORD, so the lines are rebuilt here: words sharing
 * block/paragraph/line are one line, and their boxes are unioned, which is exactly
 * what the screen-furniture rules in read.js need.
 * @param {string} tsv
 */
export function parseTsv(tsv) {
  const groups = new Map();
  let width = 0;
  let height = 0;
  for (const raw of String(tsv || '').split(/\r?\n/)) {
    const row = raw.split('\t');
    if (row.length < 12) continue;
    const level = Number(row[0]);
    if (!Number.isFinite(level)) continue; // the header row
    if (level === 1) {
      width = Number(row[8]) || 0;
      height = Number(row[9]) || 0;
      continue;
    }
    if (level !== 5) continue;
    const text = row.slice(11).join('\t').trim();
    if (!text) continue;
    const confidence = Number(row[10]);
    if (Number.isFinite(confidence) && confidence < 0) continue;
    const x0 = Number(row[6]) || 0;
    const y0 = Number(row[7]) || 0;
    const word = {
      text, x0, y0,
      x1: x0 + (Number(row[8]) || 0),
      y1: y0 + (Number(row[9]) || 0),
      n: Number(row[5]) || 0,
    };
    const key = row[2] + ':' + row[3] + ':' + row[4];
    const group = groups.get(key);
    if (group) group.push(word);
    else groups.set(key, [word]);
  }
  const lines = [];
  for (const words of groups.values()) {
    words.sort((a, b) => a.n - b.n);
    lines.push({
      text: joinWords(words.map((w) => w.text)),
      x0: Math.min(...words.map((w) => w.x0)),
      y0: Math.min(...words.map((w) => w.y0)),
      x1: Math.max(...words.map((w) => w.x1)),
      y1: Math.max(...words.map((w) => w.y1)),
    });
  }
  const ordered = readingOrder(lines);
  if (!width) width = ordered.reduce((m, l) => Math.max(m, l.x1), 0);
  if (!height) height = ordered.reduce((m, l) => Math.max(m, l.y1), 0);
  return { text: ordered.map((l) => l.text).join('\n'), lines: ordered, width, height };
}

/**
 * Where the image path goes in `DSH_OCR_CMD`. A path with a space is quoted, and
 * `{image}` lets the caller put the path somewhere other than the end —
 * `mytool --lang=chi_sim {image} --stdout`, for instance.
 */
export function ocrCommandLine(cmd, imagePath) {
  const path = String(imagePath);
  const quoted = /[\s"]/.test(path) ? '"' + path + '"' : path;
  const line = String(cmd);
  return line.includes('{image}') ? line.split('{image}').join(quoted) : line + ' ' + quoted;
}

/** recognise one image per process through any external engine */
async function ocrExternal(dir, pngs, backend, opts) {
  const env = opts.env || process.env;
  const language = String(env.DSH_OCR_LANG || '').trim();
  const failures = [];
  const results = await mapPool(pngs, ENGINE_CONCURRENCY, async (file) => {
    const image = join(dir, file);
    let res;
    if (backend.kind === 'tesseract') {
      const args = [image, 'stdout', 'tsv'];
      if (language) args.push('-l', language);
      res = await run(backend.bin, args, { signal: opts.signal, timeoutMs: IMAGE_TIMEOUT_MS });
    } else {
      res = await runShell(ocrCommandLine(backend.cmd, image), {
        env, signal: opts.signal, timeoutMs: IMAGE_TIMEOUT_MS,
      });
    }
    if (res.code !== 0) {
      const why = res.stderr.toString('utf8').trim().slice(-200) || 'exit ' + res.code;
      failures.push(file + ': ' + why);
      return { file, text: '', lines: [], width: 0, height: 0 };
    }
    const stdout = res.stdout.toString('utf8');
    if (backend.kind === 'tesseract') return { file, ...parseTsv(stdout) };
    const lines = [];
    for (const raw of stdout.replace(/\r/g, '').split('\n')) {
      const text = raw.trim();
      if (text) lines.push({ text, x0: 0, y0: 0, x1: 0, y1: 0 });
    }
    return {
      file, text: lines.map((l) => l.text).join('\n'), lines,
      // no boxes: width and height stay 0 so the furniture rules keep every line
      width: 0, height: 0,
    };
  });
  if (failures.length === pngs.length) throw new Error('OCR failed: ' + failures[0]);
  const map = new Map();
  for (const result of results) {
    map.set(result.file.slice(0, -4), {
      text: result.text, lines: result.lines, width: result.width, height: result.height,
      ...(failures.some((f) => f.startsWith(result.file + ':')) ? { error: true } : {}),
    });
  }
  return map;
}

/** run a shell command line the way the user wrote it (pipes and quotes included) */
function runShell(line, { env = process.env, signal, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(line, { shell: true, windowsHide: true, env, signal });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => { child.kill('SIGKILL'); finish(resolve, { code: -1, stdout: Buffer.concat(out), stderr: Buffer.from('timed out after ' + timeoutMs + ' ms') }); }, timeoutMs)
      : null;
    timer?.unref?.();
    child.stdout?.on('data', (c) => out.push(Buffer.from(c)));
    child.stderr?.on('data', (c) => err.push(Buffer.from(c)));
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, { code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
  });
}

/** `limit` promises in flight at a time, results in input order */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
