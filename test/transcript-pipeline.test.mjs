import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStoryboard } from '../src/pipeline.js';
import { findFfmpeg } from '../src/media.js';

const CORPUS = fileURLToPath(new URL('../bench/corpus/', import.meta.url));
const SLIDES = join(CORPUS, 'D_slideshow_720p.mp4');   // 36 s, six text cards
const SPEECH = join(CORPUS, 'G_speech_360p.mp4');      // 22 s, narration

let ffmpeg = null;
try { ffmpeg = await findFfmpeg(); } catch { ffmpeg = null; }
const skip = !ffmpeg || !existsSync(SLIDES) || !existsSync(SPEECH)
  ? 'needs ffmpeg and bench/corpus'
  : false;

test('a transcript file drives the quotes and is named as such', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-tf-'));
  try {
    const file = join(dir, 'cards.srt');
    const lines = ['1', '00:00:00,500 --> 00:00:06,000', '这是第一张卡片', '',
      '2', '00:00:06,200 --> 00:00:12,000', '这是第二张卡片', '',
      '3', '00:00:12,200 --> 00:00:18,000', '这是第三张卡片', '',
      '4', '00:00:18,200 --> 00:00:24,000', '这是第四张卡片', '',
      '5', '00:00:24,200 --> 00:00:30,000', '这是第五张卡片', '',
      '6', '00:00:30,200 --> 00:00:35,500', '这是第六张卡片', ''];
    writeFileSync(file, lines.join('\r\n'));

    const result = await runStoryboard({ input: SLIDES, detail: 'low', transcriptFile: file, ffmpegPath: ffmpeg });
    assert.ok(result.manifest, 'a manifest was produced');
    assert.match(result.manifest, /transcript: file:srt · 6 lines/);
    assert.match(result.manifest, /这是第一张卡片/);
    // Each card's line lands on the card it was spoken over, not on all of them.
    const quoted = result.manifest.match(/这是第[一二三四五六]张卡片/g) ?? [];
    assert.equal(new Set(quoted).size, quoted.length, `each line quoted once, got ${quoted.join('/')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recogniser that invents lines is filtered and the filter reports itself', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vv-asr-'));
  const previous = { cmd: process.env.DSH_ASR_CMD, home: process.env.DSH_HOME };
  try {
    // A stand-in engine: writes an SRT with one real line, one punctuation-only
    // line, one 20 s nine-character "music" line, and a misheard term.
    const engine = join(dir, 'engine.mjs');
    writeFileSync(engine, [
      "import { writeFileSync } from 'node:fs';",
      'const out = process.argv[3];',
      'writeFileSync(out, [',
      "  '1', '00:00:00,500 --> 00:00:03,000', '这一段是人说的，讲的是地规。', '',",
      "  '2', '00:00:03,200 --> 00:00:05,000', '。', '',",
      "  '3', '00:00:05,200 --> 00:00:19,900', '四十五分钟的海', '',",
      "].join('\\r\\n'));",
    ].join('\n'));
    writeFileSync(join(dir, 'asr.json'), JSON.stringify({ cmd: `"${process.execPath}" "${engine}" {wav} {out}`, terms: { 地规: '递推' } }));
    process.env.DSH_HOME = dir;
    delete process.env.DSH_ASR_CMD;

    const result = await runStoryboard({ input: SPEECH, detail: 'low', ffmpegPath: ffmpeg });
    assert.match(result.manifest, /transcript: asr/);
    assert.match(result.manifest, /2 suspect line\(s\) dropped/);
    assert.match(result.manifest, /1 term\(s\) fixed/);
    assert.match(result.manifest, /讲的是递推/, 'the term dictionary fixed the transcript');
    assert.ok(!/四十五分钟的海/.test(result.manifest), 'the invented music line is gone');
  } finally {
    if (previous.cmd == null) delete process.env.DSH_ASR_CMD; else process.env.DSH_ASR_CMD = previous.cmd;
    if (previous.home == null) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    rmSync(dir, { recursive: true, force: true });
  }
});
