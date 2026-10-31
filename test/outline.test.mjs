import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFfmpeg, findFfprobe } from '../src/media.js';
import { runOutline } from '../src/pipeline.js';
import {
  OUTLINE_DEFAULTS, outlineClock, planOutline, spanOverlap, outlineRows,
  outlineHighlights, outlineReport,
} from '../src/outline.js';

const VENDOR = 'F:\\ai\\v4video\\vendor\\bin';
const CORPUS = fileURLToPath(new URL('../bench/corpus/', import.meta.url));

async function resolveTool(name, envKey, finder) {
  if (process.env[envKey]) return process.env[envKey];
  const found = await finder();
  if (found) return found;
  const literal = join(VENDOR, name);
  return existsSync(literal) ? literal : null;
}

const ROW = /^\s+\d+\s+\d\d:\d\d-\d\d:\d\d\s+[▁▂▃▄▅▆▇█]{8}\s+cuts \d+/u;

test('outlineClock reads whole seconds, and hours only when there are any', () => {
  assert.equal(outlineClock(0), '00:00');
  assert.equal(outlineClock(290), '04:50');
  assert.equal(outlineClock(59.6), '01:00');
  assert.equal(outlineClock(3600), '1:00:00');
  assert.equal(outlineClock(6969), '1:56:09');
  assert.equal(outlineClock(-4), '00:00');
  assert.equal(outlineClock(undefined), '00:00');
});

test('planOutline cuts the file into equal windows and says when it capped', () => {
  const plan = planOutline({ duration: 600, windows: 4 });
  assert.equal(plan.count, 4);
  assert.equal(plan.span, 600);
  assert.equal(plan.capped, false);
  assert.deepEqual(plan.windows.map((w) => [w.index, w.t0, w.t1]), [
    [1, 0, 150], [2, 150, 300], [3, 300, 450], [4, 450, 600],
  ]);

  const many = planOutline({ duration: 600, windows: 120 });
  assert.equal(many.count, OUTLINE_DEFAULTS.maxWindows);
  assert.equal(many.capped, true, 'asked for more windows than the cap');

  const few = planOutline({ duration: 600, windows: 2 });
  assert.equal(few.count, OUTLINE_DEFAULTS.minWindows, 'raised to the floor');
  assert.equal(few.capped, false, 'a floor is not a cap');

  // Six seconds cannot carry twenty-four quarter-second slices.
  const tiny = planOutline({ duration: 6, windows: 24 });
  assert.equal(tiny.count, 6);
  assert.equal(tiny.capped, true);

  const empty = planOutline({ duration: 0, windows: 24 });
  assert.equal(empty.count, 1);
  assert.equal(empty.windows[0].t0, 0);
});

test('spanOverlap clips spans to the window', () => {
  assert.equal(spanOverlap([{ t: 0, dur: 10 }], 0, 10), 10);
  assert.equal(spanOverlap([{ t: 5, dur: 10 }], 0, 10), 5);
  assert.equal(spanOverlap([{ t: 0, dur: 10 }], 12, 20), 0);
  assert.equal(spanOverlap([], 0, 10), 0);
  assert.equal(spanOverlap([{ t: 1, dur: 2 }, { t: 4, dur: 2 }], 0, 10), 4);
});

test('outlineRows puts cuts, movement, speech and silence in the right window', () => {
  const plan = planOutline({ duration: 60, windows: 4 });
  const motion = new Uint8Array(60);
  for (let i = 0; i < 15; i += 1) motion[i] = 1;
  const bright = new Float32Array(60).fill(128);
  for (let i = 0; i < 15; i += 1) bright[i] = 10;
  const rows = outlineRows({
    plan,
    effFps: 1,
    cuts: [{ t: 2 }, { t: 20 }, { t: 50 }],
    motion,
    vectors: { bright },
    speech: [{ t: 0, dur: 30 }],
    activity: [{ t: 0, dur: 30 }],
    silence: [{ t: 45, dur: 14 }],
  });

  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.cuts), [1, 1, 0, 1]);
  assert.equal(rows[0].motionShare, 1);
  assert.equal(rows[1].motionShare, 0);
  assert.equal(rows[0].speechShare, 1);
  assert.equal(rows[1].speechShare, 1);
  assert.equal(rows[2].speechShare, 0);
  assert.equal(rows[0].bright, 10);
  assert.equal(rows[1].bright, 128);
  assert.ok(rows[3].silentShare > 0.9, 'fourteen of fifteen seconds are silent');
  assert.ok(rows[0].tags.includes('dark'));
  assert.ok(rows[2].tags.includes('static'));
  assert.ok(rows[3].tags.includes('quiet'));
  assert.ok(rows[0].tags.includes('busy'));
  assert.ok(rows[0].tags.includes('talk'));
  for (const r of rows) assert.equal(r.bar.length, OUTLINE_DEFAULTS.sparkWidth);
  assert.ok(rows[0].score > rows[2].score, 'the busy window outscores the empty one');
});

