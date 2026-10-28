import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  run,
  findBinary,
  findFfmpeg,
  findFfprobe,
  probeVideo,
  parseRational,
  parseSar,
  normalizeRotation,
  uprightSize,
  displayAspect,
  parseFfmpegBanner,
} from '../src/media.js';

const BANNER = `ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
  built with gcc 13.2.0 (GCC)
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'demo.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:06.00, start: 0.000000, bitrate: 1234 kb/s
  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 1198 kb/s, 30 fps, 30 tbr, 15360 tbn, 60 tbc (default)
    Metadata:
      encoder         : Lavf61.1.100
      rotate          : -90
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:2(und): Subtitle: mov_text (tx3g / 0x67337874), 0 kb/s (default)
At least one output file must be specified`;

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));
const CORPUS = fileURLToPath(new URL('../bench/corpus/A_hardcuts_720p.mp4', import.meta.url));

test('a realistic banner yields duration, size, fps and stream flags', () => {
  const info = parseFfmpegBanner(BANNER, 'demo.mp4');
  assert.equal(info.duration, 6);
  assert.equal(info.bitrate, 1234000);
  assert.deepEqual(info.coded, { width: 1920, height: 1080 });
  assert.equal(info.rotation, -90);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(info.aspect, 0.5625);
  assert.equal(info.fps, 30);
  assert.equal(info.sar, 1);
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.equal(info.hasAudio, true);
  assert.equal(info.hasSubtitle, true);
  assert.equal(info.probeMode, 'banner');
});

test('a quarter-turn from the display matrix is applied to the upright size', () => {
  const text = BANNER.replace(/^.*rotate.*$/m, '').replace('displaymatrix: rotation of -90.00 degrees', 'displaymatrix: rotation of 90.00 degrees');
  const info = parseFfmpegBanner(text, 'x.mp4');
  assert.equal(info.rotation, 90);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
});

test('the first video stream wins over later cover-art streams', () => {
  const text = `Input #0, mp4, from 'cover.mp4':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 800 kb/s
  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 700 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1(und): Video: mjpeg (Baseline), yuvj420p, 320x240 [SAR 1:1 DAR 4:3], 90k tbr, 90k tbn (attached pic)
`;
  const info = parseFfmpegBanner(text, 'cover.mp4');
  assert.equal(info.videoCodec, 'h264');
  assert.deepEqual(info.coded, { width: 1920, height: 1080 });
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
});

test('without ffprobe the banner path still returns real facts', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  if (!existsSync(CORPUS)) return t.skip('bench corpus clip missing');
  const info = await probeVideo(CORPUS, { ffprobePath: null, ffmpegPath });
  assert.equal(info.probeMode, 'banner');
  assert.ok(Math.abs(info.duration - 40) < 1.5, `duration ${info.duration}`);
  assert.ok(info.coded.width >= 640 && info.coded.height >= 360, JSON.stringify(info.coded));
  assert.ok(info.fps > 0);
});

test('a tbr line stands in when no fps is printed', () => {
  const text = `Input #0, matroska,webm, from 'x.mkv':
  Duration: 00:00:03.20, start: 0.000000, bitrate: 500 kb/s
  Stream #0:0: Video: mpeg4 (Simple Profile), yuv420p, 640x480 [SAR 1:1 DAR 4:3], 500 kb/s, 25 tbr, 25 tbn, 50 tbc`;
  const info = parseFfmpegBanner(text, 'x.mkv');
  assert.equal(info.fps, 25);
  assert.equal(info.width, 640);
  assert.equal(info.height, 480);
  assert.equal(info.aspect, 640 / 480);
  assert.equal(info.rotation, 0);
});

test('an audio-only file has no picture and defaults to 16:9', () => {
  const text = `Input #0, mp3, from 'song.mp3':
  Duration: 00:04:00.00, start: 0.000000, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s`;
  const info = parseFfmpegBanner(text, 'song.mp3');
  assert.equal(info.width, 0);
  assert.equal(info.height, 0);
  assert.equal(info.hasAudio, true);
  assert.equal(info.hasSubtitle, false);
  assert.equal(info.videoCodec, 'unknown');
  assert.equal(info.aspect, 16 / 9);
});

test('a banner with no metadata at all still yields a complete shape', () => {
  const info = parseFfmpegBanner('', 'missing.mp4');
  assert.equal(info.path, 'missing.mp4');
  assert.equal(info.duration, 0);
  assert.equal(info.width, 0);
  assert.equal(info.height, 0);
  assert.equal(info.fps, 25);
  assert.equal(info.sar, 1);
  assert.equal(info.aspect, 16 / 9);
  assert.equal(info.hasAudio, false);
  assert.equal(info.hasSubtitle, false);
  assert.equal(info.probeMode, 'banner');
});

