import test from 'node:test';
import assert from 'node:assert/strict';
import { formatManifest, formatShotList, slotLabel, ROW } from '../src/manifest.js';

function fixture(overrides = {}) {
  const grid = { cols: 1, rows: 3, cellW: 417, cellH: 234, width: 421, height: 712, count: 3, padding: 0 };
  const cells = [
    { index: 1, t0: 0, t1: 2, frameT: 0.983, dupOf: null },
    { index: 2, t0: 2, t1: 4, frameT: 2.983, dupOf: null },
    { index: 3, t0: 4, t1: 6, frameT: 4.983, dupOf: null },
  ];
  const scan = {
    start: 0,
    duration: 6,
    cuts: [
      { i: 59, t: 2, kind: 'cut' },
      { i: 119, t: 4, kind: 'cut' },
    ],
    summary: { medianShot: 2, shots: 3, cuts: 2 },
    degraded: null,
  };
  const probe = { path: 'clip.mp4', duration: 6, width: 640, height: 360, fps: 30 };
  return {
    probe,
    scan,
    plan: { duration: 6, cells },
    sheet: { pages: [{ grid, cells }] },
    ...overrides,
  };
}

test('the manifest header names the clip, geometry, cuts and median shot', () => {
  const { text } = formatManifest(fixture());
  assert.ok(text.includes('clip.mp4 · 0:00:06.00 · 640x360 · 30fps · 2 cuts · median shot 2.00s'), text);
});

test('a caller-supplied name replaces the probed path', () => {
  const { text } = formatManifest(fixture({ name: '我的片段.mp4' }));
  assert.ok(text.startsWith('我的片段.mp4 · '));
});

test('the sheet line gives the grid, its size and the cell count', () => {
  const { text } = formatManifest(fixture());
  assert.ok(text.includes('sheet 1 · 1x3 grid · 421x712 · 3 cells · window 00:00.00-00:06.00'), text);
});

test('a windowed scan reports the window it took, not the whole clip', () => {
  const data = fixture({
    probe: { path: 'clip.mp4', duration: 40, width: 640, height: 360, fps: 30 },
    plan: { duration: 20, cells: [] },
    sheet: { pages: [{ grid: { cols: 1, rows: 1, cellW: 10, cellH: 10, width: 12, height: 12, count: 1, padding: 0 }, cells: [] }] },
  });
  data.scan.start = 10;
  data.scan.duration = 20;
  const { text } = formatManifest(data);
  assert.ok(text.includes(' · window 00:10.00-00:30.00'), text);
  assert.ok(!text.includes('00:10.00-00:40.00'), text);
});

test('each cell gets its slot label, span and frame time', () => {
  const { text } = formatManifest(fixture());
  assert.ok(text.includes('1 r1c1 00:00.00-00:02.00 @00:00.98'));
  assert.ok(text.includes('2 r2c1 00:02.00-00:04.00 @00:02.98'));
  assert.ok(text.includes('3 r3c1 00:04.00-00:06.00 @00:04.98'));
});

test('a cut strictly inside a span is called out, and a fade is named', () => {
  const data = fixture();
  data.plan.cells = [{ index: 1, t0: 0, t1: 6, frameT: 3, dupOf: null }];
  data.scan.cuts = [
    { i: 30, t: 3, kind: 'cut' },
    { i: 40, t: 4, kind: 'fade' },
  ];
  const { text } = formatManifest(data);
  assert.ok(text.includes(' (2fade)'), text);
});

test('a repeat cell points at the cell it duplicates', () => {
  const data = fixture();
  data.plan.cells[2].dupOf = 2;
  const { text } = formatManifest(data);
  assert.ok(text.includes('3 r3c1 00:04.00-00:06.00 @00:04.98 =cell 2'), text);
});

test('a multi-page sheet is numbered as 1/N', () => {
  const data = fixture();
  data.sheet.pages.push({ grid: data.sheet.pages[0].grid, cells: [] });
  const { text } = formatManifest(data);
  assert.ok(text.includes('sheet 1/2 · 1x3 grid'), text);
});

