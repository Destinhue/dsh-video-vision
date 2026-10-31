import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, findFfmpeg, findFfprobe } from '../src/media.js';
import { runStoryboard, windowNotes } from '../src/pipeline.js';
import { keyframeGap, scanShots } from '../src/scan.js';

const VENDOR = 'F:\\ai\\v4video\\vendor\\bin';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url));

async function resolveTool(name, envKey, finder) {
  if (process.env[envKey]) return process.env[envKey];
  const found = await finder();
  if (found) return found;
  const literal = join(VENDOR, name);
  return existsSync(literal) ? literal : null;
}

test('the real pipeline turns one clip into one sheet, manifest and cache hit', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  if (!ffmpegPath) {
    return t.skip('no ffmpeg binary on this machine');
  }
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffprobePath) {
    return t.skip('no ffprobe binary on this machine');
  }

  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'cuts.mp4');

  const built = await run(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:r=30:d=2',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    input,
  ]);
  assert.equal(built.code, 0, `ffmpeg failed: ${built.stderr.toString()}`);

  const first = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto' });

  assert.equal(first.empty, false);
  assert.equal(first.probe.width, 640);
  assert.equal(first.probe.height, 360);

  const cutTimes = first.scan.cuts.map((cut) => cut.t).sort((a, b) => a - b);
  assert.equal(cutTimes.length, 2, `expected two cuts, got ${JSON.stringify(first.scan.cuts)}`);
  assert.ok(Math.abs(cutTimes[0] - 2) <= 0.25, `first cut at ${cutTimes[0]}`);
  assert.ok(Math.abs(cutTimes[1] - 4) <= 0.25, `second cut at ${cutTimes[1]}`);

  assert.equal(first.plan.cells.length, 3);
  assert.ok(first.sheet.width > 0);
  assert.ok(first.sheet.height > 0);
  assert.deepEqual(first.png.subarray(0, 8), PNG_SIGNATURE);
  assert.ok(first.visionTokens <= 1024, `visionTokens ${first.visionTokens}`);

  assert.match(first.manifest, /sheet 1/);
  assert.equal((first.manifest.match(/^\d+ r\d+c\d+ /gm) ?? []).length, 3, first.manifest);

  const second = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto' });
  assert.equal(second.fromCache, true);
  assert.equal(second.sheet.width, first.sheet.width);
  assert.equal(second.manifest, first.manifest);
});


test("a picture that returns after a cut keeps a cell unless dedupe is 'global'", async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffprobePath) return t.skip('no ffprobe binary on this machine');

  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'dedupe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'repeat.mp4');

  // bars / black / bars: the first picture comes back as the third shot. Flat
  // colours would not do — the block signature is exposure-normalised, so two
  // solid fills of different hue read as the same picture.
  const built = await run(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map', '[out]', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30',
    input,
  ]);
  assert.equal(built.code, 0, `ffmpeg failed: ${built.stderr.toString()}`);

  const perShot = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto' });
  assert.equal(perShot.plan.cells.length, 3, 'by default a returning picture keeps its cell');
  assert.equal(perShot.plan.folded, 0);
  assert.doesNotMatch(perShot.manifest, /dropped as repeats/);

  const global = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto', dedupe: 'global' });
  assert.equal(global.plan.cells.length, 2, 'with dedupe global the sheet spends both slots on two pictures');
  assert.equal(global.plan.folded, 1);
  assert.equal(global.plan.foldedCells[0].cell, 1);
  assert.match(global.manifest, /note: 1 cell\(s\) dropped as repeats — 00:04\.00-00:06\.00 = cell 1; pass dedupe "shots" to keep them/);
  assert.equal(global.sheet.grid.cols * global.sheet.grid.rows >= 2, true);
});

test('windowNotes says nothing when the window fit the file', () => {
  assert.deepEqual(windowNotes({ duration: 60, start: 0, end: 20, askedStart: 0, askedEnd: 20 }), []);
  assert.deepEqual(windowNotes({ duration: 60, start: 0, end: 60, askedStart: 0, askedEnd: NaN, askedDuration: NaN }), []);
});

