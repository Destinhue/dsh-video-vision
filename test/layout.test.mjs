import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_DEFAULTS,
  VISION_TOKEN_CAP,
  DETAIL_PRESETS,
  MIN_SHEET_PIXELS,
  sheetPixelsFor,
  buildShots,
  shotWeight,
  bestFrameIndex,
  pictureDistance,
  samePictureThreshold,
  samePicture,
  planCells,
  maxCellsByPixels,
  cellReadability,
  planGrid,
  pictureChangeFraction,
} from '../src/layout.js';

const BW = 12;
const BH = 7;
const STRIDE = BW * BH;
const GUTTER = 2;

function zeroVectors(frames) {
  return {
    sharp: new Float32Array(frames),
    detail: new Float32Array(frames),
    edge: new Float32Array(frames),
    bright: new Float32Array(frames),
    sat: new Float32Array(frames),
  };
}

function makeScan({ duration = 6, effFps = 10, cuts = [], blockAt = () => 0, vectors = null } = {}) {
  const frames = Math.max(1, Math.round(duration * effFps));
  const blocks = new Uint8Array(frames * STRIDE);
  for (let i = 0; i < frames; i++) {
    blocks.fill(blockAt(i, frames), i * STRIDE, (i + 1) * STRIDE);
  }
  return {
    duration,
    effFps,
    frames,
    start: 0,
    cuts: cuts.map((t) => ({ i: Math.max(0, Math.round(t * effFps) - 1), t, score: 50, kind: 'cut' })),
    blocks,
    chromaBlocks: new Int8Array(frames * STRIDE * 2),
    scores: new Float32Array(frames),
    vectors: vectors ?? zeroVectors(frames),
    stats: { median: 0 },
    summary: { medianShot: 0 },
  };
}

const emptyScan = {
  duration: 0,
  effFps: 25,
  frames: 0,
  start: 0,
  cuts: [],
  blocks: new Uint8Array(0),
  chromaBlocks: new Int8Array(0),
  scores: new Float32Array(0),
  vectors: zeroVectors(0),
  stats: { median: 0 },
  summary: { medianShot: 0 },
};

function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

test('a cut splits the film into one cell per shot', () => {
  const scan = makeScan({ cuts: [2, 4], blockAt: (i) => (i < 20 ? 0 : i < 40 ? 60 : 120) });
  const plan = planCells({ scan });
  assert.equal(plan.cells.length, 3);
  assert.deepEqual(plan.cells.map((c) => [c.t0, c.t1]), [[0, 2], [2, 4], [4, 6]]);
  assert.deepEqual(plan.cells.map((c) => c.index), [1, 2, 3]);
  assert.deepEqual(plan.cells.map((c) => c.shotIndex), [0, 1, 2]);
  assert.equal(plan.budgetUsed, 3);
  assert.equal(plan.pixelBudget, sheetPixelsFor(3, 'auto'));
});

test('adjacent cells meet exactly, with no gap and no overlap', () => {
  const scan = makeScan({ cuts: [2, 4], blockAt: (i) => (i < 20 ? 0 : i < 40 ? 60 : 120) });
  const { cells } = planCells({ scan });
  for (let k = 1; k < cells.length; k++) {
    assert.equal(cells[k].t0, cells[k - 1].t1);
  }
  for (const cell of cells) assert.ok(cell.t1 > cell.t0);
});

test('a static single shot is one cell, not a grid of repeats', () => {
  const scan = makeScan({ duration: 60, blockAt: () => 0 });
  const plan = planCells({ scan });
  assert.equal(plan.cells.length, 1);
  assert.equal(plan.shots.length, 1);
});

test('a long moving shot spends at most four cells on itself', () => {
  const scan = makeScan({ duration: 60, blockAt: (i, frames) => Math.round((i / (frames - 1)) * 255) });
  const plan = planCells({ scan });
  assert.equal(plan.cells.length, 4);
  assert.deepEqual(plan.cells.map((c) => c.index), [1, 2, 3, 4]);
  assert.equal(new Set(plan.cells.map((c) => c.frameIndex)).size, 4, 'every cell shows a different frame');
  for (const cell of plan.cells) assert.ok(cell.t1 > cell.t0);
});

test('more shots than the budget merge neighbours instead of shrinking every cell', () => {
  const cuts = Array.from({ length: 29 }, (_, k) => (k + 1) * 2);
  const scan = makeScan({
    duration: 60,
    cuts,
    blockAt: (i) => 20 + ((Math.floor(i / 20) * 7) % 200),
  });
  const plan = planCells({ scan, maxCells: 3 });
  assert.equal(plan.budget, 3);
  assert.equal(plan.cells.length, 3);
  assert.equal(plan.mergedGroups, 3);
  assert.equal(plan.cells.reduce((sum, c) => sum + c.shots, 0), 30);
  assert.deepEqual(plan.cells.map((c) => c.shots), [10, 10, 10]);
});