test('parseRational reads a real ratio and rejects nonsense', () => {
  assert.equal(parseRational('30000/1001'), 30000 / 1001);
  assert.equal(parseRational('30'), 30);
  assert.equal(parseRational('0/1'), null);
  assert.equal(parseRational('1/0'), null);
  assert.equal(parseRational('-2/1'), null);
  assert.equal(parseRational('abc'), null);
  assert.equal(parseRational(''), null);
  assert.equal(parseRational(null), null);
  assert.equal(parseRational(30), null);
});

test('parseSar defaults to square pixels', () => {
  assert.equal(parseSar(null), 1);
  assert.equal(parseSar('1:1'), 1);
  assert.equal(parseSar(undefined), 1);
  assert.equal(parseSar('4:3'), 4 / 3);
  assert.equal(parseSar('0:1'), 1);
  assert.equal(parseSar('1:0'), 1);
  assert.equal(parseSar('nonsense'), 1);
});

test('normalizeRotation wraps into (-180, 180]', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), -90);
  // 270° and -270° are quarter turns; (-180, 180] names them -90 and +90.
  assert.equal(normalizeRotation(270), -90);
  assert.equal(normalizeRotation(-270), 90);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-450), -90);
  assert.equal(normalizeRotation(180), 180);
  assert.equal(normalizeRotation('90'), 90);
  assert.equal(normalizeRotation(89.6), 90);
  assert.equal(normalizeRotation(undefined), 0);
  assert.equal(normalizeRotation(Number.NaN), 0);
});

test('uprightSize swaps the axes for quarter turns only', () => {
  assert.deepEqual(uprightSize(1920, 1080, 90), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, -90), { width: 1080, height: 1920 });
  assert.deepEqual(uprightSize(1920, 1080, 180), { width: 1920, height: 1080 });
  assert.deepEqual(uprightSize(1920, 1080, 0), { width: 1920, height: 1080 });
});

test('displayAspect accounts for SAR and rotation', () => {
  assert.ok(Math.abs(displayAspect(1920, 1080, 1) - 16 / 9) < 1e-12);
  assert.equal(displayAspect(1920, 1080, 1, 90), 1080 / 1920);
  assert.equal(displayAspect(720, 480, 4 / 3), 2);
  assert.equal(displayAspect(0, 1080), 16 / 9);
  assert.equal(displayAspect(1920, 0), 16 / 9);
});

test('findFfprobe returns null when only ffmpeg is on PATH', async (t) => {
  const real = await findFfmpeg();
  if (!real) return t.skip('no ffmpeg on this machine to put on PATH');
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'path-'));
  // Windows sometimes holds a fresh exe for a moment (Defender); retry the delete.
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  try {
    linkSync(real, join(dir, 'ffmpeg.exe'));
  } catch {
    return t.skip('cannot hardlink ffmpeg into the temp dir');
  }
  const saved = {};
  for (const k of ['PATH', 'DSH_FFPROBE_PATH', 'DSH_VIDEO_FFPROBE', 'FFPROBE_PATH']) saved[k] = process.env[k];
  try {
    for (const k of ['DSH_FFPROBE_PATH', 'DSH_VIDEO_FFPROBE', 'FFPROBE_PATH']) delete process.env[k];
    process.env.PATH = dir;
    const found = await findBinary('ffprobe');
    if (found && /ffprobe(?:\.exe)?$/i.test(found)) return t.skip(`a real ffprobe exists at ${found}`);
    assert.equal(found, null);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('findBinary returns a string path or null, never a broken value', async () => {
  for (const kind of ['ffmpeg', 'ffprobe']) {
    const found = await findBinary(kind);
    assert.ok(found === null || typeof found === 'string', `${kind}: ${String(found)}`);
  }
  const ffmpeg = await findFfmpeg();
  const ffprobe = await findFfprobe();
  assert.ok(ffmpeg === null || typeof ffmpeg === 'string');
  assert.ok(ffprobe === null || typeof ffprobe === 'string');
  // An unknown kind is rejected, never silently resolved to some other binary.
  assert.equal(await findBinary('nonsense-tool'), null);
});

test('run captures stdout and a zero exit code', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), 'hi');
  assert.ok(result.stderr.length === 0);
  assert.equal(typeof result.ms, 'number');
});

test('run resolves a non-zero exit instead of rejecting', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("bye"); process.exit(3)']);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.toString(), 'bye');
});

test('run rejects when the binary cannot be spawned', async () => {
  await assert.rejects(run('definitely-not-a-real-binary-xyz', []));
});
