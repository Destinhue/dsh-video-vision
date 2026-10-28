import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCAN_DEFAULTS,
  scanRaster,
  emptyVectors,
  robustStats,
  blockStats,
  classifyJump,
  summarizeShots,
} from '../src/scan.js';

const BW = 4;
const BH = 2;
const TOTAL = BW * BH;

function solid(n, value = 0) {
  return Uint8Array.from({ length: n }, () => value);
}

function chroma(n, u = 0, v = 0) {
  const out = new Int8Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = u;
    out[i * 2 + 1] = v;
  }
  return out;
}

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

/** Compare two luma/chroma frames as blockStats sees a pair of frames. */
function compare(a, b, ca = chroma(TOTAL), cb = chroma(TOTAL)) {
  const yb = new Uint8Array(TOTAL * 2);
  yb.set(a, 0);
  yb.set(b, TOTAL);
  const chromaBlocks = new Int8Array(TOTAL * 4);
  chromaBlocks.set(ca, 0);
  chromaBlocks.set(cb, TOTAL * 2);
  return blockStats(yb, chromaBlocks, 0, TOTAL, BW, BH);
}

/** Classify the jump from frame A to frame B (classifyJump compares i-1 with i+1). */
function jump(a, b, ca = chroma(TOTAL), cb = chroma(TOTAL)) {
  const blocks = new Uint8Array(TOTAL * 2);
  blocks.set(a, 0);
  blocks.set(b, TOTAL);
  const chromaBlocks = new Int8Array(TOTAL * 4);
  chromaBlocks.set(ca, 0);
  chromaBlocks.set(cb, TOTAL * 2);
  return classifyJump(blocks, chromaBlocks, 0, BW, BH);
}

test('the analysis raster keeps a 16:9 picture inside 96x54', () => {
  assert.deepEqual(scanRaster(16 / 9), { width: 96, height: 54 });
  assert.deepEqual(scanRaster(4 / 3), { width: 72, height: 54 });
});

test('a square source stays square and a portrait source gets tall cells', () => {
  assert.deepEqual(scanRaster(1), { width: 54, height: 54 });
  assert.deepEqual(scanRaster(9 / 16), { width: 30, height: 54 });
});

test('a very wide source is capped by the raster width', () => {
  assert.deepEqual(scanRaster(4), { width: 96, height: 24 });
  assert.deepEqual(scanRaster(10), { width: 96, height: 16 });
});

test('an extreme portrait source is floored at the minimum raster side', () => {
  assert.deepEqual(scanRaster(0.1), { width: 16, height: 54 });
});

test('a missing or nonsensical aspect falls back to 16:9', () => {
  assert.deepEqual(scanRaster(NaN), { width: 96, height: 54 });
  assert.deepEqual(scanRaster(0), { width: 96, height: 54 });
  assert.deepEqual(scanRaster(Infinity), { width: 96, height: 54 });
});

test('emptyVectors allocates every channel the planner reads', () => {
  const vectors = emptyVectors(3);
  assert.deepEqual(Object.keys(vectors).sort(), ['bright', 'detail', 'edge', 'sat', 'sharp']);
  for (const channel of Object.values(vectors)) {
    assert.equal(channel.length, 3);
    assert.deepEqual(Array.from(channel), [0, 0, 0]);
  }
});

test('robustStats of no scores reports the noise floor', () => {
  assert.deepEqual(robustStats([]), { median: 0, mad: 0, p90: 0, p99: 0, threshold: SCAN_DEFAULTS.floor });
});

test('the cut threshold follows the noise band of this clip', () => {
  const stats = robustStats([1, 2, 5, 8, 9]);
  assert.equal(stats.median, 5);
  assert.equal(stats.mad, 3);
  assert.equal(stats.p90, 9);
  assert.equal(stats.p99, 9);
  assert.equal(stats.threshold, 26);
});

test('a clip where nothing moves only has to clear the floor', () => {
  const stats = robustStats([0, 0, 0, 0, 0]);
  assert.equal(stats.median, 0);
  assert.equal(stats.mad, 0);
  assert.equal(stats.threshold, SCAN_DEFAULTS.floor);
});

test('robustStats leaves the caller scores in their original order', () => {
  const scores = new Float32Array([9, 1, 5, 3]);
  robustStats(scores);
  assert.deepEqual(Array.from(scores), [9, 1, 5, 3]);
});

test('identical frames are one picture with no changed blocks', () => {
  const stats = compare(solid(TOTAL, 200), solid(TOTAL, 200));
  assert.equal(stats.active, TOTAL);
  assert.equal(stats.sameFrac, 1);
  assert.equal(stats.changedFrac, 0);
  assert.equal(stats.chromaSameFrac, 1);
  assert.equal(stats.dyMean, 0);
  assert.equal(stats.dyStd, 0);
});

