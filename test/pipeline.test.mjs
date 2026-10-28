import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, findFfmpeg, findFfprobe } from '../src/media.js';
import { runStoryboard } from '../src/pipeline.js';

const VENDOR = 'F:\\ai\\v4video\\vendor\\bin';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url));

async function resolveTool(name, envKey, finder) {
  if (process.env[envKey]) return process.env[envKey];
  const found = await finder();
  if (found) return found;
  const literal = join(VENDOR, name);
  return existsSync(literal) ? literal : null;
}

test('the real pipeline turns one clip into one sheet, manifest and cache hit', async (t) => {
  const ffmpegPath = await resolveTool('ffmpeg.exe', 'DSH_FFMPEG_PATH', findFfmpeg);
  if (!ffmpegPath) {
    return t.skip('no ffmpeg binary on this machine');
  }
  const ffprobePath = await resolveTool('ffprobe.exe', 'DSH_FFPROBE_PATH', findFfprobe);
  if (!ffprobePath) {
    return t.skip('no ffprobe binary on this machine');
  }

  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, 'pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'cuts.mp4');

  const built = await run(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=640x360:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:r=30:d=2',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    input,
  ]);
  assert.equal(built.code, 0, `ffmpeg failed: ${built.stderr.toString()}`);

  const first = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto' });

  assert.equal(first.empty, false);
  assert.equal(first.probe.width, 640);
  assert.equal(first.probe.height, 360);

  const cutTimes = first.scan.cuts.map((cut) => cut.t).sort((a, b) => a - b);
  assert.equal(cutTimes.length, 2, `expected two cuts, got ${JSON.stringify(first.scan.cuts)}`);
  assert.ok(Math.abs(cutTimes[0] - 2) <= 0.25, `first cut at ${cutTimes[0]}`);
  assert.ok(Math.abs(cutTimes[1] - 4) <= 0.25, `second cut at ${cutTimes[1]}`);

  assert.equal(first.plan.cells.length, 3);
  assert.ok(first.sheet.width > 0);
  assert.ok(first.sheet.height > 0);
  assert.deepEqual(first.png.subarray(0, 8), PNG_SIGNATURE);
  assert.ok(first.visionTokens <= 1024, `visionTokens ${first.visionTokens}`);

  assert.match(first.manifest, /sheet 1/);
  assert.equal((first.manifest.match(/^\d+ r\d+c\d+ /gm) ?? []).length, 3, first.manifest);

  const second = await runStoryboard({ input, ffmpegPath, ffprobePath, detail: 'auto' });
  assert.equal(second.fromCache, true);
  assert.equal(second.sheet.width, first.sheet.width);
  assert.equal(second.manifest, first.manifest);
});
