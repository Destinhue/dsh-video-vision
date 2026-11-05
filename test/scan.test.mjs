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
  keyframeMode,
  microMotionStats,
  detectTextMotion,
  markTimes,
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
test('the keyframe pass is taken only when there is something to skip', () => {
  // an explicit choice is obeyed whatever the measurement says
  assert.equal(keyframeMode({ asked: 'off', duration: 7200, gap: 5 }).keyframes, false);
  assert.equal(keyframeMode({ asked: 'force', duration: 20, gap: null }).keyframes, true);
  // a short window is cheap to decode fully and loses accuracy otherwise
  assert.equal(keyframeMode({ duration: 120, gap: 5 }).keyframes, false);
  // keyframes a fraction of a second apart leave nothing to skip
  assert.equal(keyframeMode({ duration: 7200, gap: 0.4 }).keyframes, false);
  // an unmeasurable file is not guessed at: it decodes every frame
  assert.equal(keyframeMode({ duration: 7200, gap: null }).keyframes, false);
  // and the case the pass exists for
  const long = keyframeMode({ duration: 7200, gap: 4.9 });
  assert.equal(long.keyframes, true);
  assert.match(long.reason, /4\.9 s/);
  // a measured gap of exactly the floor is already worth skipping
  assert.equal(keyframeMode({ duration: 7200, gap: 1 }).keyframes, true);
});
/* ---------------------------------------------- text motion vs a still picture */

/**
 * A caption clip as the scanner sees it: the picture is a flat field that only
 * ever brightens by a step the block comparison ignores, and a six-block band in
 * the same corner swaps at a handful of pairs.
 */
function captionBlocks({ bw = 12, bh = 7, frames = 60, swaps = [5, 15, 25, 35, 45, 55], band = 6 } = {}) {
  const total = bw * bh;
  const blocks = new Uint8Array(total * frames);
  const at = new Set(swaps);
  let caption = 0;
  for (let f = 0; f < frames; f++) {
    if (f > 0 && at.has(f - 1)) caption += 1;
    const base = 40 + 8 * caption;                 // a shade the block gate ignores
    for (let k = 0; k < total; k++) blocks[f * total + k] = base;
    if (caption % 2 === 1) for (let k = 0; k < band; k++) blocks[f * total + k] = 200;
  }
  return { blocks, bw, bh, frames };
}

/** A pan: every pair moves, over different blocks each time. */
function panBlocks({ bw = 12, bh = 7, frames = 60, band = 4 } = {}) {
  const total = bw * bh;
  const blocks = new Uint8Array(total * frames);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < total; k++) blocks[f * total + k] = 40;
    for (let j = 0; j < band; j++) blocks[f * total + ((f * band + j) % total)] = 200;
  }
  return { blocks, bw, bh, frames };
}

test('microMotionStats sees marks that change while the picture does not', () => {
  const { blocks, bw, bh, frames } = captionBlocks();
  const micro = microMotionStats({ blocks, bw, bh, frames });
  assert.equal(micro.pairs, frames - 1);
  assert.equal(micro.events, 6, 'one event per caption swap');
  assert.ok(micro.density < 0.15, 'a caption swaps on a few pairs, not on every one');
  assert.equal(micro.medFrac.toFixed(3), (6 / 84).toFixed(3), 'six of eighty-four blocks moved');
  assert.ok(micro.topShare > 0.99, 'and always those six: the mark band, not the camera');
});

test('a pan moves a little on every pair and never concentrates', () => {
  const { blocks, bw, bh, frames } = panBlocks();
  const micro = microMotionStats({ blocks, bw, bh, frames });
  assert.ok(micro.density > 0.9, 'every pair moves');
  assert.ok(micro.topShare < 0.5, 'and it wanders over the whole grid');
  assert.equal(detectTextMotion({ micro, cuts: [], duration: 30 }), null);
});

test('detectTextMotion only fires on a cutless clip whose marks are the content', () => {
  const { blocks, bw, bh, frames } = captionBlocks();
  const micro = microMotionStats({ blocks, bw, bh, frames });
  const hit = detectTextMotion({ micro, cuts: [], duration: 30 });
  assert.ok(hit, 'the caption clip is text, not a still');
  assert.equal(hit.reason, 'the picture hardly changes; the marks on it do');

  assert.equal(detectTextMotion({ micro, cuts: [{ t: 4 }], duration: 30 }), null, 'a cut means there is picture to see');
  assert.equal(detectTextMotion({ micro, cuts: [], duration: 12 }), null, 'too short to call the picture static');
  assert.equal(detectTextMotion({ micro: null, cuts: [], duration: 30 }), null);
  assert.equal(detectTextMotion({ micro: { ...micro, events: 2 }, cuts: [], duration: 30 }), null,
    'two swaps is not a clip about its text');
});

test('markTimes says when the marks landed, so a layout can break there', () => {
  // The pair (1, 2) moved a little, so frame 2 is the first frame of the new
  // card: the time is attributed to the frame after the pair, not before it.
  const micro = { frac: Float32Array.from([0, 0.012, 0, 0.03, 0.4, 0]) };
  assert.deepEqual(markTimes(micro, 10), [0.2, 0.4]);

  const { blocks, bw, bh, frames } = captionBlocks();
  const caption = microMotionStats({ blocks, bw, bh, frames });
  assert.equal(markTimes(caption, 25).length, caption.events,
    'the same band the statistics counted, so the two cannot disagree');

  assert.deepEqual(markTimes(null, 25), []);
  assert.deepEqual(markTimes({ frac: new Float32Array(0) }, 25), []);
  assert.deepEqual(markTimes(micro, 0), [], 'a scan with no frame rate has no times');
});