test('windowNotes reports a start that was pushed back inside the file', () => {
  const notes = windowNotes({ duration: 12, start: 11.8, end: 12, askedStart: 40 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /start 00:40.00 moved to 00:11.80 — the file is 00:12.00 long/);
});

test('windowNotes reports an end past the file and one before the start', () => {
  const past = windowNotes({ duration: 30, start: 0, end: 30, askedStart: 0, askedEnd: 90 });
  assert.equal(past.length, 1);
  assert.match(past[0], /end 01:30.00 moved to 00:30.00 — the file is 00:30.00 long/);
  const backwards = windowNotes({ duration: 30, start: 10, end: 30, askedStart: 10, askedEnd: 5 });
  assert.match(backwards[0], /end 00:05.00 is not after the start; ignored/);
});

test('windowNotes reports a duration that ran past the end of the file', () => {
  const notes = windowNotes({ duration: 30, start: 20, end: 30, askedStart: 20, askedDuration: 60 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /duration 60s runs past the end — window is 00:20.00-00:30.00/);
});
test('the keyframe gap is measured from packet headers, not frames', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffmpegPath || !ffprobePath) return t.skip('no ffmpeg/ffprobe binary on this machine');
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'keygap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'gop.mp4');
  // a still picture with a keyframe every 60 frames at 15 fps: one every 4 s
  const built = await run(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=15:d=14',
    '-c:v', 'libx264', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', input,
  ]);
  assert.equal(built.code, 0, built.stderr.toString());
  const gap = await keyframeGap({ input, ffprobePath });
  assert.ok(gap.samples >= 2, `only ${gap.samples} keyframes`);
  assert.ok(Math.abs(gap.gap - 4) <= 0.6, `gap ${gap.gap}`);
  // no probe binary means no measurement, and no measurement means no guess
  assert.deepEqual(await keyframeGap({ input, ffprobePath: null }), { gap: null, samples: 0 });
});

test('reading keyframes only keeps the timeline and reports what it skipped', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffmpegPath || !ffprobePath) return t.skip('no ffmpeg/ffprobe binary on this machine');
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'allkey-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'every-frame-a-key.mp4');
  // -g 1 makes every frame a keyframe, so skipping has nothing to skip: the two
  // passes must then agree exactly, which is what proves the timeline survives
  const built = await run(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]',
    '-map', '[out]', '-c:v', 'libx264', '-g', '1', '-pix_fmt', 'yuv420p', '-r', '10', input,
  ]);
  assert.equal(built.code, 0, built.stderr.toString());
  const opts = { input, ffmpegPath, fps: 10, duration: 4, aspect: 16 / 9 };
  const full = await scanShots({ ...opts, keyframes: false });
  const fast = await scanShots({ ...opts, keyframes: true });
  assert.equal(fast.keyframes, true);
  assert.equal(fast.frames, full.frames, 'the rate stays uniform in both passes');
  assert.equal(fast.cuts.length, full.cuts.length, JSON.stringify({ fast: fast.cuts, full: full.cuts }));
  for (let i = 0; i < fast.cuts.length; i++) {
    assert.ok(Math.abs(fast.cuts[i].t - full.cuts[i].t) <= 0.15, `cut ${i} moved`);
  }
});

test('a forced keyframe pass says so in the manifest', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffmpegPath || !ffprobePath) return t.skip('no ffmpeg/ffprobe binary on this machine');
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'forcekf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'lecture.mp4');
  const built = await run(ffmpegPath, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=10:d=6',
    '-c:v', 'libx264', '-g', '20', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', input,
  ]);
  assert.equal(built.code, 0, built.stderr.toString());
  const out = await runStoryboard({ input, ffmpegPath, ffprobePath, keyframes: 'force' });
  assert.equal(out.scan.keyframes, true);
  assert.match(out.manifest, /note: analysis read keyframes only \(one every [\d.]+ s\)/);
  assert.match(out.manifest, /set DSH_SCAN_KEYFRAMES=off to decode every frame/);
});