test('a full-frame luma jump is reported as entirely changed', () => {
  const stats = compare(solid(TOTAL, 200), solid(TOTAL, 100));
  assert.equal(stats.changedFrac, 1);
  assert.equal(stats.sameFrac, 0);
  assert.equal(stats.dyMean, 100);
  assert.equal(stats.dyStd, 0);
});

test('dyStd reports how unevenly the frame moved', () => {
  const stats = compare(solid(TOTAL, 100), Uint8Array.from([110, 110, 110, 110, 130, 130, 130, 130]));
  assert.equal(stats.dyMean, 20);
  assert.equal(stats.dyStd, 10);
});

test('near-black frames have no active blocks to compare', () => {
  const stats = compare(solid(TOTAL, 5), solid(TOTAL, 5));
  assert.equal(stats.active, 0);
  assert.equal(stats.sameFrac, 0);
  assert.equal(stats.chromaSameFrac, 1);
  assert.equal(stats.dyMean, 0);
});

test('chroma movement counts even when luma does not move', () => {
  const before = chroma(TOTAL, 0, 0);
  const after = chroma(TOTAL, 40, 40);
  const stats = compare(solid(TOTAL, 200), solid(TOTAL, 200), before, after);
  assert.equal(stats.changedFrac, 1);
  assert.equal(stats.chromaSameFrac, 0);
  assert.equal(stats.dyMean, 0);
});

test('a caption over an unchanged picture is an overlay, not a cut', () => {
  const before = solid(TOTAL, 200);
  const after = solid(TOTAL, 200);
  after[0] = 40;
  const beforeChroma = chroma(TOTAL, 0, 0);
  const afterChroma = chroma(TOTAL, 0, 0);
  afterChroma[0] = 60;
  const result = jump(before, after, beforeChroma, afterChroma);
  assert.equal(result.kind, 'overlay');
  assert.equal(result.stat.sameFrac, 7 / 8);
});

test('a brightness step with unchanged colour is a lighting event', () => {
  const result = jump(solid(TOTAL, 30), solid(TOTAL, 100));
  assert.equal(result.kind, 'light');
  assert.equal(result.stat.chromaSameFrac, 1);
});

test('a full-frame change of subject is a cut', () => {
  const result = jump(solid(TOTAL, 30), solid(TOTAL, 100), chroma(TOTAL, 0, 0), chroma(TOTAL, 60, 60));
  assert.equal(result.kind, 'cut');
  assert.equal(result.stat.changedFrac, 1);
});

test('a slight uniform drift is noise, not an event', () => {
  const result = jump(solid(TOTAL, 100), solid(TOTAL, 110));
  assert.equal(result.kind, 'noise');
  assert.equal(result.stat.changedFrac, 0);
});

test('a change covering a quarter of the grid is not yet a cut', () => {
  const after = solid(TOTAL, 110);
  after[0] = 40;
  after[1] = 40;
  const result = jump(solid(TOTAL, 100), after);
  assert.equal(result.kind, 'partial');
  assert.equal(result.stat.changedFrac, 0.25);
});

test('a frame too dark to judge is given the benefit of the doubt', () => {
  const result = jump(solid(TOTAL, 5), solid(TOTAL, 5));
  assert.equal(result.kind, 'cut');
  assert.equal(result.stat.active, 0);
});

test('no cuts means one shot spanning the whole clip', () => {
  const summary = summarizeShots([], 6, 30);
  assert.deepEqual(summary, {
    frames: 180,
    shots: 1,
    cuts: 0,
    medianShot: 6,
    p10Shot: 6,
    cutsPerMin: 0,
  });
});

test('two cuts divide the clip into three shots with a per-minute rate', () => {
  const summary = summarizeShots([{ t: 2 }, { t: 4 }], 6, 30);
  assert.deepEqual(summary, {
    frames: 180,
    shots: 3,
    cuts: 2,
    medianShot: 2,
    p10Shot: 2,
    cutsPerMin: 20,
  });
});

test('uneven cut spacing uses the sorted span list for its statistics', () => {
  const summary = summarizeShots([{ t: 1 }, { t: 2 }, { t: 6 }], 10, 25);
  assert.equal(summary.shots, 4);
  assert.equal(summary.medianShot, 4);
  assert.equal(summary.p10Shot, 1);
  assert.equal(summary.cutsPerMin, 18);
});

test('a zero-length recording still reports one unmeasured shot', () => {
  const summary = summarizeShots([], 0, 25);
  assert.equal(summary.frames, 0);
  assert.equal(summary.shots, 1);
  assert.equal(summary.medianShot, 0);
  assert.equal(summary.cutsPerMin, 0);
});

test('the cut detector assumes a 12x7 block grid', () => {
  assert.equal(SCAN_DEFAULTS.blockCols, 12);
  assert.equal(SCAN_DEFAULTS.blockRows, 7);
  assert.equal(SCAN_DEFAULTS.blockDelta, 14);
  assert.equal(SCAN_DEFAULTS.activeLuma, 12);
});
