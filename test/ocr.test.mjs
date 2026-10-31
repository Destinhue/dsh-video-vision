import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png.js';
import {
  findOnPath,
  joinWords,
  ocrBackend,
  ocrCommandLine,
  ocrDirectory,
  parseTsv,
  readingOrder,
} from '../src/ocr.js';

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));

function tempDir(label) {
  mkdirSync(TMP, { recursive: true });
  return mkdtempSync(join(TMP, label));
}

/** a 2x2 image is enough: the test is about plumbing, not recognition */
function tinyPng(size = 2) {
  const rgb = new Uint8Array(size * size * 3);
  for (let i = 0; i < size * size; i++) { rgb[i * 3] = 200; rgb[i * 3 + 1] = 200; rgb[i * 3 + 2] = 200; }
  return encodePng(rgb, size, size);
}

/** a stand-in engine: prints two lines whatever the image is */
function fakeEngine(dir, lines) {
  if (process.platform === 'win32') {
    const path = join(dir, 'ocr.bat');
    writeFileSync(path, ['@echo off', ...lines.map((l) => 'echo ' + l)].join('\r\n') + '\r\n');
    return '"' + path + '"';
  }
  const path = join(dir, 'ocr.sh');
  writeFileSync(path, '#!/bin/sh\n' + lines.map((l) => 'echo ' + l).join('\n') + '\n');
  chmodSync(path, 0o755);
  return path;
}

test('findOnPath walks PATH and returns an absolute file', () => {
  const dir = tempDir('path-');
  const name = process.platform === 'win32' ? 'tesseract.exe' : 'tesseract';
  const full = join(dir, name);
  writeFileSync(full, '');
  assert.equal(findOnPath('tesseract', { PATH: dir }), full);
  assert.equal(findOnPath('tesseract', { PATH: join(dir, 'nope') }), null);
  assert.equal(findOnPath('nothing-here', { PATH: dir }), null);
  rmSync(dir, { recursive: true, force: true });
});

test('ocrBackend prefers DSH_OCR_CMD, honours off, and explains a missing engine', () => {
  const custom = ocrBackend({ DSH_OCR_CMD: 'myocr {image}', PATH: '' });
  assert.equal(custom.ok, true);
  assert.equal(custom.kind, 'cmd');
  assert.match(custom.engine, /DSH_OCR_CMD/);

  const off = ocrBackend({ DSH_OCR_BACKEND: 'off' });
  assert.equal(off.ok, false);
  assert.match(off.reason, /switched off/i);

  const forced = ocrBackend({ DSH_OCR_BACKEND: 'tesseract', PATH: join(TMP, 'no-bin') });
  assert.equal(forced.ok, false);
  assert.match(forced.reason, /not on PATH/);

  // with nothing configured the answer is the host's own engine, whatever it is
  const plain = ocrBackend({ PATH: '', Path: '' });
  if (process.platform === 'win32') {
    assert.equal(plain.ok, true);
    assert.equal(plain.engine, 'windows-media-ocr');
  } else {
    assert.equal(plain.ok, false);
    assert.match(plain.reason, /tesseract|no OCR engine/);
  }
});

test('joinWords keeps Han runs together and spaces Latin words', () => {
  assert.equal(joinWords(['Hello', 'world']), 'Hello world');
  assert.equal(joinWords(['中文', '测试']), '中文测试');
  assert.equal(joinWords(['第', '1', '讲']), '第1讲');
  assert.equal(joinWords(['  ', 'a']), 'a');
});

test('readingOrder reads a row left to right and a page top to bottom', () => {
  const lines = [
    { text: 'footer', x0: 10, y0: 700, x1: 100, y1: 720 },
    { text: 'title', x0: 100, y0: 40, x1: 400, y1: 64 },
    { text: 'left', x0: 20, y0: 42, x1: 90, y1: 66 },
  ];
  assert.deepEqual(readingOrder(lines).map((l) => l.text), ['left', 'title', 'footer']);
});

test('parseTsv rebuilds lines, unions their boxes, and reads them in picture order', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '1\t1\t0\t0\t0\t0\t0\t0\t1280\t720\t-1\t',
    '5\t1\t2\t1\t1\t1\t100\t400\t60\t24\t96.5\tSlide',
    '5\t1\t2\t1\t1\t2\t170\t400\t50\t24\t96.5\ttwo',
    '5\t1\t1\t1\t1\t1\t100\t40\t40\t24\t90.0\t中文',
    '5\t1\t1\t1\t1\t2\t150\t40\t40\t24\t90.0\t测试',
  ].join('\n');
  const out = parseTsv(tsv);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 720);
  assert.equal(out.text, '中文测试\nSlide two');
  assert.equal(out.lines.length, 2);
  const [first, second] = out.lines;
  assert.deepEqual({ x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1 }, { x0: 100, y0: 40, x1: 190, y1: 64 });
  assert.equal(second.x0, 100);
  assert.equal(second.x1, 220);
});