test('asking for fewer than three cells still returns the documented floor', () => {
  const scan = makeScan({
    duration: 10,
    cuts: [2, 4, 6, 8],
    blockAt: (i) => (Math.floor(i / 20) * 40) % 255,
  });
  const plan = planCells({ scan, maxCells: 1 });
  assert.equal(plan.budget, LAYOUT_DEFAULTS.minCells);
  assert.equal(plan.cells.length, 3);
});

test('a flash frame too short to merit a cell is marked as a repeat', () => {
  const scan = makeScan({ duration: 5.05, cuts: [5], blockAt: () => 0 });
  const plan = planCells({ scan });
  assert.equal(plan.cells.length, 1);
  assert.equal(plan.shots.length, 2);
  assert.equal(plan.shots[1].sameAsCell, plan.cells[0].index);
  assert.equal(plan.deduped, 1);
});

test('an empty scan plans no cells instead of throwing', () => {
  const plan = planCells({ scan: emptyScan });
  assert.deepEqual(plan.cells, []);
  assert.deepEqual(plan.shots, []);
  assert.equal(plan.duration, 0);
  assert.equal(plan.pixelBudget, MIN_SHEET_PIXELS);
  assert.equal(plan.budgetUsed, 0);
});

test('buildShots ignores cuts at the very start and end', () => {
  const scan = makeScan({ cuts: [0, 0.01, 2, 6] });
  const shots = buildShots(scan);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots.map((s) => [s.t0, s.t1]), [[0, 2], [2, 6]]);
  assert.deepEqual(shots.map((s) => [s.i0, s.i1]), [[0, 19], [20, 59]]);
});

test('a clip with no cuts is still one shot', () => {
  const shots = buildShots(makeScan({ duration: 6 }));
  assert.equal(shots.length, 1);
  assert.equal(shots[0].t0, 0);
  assert.equal(shots[0].t1, 6);
  assert.equal(shots[0].i0, 0);
  assert.equal(shots[0].i1, 59);
  assert.equal(shots[0].kind, 'start');
});

test('shot kinds come from the cut that opens the shot, not the one that closes it', () => {
  const scan = makeScan({ cuts: [2, 4] });
  scan.cuts[0].kind = 'fade';
  const shots = buildShots(scan);
  assert.deepEqual(shots.map((s) => s.kind), ['start', 'fade', 'cut']);
});

test('a zero-length clip has no shots', () => {
  assert.deepEqual(buildShots(emptyScan), []);
});

test('the cell budget caps a huge request at the preset ceiling', () => {
  const scan = makeScan({
    duration: 16,
    cuts: [2, 4, 6, 8, 10, 12, 14],
    blockAt: (i) => (Math.floor(i / 20) * 30) % 255,
  });
  const auto = planCells({ scan, maxCells: 999 });
  assert.equal(auto.budget, DETAIL_PRESETS.auto.maxCells);
  assert.equal(auto.cells.length, 8, 'one cell per shot until the budget is reached');

  const low = planCells({ scan, detail: 'low', maxCells: 999 });
  assert.equal(low.budget, DETAIL_PRESETS.low.maxCells);
  assert.equal(low.cells.length, DETAIL_PRESETS.low.maxCells);
});

test('the pixel budget follows the cell count and the detail preset', () => {
  assert.equal(sheetPixelsFor(0), MIN_SHEET_PIXELS);
  assert.equal(sheetPixelsFor(1), MIN_SHEET_PIXELS);
  assert.equal(sheetPixelsFor(6, 'auto'), 552_000);
  assert.equal(sheetPixelsFor(6, 'low'), 780_000);
  assert.equal(sheetPixelsFor(20, 'auto'), 1_760_000);
  assert.equal(sheetPixelsFor(100, 'ultra'), 1_800_000);
  assert.equal(sheetPixelsFor(6, 'not-a-preset'), sheetPixelsFor(6, 'auto'));
});

test('a one-cell grid is a real grid with no padding', () => {
  const grid = planGrid(1, 16 / 9, { pixels: MIN_SHEET_PIXELS });
  assert.equal(grid.count, 1);
  assert.equal(grid.cols, 1);
  assert.equal(grid.rows, 1);
  assert.equal(grid.padding, 0);
  assert.ok(grid.cellW > 0 && grid.cellH > 0);
  assert.ok(grid.width >= grid.cellW + GUTTER * 2);
  assert.ok(grid.height >= grid.cellH + GUTTER * 2);
});