test('without a sheet every cell line still names a span', () => {
  const { text } = formatManifest(fixture({ sheet: { pages: [] } }));
  // No sheet means no position column: one separator, then the span.
  const cellLines = text.split('\n').filter((line) => /^\d+ \d/.test(line));
  assert.equal(cellLines.length, 3);
  assert.ok(cellLines[0].startsWith('1 00:00.00-00:02.00'));
});

test('only-cell filtering drops every other cell line', () => {
  const { text } = formatManifest(fixture({ only: [2] }));
  assert.ok(text.includes('2 r2c1 00:02.00-00:04.00'));
  assert.ok(!text.includes('1 r1c1'));
  assert.ok(!text.includes('3 r3c1'));
});

test('the degraded note explains a flat or empty scan', () => {
  const data = fixture();
  data.scan.degraded = 'flat';
  assert.ok(formatManifest(data).text.includes('note: '));
});

test('subtitles are quoted on the cells they overlap', () => {
  const data = fixture({
    transcript: {
      source: 'embedded',
      segments: [
        { t0: 0.5, t1: 1.5, text: '你好，世界' },
        { t0: 2.5, t1: 3.5, text: '第二句' },
      ],
    },
  });
  const { text } = formatManifest(data);
  assert.ok(text.includes('1 r1c1 00:00.00-00:02.00 @00:00.98 · "你好，世界"'), text);
  assert.ok(text.includes('2 r2c1 00:02.00-00:04.00 @00:02.98 · "第二句"'), text);
  assert.ok(text.includes('transcript: embedded · 2 segments'), text);
});

test('an over-long subtitle quote is cut with an ellipsis', () => {
  const data = fixture({
    transcript: { source: 'embedded', segments: [{ t0: 0, t1: 6, text: '字'.repeat(400) }] },
    limits: { maxChars: 24000, maxCellChars: 20 },
  });
  const { text } = formatManifest(data);
  assert.ok(text.includes(` · "${'字'.repeat(19)}…"`), text);
});

// Regression: the pipeline hands over RAW cues, and a line that straddles a cut
// must be quoted once, on the cell holding its midpoint — not on both.
test('raw cues are attributed to one cell by midpoint', () => {
  const data = fixture({
    transcript: {
      source: 'subtitle-track',
      cues: [
        { t0: 0.5, t1: 2.0, text: 'Hello from the subtitle track.' },
        { t0: 2.2, t1: 4.0, text: 'Second line, still shot one.' },
        { t0: 5.1, t1: 7.4, text: 'Now we are in shot two.' },
      ],
      segments: [{ t0: 0.5, t1: 7.4, text: 'Hello. Second line. Now we are in shot two.' }],
    },
  });
  const { text } = formatManifest(data);
  assert.ok(
    text.includes('1 r1c1 00:00.00-00:02.00 @00:00.98 · "Hello from the subtitle track."'),
    text,
  );
  assert.ok(
    text.includes('2 r2c1 00:02.00-00:04.00 @00:02.98 · "Second line, still shot one."'),
    text,
  );
  // The third cue's midpoint (6.25 s) is past this three-cell fixture's last span.
  assert.ok(!text.includes('Now we are in shot two.'), text);
});

test('a cue spanning a cut is quoted on the cell with its midpoint only', () => {
  const data = fixture({
    transcript: {
      source: 'subtitle-track',
      cues: [{ t0: 1.6, t1: 2.4, text: 'straddles the cut' }],
    },
  });
  const { text } = formatManifest(data);
  const hits = text.split('straddles the cut').length - 1;
  assert.equal(hits, 1, text);
  assert.ok(text.includes('2 r2c1 00:02.00-00:04.00'), text);
});

test('the manifest stops growing at the character limit', () => {
  const { text, truncated } = formatManifest(
    fixture({ limits: { maxChars: 220, maxCellChars: 160 } }),
  );
  assert.equal(truncated, true);
  // The message names the first cell that did not fit, not the line count.
  assert.ok(text.includes('[text truncated at cell 2]'), text);
});

