import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS,
  TEXT_HEIGHT,
  TEXT_WIDTH,
  textWidth,
  newSheet,
  fillRect,
  drawText,
  blitCell,
  drawBadge,
  drawAudioBand,
  composeSheet,
  sheetQuality,
} from '../src/sheet.js';

function pixel(sheet, x, y) {
  const i = (y * sheet.width + x) * 3;
  return [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2]];
}

test('textWidth advances by one inter-glyph gap', () => {
  assert.equal(TEXT_WIDTH, 5);
  assert.equal(TEXT_HEIGHT, 7);
  assert.equal(textWidth('1', 1), 5);
  assert.equal(textWidth('123', 1), 17);
  // One glyph at scale 2 inks 5*2 px; drawText advances (5+1)*2 between glyph starts.
  assert.equal(textWidth('1', 2), 10);
  assert.equal(textWidth('', 3), 0);
});

test('a new sheet is fully filled with the background colour', () => {
  const sheet = newSheet(4, 3);
  assert.equal(sheet.width, 4);
  assert.equal(sheet.height, 3);
  assert.equal(sheet.data.length, 4 * 3 * 3);
  assert.deepEqual(pixel(sheet, 0, 0), COLORS.bg);
  assert.deepEqual(pixel(sheet, 3, 2), COLORS.bg);
});

test('fillRect clamps to the sheet instead of writing outside it', () => {
  const sheet = newSheet(4, 4, [0, 0, 0]);
  fillRect(sheet, 2, 2, 100, 100, [255, 0, 0]);
  assert.deepEqual(pixel(sheet, 3, 3), [255, 0, 0]);
  assert.deepEqual(pixel(sheet, 1, 1), [0, 0, 0]);
});

test('fillRect ignores a negative extent', () => {
  const sheet = newSheet(4, 4, [0, 0, 0]);
  fillRect(sheet, 1, 1, -5, -5, [255, 0, 0]);
  assert.deepEqual(pixel(sheet, 1, 1), [0, 0, 0]);
});

test('a half-alpha fill blends with what is already there', () => {
  const sheet = newSheet(2, 2, [0, 0, 0]);
  fillRect(sheet, 0, 0, 2, 2, [255, 255, 255], 0.5);
  assert.deepEqual(pixel(sheet, 0, 0), [128, 128, 128]);
});

test('drawText lights the 5x7 glyph and returns the next x', () => {
  const sheet = newSheet(40, 20, [0, 0, 0]);
  const end = drawText(sheet, 2, 2, '1', 1, [255, 255, 255], { shadow: false });
  assert.equal(end, 2 + 6);
  let lit = 0;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 40; x++) if (pixel(sheet, x, y)[0] === 255) lit++;
  }
  assert.equal(lit, 10, 'the "1" glyph is ten pixels');
});

test('drawText scales the glyph instead of stretching one pixel', () => {
  const sheet = newSheet(80, 40, [0, 0, 0]);
  drawText(sheet, 0, 0, '8', 2, [255, 255, 255], { shadow: false });
  let lit = 0;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 80; x++) if (pixel(sheet, x, y)[0] === 255) lit++;
  }
  assert.ok(lit > 10, `expected a multi-pixel glyph, got ${lit}`);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 80; x++) {
      if (pixel(sheet, x, y)[0] === 255) {
        assert.deepEqual(pixel(sheet, Math.floor(x / 2) * 2, Math.floor(y / 2) * 2), [255, 255, 255]);
        return;
      }
    }
  }
});

test('an empty string draws nothing but still reports an x', () => {
  const sheet = newSheet(10, 10);
  assert.equal(drawText(sheet, 3, 3, '', 2, [255, 255, 255]), 3);
});

test('an unknown character renders as a blank advance', () => {
  const sheet = newSheet(40, 20, [0, 0, 0]);
  const end = drawText(sheet, 0, 0, '@', 1, [255, 255, 255], { shadow: false });
  assert.equal(end, 6);
  let lit = 0;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) if (pixel(sheet, x, y)[0] === 255) lit++;
  assert.equal(lit, 0);
});

test('blitCell copies a frame of exactly the destination size', () => {
  const dest = newSheet(1, 1);
  const frame = newSheet(1, 1, [12, 34, 56]);
  blitCell(dest, frame, 0, 0, 1, 1);
  assert.deepEqual(pixel(dest, 0, 0), [12, 34, 56]);
});

test('blitCell resamples a larger frame into a smaller slot', () => {
  const src = newSheet(4, 1, [0, 0, 0]);
  const colours = [
    [10, 0, 0],
    [20, 0, 0],
    [30, 0, 0],
    [40, 0, 0],
  ];
  colours.forEach((c, x) => {
    src.data[x * 3] = c[0];
    src.data[x * 3 + 1] = c[1];
    src.data[x * 3 + 2] = c[2];
  });
  const dest = newSheet(2, 1, [0, 0, 0]);
  blitCell(dest, src, 0, 0, 2, 1);
  assert.equal(pixel(dest, 0, 0)[0], 10);
  assert.equal(pixel(dest, 1, 0)[0], 30);
});

