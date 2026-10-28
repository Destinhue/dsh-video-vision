/**
 * OCR backend.
 *
 * A video of a lecture, a slide deck or a screen recording carries most of its
 * information as *text on the picture*, and text is the cheapest thing a model
 * can be handed: a 2-hour lecture is ~20k characters, while pictures of the same
 * lecture are capped at 1024 vision tokens and are unreadable at that size.
 *
 * So when the host can read text off an image, prefer text. Windows ships an
 * OCR engine (Windows.Media.Ocr, no download, no model, ~100 ms per frame); that
 * is the backend here. Everywhere else this module reports "unavailable" and the
 * caller falls back to the picture path.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', 'bin', 'ocr-batch.ps1');
const POWERSHELL = process.env.DSH_POWERSHELL || join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let cachedBackend = null;

/**
 * Is there an OCR engine we can drive?
 * @returns {{ok: boolean, engine: string|null, reason?: string}}
 */
export function ocrBackend() {
  if (cachedBackend) return cachedBackend;
  if (process.platform !== 'win32') {
    cachedBackend = { ok: false, engine: null, reason: 'only the Windows OCR engine is wired up' };
    return cachedBackend;
  }
  if (!existsSync(SCRIPT)) {
    cachedBackend = { ok: false, engine: null, reason: `missing ${SCRIPT}` };
    return cachedBackend;
  }
  if (!existsSync(POWERSHELL)) {
    cachedBackend = { ok: false, engine: null, reason: `missing ${POWERSHELL}` };
    return cachedBackend;
  }
  cachedBackend = { ok: true, engine: 'windows-media-ocr' };
  return cachedBackend;
}

/**
 * OCR every PNG in a directory, in ONE process (engine startup dominates the
 * per-image cost, so batching matters more than concurrency).
 *
 * @param {string} dir directory of `*.png` files
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
 * @returns {Promise<Map<string,{text:string,lines:object[],width:number,height:number}>>}
 */
export async function ocrDirectory(dir, opts = {}) {
  const backend = ocrBackend();
  if (!backend.ok) throw new Error(`OCR unavailable: ${backend.reason}`);
  const out = join(dir, 'ocr.txt');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-Dir', dir, '-Out', out];
  await new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, args, { stdio: ['ignore', 'ignore', 'pipe'], signal: opts.signal });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = opts.timeoutMs
      ? setTimeout(() => { child.kill(); reject(new Error(`OCR timed out after ${opts.timeoutMs} ms`)); }, opts.timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`OCR failed (${code}): ${err.slice(-400)}`));
      else resolve();
    });
  });
  const text = readFileSync(out, 'utf8');
  const parts = text.split(/^== (f\d+) ==\r?\n/gm);
  const map = new Map();
  for (let i = 1; i < parts.length; i += 2) map.set(parts[i], parseSection(parts[i + 1]));
  // anything the engine skipped stays empty rather than missing
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.png')) continue;
    const stem = file.slice(0, -4);
    if (!map.has(stem)) map.set(stem, { text: '', lines: [], width: 0, height: 0 });
  }
  return map;
}

/**
 * A recognised screen: the raw text, and each line with the box it occupied, so
 * the caller can throw away a tab strip without being told which app drew it.
 * @param {string} section one `== stem ==` block
 */
function parseSection(section) {
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
