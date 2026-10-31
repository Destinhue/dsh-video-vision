/**
 * media.js — find the ffmpeg toolchain, run it, and probe a file.
 *
 * Two promises this module keeps, because both are where video plugins
 * actually die on user machines:
 *
 *  1. **ffmpeg is found even when the user never installed it.** A static
 *     build shipped next to the plugin wins, then PATH, then the common
 *     install locations of the three package managers, then the binary that
 *     `pip install imageio-ffmpeg` drops into the Python runtime (a very
 *     common "I had ffmpeg once" residue).
 *  2. **ffprobe is optional.** If only ffmpeg exists we parse its banner.
 *     A video tool that refuses to start because a *metadata* binary is
 *     missing is a bad trade: the banner carries duration, size, fps,
 *     rotation and SAR, which is everything we need.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/* ------------------------------------------------------------------ exec */

/**
 * Run a process and collect its output.
 * Never rejects on a non-zero exit — callers decide what a failure means,
 * because ffmpeg exits non-zero on perfectly useful invocations.
 *
 * @returns {Promise<{code:number, stdout:Buffer, stderr:Buffer, ms:number}>}
 */
export function run(bin, args, { input = null, maxBuffer = 256 * 1024 * 1024, timeoutMs = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }
    if (signal) {
      const onAbort = () => { child.kill('SIGKILL'); finish(reject, new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (b) => {
      outLen += b.length;
      if (outLen > maxBuffer) { child.kill('SIGKILL'); return; }
      out.push(b);
    });
    // stderr is where ffmpeg writes progress AND the probe banner: keep a
    // bounded tail so a 2h encode cannot balloon memory.
    child.stderr?.on('data', (b) => {
      errLen += b.length;
      err.push(b);
      if (errLen > 4 * 1024 * 1024) { err.splice(0, err.length - 64); errLen = 4 * 1024 * 1024; }
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => finish(resolve, {
      code: typeof code === 'number' ? code : -1,
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err),
      ms: Date.now() - started,
    }));
    if (input) child.stdin.end(input);
    else child.stdin?.end();
  });
}

/** Convenience: run and return trimmed stderr (ffmpeg's real log stream). */
const _fpsModeCache = new Map();

/**
 * `-vsync 0` was removed in ffmpeg 8 and replaced by `-fps_mode passthrough`,
 * which ffmpeg < 5.1 does not know. Both mean "do not duplicate or drop frames
 * to reach a constant rate", which is what a frame-by-frame reader needs: the
 * timestamps it pairs with the pictures come from `showinfo`, and a duplicated
 * frame would make them lie.
 *
 * The choice is made once per binary by asking it its version; a build that
 * lies (or a wrapper script) is caught by the caller's retry with the other
 * spelling.
 */
export async function fpsModeArgs(ffmpegPath) {
  if (_fpsModeCache.has(ffmpegPath)) return _fpsModeCache.get(ffmpegPath);
  let args = ['-vsync', '0'];
  try {
    const { stdout, stderr } = await run(ffmpegPath, ['-hide_banner', '-version']);
    const m = /ffmpeg version\s+n?(\d+)(?:\.(\d+))?/i.exec(`${stdout}${stderr}`);
    if (m) {
      const major = Number(m[1]);
      const minor = Number(m[2] || 0);
      // `-fps_mode` arrived in 5.1; `-vsync` was removed in 8.0. Between 5.1 and
      // 7.x both work, and there we prefer the modern spelling.
      if (major > 5 || (major === 5 && minor >= 1)) args = ['-fps_mode', 'passthrough'];
    }
  } catch {
    // unknown version: keep the legacy spelling and let the caller retry
  }
  _fpsModeCache.set(ffmpegPath, args);
  return args;
}

/** the other spelling of the same flag, for a build that rejected the first */
export function altFpsModeArgs(args) {
  // Only the two spellings are interchangeable. Anything else is returned as it
  // came: inventing a flag for an argv we do not recognise would be worse than
  // failing with the original error.
  if (args[0] === '-fps_mode') return ['-vsync', '0'];
  if (args[0] === '-vsync') return ['-fps_mode', 'passthrough'];
  return args;
}

