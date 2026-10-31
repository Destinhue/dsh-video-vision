import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRead } from '../src/read.js';
import { findFfmpeg } from '../src/media.js';
import { ocrBackend } from '../src/ocr.js';
import { readSpec } from '../src/tools.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-pictures-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A clip with no words in it: the bars are the picture, nothing is text. */
function makeSilentPicture() {
  const clip = join(dir, 'bars.mp4');
  execFileSync(process.env.DSH_FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'smptebars=duration=4:size=480x270:rate=15',
    '-y', clip,
  ]);
  return clip;
}

test('a video with no readable text comes back as pictures, not an empty document', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg');
  const backend = ocrBackend();
  if (!backend.ok) return t.skip(`no OCR engine: ${backend.reason}`);
  const clip = makeSilentPicture();
  const out = await runRead({ input: clip, ffmpegPath });
  assert.equal(out.screens.length, 0, 'nothing in this file reads as text');
  assert.ok(out.png && out.png.length > 2000, 'a picture sheet came back instead');
  assert.ok(out.pictures.length >= 1 && out.pictures.length <= 6, `got ${out.pictures.length} pictures`);
  assert.equal(out.stats.pictures, out.pictures.length);
  assert.match(out.text, /no readable text/);
  assert.match(out.text, /showing \d+ pictures instead/);
  assert.match(out.text, /transcriptFile/);
  assert.ok(!/note: none of the/.test(out.text), 'the empty-document wording is gone');
});

test('a video that does have text returns no picture sheet', async (t) => {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return t.skip('no ffmpeg');
  const backend = ocrBackend();
  if (!backend.ok) return t.skip(`no OCR engine: ${backend.reason}`);
  // the repro clip lives outside the package: <checkout>/work/subs_only.mp4
  const clip = fileURLToPath(new URL('../../../work/subs_only.mp4', import.meta.url));
  if (!existsSync(clip)) return t.skip('repro clip not on this machine');
  const out = await runRead({ input: clip, ffmpegPath });
  assert.ok(out.screens.length > 0, 'the subtitle lines are still read as text');
  assert.equal(out.png, undefined, 'no sheet is bought for a file that already answered in text');
});

test('the read tool renders an attached picture before its text', () => {
  const spec = readSpec({ read: async () => ({ text: '' }) });
  const blocks = spec.output.render({}, { text: 'words', images: [{ kind: 'image-ref' }] });
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].text, 'words');
});
