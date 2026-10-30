import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { filterSuspectSegments, applyTermMap, loadAsrSettings, scriptVariants } from '../src/asr.js';
import { loadTranscriptFile } from '../src/transcript.js';
import { sentenceGaps, snapCellsToSpeech, speechRate, groupCues } from '../src/timeline.js';

const cue = (t0, t1, text) => ({ t0, t1, text });

/* --------------------------------------------------------- hallucinations */

test('a punctuation-only segment is dropped, not quoted', () => {
  const { cues, dropped } = filterSuspectSegments([cue(0, 2, '。'), cue(2, 4, '真正的台词')]);
  assert.equal(cues.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].why, 'punctuation');
});

test('a long, near-empty segment is treated as music, not speech', () => {
  // The real case: a 90 s PV with one line, where the recogniser invented
  // "45.35-74.33, 9 characters" over the instrumental.
  const { cues, dropped } = filterSuspectSegments([
    cue(45.35, 74.33, '四十五分钟的海'),
    cue(10, 12, '这一句是人说的'),
  ]);
  assert.deepEqual(cues.map((c) => c.text), ['这一句是人说的']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].why, 'too-sparse');
});

test('a long segment with real talking speed survives', () => {
  // 10 s and 40 characters = 4 chars/s, which is normal speech.
  const { cues, dropped } = filterSuspectSegments([cue(0, 10, '这是一段正常的讲话内容包含着足够多的字而不会被认为是音乐')]);
  assert.equal(dropped.length, 0);
  assert.equal(cues.length, 1);
});

test('latin words count as content, so an English line is not punctuation', () => {
  const { cues } = filterSuspectSegments([cue(0, 3, 'wait, really?')]);
  assert.equal(cues.length, 1);
});

/* -------------------------------------------------------------- term map */

test('the longest key wins, so a short entry cannot half-fix a long one', () => {
  const { text, applied } = applyTermMap('八羽怪和羽', { 羽: '羽化', 八羽怪: '巴与怪' });
  assert.equal(text, '巴与怪和羽化');
  assert.equal(applied, 2);
});

test('a replacement is literal, not a regex replacement', () => {
  const { text } = applyTermMap('地规与地规', { 地规: '$&$&' });
  assert.equal(text, '$&$&与$&$&', 'the dollar sign in the replacement is not expanded');
});

test('an empty dictionary is a no-op that still reports zero', () => {
  const { text, applied } = applyTermMap('递推', {});
  assert.equal(text, '递推');
  assert.equal(applied, 0);
});


test('a Simplified dictionary entry also fixes Traditional output', () => {
  // Measured: whisper small returns 遞/規/階 for Mandarin, so a key the user
  // typed in Simplified used to miss entirely.
  const { text, applied } = applyTermMap('進行一個地規，階層是對的', { 地规: '递推' });
  assert.match(text, /递推/);
  assert.equal(applied, 1);
});

test('scriptVariants only swaps characters it knows', () => {
  assert.deepEqual(scriptVariants('地规').sort(), ['地規', '地规'].sort());
  assert.deepEqual(scriptVariants('abc'), ['abc']);
});

/* -------------------------------------------------------------- settings */