test('outlineHighlights ranks by score and respects the cap', () => {
  const rows = [
    { index: 1, span: 15, score: 0.1 },
    { index: 2, span: 15, score: 0.9 },
    { index: 3, span: 0.4, score: 0.99 },
    { index: 4, span: 15, score: 0.5 },
    { index: 5, span: 15, score: 0 },
  ];
  assert.deepEqual(outlineHighlights(rows, 2).map((r) => r.index), [2, 4]);
  assert.deepEqual(outlineHighlights(rows, 0), []);
  assert.deepEqual(outlineHighlights(rows, 99).map((r) => r.index), [2, 4, 1]);
  assert.deepEqual(outlineHighlights([], 3), []);
});

function reportFixture(overrides = {}) {
  const plan = planOutline({ duration: 60, windows: 4 });
  const rows = outlineRows({
    plan,
    effFps: 1,
    cuts: [{ t: 20 }],
    speech: [{ t: 0, dur: 60 }],
    activity: [{ t: 0, dur: 60 }],
    ...overrides,
  });
  return { plan, rows };
}

test('outlineReport prints the map, the picks and the next call', () => {
  const { plan, rows } = reportFixture();
  const text = outlineReport({
    title: 'lesson.mp4',
    duration: 60,
    plan,
    rows,
    top: 2,
    totalCuts: 1,
    speechShare: 1,
    hasAudio: true,
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'lesson.mp4 · 01:00 · 1 cut · speech 100% · 4 windows of 00:15');
  assert.match(lines[1], /^note: text only — nothing was drawn/);
  assert.equal(lines.filter((line) => ROW.test(line)).length, 4);
  assert.match(text, /watch first: \d+ \(00:\d\d-0\d:\d\d, \d+ cut/);
  assert.match(text, /^next: video_storyboard start=\d+ end=\d+ for the pictures, video_read start=\d+ end=\d+ for the words$/m);
});

test('outlineReport without audio drops the speech column and points at the picture', () => {
  const plan = planOutline({ duration: 40, windows: 4 });
  const rows = outlineRows({ plan, effFps: 1, cuts: [{ t: 4 }, { t: 14 }], motion: new Uint8Array(40).fill(1) });
  const text = outlineReport({
    title: 'silent.mp4', duration: 40, plan, rows, totalCuts: 2, hasAudio: false,
  });
  assert.ok(!text.includes('speech '), 'no speech column and no speech share');
  assert.match(text, /note: no audio track — this outline reads the picture only/);
  assert.match(text, /^next: video_storyboard start=\d+ end=\d+ — the pictures of the window above$/m);
});

test('outlineReport says so when nothing stands out, and when it capped', () => {
  const plan = planOutline({ duration: 60, windows: 4 });
  const rows = outlineRows({ plan, effFps: 1 });
  const text = outlineReport({
    title: 'still.mp4', duration: 60, plan, rows, totalCuts: 0, hasAudio: false,
    notes: ['windows 120 capped at 60'],
  });
  assert.match(text, /note: windows 120 capped at 60/);
  assert.match(text, /note: nothing stands out — the picture and the sound barely change/);
  assert.ok(!/watch first:/.test(text));
  assert.match(text, /^next: video_storyboard start=0 end=15/m);
});

test('the whole outline of a real clip is one call and one picture-free answer', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffprobePath) return t.skip('no ffprobe binary on this machine');
  const input = join(CORPUS, 'A_hardcuts_720p.mp4');
  if (!existsSync(input)) return t.skip('corpus clip missing');

  const out = await runOutline({ input, ffmpegPath, ffprobePath, windows: 4, top: 2 });
  const lines = out.text.split('\n');
  assert.match(lines[0], /^A_hardcuts_720p\.mp4 · 00:40 · 9 cuts · 4 windows of 00:10$/);
  assert.ok(!out.text.includes('speech '), 'the clip is silent');
  assert.equal(lines.filter((line) => ROW.test(line)).length, 4);
  assert.match(out.text, /watch first: \d+ \(00:\d\d-00:\d\d, \d+ cut/);
  assert.match(out.text, /^next: video_storyboard start=\d+ end=\d+/m);
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows.reduce((s, r) => s + r.cuts, 0), 9);
  assert.ok(out.timings.total > 0);
});