test('a badge is sized from the cell and stays legible', () => {
  const sheet = newSheet(421, 712);
  const size = drawBadge(sheet, 100, 40, '1', 417, 234);
  assert.deepEqual(size, { w: 24, h: 32 });
  let ink = 0;
  for (let y = 40; y < 40 + size.h; y++) {
    for (let x = 100; x < 100 + size.w; x++) {
      if (pixel(sheet, x, y).some((v, k) => v !== COLORS.bg[k])) ink++;
    }
  }
  assert.ok(ink > 0);
});

test('a tiny cell still gets the minimum badge scale', () => {
  const sheet = newSheet(40, 40);
  const size = drawBadge(sheet, 0, 0, '2', 40, 40);
  // Minimum scale 2: w = textWidth('2', 2) + 2*2 pad = 14, h = 7*2 + 4 = 18.
  assert.deepEqual(size, { w: 14, h: 18 });
});

test('the audio band paints its background and some bars', () => {
  const sheet = newSheet(20, 12);
  const before = Buffer.from(sheet.data);
  drawAudioBand(sheet, 0, 0, 20, 12, {
    envelope: [0.2, 0.5, 1, 0.7, 0.1, 0.9],
    binsPerSecond: 2,
    t0: 0,
    t1: 3,
    cuts: [{ t: 1.5 }],
    speech: [{ t0: 0, t1: 1 }],
  });
  assert.deepEqual(pixel(sheet, 0, 0), COLORS.stripBg);
  assert.ok(!Buffer.from(sheet.data).equals(before));
});

test('an empty audio span leaves the band untouched', () => {
  const sheet = newSheet(10, 10);
  sheet.data.fill(1);
  // t1 <= t0 is a no-op: an empty window paints nothing, not even the background.
  drawAudioBand(sheet, 0, 0, 10, 10, { envelope: [1], binsPerSecond: 1, t0: 2, t1: 2 });
  assert.ok(sheet.data.every((v) => v === 1));
});

test('composeSheet places each frame in its slot and pads the rest', () => {
  const grid = { cols: 2, rows: 1, cellW: 100, cellH: 50, width: 206, height: 54, count: 2, padding: 0 };
  const blue = newSheet(100, 50, [0, 0, 255]);
  const green = newSheet(100, 50, [0, 255, 0]);
  const sheet = composeSheet({
    grid,
    cells: [
      { index: 1, frame: blue.data, width: 100, height: 50 },
      { index: 2, frame: green.data, width: 100, height: 50 },
    ],
  });
  assert.equal(sheet.width, 206);
  assert.equal(sheet.height, 54);
  // 100x50 cells keep the top-left badge clear of this bottom-right pixel.
  assert.deepEqual(pixel(sheet, 2 + 100 - 1, 2 + 50 - 1), [0, 0, 255]);
  assert.deepEqual(pixel(sheet, 100 + 2 + 100 - 1, 2 + 50 - 1), [0, 255, 0]);
});

test('an empty grid slot is filled with the pad colour', () => {
  const grid = { cols: 1, rows: 2, cellW: 4, cellH: 2, width: 8, height: 12, count: 2, padding: 1 };
  const sheet = composeSheet({ grid, cells: [] });
  assert.deepEqual(pixel(sheet, 2, 2), COLORS.pad);
  assert.deepEqual(pixel(sheet, 2, 2 + 2 + 2), COLORS.pad);
});

test('the audio band is appended below the grid', () => {
  const grid = { cols: 1, rows: 1, cellW: 8, cellH: 8, width: 12, height: 12, count: 1, padding: 0 };
  const cell = newSheet(8, 8, [50, 50, 50]);
  const sheet = composeSheet({
    grid,
    cells: [{ index: 1, frame: cell }],
    audio: { envelope: [1, 1, 1, 1], binsPerSecond: 2, t0: 0, t1: 2, height: 6 },
  });
  assert.equal(sheet.height, 12 + 6 + 2);
  assert.deepEqual(pixel(sheet, 2, 12 + 2), COLORS.stripBg);
});

test('sheetQuality reports the fraction of slots actually used', () => {
  const grid = { cols: 2, rows: 2, cellW: 100, cellH: 50, width: 206, height: 106, count: 4, padding: 1 };
  assert.deepEqual(sheetQuality(grid, 3), {
    usedRatio: 0.75,
    cellW: 100,
    cellH: 50,
    width: 206,
    height: 106,
  });
});

test('the palette is the documented one', () => {
  assert.deepEqual(COLORS.bg, [11, 11, 14]);
  assert.deepEqual(COLORS.pad, [30, 30, 36]);
  assert.deepEqual(COLORS.stripBar, [63, 184, 175]);
});
