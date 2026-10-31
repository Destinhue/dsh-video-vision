import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asrAvailable, fillArgs, runAsrCommand, splitCommand } from '../src/asr.js';

test('splitCommand keeps quoted paths together', () => {
  const argv = splitCommand('"C:\\Program Files\\whisper\\whisper.exe" -m "C:\\models\\small.bin" -f {wav}');
  assert.deepEqual(argv, ['C:\\Program Files\\whisper\\whisper.exe', '-m', 'C:\\models\\small.bin', '-f', '{wav}']);
});

test('splitCommand keeps single-quoted and empty-quoted tokens', () => {
  assert.deepEqual(splitCommand("asr --lang 'zh CN' ''"), ['asr', '--lang', 'zh CN', '']);
});

test('splitCommand of an empty template is empty', () => {
  assert.deepEqual(splitCommand(''), []);
  assert.deepEqual(splitCommand(null), []);
});

test('fillArgs replaces both placeholders in every token', () => {
  const argv = fillArgs(['run', '--in={wav}', '--out', '{out}'], { wav: 'a.wav', out: 'b.srt' });
  assert.deepEqual(argv, ['run', '--in=a.wav', '--out', 'b.srt']);
});

test('asrAvailable is false without DSH_ASR_CMD and true with one', () => {
  assert.equal(asrAvailable({}), false);
  assert.equal(asrAvailable({ DSH_ASR_CMD: '   ' }), false);
  assert.equal(asrAvailable({ DSH_ASR_CMD: 'whisper {wav}' }), true);
});