export async function runLog(bin, args, opts) {
  const r = await run(bin, args, opts);
  return r.stderr.toString('utf8');
}

/**
 * Stream stdout through a callback instead of buffering it.
 * This is how the analysis pass consumes rawvideo: a 2-hour film would be
 * hundreds of GB if we buffered it, and backpressure must reach ffmpeg so the
 * pipe stays hot instead of thrashing.
 *
 * @param {(chunk:Buffer)=>void|false} onChunk return false to stop the process
 * @returns {Promise<{code:number, stderr:Buffer, ms:number, stopped:boolean}>}
 */
export function spawnStream(bin, args, onChunk, { signal, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) { reject(error); return; }
    const err = [];
    let errLen = 0;
    let settled = false;
    let stopped = false;
    let timer = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => { child.kill('SIGKILL'); done(reject, new Error('ffmpeg timed out')); }, timeoutMs);
      timer.unref?.();
    }
    if (signal) {
      const onAbort = () => { child.kill('SIGKILL'); done(reject, new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (b) => {
      if (stopped) return;
      try {
        if (onChunk(b) === false) { stopped = true; child.kill('SIGKILL'); }
      } catch (error) {
        stopped = true;
        child.kill('SIGKILL');
        done(reject, error);
      }
    });
    child.stderr.on('data', (b) => {
      errLen += b.length;
      err.push(b);
      if (errLen > 2 * 1024 * 1024) { err.splice(0, err.length - 32); errLen = 2 * 1024 * 1024; }
    });
    child.on('error', (error) => done(reject, error));
    child.on('close', (code) => done(resolve, {
      code: typeof code === 'number' ? code : -1,
      stderr: Buffer.concat(err),
      ms: Date.now() - started,
      stopped,
    }));
  });
}

/* --------------------------------------------------------- binary lookup */

const cache = new Map();

function firstExisting(candidates) {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

function winCandidates(name) {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const files = IS_WIN ? `${name}.exe` : name;
  const list = [
    path.join(PKG_ROOT, 'vendor', 'bin', files),
    path.join(PKG_ROOT, 'vendor', files),
    path.join(PKG_ROOT, 'node_modules', 'ffmpeg-static', files),
    path.join(PKG_ROOT, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, files),
    path.join(local, 'Microsoft', 'WinGet', 'Links', files),
    `C:\\ffmpeg\\bin\\${files}`,
    `C:\\Program Files\\ffmpeg\\bin\\${files}`,
    path.join(home, 'scoop', 'shims', files),
    path.join(roaming, 'npm', files),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  return list;
}

/** Walk the known imageio-ffmpeg drop locations without importing Python. */
function imageioCandidates(kind) {
  const roots = [
    path.join(os.homedir(), '.dsh', 'dsh-runtimes'),
    path.join(process.env.LOCALAPPDATA || '', 'dsh', 'dsh-runtimes'),
  ].filter(Boolean);
  const hits = [];
  const name = kind === 'ffprobe' ? 'ffprobe' : 'ffmpeg';
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let runtimes;
    try { runtimes = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const rt of runtimes) {
      if (!rt.isDirectory()) continue;
      const pyRoot = path.join(root, rt.name, 'dependencies', 'python', 'Lib', 'site-packages');
      if (!existsSync(pyRoot)) continue;
      let pkgs;
      try { pkgs = readdirSync(pyRoot, { withFileTypes: true }); } catch { continue; }
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        if (!pkg.name.startsWith('imageio_ffmpeg') && !pkg.name.startsWith('imageio-ffmpeg')) continue;
        const binDir = path.join(pyRoot, pkg.name, 'binaries');
        if (!existsSync(binDir)) continue;
        let files;
        try { files = readdirSync(binDir); } catch { continue; }
        for (const f of files) {
          if (f.toLowerCase().startsWith(name) && (IS_WIN ? f.endsWith('.exe') : true)) {
            hits.push(path.join(binDir, f));
          }
        }
      }
    }
  }
  return hits;
}

