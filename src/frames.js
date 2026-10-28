/**
 * frames.js — turn cell timestamps into raw RGB pictures.
 *
 * Two things matter here: how many processes are started, and how much of the
 * file each one has to decode.
 *
 * Upstream starts three decoders per cell (to pick the sharpest of three
 * candidates). The scan pass has already scored every frame, so this build
 * knows which frame to take and starts exactly one decoder per *group* of
 * cells: several `-ss N -i file` inputs are opened in a single ffmpeg process,
 * each writing one cell. A 12-cell sheet is one process instead of 36, and the
 * groups run concurrently.
 *
 * Every decode is an input-level seek (`-ss` before `-i`), so the decoder
 * jumps to the preceding keyframe and touches only a handful of frames. Output
 * goes to small raw RGB files rather than stdout because a single process has
 * one stdout and many cells.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FRAME_DEFAULTS = {
  batch: 6,
  concurrency: 3,
  scaleFlags: 'lanczos+accurate_rnd',
  /** Retries for a seek that lands past the end of the stream. */
  retries: 1,
};

function runOnce(bin, args, { signal, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let done = false;
    const timer = timeoutMs
      ? setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* gone */ } resolve({ code: -1, stderr: `${stderr}\ntimeout` }); } }, timeoutMs)
      : null;
    child.stderr.on('data', (b) => { stderr += b.toString('utf8').slice(0, 8000); });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stderr });
    });
    if (signal) {
      if (signal.aborted) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      else signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, { once: true });
    }
  });
}

function buildArgs({ input, jobs, cellW, cellH, scaleFlags }) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error'];
  for (const job of jobs) {
    args.push('-ss', job.seek.toFixed(3));
    args.push('-i', input);
  }
  for (let i = 0; i < jobs.length; i++) {
    args.push('-map', `${i}:v:0`);
    args.push('-frames:v', '1');
    args.push('-an', '-sn', '-dn');
    args.push('-vf', `scale=${cellW}:${cellH}:flags=${scaleFlags},format=rgb24`);
    args.push('-pix_fmt', 'rgb24');
    args.push('-f', 'rawvideo');
    args.push('-y', jobs[i].out);
  }
  return args;
}

/**
 * @param {object} p
 * @param {string} p.input
 * @param {string} p.ffmpegPath
 * @param {Array<{index:number, frameT:number}>} p.cells
 * @param {number} p.cellW
 * @param {number} p.cellH
 * @param {AbortSignal} [p.signal]
 * @param {string} [p.tmpDir]
 * @returns {Promise<{frames: Map<number, {data:Buffer,width:number,height:number}>, stats: object}>}
 */
export async function extractCells(p) {
  const {
    input, ffmpegPath, cells, cellW, cellH,
    signal, batch = FRAME_DEFAULTS.batch, concurrency = FRAME_DEFAULTS.concurrency,
    scaleFlags = FRAME_DEFAULTS.scaleFlags,
  } = p;
  const started = Date.now();
  const tmpDir = p.tmpDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vv-')));
  const created = !p.tmpDir;
  const bytes = cellW * cellH * 3;

  const frames = new Map();
  const failures = [];
  let processes = 0;

  const groups = [];
  for (let i = 0; i < cells.length; i += batch) groups.push(cells.slice(i, i + batch));

  const runGroup = async (group) => {
    const jobs = group.map((c, j) => ({
      cell: c,
      seek: Math.max(0, c.frameT),
      out: path.join(tmpDir, `c${j}-${Math.random().toString(36).slice(2, 8)}.raw`),
    }));
    const args = buildArgs({ input, jobs: jobs.map(({ seek, out }) => ({ seek, out })), cellW, cellH, scaleFlags });
    processes += 1;
    const res = await runOnce(ffmpegPath, args, { signal });
    for (const job of jobs) {
      try {
        const buf = await fs.readFile(job.out);
        if (buf.length >= bytes) {
          frames.set(job.cell.index, { data: Buffer.from(buf.subarray(0, bytes)), width: cellW, height: cellH });
        } else {
          failures.push({ index: job.cell.index, t: job.cell.frameT, reason: 'short', got: buf.length });
        }
      } catch {
        failures.push({ index: job.cell.index, t: job.cell.frameT, reason: 'missing' });
      }
      await fs.rm(job.out, { force: true });
    }
    return res.code;
  };

  // simple bounded concurrency
  const queue = [...groups];
  const workers = new Array(Math.max(1, Math.min(concurrency, groups.length))).fill(0).map(async () => {
    for (;;) {
      const group = queue.shift();
      if (!group || (signal && signal.aborted)) return;
      await runGroup(group);
    }
  });
  await Promise.all(workers);

  // ---- retry the stragglers one timestamp earlier: a seek can land past the
  // end of the stream, especially on the last cell of a clip.
  if (failures.length && FRAME_DEFAULTS.retries > 0 && !(signal && signal.aborted)) {
    const retry = failures.filter((f) => !frames.has(f.index));
    if (retry.length) {
      await runGroup(retry.map((f) => ({ index: f.index, frameT: Math.max(0, f.t - 0.08) })));
    }
  }

  if (created) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  const missing = cells.filter((c) => !frames.has(c.index)).map((c) => c.index);
  return {
    frames,
    stats: {
      requested: cells.length,
      decoded: frames.size,
      missing,
      processes,
      batches: groups.length,
      ms: Date.now() - started,
      cellW, cellH,
    },
  };
}

/**
 * Grab one frame at full-ish resolution (used by the zoom tool and by the
 * single-frame fallback when the sheet would be a huge grid).
 */
export async function extractFrame(p) {
  const { input, ffmpegPath, t, width, height, signal, tmpDir } = p;
  const dir = tmpDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vv1-')));
  const created = !tmpDir;
  const out = path.join(dir, `f-${Math.random().toString(36).slice(2, 8)}.raw`);
  const bytes = width * height * 3;
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', Math.max(0, t).toFixed(3), '-i', input,
    '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', `scale=${width}:${height}:flags=${FRAME_DEFAULTS.scaleFlags},format=rgb24`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-y', out,
  ];
  const res = await runOnce(ffmpegPath, args, { signal });
  let data = null;
  try {
    const buf = await fs.readFile(out);
    if (buf.length >= bytes) data = Buffer.from(buf.subarray(0, bytes));
  } catch { /* reported below */ }
  await fs.rm(out, { force: true });
  if (created) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { data, width, height, code: res.code, stderr: res.stderr.slice(-300) };
}