test('parseTsv survives a header-only or broken answer', () => {
  assert.deepEqual(parseTsv(''), { text: '', lines: [], width: 0, height: 0 });
  assert.deepEqual(parseTsv('level\tpage_num\n'), { text: '', lines: [], width: 0, height: 0 });
  const short = parseTsv('5\t1\t1\t1\t1\t1\t10\t20\t30\t40\t88\tWord');
  assert.equal(short.text, 'Word');
  assert.equal(short.width, 40);
  assert.equal(short.height, 60);
});

test('ocrCommandLine appends the path, or puts it at {image}, and quotes a space', () => {
  assert.equal(ocrCommandLine('myocr', 'a/b.png'), 'myocr a/b.png');
  assert.equal(ocrCommandLine('myocr --lang=chi', 'a/b.png'), 'myocr --lang=chi a/b.png');
  assert.equal(ocrCommandLine('myocr --stdout {image} --fast', 'a/b.png'), 'myocr --stdout a/b.png --fast');
  assert.equal(ocrCommandLine('myocr', 'C:/My Files/b.png'), 'myocr "C:/My Files/b.png"');
});

test('ocrDirectory drives DSH_OCR_CMD once per image and fills the whole map', async () => {
  const dir = tempDir('cmd-');
  const cmd = fakeEngine(dir, ['first line', 'second line']);
  for (const name of ['d00000.png', 'f0000042.png']) writeFileSync(join(dir, name), tinyPng());
  const env = { ...process.env, DSH_OCR_CMD: cmd };
  const out = await ocrDirectory(dir, { env });
  assert.deepEqual([...out.keys()].sort(), ['d00000', 'f0000042']);
  const screen = out.get('d00000');
  assert.equal(screen.text, 'first line\nsecond line');
  assert.equal(screen.lines.length, 2);
  // no boxes, no size: the furniture rules must keep every line
  assert.equal(screen.width, 0);
  assert.equal(screen.height, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('ocrDirectory reports an engine that fails on every image', async () => {
  const dir = tempDir('bad-');
  const cmd = fakeEngine(dir, []);
  writeFileSync(join(dir, 'only.png'), tinyPng());
  const failing = process.platform === 'win32'
    ? join(dir, 'fail.bat')
    : join(dir, 'fail.sh');
  writeFileSync(failing, process.platform === 'win32' ? '@echo off\r\nexit /b 3\r\n' : '#!/bin/sh\nexit 3\n');
  if (process.platform !== 'win32') chmodSync(failing, 0o755);
  await assert.rejects(
    () => ocrDirectory(dir, { env: { ...process.env, DSH_OCR_CMD: '"' + failing + '"' } }),
    /OCR failed/,
  );
  void cmd;
  rmSync(dir, { recursive: true, force: true });
});

test('ocrDirectory returns an empty map for a directory with no images', async () => {
  const dir = tempDir('empty-');
  const out = await ocrDirectory(dir, { env: { ...process.env, DSH_OCR_CMD: 'whatever' } });
  assert.equal(out.size, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('tesseract is used when it is installed', async (t) => {
  const bin = findOnPath('tesseract');
  if (!bin) { t.skip('tesseract is not installed on this host'); return; }
  const dir = tempDir('tes-');
  // one big black word on white: every engine reads this
  const ffmpeg = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
  const { run } = await import('../src/media.js');
  const png = join(dir, 'd00000.png');
  const made = await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=640x240',
    '-vf', "drawtext=text='HELLO':fontcolor=black:fontsize=120:x=40:y=60", '-frames:v', '1', '-y', png]);
  if (made.code !== 0 || !existsSync(png)) { t.skip('ffmpeg cannot draw text here'); return; }
  const out = await ocrDirectory(dir, { env: { ...process.env, DSH_OCR_BACKEND: 'tesseract' } });
  assert.match(out.get('d00000').text.toUpperCase(), /HELLO/);
  rmSync(dir, { recursive: true, force: true });
});

test('read refuses politely when OCR is switched off', async (t) => {
  const clip = fileURLToPath(new URL('../../../work/subs_only.mp4', import.meta.url));
  if (!existsSync(clip)) { t.skip('work/subs_only.mp4 is not here'); return; }
  const { runRead } = await import('../src/read.js');
  const ffmpegPath = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
  const ffprobePath = process.env.DSH_FFPROBE_PATH || 'ffprobe';
  const before = process.env.DSH_OCR_BACKEND;
  process.env.DSH_OCR_BACKEND = 'off';
  try {
    await assert.rejects(
      () => runRead({ input: clip, ffmpegPath, ffprobePath }),
      /cannot read text: OCR is switched off/,
    );
  } finally {
    if (before === undefined) delete process.env.DSH_OCR_BACKEND;
    else process.env.DSH_OCR_BACKEND = before;
  }
});
