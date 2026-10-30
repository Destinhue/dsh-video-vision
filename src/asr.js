/**
 * asr.js — speech to text, delegated to an engine the user already trusts.
 *
 * Why this file is a thin adapter and not a recogniser:
 *
 *   - this plugin ships zero dependencies and ~600 KB of code, and installs by
 *     linking a directory. A bundled model (whisper tiny 75 MB, small 484 MB,
 *     medium 1.5 GB) would turn that into a download, a licence question and a
 *     first-run stall;
 *   - the accuracy that makes a lecture usable lives in the model, not in the
 *     plumbing. Whatever wins on your machine — whisper.cpp, faster-whisper,
 *     a vendor API — should be the thing that runs;
 *   - the host already has an offline recogniser (`System.Speech`, zh-CN), and
 *     measured on a real lecture it returns 1.7 % confidence nonsense. Shipping
 *     *that* as "ASR" would be worse than shipping nothing.
 *
 * So: you set `DSH_ASR_CMD` to a command that turns a 16 kHz mono wav into
 * subtitles, and this module does the parts that are easy to get wrong —
 * extracting the audio once, keeping the timestamps absolute, and handing the
 * result to the same cell-quoting code the subtitle track uses.
 *
 *   DSH_ASR_CMD='whisper-cli -m C:\models\ggml-small.bin -f {wav} -osrt -of {out}'
 *
 * `{wav}` is replaced by the extracted audio, `{out}` by a path the command may
 * write an SRT to (if it prints SRT on stdout instead, that works too).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './media.js';
import { parseSubtitleText } from './timeline.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Split a command template into argv, honouring '…' and "…" quoting. */
export function splitCommand(template) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(template ?? '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== '' || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || has) out.push(cur);
  return out;
}

/** Substitute the two placeholders in every argv token. */
export function fillArgs(argv, { wav, out }) {
  return argv.map((a) => a.split('{wav}').join(wav).split('{out}').join(out));
}

/** Is an engine configured? Cheap enough to call per request. */
export function asrAvailable(env = process.env) {
  return Boolean(env.DSH_ASR_CMD && env.DSH_ASR_CMD.trim());
}

function asrTimeout(env = process.env) {
  const n = Number(env.DSH_ASR_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Run the configured engine against one wav and parse whatever it produced.
 * Kept separate from `asrCues` so it can be tested without ffmpeg.
 *
 * @param {{cmd?: string, wav: string, out: string, offset?: number, signal?: any, env?: any}} opts
 * @returns {Promise<{cues: Array<{t0:number,t1:number,text:string}>, engine: string, stderr: string}>}
 */
export async function runAsrCommand(opts) {
  const env = opts.env ?? process.env;
  const cmd = opts.cmd ?? env.DSH_ASR_CMD;
  const argv = fillArgs(splitCommand(cmd), { wav: opts.wav, out: opts.out });
  if (!argv.length) throw new Error('DSH_ASR_CMD is empty');

  const bin = argv[0];
  const res = await run(bin, argv.slice(1), {
    signal: opts.signal,
    timeoutMs: asrTimeout(env),
    maxBuffer: 32 * 1024 * 1024,
  });

  // A command may either write {out} or print the subtitles; prefer the file,
  // because a chatty engine also prints progress on stdout.
  let text = '';
  try {
    text = readFileSync(opts.out, 'utf8');
  } catch {
    text = res.stdout.toString('utf8');
  }
  if (res.code !== 0 && !text.trim()) {
    const tail = res.stderr.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
    throw new Error(`ASR command exited ${res.code}${tail ? `: ${tail}` : ''}`);
  }

  const offset = Number(opts.offset) || 0;
  const cues = parseSubtitleText(text)
    .map((c) => ({ t0: +(c.t0 + offset).toFixed(2), t1: +(c.t1 + offset).toFixed(2), text: c.text }))
    .filter((c) => c.text && c.t1 > c.t0);

  return { cues, engine: bin, stderr: res.stderr.toString('utf8') };
}

/**
 * Extract the window's audio once and transcribe it.
 *
 * Timestamps come back on the *file's* clock, not the window's, so a cell at
 * 04:00 is quoted by a cue that says 04:00 — `offset` is what makes that true.
 *
 * @returns {Promise<{cues: Array<{t0:number,t1:number,text:string}>, engine: string|null, reason?: string}>}
 */
export async function asrCues(opts) {
  const { ffmpegPath, input, start = 0, end = null, signal } = opts;
  if (!asrAvailable(opts.env ?? process.env)) {
    return { cues: [], engine: null, reason: 'DSH_ASR_CMD is not set' };
  }

  const tmp = mkdtempSync(join(tmpdir(), 'vv-asr-'));
  const wav = join(tmp, 'audio.wav');
  const out = join(tmp, 'asr.out');
  try {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(start), '-i', input];
    if (end != null) args.push('-t', String(Math.max(0.2, end - start)));
    args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav);
    const res = await run(ffmpegPath, args, { signal, timeoutMs: 30 * 60 * 1000 });
    if (res.code !== 0) {
      return { cues: [], engine: null, reason: `audio extraction failed (ffmpeg ${res.code})` };
    }
    const out2 = await runAsrCommand({ wav, out, offset: start, signal, env: opts.env });
    return out2;
  } catch (err) {
    return { cues: [], engine: null, reason: err && err.message ? err.message : String(err) };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* a temp directory that will not delete is not worth failing a call over */
    }
  }
}
