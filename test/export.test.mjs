import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findFfmpeg, run } from '../src/media.js';
import { ocrBackend } from '../src/ocr.js';
import {
  exportFormat, runRead, subtitleFile, transcriptLines, writeReadExport, screensAsItems,
} from '../src/read.js';

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));

function tempDir(tag = 'export-') {
  mkdirSync(TMP, { recursive: true });
  return mkdtempSync(join(TMP, tag));
}

test('the extension decides the export shape', () => {
  assert.equal(exportFormat('a.srt'), 'srt');
  assert.equal(exportFormat('A.SRT'), 'srt');
  assert.equal(exportFormat('notes/talk.vtt'), 'vtt');
  assert.equal(exportFormat('notes/talk.txt'), 'text');
  assert.equal(exportFormat('notes/talk'), 'text');
  assert.equal(exportFormat(undefined), 'text');
});

test('a subtitle file is numbered cues with real timecodes', () => {
  const cues = [
    { t0: 1.5, t1: 3, text: 'first line' },
    { t0: 3, t1: 62.25, text: 'second  line\nwrapped' },
    { t0: 62.25, t1: 64, text: '   ' },
  ];
  const srt = subtitleFile(cues);
  assert.match(srt, /^1\n00:00:01,500 --> 00:00:03,000\nfirst line$/m);
  // whitespace is collapsed: a cue is one subtitle line, not a paragraph
  assert.match(srt, /^2\n00:00:03,000 --> 00:01:02,250\nsecond line wrapped$/m);
  assert.ok(!/^3$/m.test(srt), 'an empty cue is not written');
  assert.equal(srt.trimEnd().split('\n').length, 7);
  // a cue with no end still gets a duration, or the subtitle never leaves the screen
  assert.match(subtitleFile([{ t0: 5, text: 'open ended' }]), /00:00:05,000 --> 00:00:07,000/);
  const vtt = subtitleFile(cues, { format: 'vtt' });
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:01\.500 --> 00:00:03\.000\nfirst line/m);
});

test('the plain export is one [mm:ss] line per screen', () => {
  const items = screensAsItems([
    { t: 0, tEnd: 4, text: 'intro' },
    { t: 4.4, tEnd: 6, text: 'body' },
    { t: 8, tEnd: 8, text: '' },
  ]);
  assert.deepEqual(items.map((i) => i.text), ['intro', 'body', '']);
  assert.deepEqual(transcriptLines(items), ['[00:00] intro', '[00:04] body']);
});

test('writeReadExport creates the folder it was pointed at', () => {
  const dir = tempDir();
  try {
    const where = join(dir, 'deep', 'talk.srt');
    const wrote = writeReadExport(where, [{ t0: 0, t1: 2, text: 'hello' }], { format: 'srt' });
    assert.ok(wrote.path.endsWith(join('deep', 'talk.srt')), `wrote ${wrote.path}`);
    assert.ok(existsSync(where), 'the parent directory is created, not assumed');
    assert.equal(wrote.lines, 1);
    assert.ok(wrote.bytes > 20);
    assert.match(readFileSync(where, 'utf8'), /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video_read writes the read screens where out says', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const backend = ocrBackend();
  if (!backend.ok) return t.skip(`no OCR engine: ${backend.reason}`);
  // the repro clip lives outside the package: <checkout>/work/subs_only.mp4
  const clip = fileURLToPath(new URL('../../../work/subs_only.mp4', import.meta.url));
  if (!existsSync(clip)) return t.skip('repro clip not on this machine');
  const dir = tempDir();
  try {
    const sub = join(dir, 'out', 'clip.srt');
    const out = await runRead({ input: clip, ffmpegPath, maxScreens: 5, out: sub });
    assert.ok(out.screens.length > 0, 'the read still found screens');
    assert.equal(out.wrote.path, sub);
    assert.equal(out.wrote.format, 'srt');
    assert.equal(out.wrote.lines, out.screens.length);
    const body = readFileSync(sub, 'utf8');
    assert.match(body, /^1\n\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d\n/m);
    assert.match(out.text, /note: wrote \d+ cue\(s\) as SRT to /);
    // the document is still returned: exporting must not cost the reader its text
    assert.match(out.text, /\[\d\d:\d\d(–\d\d:\d\d)?\] /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an audio read exports its cues too', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const dir = tempDir();
  try {
    const wav = join(dir, 'talk.wav');
    const made = await run(ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-y', wav,
    ]);
    assert.equal(made.code, 0, made.stderr?.toString?.() ?? 'ffmpeg failed');
    const srt = join(dir, 'in.srt');
    writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n第一句\n\n2\n00:00:02,000 --> 00:00:03,000\n第二句\n', 'utf8');
    const outSrt = join(dir, 'talk.vtt');
    const out = await runRead({ input: wav, ffmpegPath, transcriptFile: srt, out: outSrt });
    assert.equal(out.audio, true);
    assert.equal(out.wrote.format, 'vtt');
    assert.equal(out.wrote.lines, 2);
    const body = readFileSync(outSrt, 'utf8');
    assert.match(body, /^WEBVTT/);
    assert.match(body, /第一句/);
    assert.match(out.text, /note: wrote 2 cue\(s\) as VTT to /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an export with nothing to write says so instead of an empty file', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const backend = ocrBackend();
  if (!backend.ok) return t.skip(`no OCR engine: ${backend.reason}`);
  const dir = tempDir();
  try {
    const clip = join(dir, 'bars.mp4');
    const made = await run(ffmpegPath, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-f', 'lavfi', '-i', 'smptebars=duration=4:size=480x270:rate=15', '-y', clip,
    ]);
    assert.equal(made.code, 0, made.stderr?.toString?.() ?? 'ffmpeg failed');
    const target = join(dir, 'nothing.srt');
    const out = await runRead({ input: clip, ffmpegPath, out: target });
    assert.equal(out.wrote, null);
    assert.ok(!existsSync(target), 'no empty subtitle file is left behind');
    assert.match(out.text, /note: nothing to write — no text was read from this window \(not written: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
