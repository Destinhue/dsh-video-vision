import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBS_DEFAULTS,
  probeTimes,
  subtitleBands,
  pickSubtitleBand,
  bandRect,
  cropExpr,
  scanPlan,
  mergeSubtitleCues,
  subsDocument,
  tc,
} from '../src/subs.js';

const W = 1280;
const H = 720;

/** one OCR result: lines given as normalised boxes, so the tests read like frames */
function frame(lines, { width = W, height = H } = {}) {
  return {
    width,
    height,
    text: lines.map((l) => l.text).join('\n'),
    lines: lines.map((l) => ({
      text: l.text,
      x0: l.x0 * width,
      x1: l.x1 * width,
      y0: l.y0 * height,
      y1: l.y1 * height,
    })),
  };
}

/** a bilingual caption: a 31 px Chinese row and a 19 px English row under it */
function bilingual(text, { y = 0.88 } = {}) {
  return frame([
    { text, x0: 0.26, x1: 0.74, y0: y, y1: y + 31 / H },
    { text: 'and this is the english line', x0: 0.35, x1: 0.65, y0: y + 38 / H, y1: y + 57 / H },
  ]);
}

test('tc formats minutes past 59 like a timestamp', () => {
  assert.equal(tc(0), '00:00');
  assert.equal(tc(65), '01:05');
  assert.equal(tc(966), '16:06');
  assert.equal(tc(-3), '00:00');
  assert.equal(tc(NaN), '00:00');
});

test('probeTimes looks at three fractions, never the first or last frame', () => {
  assert.deepEqual(probeTimes({ start: 0, end: 100 }), [15, 45, 75]);
  assert.deepEqual(probeTimes({ start: 20, end: 120 }), [35, 65, 95]);
  assert.deepEqual(probeTimes({ start: 0, end: 100, count: 2 }), [15, 45]);
  // a window with no length still gets one honest still, not a division by zero
  assert.equal(probeTimes({ start: 10, end: 10 }).length, 3);
  assert.ok(probeTimes({ start: 10, end: 10 }).every((t) => t > 10));
});

test('subtitleBands joins a bilingual pair into one band and prices its glyphs', () => {
  const bands = subtitleBands(bilingual('先说结论，字幕其实是画面里最便宜的信息'));
  assert.equal(bands.length, 1);
  const band = bands[0];
  assert.equal(band.lines.length, 2);
  // the Chinese row is taller; the median of one 31 and one 19 px row is 25
  assert.equal(Math.round(band.glyphPx), 25);
  assert.ok(band.y0 > 0.85 && band.y1 < 1);
  assert.ok(band.x0 >= 0.26 && band.x1 <= 0.74);
});

test('subtitleBands rejects what only looks like a caption', () => {
  // a title card pinned to the top edge
  assert.deepEqual(subtitleBands(frame([{ text: '第一章 绪论', x0: 0.3, x1: 0.7, y0: 0, y1: 0.04 }])), []);
  // a heading four times the height of a caption row
  assert.deepEqual(subtitleBands(frame([{ text: '第一章 绪论与研究方法', x0: 0.2, x1: 0.8, y0: 0.4, y1: 0.54 }])), []);
  // a label in the corner, not the middle of the picture
  assert.deepEqual(subtitleBands(frame([{ text: '订阅按钮在这里', x0: 0.86, x1: 0.99, y0: 0.9, y1: 0.935 }])), []);
  // a screenshot with no text at all
  assert.deepEqual(subtitleBands(frame([])), []);
  // a single narrow glyph is not a line
  assert.deepEqual(subtitleBands(frame([{ text: '。', x0: 0.5, x1: 0.52, y0: 0.9, y1: 0.94 }])), []);
});

test('pickSubtitleBand accepts a band that moves on the clock', () => {
  const records = [
    { t: 18, rec: bilingual('这一期我们聊聊怎么把一整条视频读成文字') },
    { t: 54, rec: bilingual('问题在于很多片子把字幕烧进了画面里') },
    { t: 90, rec: bilingual('字幕的位置每条片子都不一样') },
  ];
  const verdict = pickSubtitleBand(records);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, undefined);
  assert.equal(verdict.frames, 3);
  assert.ok(verdict.glyphPx > 20);
  assert.ok(verdict.band.y0 > 0.8);
});

test('pickSubtitleBand refuses text that never changes', () => {
  const one = '@某某观察频道';
  const records = [18, 54, 90].map((t) => ({ t, rec: bilingual(one) }));
  const verdict = pickSubtitleBand(records);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'fixed');
  assert.match(verdict.reason, /caption changes on the clock/);
});