test('settings come from DSH_HOME/asr.json when the environment is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-cfg-'));
  try {
    writeFileSync(join(dir, 'asr.json'), JSON.stringify({ cmd: 'whisper-cli -m m.bin -f {wav} -of {out}', terms: { 地规: '递推' } }));
    const s = loadAsrSettings({ DSH_HOME: dir });
    assert.equal(s.source, 'file');
    assert.match(s.cmd, /whisper-cli/);
    assert.equal(s.terms['地规'], '递推');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the environment overrides the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-cfg-'));
  try {
    writeFileSync(join(dir, 'asr.json'), JSON.stringify({ cmd: 'from-file {wav}' }));
    const s = loadAsrSettings({ DSH_HOME: dir, DSH_ASR_CMD: 'from-env {wav}' });
    assert.equal(s.source, 'env');
    assert.equal(s.cmd, 'from-env {wav}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or broken settings file is not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-cfg-'));
  try {
    writeFileSync(join(dir, 'asr.json'), '{ not json');
    const s = loadAsrSettings({ DSH_HOME: dir });
    assert.equal(s.cmd, '');
    assert.equal(s.source, 'none');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------- transcript file */

const SRT = [
  '1',
  '00:00:00,500 --> 00:00:02,000',
  '第一句',
  '',
  '2',
  '00:00:02,200 --> 00:00:04,000',
  '第二句',
  '',
].join('\r\n');

test('an SRT transcript file is read with its own timing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-tr-'));
  try {
    const f = join(dir, 'a.srt');
    writeFileSync(f, SRT);
    const { cues, source } = loadTranscriptFile(f);
    assert.equal(source, 'srt');
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, '第一句');
    assert.equal(cues[0].t0, 0.5);
    assert.equal(cues[1].t1, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a WebVTT transcript file is recognised', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-tr-'));
  try {
    const f = join(dir, 'a.vtt');
    writeFileSync(f, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n');
    const { cues, source } = loadTranscriptFile(f);
    assert.equal(source, 'vtt');
    assert.equal(cues.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a JSON transcript file accepts seconds and {segments}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-tr-'));
  try {
    const f = join(dir, 'a.json');
    writeFileSync(f, JSON.stringify({ segments: [{ start: 1.5, end: 3, text: '甲' }, { start: 3, end: 4.25, text: '乙' }] }));
    const { cues, source } = loadTranscriptFile(f);
    assert.equal(source, 'json');
    assert.equal(cues.length, 2);
    assert.equal(cues[1].t1, 4.25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transcript file that cannot help says why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-tr-'));
  try {
    const empty = join(dir, 'e.srt');
    writeFileSync(empty, 'no cues here');
    assert.throws(() => loadTranscriptFile(empty), /no subtitle cues/);
    assert.throws(() => loadTranscriptFile(join(dir, 'missing.srt')), /could not be read/);
    const bad = join(dir, 'b.json');
    writeFileSync(bad, '{oops');
    assert.throws(() => loadTranscriptFile(bad), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- sentence snapping */

test('gaps are reported at the midpoint of the silence, ignoring short ones', () => {
  const gaps = sentenceGaps([cue(0, 2, 'a'), cue(2.1, 4, 'b'), cue(5, 6, 'c')]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, 4.5);
  assert.equal(gaps[0].gap, 1);
});

test('a cell boundary within the window moves onto the silence', () => {
  // The silence runs 3.7-4.1 s, so 3.9 is where the sentence changes hands.
  const cells = [{ t0: 0, t1: 3.4 }, { t0: 3.4, t1: 8 }];
  const moved = snapCellsToSpeech(cells, [cue(0, 3.7, 'a'), cue(4.1, 8, 'b')]);
  assert.equal(moved, 1);
  assert.equal(cells[0].t1, 3.9);
  assert.equal(cells[1].t0, 3.9);
});

test('a boundary far from any silence is left alone', () => {
  const cells = [{ t0: 0, t1: 2 }, { t0: 2, t1: 8 }];
  const moved = snapCellsToSpeech(cells, [cue(0, 6, 'a'), cue(6.4, 8, 'b')]);
  assert.equal(moved, 0);
  assert.equal(cells[0].t1, 2);
});

test('snapping never makes a cell shorter than the floor', () => {
  const cells = [{ t0: 0, t1: 3.95 }, { t0: 3.95, t1: 8 }];
  const moved = snapCellsToSpeech(cells, [cue(0, 3.9, 'a'), cue(4.5, 8, 'b')], { maxShift: 2, minCellSeconds: 4 });
  assert.equal(moved, 0, 'the move would have left the first cell at 3.9 s');
});

test('speechRate is characters per second over the spoken span', () => {
  assert.equal(speechRate([cue(0, 2, '一二三四'), cue(2, 4, '五六七八')]), 2);
  assert.equal(speechRate([]), 0);
});

test('groupCues still merges nearby lines for the summary count', () => {
  const merged = groupCues([cue(0, 1, '甲'), cue(1.1, 2, '乙')]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, '甲 乙');
});
