import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeFromProbe, findFfmpeg, findFfprobe, run } from '../src/media.js';
import { audioDocument, runRead } from '../src/read.js';
import { runProbe, runStoryboard } from '../src/pipeline.js';

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));

/** A real 3-second audio-only file, so the probe sees what a user sees. */
async function synthAudio(ffmpegPath) {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'audio-'));
  const file = join(dir, 'talk.wav');
  const res = await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-y', file,
  ]);
  assert.equal(res.code, 0, res.stderr?.toString?.() ?? 'ffmpeg failed');
  return { dir, file };
}

const SRT = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  '第一句：这是音频里的话。',
  '',
  '2',
  '00:00:02,000 --> 00:00:03,000',
  '第二句：没有画面。',
  '',
].join('\n');

test('a file with no video stream is a fact, not an error, when asked for one', () => {
  const parsed = {
    format: { duration: '4.20', format_name: 'mp3', bit_rate: '192000' },
    streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
  };
  const info = finalizeFromProbe(parsed, 'song.mp3', { allowAudioOnly: true });
  assert.equal(info.hasVideo, false);
  assert.equal(info.hasAudio, true);
  assert.equal(info.audioCodec, 'mp3');
  assert.equal(info.container, 'mp3');
  assert.equal(info.duration, 4.2);
  assert.equal(info.bitrate, 192000);
  assert.deepEqual(info.coded, { width: 0, height: 0 });
  // and without the flag the same call is still the old hard error
  assert.throws(() => finalizeFromProbe(parsed, 'song.mp3'), /this file is audio only/);
});

test('a normal probe still reports hasVideo and the picture it found', async (t) => {
  const ffmpegPath = await findFfmpeg();
  const ffprobePath = await findFfprobe();
  const corpus = fileURLToPath(new URL('../bench/corpus/A_hardcuts_720p.mp4', import.meta.url));
  if (!ffmpegPath || !ffprobePath || !existsSync(corpus)) return t.skip('no ffmpeg/ffprobe or corpus clip');
  const { probeVideo } = await import('../src/media.js');
  const info = await probeVideo(corpus, { ffmpegPath, ffprobePath });
  assert.equal(info.hasVideo, true);
  assert.ok(info.coded.width > 0);
});

test('an audio document states what it is and quotes every line', () => {
  const doc = audioDocument({
    title: 'talk.mp3', duration: 62, quotedBy: 'the subtitle track in the container',
    cues: [
      { t0: 0, t1: 3, text: '这一句是开头。' },
      { t0: 3, t1: 8, text: '这一句在后  面。' },
    ],
  });
  const lines = doc.text.split('\n');
  assert.equal(lines[0], '# talk.mp3 — read as text · audio only · 2 lines · 01:02');
  assert.ok(lines.includes('note: audio only — there is no picture, so this document quotes the speech, not the screen'));
  assert.ok(lines.includes('note: quoted by the subtitle track in the container'));
  assert.ok(lines.includes('[00:00–00:03] 这一句是开头。'));
  assert.ok(lines.includes('[00:03–00:08] 这一句在后 面。'), 'inner whitespace is collapsed');
  assert.equal(doc.lines, 2);
  assert.equal(doc.cues, 2);
  assert.equal(doc.capped, 0);
});

test('an audio document cuts on a cue boundary and says how much it dropped', () => {
  const cues = Array.from({ length: 6 }, (_, i) => ({ t0: i * 5, t1: i * 5 + 4, text: '这一句有点长，用来把字符预算撑开。' }));
  const doc = audioDocument({ title: 'long.m4a', duration: 30, cues, maxChars: 60 });
  assert.ok(doc.capped > 0);
  assert.ok(doc.lines < cues.length);
  assert.match(doc.text, new RegExp('capped at ' + doc.lines + ' of ' + cues.length + ' lines'));
  // the document never ends mid-cue: every quoted line is a whole cue
  const quoted = doc.text.split('\n').filter((l) => l.startsWith('['));
  assert.equal(quoted.length, doc.lines);
  assert.ok(quoted.every((l) => l.endsWith('。')));
});

test('a window keeps only the cues that overlap it', () => {
  const cues = [
    { t0: 0, t1: 2, text: 'before' },
    { t0: 2, t1: 4, text: 'inside' },
    { t0: 4, t1: 6, text: 'after' },
  ];
  const doc = audioDocument({ title: 'a.wav', duration: 6, cues, start: 2, end: 4 });
  assert.equal(doc.lines, 1);
  assert.match(doc.text, /\[00:02–00:04\] inside/);
  assert.match(doc.text, /note: window 00:02–00:04 of 00:06/);
});

test('an audio document with no speech says so instead of reading as empty', () => {
  const doc = audioDocument({ title: 'silence.wav', duration: 10, cues: [] });
  assert.equal(doc.lines, 0);
  assert.match(doc.text, /no speech was found in this window/);
});

test('video_probe explains an audio file and names the tool that can read it', async (t) => {
  const ffmpegPath = await findFfmpeg();
  const ffprobePath = await findFfprobe();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const { dir, file } = await synthAudio(ffmpegPath);
  try {
    const out = await runProbe({ input: file, ffmpegPath, ffprobePath });
    assert.equal(out.plan, null, 'there is no sheet to plan');
    assert.equal(out.probe.hasVideo, false);
    assert.match(out.text, /audio only/);
    assert.match(out.text, /no video stream/);
    assert.match(out.text, /video_read quotes this file/);
    assert.match(out.text, /elapsed \d+ms/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video_storyboard refuses an audio file and points at video_read', async (t) => {
  const ffmpegPath = await findFfmpeg();
  const ffprobePath = await findFfprobe();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const { dir, file } = await synthAudio(ffmpegPath);
  try {
    await assert.rejects(
      () => runStoryboard({ input: file, ffmpegPath, ffprobePath }),
      /video_read transcribes audio/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video_read reads an audio file through a transcript file', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const { dir, file } = await synthAudio(ffmpegPath);
  const srt = join(dir, 'talk.srt');
  writeFileSync(srt, SRT, 'utf8');
  try {
    const out = await runRead({ input: file, ffmpegPath, transcriptFile: srt });
    assert.equal(out.audio, true);
    assert.deepEqual(out.screens, []);
    assert.deepEqual(out.outline, []);
    assert.equal(out.stats.audio, true);
    assert.equal(out.stats.quotedBy, 'the transcript file you passed (srt)');
    assert.match(out.text, /^# talk\.wav — read as text · audio only · 2 lines · 00:03\b/m);
    assert.match(out.text, /\[00:00–00:02\] 第一句：这是音频里的话。/);
    // a one-second cue is quoted by its start only, like the video document does
    assert.match(out.text, /\[00:02\] 第二句：没有画面。/);
    assert.ok(Number.isFinite(out.timings.total));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video_read without a transcript or an engine explains how to get one', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg binary on this machine');
  const { dir, file } = await synthAudio(ffmpegPath);
  // an empty DSH_HOME hides the machine's ~/.dsh/asr.json, and an empty env
  // hides DSH_ASR_CMD: the test pins the branch, not this machine's setup
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  try {
    await assert.rejects(
      () => runRead({ input: file, ffmpegPath, env: { DSH_HOME: home } }),
      (error) => {
        assert.match(error.message, /no picture and no text/);
        assert.match(error.message, /audio only \(00:03/);
        assert.match(error.message, /DSH_ASR_CMD/);
        assert.match(error.message, /transcriptFile/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