test('three-, four- and five-cell grids pack exactly the cells they claim', () => {
  for (const n of [3, 4, 5]) {
    const grid = planGrid(n, 16 / 9, { pixels: sheetPixelsFor(n, 'auto') });
    assert.equal(grid.count, n);
    assert.equal(grid.cols * grid.rows - grid.padding, n);
    assert.ok(grid.padding <= 1, `unexpected padding for ${n} cells`);
    assert.ok(grid.width >= grid.cols * grid.cellW + GUTTER * (grid.cols + 1));
    assert.ok(grid.height >= grid.rows * grid.cellH + GUTTER * (grid.rows + 1));
  }
});

test('a portrait grid gets tall cells', () => {
  const grid = planGrid(4, 9 / 16, { pixels: sheetPixelsFor(4, 'auto') });
  assert.ok(grid.cellH > grid.cellW);
});

test('a zero or negative cell count still returns a usable grid', () => {
  for (const n of [0, -3]) {
    const grid = planGrid(n, 16 / 9, { pixels: MIN_SHEET_PIXELS });
    assert.equal(grid.count, 1);
    assert.equal(grid.cols, 1);
    assert.equal(grid.rows, 1);
    assert.ok(grid.cellW > 0 && grid.cellH > 0);
  }
});

test('the grid never exceeds the maximum sheet side', () => {
  const grid = planGrid(20, 16 / 9, { pixels: sheetPixelsFor(20, 'auto') });
  assert.ok(grid.width <= LAYOUT_DEFAULTS.maxSheetSide);
  assert.ok(grid.height <= LAYOUT_DEFAULTS.maxSheetSide);
});

test('subtitle legibility is judged against the source height', () => {
  assert.deepEqual(cellReadability(417, 234), {
    subtitlePx: 10,
    smallTextPx: 5.2,
    legible: true,
    comfortable: false,
  });
  const tiny = cellReadability(100, 100, 1080);
  assert.equal(tiny.subtitlePx, 4.3);
  assert.equal(tiny.legible, false);
  const sd = cellReadability(400, 300, 720);
  assert.equal(sd.subtitlePx, 19.2);
  assert.equal(sd.comfortable, true);
});

test('the same-picture threshold tracks the clip noise floor', () => {
  assert.equal(samePictureThreshold({}), 10.9);
  assert.equal(samePictureThreshold({ stats: { median: 10 } }), 20.5);
  assert.equal(samePictureThreshold({ stats: { median: 100 } }), 22);
  assert.equal(samePictureThreshold({ stats: { median: -9 } }), 4.5);
});

test('pictureDistance measures the mean block difference', () => {
  const scan = makeScan({ duration: 3, effFps: 1, blockAt: (i) => [0, 20, 200][i] });
  assert.equal(pictureDistance(scan, 0, 0), 0);
  assert.equal(pictureDistance(scan, 0, 1), 20);
  assert.equal(pictureDistance(scan, 0, 2), 200);
  assert.equal(pictureDistance(scan, 0, 3), 255);
});

test('samePicture uses the clip threshold unless the caller narrows it', () => {
  const scan = makeScan({ duration: 3, effFps: 1, blockAt: (i) => [0, 3, 50][i] });
  assert.equal(samePicture(scan, 0, 1), true);
  assert.equal(samePicture(scan, 0, 2), false);
  assert.equal(samePicture(scan, 0, 1, 2), false);
  assert.equal(samePicture(scan, 0, 1, 10), true);
});

test('the best frame sits in the middle when nothing stands out', () => {
  const pick = bestFrameIndex(0, 10, zeroVectors(11));
  assert.equal(pick.i, 5);
  near(pick.score, 0.45);
});

test('a much sharper frame can outvote the middle bias', () => {
  const vectors = zeroVectors(11);
  vectors.sharp[9] = 1000;
  assert.equal(bestFrameIndex(0, 10, vectors).i, 9);
});

test('an exposure spike does not become the shot frame', () => {
  const vectors = zeroVectors(11);
  vectors.bright.fill(50);
  vectors.bright[5] = 1000;
  vectors.sharp[5] = 100;
  assert.notEqual(bestFrameIndex(0, 10, vectors).i, 5);
});

test('bestFrameIndex survives an inverted range', () => {
  assert.equal(bestFrameIndex(9, 3, zeroVectors(11)).i, 9);
});