test('pickSubtitleBand does not trust a band seen on one still', () => {
  const records = [
    { t: 18, rec: bilingual('这一期我们聊聊怎么把一整条视频读成文字') },
    { t: 54, rec: frame([]) },
    { t: 90, rec: frame([]) },
  ];
  const verdict = pickSubtitleBand(records);
  assert.equal(verdict.code, 'single-frame');
  assert.match(verdict.reason, /only one of 3/);
});

test('pickSubtitleBand measures a caption too small to read instead of scanning it', () => {
  // an 8 px row on a 720 px picture: the engine returns invented characters
  const tiny = (text) => frame([{ text, x0: 0.3, x1: 0.7, y0: 0.945, y1: 0.945 + 8 / H }]);
  const records = [
    { t: 9, rec: tiny('先说墮论@ 字 其 实 是 面 果') },
    { t: 27, rec: tiny('器 果 没 有 字 辇 也 拍 不 出') },
    { t: 45, rec: tiny('就 是 字 号 庭 够 不 够 认') },
  ];
  const verdict = pickSubtitleBand(records);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'small');
  assert.ok(verdict.glyphPx < 11);
  assert.match(verdict.reason, /720 px picture/);
  assert.match(verdict.reason, /11 px floor/);
});

test('pickSubtitleBand reports a doubled probe at file resolution', () => {
  // the same 8 px caption, read from stills that were doubled before OCR: the
  // row is 16 px on a 1440 px copy, which is 8 px of the 720 px file
  const rec = (text) => frame(
    [{ text, x0: 0.3, x1: 0.7, y0: 0.945, y1: 0.945 + 16 / (H * 2) }],
    { width: W * 2, height: H * 2 },
  );
  const records = [{ t: 9, rec: rec('先说墮论@ 字 其 实 是 面 果') }, { t: 27, rec: rec('器 果 没 有 字 辇 也 拍 不 出') }];
  const verdict = pickSubtitleBand(records, { scale: 2 });
  assert.equal(verdict.code, 'small');
  assert.ok(Math.abs(verdict.glyphPx - 8) < 0.6);
  assert.match(verdict.reason, /720 px picture/);
});

test('pickSubtitleBand falls back to near-miss text when no line has caption shape', () => {
  // a narrow column of caption text: too narrow for the band test, still text
  const column = (text) => frame([{ text, x0: 0.48, x1: 0.52, y0: 0.6, y1: 0.6 + 8 / H }]);
  const records = [
    { t: 9, rec: column('字幕太窄了但确实有字') },
    { t: 27, rec: column('这一列也是同一行字') },
    { t: 45, rec: column('第三帧还是这一行') },
  ];
  const verdict = pickSubtitleBand(records);
  assert.equal(verdict.code, 'small');
  assert.match(verdict.reason, /stops reading and starts guessing/);
});

test('pickSubtitleBand never reports picture noise as small captions', () => {
  // glyphs off a busy pattern: static, readable enough to be a band, and far too
  // few characters to be what the "too small" answer is about
  const noise = frame([{ text: '： ： 13 ． 6æ', x0: 0.45, x1: 0.55, y0: 0.5, y1: 0.5 + 10 / H }]);
  const verdict = pickSubtitleBand([{ t: 9, rec: noise }, { t: 27, rec: noise }]);
  assert.notEqual(verdict.code, 'small');
  assert.equal(verdict.ok, false);
  // a frame the engine read nothing from is the no-band answer
  assert.equal(pickSubtitleBand([{ t: 9, rec: frame([]) }, { t: 27, rec: frame([]) }]).code, 'no-band');
});

test('bandRect adds air around the glyphs and stays inside the frame', () => {
  const rect = bandRect({ x0: 0.26, y0: 0.88, x1: 0.74, y1: 0.97 });
  assert.ok(rect.y < 0.88);
  assert.ok(rect.y + rect.h > 0.97 || Math.abs(rect.y + rect.h - 1) < 1e-9);
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.w <= 1 + 1e-9 && rect.y + rect.h <= 1 + 1e-9);
  assert.ok(rect.w > 0.48 - 1e-9);
  // a band at the very top pads into the frame rather than outside it
  const top = bandRect({ x0: 0.1, y0: 0, x1: 0.9, y1: 0.05 });
  assert.equal(top.y, 0);
  assert.ok(top.y + top.h <= 1);
});