test('audio statistics appear only when the file has audio', () => {
  const data = fixture({
    probe: { path: 'clip.mp4', duration: 6, width: 640, height: 360, fps: 30, hasAudio: true },
    audio: {
      // The real analyzeAudio() shape: speech spans, loudnessDb, events.
      hasAudio: true,
      duration: 6,
      binsPerSecond: 10,
      speech: [{ t: 0, dur: 3 }],
      loudnessDb: -10,
      envelope: Array.from({ length: 60 }, (_, i) => (i === 30 ? 1 : 0)),
      silences: [{ t0: 0, t1: 1 }],
      events: [{ t: 1 }, { t: 3 }],
    },
  });
  const { text } = formatManifest(data);
  assert.ok(text.includes('audio: speech 50% · -10 dBFS · loudest 00:03.00 · 1 silences · 2 onsets'), text);
});

test('a silent file is reported as having no audio', () => {
  const data = fixture({ probe: { path: 'clip.mp4', duration: 6, width: 640, height: 360, fps: 30, hasAudio: false } });
  assert.ok(formatManifest(data).text.includes('audio: none'));
});

test('a zero-cut clip reports zero cuts and one shot', () => {
  const data = fixture();
  data.scan.cuts = [];
  data.scan.summary = { medianShot: 6, shots: 1, cuts: 0 };
  data.plan.cells = [{ index: 1, t0: 0, t1: 6, frameT: 3, dupOf: null }];
  data.sheet.pages[0].cells = data.plan.cells;
  data.sheet.pages[0].grid = { ...data.sheet.pages[0].grid, rows: 1, count: 1 };
  const { text } = formatManifest(data);
  assert.ok(text.includes('0 cuts · median shot 6.00s'), text);
  assert.ok(text.includes('1 cells'), text);
});

test('slotLabel is one-based in both axes', () => {
  assert.equal(slotLabel(0, 1), 'r1c1');
  assert.equal(slotLabel(2, 1), 'r3c1');
  assert.equal(slotLabel(3, 2), 'r2c2');
});

test('ROW ids are integer strings', () => {
  assert.equal(ROW(3.5), '4');
  assert.equal(ROW(12.4), '12');
});

test('the shot list pairs each span with its kind and cell count', () => {
  const scan = { cuts: [{ t: 2, kind: 'fade' }, { t: 4, kind: 'cut' }] };
  // planCells() attaches each shot's cell count (src/layout.js:464).
  const plan = {
    cells: [{ shotIndex: 0 }, { shotIndex: 1 }, { shotIndex: 1 }, { shotIndex: 2 }],
    shots: [
      { t0: 0, t1: 2, kind: 'cut', cells: 1, sameAsCell: null },
      { t0: 2, t1: 4, kind: 'fade', cells: 2, sameAsCell: 1 },
      { t0: 4, t1: 6, kind: 'cut', cells: 1, sameAsCell: null },
    ],
  };
  const text = formatShotList(scan, plan);
  assert.deepEqual(text.split('\n'), [
    '00:00-00:02 cut ·1 cell',
    '00:02-00:04 fade ·2 cells =cell 1',
    '00:04-00:06 cut ·1 cell',
  ]);
});

test('the shot list honours maxShots', () => {
  const plan = {
    cells: [],
    shots: Array.from({ length: 10 }, (_, i) => ({ t0: i, t1: i + 1, kind: 'cut', sameAsCell: null })),
  };
  assert.equal(formatShotList({ cuts: [] }, plan, { maxShots: 3 }).split('\n').length, 3);
});

test('notes about what the request lost are printed after the sheet line', () => {
  const { text } = formatManifest(fixture({ notes: ['start 00:40.00 moved to 00:11.80 — the file is 00:12.00 long'] }));
  assert.ok(text.includes('\nnote: start 00:40.00 moved to 00:11.80 — the file is 00:12.00 long'), text);
});

test('a manifest without notes prints no note lines', () => {
  const { text } = formatManifest(fixture());
  assert.equal((text.match(/^note: /gm) ?? []).length, 0, text);
});
