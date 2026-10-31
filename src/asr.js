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
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, netInputArgs } from './media.js';
import { parseSubtitleText } from './timeline.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Two failure modes belong to the CLIENT, not to the engine, because every
 * engine has them and every caller would otherwise reinvent them:
 *
 *   1. music. Given a minute of instrumental, a recogniser does not return
 *      nothing — it invents a sentence and hands it a long timestamp. Cells are
 *      quoted by time overlap, so one invented line is quoted on every cell it
 *      touches. Filtered here, counted, and reported: a filter that hides its
 *      own work is indistinguishable from a bug.
 *   2. vocabulary. Models are trained on the internet, and a lecture is not the
 *      internet: `递推` comes back `地规`, `阶乘` comes back `階層`. A small
 *      deterministic dictionary fixes more than a bigger model does.
 */
const SUSPECT_MIN_SECONDS = 8;
const SUSPECT_MAX_CHARS_PER_SEC = 0.8;

/** Content characters: CJK or a word, the same rule the reader uses. */
function contentLength(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const han = (s.match(/[\u3400-\u9fff]/g) ?? []).length;
  const words = (s.match(/[A-Za-z]{2,}/g) ?? []).length;
  return han + words;
}

/**
 * Drop segments that no human could have said.
 *
 * Two shapes only, both measured on real material: punctuation-only, and a
 * segment longer than 8 s at under 0.8 characters per second (real speech runs
 * 2-6). Everything dropped is counted so the manifest can say so.
 */
export function filterSuspectSegments(cues, opts = {}) {
  const minDur = Number(opts.minDur ?? SUSPECT_MIN_SECONDS);
  const maxRate = Number(opts.maxCharsPerSec ?? SUSPECT_MAX_CHARS_PER_SEC);
  const kept = [];
  const dropped = [];
  for (const c of cues ?? []) {
    const dur = c.t1 - c.t0;
    const chars = contentLength(c.text);
    if (!chars) { dropped.push({ ...c, why: 'punctuation' }); continue; }
    if (dur > minDur && chars / dur < maxRate) { dropped.push({ ...c, why: 'too-sparse' }); continue; }
    kept.push(c);
  }
  return { cues: kept, dropped };
}

/**
 * Simplified/Traditional pairs that show up in Chinese technical speech.
 *
 * Not a converter — a short list of the characters a lecture actually contains.
 * It exists because of a measurement: whisper `small` on Mandarin returns
 * **Traditional** characters, so a dictionary keyed `递推` silently missed the
 * `遞推` it was written for. Variants are generated from the key, so the user
 * writes one spelling and the other one works too.
 */
const SCRIPT_PAIRS = [
  ['规', '規'], ['递', '遞'], ['阶', '階'], ['选', '選'], ['归', '歸'], ['数', '數'],
  ['论', '論'], ['层', '層'], ['证', '證'], ['题', '題'], ['问', '問'], ['开', '開'],
  ['关', '關'], ['长', '長'], ['边', '邊'], ['点', '點'], ['线', '線'], ['图', '圖'],
  ['变', '變'], ['极', '極'], ['条', '條'], ['项', '項'], ['组', '組'], ['合', '合'],
  ['设', '設'], ['计', '計'], ['算', '算'], ['这', '這'], ['个', '個'], ['从', '從'],
  ['后', '後'], ['来', '來'], ['时', '時'], ['间', '間'], ['对', '對'], ['应', '應'],
  ['进', '進'], ['过', '過'], ['还', '還'], ['么', '麼'], ['为', '為'], ['会', '會'],
  ['发', '發'], ['现', '現'], ['实', '實'], ['际', '際'], ['区', '區'], ['间', '間'],
  ['积', '積'], ['导', '導'], ['术', '術'], ['项', '項'], ['级', '級'], ['类', '類'],
];

const TO_FAN = new Map(SCRIPT_PAIRS);
const TO_JIAN = new Map(SCRIPT_PAIRS.map(([j, f]) => [f, j]));

/** Spellings of a key worth trying: itself plus single-character script swaps. */
export function scriptVariants(key) {
  const out = new Set([key]);
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    const other = TO_FAN.get(ch) ?? TO_JIAN.get(ch);
    if (!other) continue;
    out.add(key.slice(0, i) + other + key.slice(i + 1));
  }
  return [...out];
}

/**
 * Apply a term dictionary to text. Longest key first, single pass, so
 * `八羽怪` cannot be half-corrected by an entry for `羽`. Each key is tried in
 * both scripts, so a Simplified dictionary fixes Traditional output.
 *
 * @returns {{text: string, applied: number}}
 */