test('shotWeight rises with duration, motion, detail and speech', () => {
  const shot = { t0: 0, t1: 10, dur: 10 };
  const plain = shotWeight(shot, { motion: 0, detailMean: 0, sharpMax: 0 }, null, 10);
  near(plain.w, 1.56);
  assert.equal(plain.parts.durN, 1.4);

  const rich = shotWeight(shot, { motion: 26, detailMean: 0.22, sharpMax: 900 }, null, 10);
  near(rich.w, 2.66);
  assert.equal(rich.parts.motionN, 1);
  assert.equal(rich.parts.detailN, 1);

  const withAudio = shotWeight(
    shot,
    { motion: 26, detailMean: 0.22, sharpMax: 900 },
    { speech: [{ t: 0, dur: 5 }], events: [{ t: 1 }, { t: 2 }, { t: 3 }] },
    10,
  );
  near(withAudio.w, 3.085);
  assert.equal(withAudio.parts.speech, 0.5);
  assert.equal(withAudio.parts.events, 3);

  const short = shotWeight({ t0: 0, t1: 2, dur: 2 }, { motion: 0, detailMean: 0, sharpMax: 0 }, null, 10);
  assert.ok(short.w < plain.w);
  assert.equal(short.parts.durN, 0.72);
});

test('the documented presets and caps are what the planner spends', () => {
  assert.deepEqual(DETAIL_PRESETS.auto, { maxCells: 28, perCell: 92_000, max: 1_760_000 });
  assert.deepEqual(DETAIL_PRESETS.low, { maxCells: 6, perCell: 130_000, max: 900_000 });
  assert.equal(VISION_TOKEN_CAP, 1024);
  assert.equal(MIN_SHEET_PIXELS, 300_000);
  assert.equal(LAYOUT_DEFAULTS.minCells, 3);
});

test('the legibility rail only binds on tall pictures', () => {
  assert.ok(maxCellsByPixels(DETAIL_PRESETS.auto, 16 / 9) >= 28);
  assert.equal(maxCellsByPixels(DETAIL_PRESETS.auto, 9 / 16), 17);
  assert.ok(maxCellsByPixels(DETAIL_PRESETS.auto, 9 / 21) <= 17);
});

test('a portrait clip merges sooner than a wide one', () => {
  const scan = makeScan({
    duration: 20,
    cuts: Array.from({ length: 19 }, (_, k) => k + 1),
    blockAt: (i) => (Math.floor(i / 10) * 40) % 255,
  });
  const wide = planCells({ scan, aspect: 16 / 9 });
  const tall = planCells({ scan, aspect: 9 / 16 });
  assert.ok(wide.cells.length >= tall.cells.length, wide.cells.length + ' vs ' + tall.cells.length);
});

test('a frame of board work counts blocks, not the average', () => {
  // One block lit, the rest untouched: the mean moves by 255/84 ≈ 3, which no
  // global threshold notices, while the block test sees exactly what happened.
  const scan = makeScan({ duration: 2, effFps: 1, blockAt: () => 0 });
  scan.blocks.fill(100, 0, STRIDE);
  scan.blocks.fill(100, STRIDE, STRIDE * 2);
  scan.blocks[STRIDE + 5] = 200;
  assert.equal(pictureChangeFraction(scan, 0, 1), 1 / STRIDE);
  scan.blocks.fill(0, 0, STRIDE);
  scan.blocks.fill(0, STRIDE, STRIDE * 2);
  assert.equal(pictureChangeFraction(scan, 0, 1), 0, 'letterbox black is not a change');
});

test('a long stretch with no cut still gets a cell per change, not one cell', () => {
  // Five minutes of writing on a board: nothing is ever a "different picture",
  // but a line appears every half minute.
  const scan = makeScan({ duration: 300, effFps: 2, blockAt: () => 120 });
  for (const t of [30, 60, 90, 120, 150, 180, 210, 240, 270]) {
    scan.blocks.fill(180, Math.round(t * 2) * STRIDE, (Math.round(t * 2) + 1) * STRIDE);
    scan.scores[Math.round(t * 2)] = 20;
  }
  const plan = planCells({ scan });
  assert.ok(plan.cells.length >= 4, `expected several cells, got ${plan.cells.length}`);
  assert.equal(plan.cells[0].t0, 0);
  assert.equal(plan.cells[plan.cells.length - 1].t1, 300);
  for (let k = 1; k < plan.cells.length; k++) {
    assert.equal(plan.cells[k].t0, plan.cells[k - 1].t1, 'board cells meet');
    assert.ok(plan.cells[k].t1 > plan.cells[k].t0);
  }
  assert.equal(new Set(plan.cells.map((c) => c.frameIndex)).size, plan.cells.length);
});

test('a long stretch that never changes is still one cell', () => {
  const scan = makeScan({ duration: 300, effFps: 2, blockAt: () => 120 });
  const plan = planCells({ scan });
  assert.equal(plan.cells.length, 1);
});
