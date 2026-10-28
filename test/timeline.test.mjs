import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_DEFAULTS,
  timecode,
  timecodeShort,
  parseSubtitleText,
  extractSubtitles,
  groupCues,
  segmentAt,
} from '../src/timeline.js';

test('timecode renders minutes, seconds and centiseconds', () => {
  assert.equal(timecode(0), '00:00.00');
  assert.equal(timecode(2), '00:02.00');
  assert.equal(timecode(61.5), '01:01.50');
  assert.equal(timecode(59.999), '01:00.00');
});

test('timecode grows an hours field only when it needs one', () => {
  assert.equal(timecode(3600), '1:00:00.00');
  assert.equal(timecode(6, { hours: true }), '0:00:06.00');
  assert.equal(timecode(3600, { hours: false }), '00:00.00');
});

test('timecode keeps the sign for times before zero', () => {
  assert.equal(timecode(-1.5), '-00:01.50');
  assert.equal(timecode(-0.004), '-00:00.00');
});

test('a NaN timecode is rendered, not thrown', () => {
  assert.equal(timecode(Number.NaN), 'NaN:NaN.NaN');
});

test('timecodeShort drops the fractional seconds', () => {
  assert.equal(timecodeShort(0), '00:00');
  assert.equal(timecodeShort(2.9), '00:02');
  assert.equal(timecodeShort(61), '01:01');
  assert.equal(timecodeShort(3599), '59:59');
});

test('an SRT cue keeps its text and time span', () => {
  const cues = parseSubtitleText(
    '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond cue\n',
  );
  assert.deepEqual(cues, [
    { t0: 1, t1: 2.5, text: 'Hello there' },
    { t0: 3, t1: 4, text: 'Second cue' },
  ]);
});

test('a multi-line cue becomes one line of text', () => {
  const cues = parseSubtitleText(
    '1\n00:00:01,000 --> 00:00:02,000\nFirst line\nSecond line\n\n2\n00:00:03,000 --> 00:00:04,000\nThird\n',
  );
  assert.equal(cues[0].text, 'First line Second line');
});

test('a WebVTT file skips its header and its NOTE block', () => {
  const cues = parseSubtitleText(
    [
      'WEBVTT',
      '',
      'NOTE this is a comment',
      '',
      '00:00:01.000 --> 00:00:02.500',
      '<v Speaker>Hello</v> {\\an8}world',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '<b>Bold</b> text',
    ].join('\n'),
  );
  assert.deepEqual(cues, [
    { t0: 1, t1: 2.5, text: 'Hello world' },
    { t0: 3, t1: 4, text: 'Bold text' },
  ]);
});

test('CRLF subtitle files parse like LF files', () => {
  const cues = parseSubtitleText('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n');
  assert.deepEqual(cues.map((c) => c.text), ['Hi', 'Bye']);
});

test('a fractional timestamp of one digit is read as tenths', () => {
  const cues = parseSubtitleText('1\n00:00:01,5 --> 00:00:02,25\nPadded\n');
  assert.equal(cues[0].t0, 1.5);
  assert.equal(cues[0].t1, 2.25);
});

test('empty and timestamp-free subtitle files produce no cues', () => {
  assert.deepEqual(parseSubtitleText(''), []);
  assert.deepEqual(parseSubtitleText('just some prose\n\nand more prose\n'), []);
  assert.deepEqual(parseSubtitleText('1\n00:00:01,000\nonly a start\n'), []);
});

test('a cue with no visible text is dropped', () => {
  assert.deepEqual(parseSubtitleText('1\n00:00:01,000 --> 00:00:02,000\n<font color="red"></font>\n'), []);
});