export function applyTermMap(text, terms) {
  const src = String(text ?? '');
  const keys = Object.keys(terms ?? {}).filter((k) => k && k.length);
  if (!keys.length || !src) return { text: src, applied: 0 };
  keys.sort((a, b) => b.length - a.length);
  let out = src;
  let applied = 0;
  for (const from of keys) {
    const to = String(terms[from] ?? '');
    if (!to) continue;
    // Try the key and its script twins: the model decides which script it
    // returns, and the user should not have to know that.
    for (const spelling of scriptVariants(from)) {
      if (!out.includes(spelling)) continue;
      // split/join instead of a built regex: the key is arbitrary user text, and
      // `String.prototype.replaceAll` would still treat `$&` in `to` specially.
      const parts = out.split(spelling);
      applied += parts.length - 1;
      out = parts.join(to);
    }
  }
  return { text: out, applied };
}

/** `~/.dsh/asr.json`: {"cmd": "...", "terms": {"地规": "递推"}} */
export function asrConfigPath(env = process.env) {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'asr.json');
}

/**
 * Settings, in the order a user expects: environment over file.
 * The file exists because a desktop host does not inherit `setx` variables.
 */
export function loadAsrSettings(env = process.env) {
  const out = { cmd: '', terms: {}, minDur: SUSPECT_MIN_SECONDS, maxCharsPerSec: SUSPECT_MAX_CHARS_PER_SEC, source: 'none' };
  try {
    const raw = JSON.parse(readFileSync(asrConfigPath(env), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.cmd === 'string') { out.cmd = raw.cmd; out.source = 'file'; }
      if (raw.terms && typeof raw.terms === 'object') out.terms = raw.terms;
      if (Number.isFinite(raw.minDur)) out.minDur = raw.minDur;
      if (Number.isFinite(raw.maxCharsPerSec)) out.maxCharsPerSec = raw.maxCharsPerSec;
    }
  } catch { /* no file, or a file someone is still editing */ }
  const envCmd = env.DSH_ASR_CMD?.trim();
  if (envCmd) { out.cmd = envCmd; out.source = 'env'; }
  return out;
}

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
export function asrAvailable(env = process.env, settings = null) {
  if (env.DSH_ASR_CMD && env.DSH_ASR_CMD.trim()) return true;
  const s = settings ?? loadAsrSettings(env);
  return Boolean(s.cmd && s.cmd.trim());
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
  const settings = opts.settings ?? loadAsrSettings(env);
  const cmd = opts.cmd ?? settings.cmd ?? env.DSH_ASR_CMD;
  const argv = fillArgs(splitCommand(cmd), { wav: opts.wav, out: opts.out });
  if (!argv.length) throw new Error('no ASR command configured (DSH_ASR_CMD or ~/.dsh/asr.json)');

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
  const parsed = parseSubtitleText(text)
    .map((c) => ({ t0: +(c.t0 + offset).toFixed(2), t1: +(c.t1 + offset).toFixed(2), text: c.text }))
    .filter((c) => c.text && c.t1 > c.t0);

  // Hallucination filter, then the term dictionary, then the engine's own
  // timestamps are kept as-is: fixing words is safe, moving time is not.
  const filtered = filterSuspectSegments(parsed, {
    minDur: settings.minDur,
    maxCharsPerSec: settings.maxCharsPerSec,
  });
  let terms = 0;
  const cues = filtered.cues.map((c) => {
    const fixed = applyTermMap(c.text, settings.terms);
    terms += fixed.applied;
    return { ...c, text: fixed.text };
  });

  return {
    cues,
    engine: bin,
    stderr: res.stderr.toString('utf8'),
    dropped: filtered.dropped,
    terms,
  };
}

/**
 * Long audio is transcribed in pieces.
 *
 * Two hours of 16 kHz mono wav is 230 MB, and engines that take a file like
 * that either truncate it, hold the whole thing in one process for half an hour,
 * or die. Cutting it up is not enough on its own: a boundary dropped in the
 * middle of a word is a word lost, while a boundary dropped in a pause is
 * invisible — so the cuts are moved onto the silences ffmpeg can find.
 *
 * All five knobs are environment variables, because the useful length differs
 * per engine (whisper wants 30 s windows, a cloud API may want minutes):
 *
 *   DSH_ASR_CHUNK_SECONDS  target chunk length, 0 disables chunking (45)
 *   DSH_ASR_CHUNK_MIN      shortest chunk worth cutting at (12)
 *   DSH_ASR_PARALLEL       chunks transcribed at once (2)
 *   DSH_ASR_SILENCE_DB     pause threshold (dB, -32)
 *   DSH_ASR_SILENCE_MIN    shortest pause worth cutting at (s, 0.35)
 */
const CHUNK_DEFAULTS = { seconds: 45, minSeconds: 12, parallel: 2, silenceDb: -32, silenceMin: 0.35 };