test('cropExpr turns a rectangle into an ffmpeg crop', () => {
  const expr = cropExpr({ x: 0.02, y: 0.88, w: 0.96, h: 0.09 });
  assert.match(expr, /^crop=iw\*0\.9600:ih\*0\.0900:iw\*0\.0200:ih\*0\.8800$/);
  // a rectangle that would overflow is clamped, not handed to ffmpeg to fail on
  const clamped = cropExpr({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
  assert.doesNotMatch(clamped, /0\.9[0-9]*[^:]*:[0-9.]*,/);
  assert.match(clamped, /crop=iw\*0\.5000:ih\*0\.5000:iw\*0\.9000:ih\*0\.9000/);
});

test('scanPlan reads one frame a second until the read gets long', () => {
  assert.deepEqual(scanPlan({ start: 0, end: 60 }), { step: 1, frames: 60, span: 60 });
  const long = scanPlan({ start: 0, end: 7200 });
  assert.ok(long.frames <= SUBS_DEFAULTS.maxFrames);
  assert.ok(long.step > 1);
  const short = scanPlan({ start: 0, end: 0.5 });
  assert.equal(short.frames, 1);
  assert.equal(scanPlan({ start: 0, end: 60, step: 2 }).frames, 30);
});

test('mergeSubtitleCues turns sampled frames into cues, one per caption', () => {
  const samples = [
    { i: 0, t: 0, text: '这一期我们聊聊怎么把一整条视频' },
    { i: 1, t: 1, text: '这一期我们聊聊怎么把一整条视频读' },
    { i: 2, t: 2, text: '这一期我们聊聊怎么把一整条视频读成' },
    { i: 3, t: 3, text: '' },
    { i: 4, t: 4, text: '问题在于很多片子把字幕烧进了画面' },
  ];
  const { cues, capped } = mergeSubtitleCues(samples, { step: 1 });
  assert.equal(capped, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].t, 0);
  assert.equal(cues[0].tEnd, 3);
  assert.match(cues[0].text, /读成$/);
  assert.equal(cues[1].t, 4);
  assert.equal(cues[1].tEnd, 5);
});

test('mergeSubtitleCues does not merge across a gap or out of order', () => {
  const samples = [
    { i: 0, t: 0, text: '一行字幕' },
    { i: 5, t: 5, text: '一行字幕' },
  ];
  assert.equal(mergeSubtitleCues(samples, { step: 1 }).cues.length, 2);
  const noIndex = [{ t: 0, text: '一行字幕' }, { t: 1, text: '一行字幕' }];
  assert.equal(mergeSubtitleCues(noIndex, { step: 1 }).cues.length, 1);
});

test('mergeSubtitleCues caps a long file and clamps the last cue to its window', () => {
  const samples = Array.from({ length: 8 }, (_, i) => ({ i, t: i, text: `第${i}句字幕内容` }));
  const { cues, capped } = mergeSubtitleCues(samples, { step: 1, maxCues: 3 });
  assert.equal(cues.length, 3);
  assert.equal(capped, 5);
  const end = mergeSubtitleCues([
    { i: 0, t: 0, text: '第一行字幕内容' },
    { i: 1, t: 1, text: '第二行字幕内容' },
    { i: 2, t: 2, text: '第三行字幕内容' },
  ], { step: 1, end: 2.2 }).cues;
  assert.equal(end.length, 3);
  assert.ok(end.every((c) => c.tEnd <= 2.2));
});

test('subsDocument says where the lines came from and how they were read', () => {
  const band = { x: 0.26, y: 0.88, w: 0.48, h: 0.09 };
  const { text } = subsDocument({
    title: 'clip.mp4',
    cues: [{ t: 0, tEnd: 3, text: '这一期我们聊聊怎么把一整条视频读成文字' }],
    band,
    glyphPx: 31,
    height: 720,
    frames: 966,
    step: 1,
    duration: 966,
  });
  assert.match(text, /^# clip\.mp4 — read as text · burned-in subtitles · 1 lines · 16:06/);
  assert.match(text, /no subtitle track/);
  assert.match(text, /caption band y 88%–97%, glyph height 31 px of 720, 966 frames read 1 s apart/);
  assert.match(text, /\[00:00–00:03\] 这一期我们聊聊/);
});

test('subsDocument reports its cap instead of silently stopping', () => {
  const cues = Array.from({ length: 3 }, (_, i) => ({ t: i * 3, tEnd: i * 3 + 3, text: `第${i}句一整行字幕` }));
  const { text } = subsDocument({ title: 'x', cues, maxChars: 40 });
  assert.match(text, /note: capped at 1 of 3 lines/);
});

test('subsDocument keeps whole-frame screens when the screen read found some', () => {
  const { text } = subsDocument({
    title: 'x',
    cues: [{ t: 0, tEnd: 2, text: '一行字幕' }],
    screens: [{ t: 5, text: '一张标题卡上的字' }],
  });
  assert.match(text, /1 whole-frame screen carried text too/);
  assert.match(text, /## screens/);
  assert.match(text, /\[00:05\] 一张标题卡上的字/);
});
