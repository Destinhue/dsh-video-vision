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