/** How to slice the audio, read from the environment with sane limits. */
export function asrChunkSettings(env = process.env) {
  const num = (raw, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const seconds = Math.min(600, Math.max(0, num(env.DSH_ASR_CHUNK_SECONDS, CHUNK_DEFAULTS.seconds)));
  return {
    seconds,
    minSeconds: Math.max(1, Math.min(seconds || CHUNK_DEFAULTS.minSeconds,
      num(env.DSH_ASR_CHUNK_MIN, CHUNK_DEFAULTS.minSeconds))),
    parallel: Math.min(8, Math.max(1, Math.round(num(env.DSH_ASR_PARALLEL, CHUNK_DEFAULTS.parallel)))),
    silenceDb: num(env.DSH_ASR_SILENCE_DB, CHUNK_DEFAULTS.silenceDb),
    silenceMin: Math.max(0.1, num(env.DSH_ASR_SILENCE_MIN, CHUNK_DEFAULTS.silenceMin)),
  };
}

/**
 * The pauses ffmpeg's `silencedetect` announced, as intervals.
 *
 * The filter prints a start, then an end with the length, so the intervals have
 * to be paired up here. A pause that never ended is the normal shape of a file
 * that stops in silence; it is kept as a zero-length interval, which is still a
 * legal place to cut.
 *
 * @param {string} stderr
 * @param {number} [offset] seconds skipped before the filter ran (its clock starts at 0)
 */
export function parseSilencePoints(stderr, offset = 0) {
  const out = [];
  let open = null;
  const mark = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/;
  for (const raw of String(stderr ?? '').split(/\r?\n/)) {
    const m = mark.exec(raw);
    if (!m) continue;
    const at = Number(m[2]) + offset;
    if (m[1] === 'start') {
      open = at;
    } else if (open != null) {
      out.push({ from: open, to: at });
      open = null;
    }
  }
  if (open != null) out.push({ from: open, to: open });
  return out;
}

/**
 * Where to cut the audio.
 *
 * Greedy from the window's start: aim for `maxSeconds`, then walk back to the
 * last pause midpoint that is at least `minSeconds` into the chunk. Without a
 * pause the cut falls at the target, which is the best a fixed grid can do.
 * A sliver at the end is folded into the chunk before it — an engine given
 * 0.4 s of audio usually returns nothing at all.
 *
 * @returns {{from:number, to:number}[]} on the input's clock
 */
export function planAudioChunks(opts = {}) {
  const start = Math.max(0, Number(opts.start) || 0);
  const maxSeconds = Number(opts.maxSeconds ?? CHUNK_DEFAULTS.seconds);
  const minSeconds = Number(opts.minSeconds ?? CHUNK_DEFAULTS.minSeconds);
  const asked = Number(opts.end);
  const known = Number(opts.duration);
  const limit = asked > start ? asked : (known > start ? known : null);
  if (limit == null) return [{ from: start, to: null }];
  if (!(maxSeconds > 0) || limit - start <= maxSeconds) return [{ from: start, to: limit }];
  const middles = (opts.silences ?? [])
    .map((s) => (Number(s.to) > Number(s.from) ? (Number(s.from) + Number(s.to)) / 2 : Number(s.from)))
    .filter((at) => Number.isFinite(at))
    .sort((a, b) => a - b);
  const chunks = [];
  let cursor = start;
  while (limit - cursor > maxSeconds) {
    const target = cursor + maxSeconds;
    let cut = target;
    for (const at of middles) {
      if (at > cursor + minSeconds && at <= target) cut = at;
    }
    chunks.push({ from: cursor, to: +cut.toFixed(3) });
    cursor = cut;
  }
  chunks.push({ from: cursor, to: limit });
  const sliver = Math.min(2, minSeconds / 2);
  while (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (last.to - last.from >= sliver) break;
    chunks.pop();
    chunks[chunks.length - 1].to = last.to;
  }
  return chunks;
}

/**
 * One decode pass that only listens for pauses; no audio is written, because the
 * point of chunking is not to make a bigger file.
 */
export async function detectSilences(opts) {
  const { ffmpegPath, input, signal } = opts;
  const start = Number(opts.start) || 0;
  const end = Number(opts.end) > start ? Number(opts.end) : null;
  const settings = opts.settings ?? CHUNK_DEFAULTS;
  const db = Number(settings.silenceDb ?? CHUNK_DEFAULTS.silenceDb);
  const min = Number(settings.silenceMin ?? CHUNK_DEFAULTS.silenceMin);
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info',
    '-ss', String(start), ...netInputArgs(input), '-i', input];
  if (end != null) args.push('-t', String(Math.max(0.2, end - start)));
  args.push('-vn', '-sn', '-dn', '-af', 'silencedetect=noise=' + db + 'dB:d=' + min, '-f', 'null', '-');
  const started = Date.now();
  const res = await run(ffmpegPath, args, { signal, timeoutMs: 30 * 60 * 1000 });
  return {
    silences: parseSilencePoints(res.stderr.toString('utf8'), start),
    ms: Date.now() - started,
    failed: res.code !== 0,
  };
}