// The engine itself is somebody else's program, so the contract worth testing is
// "whatever it writes comes back as absolute-time cues". A stand-in script plays
// the engine: it asserts it was given a wav that exists and writes an SRT.
test('runAsrCommand parses what the engine wrote and shifts it onto the file clock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-test-'));
  try {
    const wav = join(dir, 'in.wav');
    const out = join(dir, 'out.srt');
    writeFileSync(wav, 'RIFF');
    const engine = join(dir, 'engine.mjs');
    writeFileSync(engine, `import { existsSync, writeFileSync } from 'node:fs';
const [, , w, o] = process.argv;
if (!existsSync(w)) { console.error('no wav'); process.exit(4); }
writeFileSync(o, ['1', '00:00:01,000 --> 00:00:02,500', 'first line', '', '2',
  '00:00:03,000 --> 00:00:04,000', 'second line', '', ''].join('\\r\\n'));
`);
    const cmd = `"${process.execPath}" "${engine}" {wav} {out}`;
    const res = await runAsrCommand({ cmd, wav, out, offset: 100, env: {} });
    assert.deepEqual(res.cues, [
      { t0: 101, t1: 102.5, text: 'first line' },
      { t0: 103, t1: 104, text: 'second line' },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAsrCommand falls back to stdout when the engine writes no file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-test-'));
  try {
    const wav = join(dir, 'in.wav');
    writeFileSync(wav, 'RIFF');
    const out = join(dir, 'never-written.srt');
    const engine = join(dir, 'engine-stdout.mjs');
    writeFileSync(engine, "process.stdout.write(['1','00:00:00,500 --> 00:00:01,000','printed','',''].join('\\r\\n'));\n");
    const cmd = `"${process.execPath}" "${engine}"`;
    const res = await runAsrCommand({ cmd, wav, out, offset: 0, env: {} });
    assert.deepEqual(res.cues, [{ t0: 0.5, t1: 1, text: 'printed' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- C11: long audio is transcribed in pieces

import { asrChunkSettings, asrCues, parseSilencePoints, planAudioChunks } from '../src/asr.js';
import { run } from '../src/media.js';

test('asrChunkSettings reads the environment and keeps the numbers sane', () => {
  const plain = asrChunkSettings({});
  assert.equal(plain.seconds, 45);
  assert.equal(plain.minSeconds, 12);
  assert.equal(plain.parallel, 2);
  assert.equal(plain.silenceDb, -32);
  assert.equal(plain.silenceMin, 0.35);

  const tuned = asrChunkSettings({
    DSH_ASR_CHUNK_SECONDS: '30', DSH_ASR_CHUNK_MIN: '8', DSH_ASR_PARALLEL: '99', DSH_ASR_SILENCE_DB: '-40',
  });
  assert.equal(tuned.seconds, 30);
  assert.equal(tuned.minSeconds, 8);
  assert.equal(tuned.parallel, 8);
  assert.equal(tuned.silenceDb, -40);

  // 0 is the documented way to switch chunking off, not a bug
  assert.equal(asrChunkSettings({ DSH_ASR_CHUNK_SECONDS: '0' }).seconds, 0);
  // a minimum longer than the chunk would slice forever
  const silly = asrChunkSettings({ DSH_ASR_CHUNK_SECONDS: '20', DSH_ASR_CHUNK_MIN: '60' });
  assert.equal(silly.minSeconds, 20);
});

test('parseSilencePoints pairs the filter report and keeps an open pause', () => {
  const stderr = [
    '[silencedetect @ 0x1] silence_start: 3.5',
    '[silencedetect @ 0x1] silence_end: 5.25 | silence_duration: 1.75',
    'frame= 120 fps=0.0 q=-0.0 size=N/A time=00:00:04.00 bitrate=N/A',
    '[silencedetect @ 0x1] silence_start: 12',
  ].join('\n');
  assert.deepEqual(parseSilencePoints(stderr), [{ from: 3.5, to: 5.25 }, { from: 12, to: 12 }]);
  assert.deepEqual(parseSilencePoints(stderr, 60), [{ from: 63.5, to: 65.25 }, { from: 72, to: 72 }]);
  assert.deepEqual(parseSilencePoints(''), []);
});

test('planAudioChunks aims at the target length and cuts on the last pause', () => {
  // nothing known about the length: one piece, no guess
  assert.deepEqual(planAudioChunks({ start: 0, maxSeconds: 45 }), [{ from: 0, to: null }]);
  // already short enough
  assert.deepEqual(planAudioChunks({ start: 0, end: 40, maxSeconds: 45 }), [{ from: 0, to: 40 }]);
  // no pauses: a fixed grid
  assert.deepEqual(planAudioChunks({ start: 0, end: 120, maxSeconds: 45, minSeconds: 12 }), [
    { from: 0, to: 45 }, { from: 45, to: 90 }, { from: 90, to: 120 },
  ]);
  // a pause just before the target wins, so the cut lands in silence
  const cut = planAudioChunks({
    start: 0, end: 100, maxSeconds: 45, minSeconds: 12, silences: [{ from: 30, to: 34 }],
  });
  assert.deepEqual(cut, [{ from: 0, to: 32 }, { from: 32, to: 77 }, { from: 77, to: 100 }]);
  // a pause too early to be worth it is ignored
  assert.equal(planAudioChunks({
    start: 0, end: 100, maxSeconds: 45, minSeconds: 12, silences: [{ from: 2, to: 4 }],
  })[0].to, 45);
  // a sliver at the end is folded in rather than handed to the engine
  assert.deepEqual(planAudioChunks({ start: 0, end: 46, maxSeconds: 45, minSeconds: 12 }), [
    { from: 0, to: 46 },
  ]);
});

test('asrCues cuts a long window on silence and offsets every chunk', async (t) => {
  const ffmpegPath = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-chunk-'));
  try {
    const wav = join(dir, 'talk.wav');
    const made = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-ac', '1', '-ar', '16000', '-y', wav]);
    if (made.code !== 0) { t.skip('ffmpeg cannot make a wav here'); return; }
    const engine = join(dir, 'engine.mjs');
    writeFileSync(engine, [
      'import { writeFileSync } from "node:fs";',
      'const out = process.argv[3];',
      'writeFileSync(out, ["1", "00:00:00,000 --> 00:00:00,400", "chunk line", "", ""].join("\\r\\n"));',
    ].join('\n'));
    const cmd = '"' + process.execPath + '" "' + engine + '" {wav} {out}';
    const env = { DSH_ASR_CMD: cmd, DSH_ASR_CHUNK_SECONDS: '2', DSH_ASR_CHUNK_MIN: '0.5', DSH_ASR_PARALLEL: '2' };
    const res = await asrCues({ ffmpegPath, input: wav, start: 0, end: null, duration: 6, env });
    assert.equal(res.chunked, true);
    assert.equal(res.chunks, 3);
    assert.deepEqual(res.cues.map((c) => c.t0), [0, 2, 4]);
    assert.equal(res.cues[0].text, 'chunk line');
    assert.equal(res.failed, 0);

    // the escape hatch: one pass over the whole window, exactly as before
    const single = await asrCues({
      ffmpegPath, input: wav, start: 0, end: 6, env: { ...env, DSH_ASR_CHUNK_SECONDS: '0' },
    });
    assert.equal(single.chunked, false);
    assert.equal(single.chunks, 1);
    assert.deepEqual(single.cues.map((c) => c.t0), [0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asrCues counts the chunks an engine failed on instead of losing the rest', async (t) => {
  const ffmpegPath = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-half-'));
  try {
    const wav = join(dir, 'talk.wav');
    const made = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ac', '1', '-ar', '16000', '-y', wav]);
    if (made.code !== 0) { t.skip('ffmpeg cannot make a wav here'); return; }
    // an engine with a one-shot licence: the first chunk works, the rest exit 9
    const stamp = join(dir, 'used');
    const engine = join(dir, 'engine.mjs');
    writeFileSync(engine, [
      'import { existsSync, writeFileSync } from "node:fs";',
      'const [w, out] = [process.argv[2], process.argv[3]];',
      'void w;',
      'if (existsSync(' + JSON.stringify(stamp) + ')) { console.error("licence spent"); process.exit(9); }',
      'writeFileSync(' + JSON.stringify(stamp) + ', "1");',
      'writeFileSync(out, ["1", "00:00:00,000 --> 00:00:00,300", "ok", "", ""].join("\\r\\n"));',
    ].join('\n'));
    const cmd = '"' + process.execPath + '" "' + engine + '" {wav} {out}';
    const res = await asrCues({
      ffmpegPath, input: wav, start: 0, end: 4,
      env: { DSH_ASR_CMD: cmd, DSH_ASR_CHUNK_SECONDS: '1', DSH_ASR_CHUNK_MIN: '0.5', DSH_ASR_PARALLEL: '1' },
    });
    assert.equal(res.chunked, true);
    assert.equal(res.chunks, 4);
    assert.equal(res.failed, 3);
    assert.equal(res.cues.length, 1);
    assert.match(res.reason, /^3 of 4 audio chunk\(s\) failed — chunk at 00:01/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