test('adjacent cues merge into one block when they fit', () => {
  // A→B gap 0.1 s merges; C's 1.5 s gap exceeds the default maxGap of 1.2 s.
  const merged = groupCues([
    { t0: 0, t1: 1, text: 'A' },
    { t0: 1.1, t1: 2, text: 'B' },
    { t0: 3.5, t1: 4.5, text: 'C' },
  ]);
  assert.deepEqual(merged, [
    { t0: 0, t1: 2, text: 'A B' },
    { t0: 3.5, t1: 4.5, text: 'C' },
  ]);
});

test('a gap larger than maxGap keeps cues apart', () => {
  const cues = groupCues(
    [
      { t0: 0, t1: 1, text: 'A' },
      { t0: 2, t1: 3, text: 'B' },
    ],
    { maxGap: 0.5 },
  );
  assert.equal(cues.length, 2);
});

test('a merge never pushes past maxChars', () => {
  const cues = groupCues(
    [
      { t0: 0, t1: 1, text: 'AA' },
      { t0: 1, t1: 2, text: 'BB' },
    ],
    { maxChars: 3 },
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'AA');
});

test('groupCues of nothing is nothing', () => {
  assert.deepEqual(groupCues([]), []);
});

test('segmentAt finds the cue covering a time and nothing outside it', () => {
  const segments = [
    { t0: 0, t1: 2, text: 'A' },
    { t0: 3, t1: 4, text: 'B' },
  ];
  assert.equal(segmentAt(segments, 0).text, 'A');
  assert.equal(segmentAt(segments, 2).text, 'A');
  assert.equal(segmentAt(segments, 2.5), null);
  assert.equal(segmentAt(segments, 3).text, 'B');
  assert.equal(segmentAt(segments, 4).text, 'B');
  assert.equal(segmentAt(segments, 4.1), null);
  assert.equal(segmentAt(segments, -0.1), null);
});

test('segmentAt rejects a non-finite time instead of answering with a cue', () => {
  const segments = [
    { t0: 0, t1: 2, text: 'A' },
    { t0: 2, t1: 3, text: 'B' },
  ];
  assert.equal(segmentAt(segments, 2).text, 'A');
  assert.equal(segmentAt(segments, Number.NaN), null);
});

test('the audio defaults are the documented ones', () => {
  assert.deepEqual(AUDIO_DEFAULTS, {
    sampleRate: 8000,
    binMs: 40,
    speechFloorDb: -42,
    minSpeech: 0.3,
    mergeGap: 0.28,
    onsetK: 2.6,
  });
});

// Built without string escapes: the shell that patches this file eats one level of them.
const NL = String.fromCharCode(10);
const SRT = ['1', '00:00:00,500 --> 00:00:02,000', 'Hello.', '', ''].join(NL);

// Regression: `probeVideo()` reports `hasSubtitle` and returns no `streams`
// array, so gating on `probe.streams` made subtitle quoting dead on every real
// file while a hand-built fixture with `streams` passed.
test('extractSubtitles runs when the probe only reports hasSubtitle', async () => {
  const srt = SRT;
  const calls = [];
  const run = async (bin, args) => {
    calls.push(args.join(' '));
    return { code: 0, stdout: Buffer.from(srt, 'utf8'), stderr: Buffer.alloc(0), ms: 1 };
  };
  const res = await extractSubtitles({
    input: 'clip.mp4',
    ffmpegPath: 'ffmpeg',
    run,
    probe: { hasSubtitle: true },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('-map 0:s:0'), calls[0]);
  assert.equal(res.source, 'subtitle-track');
  assert.equal(res.cues.length, 1);
  assert.equal(res.cues[0].text, 'Hello.');
});

test('extractSubtitles stays quiet when there is no subtitle stream', async () => {
  let called = false;
  const run = async () => { called = true; return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), ms: 1 }; };
  for (const probe of [{ hasSubtitle: false }, {}, null]) {
    const res = await extractSubtitles({ input: 'clip.mp4', ffmpegPath: 'ffmpeg', run, probe });
    assert.deepEqual(res, { cues: [], source: null });
  }
  assert.equal(called, false);
});