async function usable(bin, versionArgs) {
  try {
    const r = await run(bin, versionArgs, { timeoutMs: 15_000, maxBuffer: 1 << 20 });
    return r.code === 0 || r.stderr.length > 0 || r.stdout.length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary. Tries env → shipped → imageio → PATH → system paths.
 * @param {'ffmpeg'|'ffprobe'} kind
 */
export async function findBinary(kind) {
  // Unknown kinds must not silently resolve to some other binary.
  if (kind !== 'ffmpeg' && kind !== 'ffprobe') return null;
  const key = `bin:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const envKeys = kind === 'ffmpeg'
    ? ['DSH_FFMPEG_PATH', 'DSH_VIDEO_FFMPEG', 'FFMPEG_PATH']
    : ['DSH_FFPROBE_PATH', 'DSH_VIDEO_FFPROBE', 'FFPROBE_PATH'];
  const fromEnv = firstExisting(envKeys.map((k) => process.env[k]));
  const versionArgs = kind === 'ffmpeg' ? ['-version'] : ['-version'];

  const candidates = [fromEnv, ...winCandidates(kind), ...imageioCandidates(kind)];
  for (const c of candidates) {
    if (c && existsSync(c) && await usable(c, versionArgs)) {
      cache.set(key, c);
      return c;
    }
  }
  // Bare name: let the OS resolve it through PATH.
  for (const bare of [kind]) {
    if (await usable(bare, versionArgs)) {
      cache.set(key, bare);
      return bare;
    }
  }
  cache.set(key, null);
  return null;
}

export async function findFfmpeg() { return findBinary('ffmpeg'); }
export async function findFfprobe() { return findBinary('ffprobe'); }

/** A human-readable report of what the toolchain looks like right now. */
export async function toolchainReport() {
  const [ffmpeg, ffprobe] = await Promise.all([findFfmpeg(), findFfprobe()]);
  let version = null;
  if (ffmpeg) {
    try {
      const r = await run(ffmpeg, ['-version'], { maxBuffer: 1 << 20, timeoutMs: 10_000 });
      version = (r.stdout.toString('utf8').split('\n')[0] || '').trim();
    } catch { /* ignore */ }
  }
  return { ffmpeg, ffprobe, version, probeMode: ffprobe ? 'ffprobe' : ffmpeg ? 'banner' : 'none' };
}

/* ---------------------------------------------------------------- probe */

export function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [num, den = '1'] = value.split('/');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function parseSar(value) {
  if (typeof value !== 'string' || !value.includes(':')) return 1;
  const [num, den = '1'] = value.split(':');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0 || a <= 0) return 1;
  return a / b;
}

export function normalizeRotation(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  let a = v % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.round(a);
}

export function uprightSize(codedWidth, codedHeight, rotation) {
  return Math.abs(rotation) % 180 === 90
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}

export function displayAspect(codedW, codedH, sar, rotation = 0) {
  if (!(codedW > 0) || !(codedH > 0)) return 16 / 9;
  const dar = (codedW * (sar > 0 ? sar : 1)) / codedH;
  return Math.abs(rotation) % 180 === 90 ? 1 / dar : dar;
}

/** End-of-file safety margin: sampling exactly at `duration` yields no frame. */
export const endEdge = (fps) => (fps > 0 ? 0.5 / fps : 0.02);

function emptyInfo(pathIn) {
  return {
    path: pathIn, duration: 0, width: 0, height: 0, coded: { width: 0, height: 0 },
    rotation: 0, fps: 25, sar: 1, aspect: 16 / 9, videoCodec: 'unknown',
    container: 'unknown', hasAudio: false, hasSubtitle: false, audioCodec: null,
    bitrate: 0, probeMode: 'none',
  };
}

/**
 * Parse `ffmpeg -i file` machine-ish output. This is the ffprobe-less path.
 * ffmpeg writes the same facts to stderr before it complains about a missing
 * output file, so we run it with `-t 0 -f null -` to get a clean, fast banner
 * without decoding a single frame of the payload.
 */
export function parseFfmpegBanner(text, pathIn) {
  const info = emptyInfo(pathIn);
  info.probeMode = 'banner';
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (dur) info.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const br = /bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (br) info.bitrate = Number(br[1]) * 1000;

  const streamRe = /Stream #\d+:\d+.*?: (Video|Audio|Subtitle): ([^\n]+)/g;
  let m;
  let sawVideo = false;
  while ((m = streamRe.exec(text)) !== null) {
    const kind = m[1];
    const body = m[2];
    if (kind === 'Audio') {
      // First audio stream wins, same as video: a container can carry a second
      // PCM/commentary track after the real AAC one, and the last writer would
      // otherwise win and misreport the codec.
      if (!info.hasAudio) {
        info.hasAudio = true;
        info.audioCodec = body.split(/[,\s]/)[0];
      }
      continue;
    }
    if (kind === 'Subtitle') { info.hasSubtitle = true; continue; }
    // Only the first video stream wins; attached cover art comes later.
    if (kind !== 'Video' || sawVideo) continue;
    sawVideo = true;

    info.videoCodec = body.split(/[,\s]/)[0];
    const size = /(\d{2,5})x(\d{2,5})/.exec(body);
    if (size) { info.coded = { width: Number(size[1]), height: Number(size[2]) }; }
    const sar = /\[SAR (\d+:\d+) DAR (\d+:\d+)\]/.exec(body);
    if (sar) info.sar = parseSar(sar[1]);
    const fps = /([\d.]+) fps/.exec(body) || /([\d.]+) tbr/.exec(body);
    if (fps) info.fps = Number(fps[1]) || 25;
    // "0x1: 1920x1080" in the displaymatrix side data is the *coded* size too.
    if (!info.width) {
      const dm = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(text);
      if (dm) info.rotation = normalizeRotation(Number(dm[1]));
    }
  }
  const rot = /rotate\s*:\s*(-?\d+)/.exec(text) || /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(text);
  if (rot) info.rotation = normalizeRotation(Number(rot[1]));

  finalize(info);
  return info;
}

function finalize(info) {
  const upright = uprightSize(info.coded.width, info.coded.height, info.rotation);
  info.width = upright.width;
  info.height = upright.height;
  info.aspect = displayAspect(info.coded.width, info.coded.height, info.sar, info.rotation);
  if (!(info.duration > 0)) info.duration = 0;
  if (!(info.fps > 0)) info.fps = 25;
  return info;
}

/**
 * The argument vector for the ffprobe-less banner read.
 *
 * `-t 0` is not cosmetic: without it the null muxer decodes the WHOLE input and
 * throws it away — measured 130 s on a two-hour lecture file against a 60 s
 * budget, so a long video simply failed to probe. With `-t 0` the same file
 * answers in 142 ms, and every line the parser wants is already on stderr by
 * the time the input has been opened.
 */
const NET_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** is this input a URL rather than a path on disk? */
export function isNetworkInput(input) {
  return /^https?:\/\//i.test(String(input || ''));
}

/**
 * ffmpeg/ffprobe arguments that make a remote input readable.
 *
 * The Bilibili CDN answers 403 to a plain GET: it wants a Referer and a
 * desktop User-Agent, and both have to be one `-headers` argument with CRLF
 * separators (a bare newline is treated as a separate option and fails).
 */
export function netInputArgs(input, env = process.env) {
  if (!isNetworkInput(input)) return [];
  const referer = env.DSH_HTTP_REFERER || 'https://www.bilibili.com';
  const ua = env.DSH_HTTP_UA || NET_UA;
  return ['-headers', `Referer: ${referer}\r\nUser-Agent: ${ua}\r\n`];
}

export function bannerProbeArgs(input) {
  return ['-hide_banner', '-nostdin', ...netInputArgs(input), '-i', input,
    '-t', '0', '-f', 'null', '-'];
}

/**
 * Probe a local file. Uses ffprobe when present, otherwise the ffmpeg banner.
 * @param {string} input
 * @param {{ffprobePath?:string|null, ffmpegPath?:string|null}} [opts]
 */
/**
 * Turn ffmpeg's stderr into one readable sentence.
 *
 * Raw stderr is 10–20 lines of banner, stream table and a muxing summary; pasted
 * into a tool error it both costs tokens and buries the actual cause. Keep the
 * last diagnostic line that looks like a diagnosis and drop the rest.
 */
export function summarizeFfmpegError(stderr, { maxChars = 160 } = {}) {
  const text = String(stderr || '').replace(/\u0000/g, '').split(/\r?\n/);
  const interesting = text
    .map((line) => line.trim())
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, ''))
    .filter((line) => line && !/^(?:ffmpeg version|built with|configuration:|lib[a-z0-9]+ +[0-9]|Metadata:|encoder +:|handler_name|vendor_id|major_brand|minor_version|compatible_brands|Duration:|Stream #|Input #|Output #|size=|Press \[q\])/i.test(line));
  const last = interesting[interesting.length - 1] || '';
  const picked = last || String(stderr || '').trim().split(/\r?\n/).pop() || 'ffmpeg failed';
  return picked.length > maxChars ? `${picked.slice(0, maxChars - 1)}…` : picked;
}

export async function probeVideo(input, opts = {}) {
  // Fail on the two mistakes a caller actually makes — a typo and a directory —
  // before spending an ffmpeg spawn and then reporting "cannot read metadata".
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(input))) {
    try {
      if (statSync(String(input)).isDirectory()) throw new Error(`not a file (it is a directory) — "${input}"`);
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error(`file not found — "${input}"`);
      if (error && error.code === 'EACCES') throw new Error(`permission denied — "${input}"`);
      if (error && !error.code) throw error;
    }
  }
  const ffprobePath = opts.ffprobePath === undefined ? await findFfprobe() : opts.ffprobePath;
  if (ffprobePath) {
    try {
      const r = await run(ffprobePath, [
        '-v', 'error', ...netInputArgs(input),
        '-print_format', 'json', '-show_format', '-show_streams', input,
      ], { maxBuffer: 16 * 1024 * 1024, timeoutMs: 60_000 });
      const parsed = JSON.parse(r.stdout.toString('utf8'));
      return finalizeFromProbe(parsed, input);
    } catch {
      /* fall through to the banner */
    }
  }
  const ffmpegPath = opts.ffmpegPath === undefined ? await findFfmpeg() : opts.ffmpegPath;
  if (!ffmpegPath) throw new Error('no ffmpeg and no ffprobe found — cannot read the video');
  const r = await run(ffmpegPath, bannerProbeArgs(input), {
    maxBuffer: 8 * 1024 * 1024, timeoutMs: 60_000,
  });
  const info = parseFfmpegBanner(r.stderr.toString('utf8'), input);
  if (!(info.coded.width > 0)) {
    const detail = r.stderr.toString('utf8');
    const audioOnly = /\bAudio:/.test(detail) && !/\bVideo:/.test(detail);
    const why = audioOnly
      ? 'no video stream (this file is audio only)'
      : /No such file|Invalid data|could not find codec|moov atom/i.test(detail)
        ? summarizeFfmpegError(detail)
        : 'cannot read video metadata';
    const error = new Error(`${why} — "${input}"`);
    error.detail = summarizeFfmpegError(detail, { maxChars: 800 });
    throw error;
  }
  return info;
}

export function finalizeFromProbe(parsed, pathIn) {
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  if (!video) {
    const audio = streams.find((s) => s?.codec_type === 'audio');
    throw new Error(audio
      ? `no video stream (this file is audio only) — "${pathIn}"`
      : `no video stream — "${pathIn}"`);
  }
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const subtitle = streams.find((s) => s?.codec_type === 'subtitle');
  const duration = Number(parsed?.format?.duration) || Number(video?.duration) || 0;
  const rotation = normalizeRotation(
    video?.side_data_list?.find((d) => d?.rotation !== undefined)?.rotation ?? video?.tags?.rotate,
  );
  const coded = { width: Number(video.width) || 0, height: Number(video.height) || 0 };
  const rFps = parseRational(video.r_frame_rate);
  const avgFps = parseRational(video.avg_frame_rate);
  const info = {
    path: pathIn,
    duration,
    coded,
    rotation,
    fps: (rFps && rFps <= 240 ? rFps : null) ?? avgFps ?? 25,
    sar: parseSar(video.sample_aspect_ratio),
    videoCodec: video.codec_name ?? 'unknown',
    container: parsed?.format?.format_name ?? 'unknown',
    hasAudio: Boolean(audio),
    hasSubtitle: Boolean(subtitle),
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number(parsed?.format?.bit_rate) || 0,
    probeMode: 'ffprobe',
  };
  finalize(info);
  return info;
}
