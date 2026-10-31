import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inkFraction, cellScale, zoomMarkers, zoomNote, downsample2 } from '../src/detail.js';
import { formatManifest } from '../src/manifest.js';

/** A flat rgb24 buffer, optionally with 1px stripes (fine detail). */
function picture(w, h, { stripe = 0, bg = 40, fg = 220 } = {}) {
  const b = Buffer.alloc(w * h * 3, bg);
  if (stripe) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x % (stripe * 2)) < stripe) {
          const i = (y * w + x) * 3;
          b[i] = b[i + 1] = b[i + 2] = fg;
        }
      }
    }
  }
  return b;
}

test('a flat picture has no ink, striped text does', () => {
  const flat = inkFraction(picture(120, 80), 120, 80);
  const stripes = inkFraction(picture(120, 80, { stripe: 2 }), 120, 80);
  assert.equal(flat, 0);
  assert.ok(stripes > 0.1, `expected ink, got ${stripes}`);

  // a picture whose detail is coarser than the 5x5 window is not "ink"
  const blocks = inkFraction(picture(120, 80, { stripe: 24 }), 120, 80);
  assert.ok(blocks < stripes, 'big blocks count less than thin strokes');
});

test('cellScale is source pixels per sheet pixel and never below one', () => {
  assert.equal(cellScale(1440, 180), 8);
  assert.equal(cellScale(720, 225), 3.2);
  assert.equal(cellScale(100, 400), 1);
});

test('zoom markers need both fine detail and a small cell', () => {
  const metrics = new Map([[1, { ink: 0.05 }], [2, { ink: 0.0001 }], [3, { ink: 0.02 }]]);

  const large = zoomMarkers(metrics, 2.0);
  assert.deepEqual(large.list, [], 'big cells are readable even where ink is dense');

  const small = zoomMarkers(metrics, 6.4);
  assert.deepEqual(small.list, [1, 3], 'the empty cell is not worth a zoom');
  assert.equal(small.all, false);
  assert.equal(small.scale, 6.4);

  const every = zoomMarkers(new Map([[1, { ink: 0.05 }], [2, { ink: 0.03 }]]), 8);
  assert.equal(every.all, true);
});

test('the header line says something different when every cell needs a zoom', () => {
  const some = zoomNote(zoomMarkers(new Map([[1, { ink: 0.05 }], [2, { ink: 0 }]]), 6));
  assert.match(some, /1\/2 cells/);
  assert.match(some, /cells 1 are marked/);

  const all = zoomNote(zoomMarkers(new Map([[1, { ink: 0.05 }], [2, { ink: 0.05 }]]), 6));
  assert.match(all, /every cell is shrunk 6x/);
  assert.match(all, /text under ~72px/);

  assert.equal(zoomNote(zoomMarkers(new Map([[1, { ink: 0.9 }]]), 1.2)), null);
});

test('a long list of zoom cells is elided instead of turning into prose', () => {
  // 20 of 30 flagged: "most cells", but not all of them, so the note lists a few
  const metrics = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, { ink: i < 20 ? 0.05 : 0 }]));
  const note = zoomNote(zoomMarkers(metrics, 6));
  assert.ok(note.length < 260, `note too long: ${note.length}`);
  assert.match(note, /…/);
});

test('downsample2 halves both axes and averages 2x2 blocks', () => {
  const buf = Buffer.from([
    0, 0, 0, 100, 100, 100,
    200, 200, 200, 255, 255, 255,
  ]);
  const out = downsample2(buf, 2, 2);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  assert.equal(out.data[0], (0 + 100 + 200 + 255) >> 2);
});

const probe = { path: 'x.mp4', duration: 60, width: 1280, height: 720, fps: 30 };
const scan = { cuts: [], summary: { medianShot: 30 }, start: 0 };
const plan = {
  duration: 60,
  cells: [
    { index: 1, t0: 0, t1: 30, frameT: 15 },
    { index: 2, t0: 30, t1: 60, frameT: 45 },
  ],
};

test('the manifest marks the cells worth zooming and lists them once', () => {
  const zoom = { list: [2], total: 2, all: false, scale: 4.5 };
  const out = formatManifest({
    probe, scan, plan, zoom,
    sheet: { pages: [{ grid: { cols: 1, rows: 2, width: 400, height: 450 } }] },
  });
  assert.match(out.text, /· zoom$/m, 'the column list mentions the marker');
  assert.match(out.text, /^zoom: 1\/2 cells/m);
  assert.match(out.text, /^2 r2c1 .* zoom$/m, 'only the flagged cell carries the word');
  assert.doesNotMatch(out.text, /^1 r1c1 .* zoom$/m);
});

test('no zoom line at all when every cell is readable', () => {
  const out = formatManifest({
    probe, scan, plan,
    zoom: { list: [], total: 2, all: false, scale: 1.2 },
    sheet: { pages: [{ grid: { cols: 1, rows: 2, width: 400, height: 450 } }] },
  });
  assert.doesNotMatch(out.text, /zoom/);
});