/** extract 16 kHz mono pcm into `wav`; returns the exit code */
async function extractAudio({ ffmpegPath, input, from = 0, to = null, wav, signal }) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(from), ...netInputArgs(input), '-i', input];
  if (to != null && to > from) args.push('-t', String(Math.max(0.2, to - from)));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav);
  const res = await run(ffmpegPath, args, { signal, timeoutMs: 30 * 60 * 1000 });
  return res.code;
}

/** mm:ss, for an error message about one chunk */
function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
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
  const env = opts.env ?? process.env;
  const settings = opts.settings ?? loadAsrSettings(env);
  if (!asrAvailable(env, settings)) {
    return { cues: [], engine: null, reason: 'no ASR engine configured (DSH_ASR_CMD or ~/.dsh/asr.json)' };
  }

  // How long the window is: the caller knows better than we do, because `end`
  // may be null (read the whole file) and the container may be silent about it.
  const askedEnd = Number(end);
  const known = Number(opts.duration);
  const limit = askedEnd > start ? askedEnd : (known > start ? known : null);
  const span = limit == null ? null : limit - start;
  const chunk = asrChunkSettings(env);

  const tmp = mkdtempSync(join(tmpdir(), 'vv-asr-'));
  try {
    if (!(chunk.seconds > 0) || span == null || span <= chunk.seconds) {
      const wav = join(tmp, 'audio.wav');
      const code = await extractAudio({ ffmpegPath, input, from: start, to: limit, wav, signal });
      if (code !== 0) {
        return { cues: [], engine: null, chunked: false, chunks: 1, reason: `audio extraction failed (ffmpeg ${code})` };
      }
      const heard = await runAsrCommand({ wav, out: join(tmp, 'asr.out'), offset: start, signal, env, settings });
      return { ...heard, chunked: false, chunks: 1 };
    }

    // Long window: listen for pauses first (one decode pass, no audio written),
    // then transcribe the pieces at once. A failure to find pauses is not fatal —
    // a fixed grid is still better than one 230 MB wav.
    const pauses = await detectSilences({ ffmpegPath, input, start, end: limit, signal, settings: chunk })
      .catch(() => ({ silences: [], ms: 0, failed: true }));
    const plan = planAudioChunks({
      start, end: limit, maxSeconds: chunk.seconds, minSeconds: chunk.minSeconds, silences: pauses.silences,
    });
    const results = await mapPool(plan, chunk.parallel, async (piece, index) => {
      const name = 'chunk-' + String(index).padStart(3, '0');
      const wav = join(tmp, name + '.wav');
      const code = await extractAudio({ ffmpegPath, input, from: piece.from, to: piece.to, wav, signal });
      if (code !== 0) return { piece, error: `audio extraction failed (ffmpeg ${code})` };
      try {
        const heard = await runAsrCommand({
          wav, out: join(tmp, name + '.srt'), offset: piece.from, signal, env, settings,
        });
        return { piece, heard };
      } catch (error) {
        return { piece, error: error && error.message ? error.message : String(error) };
      }
    });

    const cues = [];
    const dropped = [];
    const errors = [];
    let terms = 0;
    let engine = null;
    for (const result of results) {
      if (result.error) {
        errors.push(`chunk at ${clock(result.piece.from)}: ${result.error}`);
        continue;
      }
      const heard = result.heard;
      if (!engine && heard.engine) engine = heard.engine;
      terms += heard.terms ?? 0;
      if (heard.dropped) dropped.push(...heard.dropped);
      for (const cue of heard.cues ?? []) cues.push(cue);
    }
    cues.sort((a, b) => a.t0 - b.t0);
    // A cut can make the engine repeat the last line on both sides of it.
    const merged = [];
    for (const cue of cues) {
      const prev = merged[merged.length - 1];
      if (prev && prev.text === cue.text && Math.abs(prev.t0 - cue.t0) < 0.5) continue;
      merged.push(cue);
    }
    const out = {
      cues: merged,
      engine,
      chunked: true,
      chunks: plan.length,
      dropped,
      terms,
      failed: errors.length,
      silenceMs: pauses.ms ?? null,
    };
    if (errors.length) out.reason = `${errors.length} of ${plan.length} audio chunk(s) failed — ${errors[0]}`;
    return out;
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
