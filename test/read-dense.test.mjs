import test from 'node:test';
import assert from 'node:assert/strict';

import { altFpsModeArgs, fpsModeArgs } from '../src/media.js';
import { parseOcrSection } from '../src/ocr.js';
import { mergeScreens, usableScreens } from '../src/read.js';

test('altFpsModeArgs flips the two spellings, and only those', () => {
  assert.deepEqual(altFpsModeArgs(['-fps_mode', 'passthrough']), ['-vsync', '0']);
  assert.deepEqual(altFpsModeArgs(['-vsync', '0']), ['-fps_mode', 'passthrough']);
  // an unrelated first flag is left alone: we do not know how to flip it
  assert.deepEqual(altFpsModeArgs(['-threads', '2']), ['-threads', '2']);
});

test('fpsModeArgs picks a flag the installed binary understands', async () => {
  const ffmpeg = process.env.DSH_FFMPEG_PATH;
  if (!ffmpeg) return;                       // no binary in this environment
  const args = await fpsModeArgs(ffmpeg);
  assert.equal(args.length, 2);
  assert.ok(['-fps_mode', '-vsync'].includes(args[0]));
  // and the answer is cached, so a second call costs nothing
  assert.deepEqual(await fpsModeArgs(ffmpeg), args);
});

test('a fixed layout whose only change is the subtitle keeps every line', () => {
  // The reported regression: the frames differ by ~2 % of the picture, which the
  // whole-frame gate calls "the same", so four subtitle lines collapsed to one.
  // The shared heading keeps the whole-screen similarity high, which is why
  // similarity alone cannot tell these screens apart.
  const head = '固定版式 · 只换字幕 · 每一屏都一样的那段模板文字，足够长，于是整屏相似度被它拉高';
  const said = [
    '第一句：这一格的文字，只有这句话。',
    '第二句：版式没动，只换了下面的字幕。',
    '第三句：整幅画面只变化了百分之二。',
    '第四句：所以整屏去重会把它当成同一屏。',
  ];
  const screens = said.map((line, i) => ({
    t: i * 5, tEnd: i * 5, text: `${head}
${line}`, lines: [head, line],
  }));
  const plain = mergeScreens(screens);
  assert.equal(plain.length, 1, 'the heading carries similarity past the threshold');
  const novel = mergeScreens(screens, { novelLine: true });
  assert.equal(novel.length, 4, 'a new subtitle line is a new screen');
});

test('usableScreens keeps a short clip with real text, drops fragments of noise', () => {
  const four = [
    { text: '第一句：这一格的文字只有这句话。' },
    { text: '第二句：版式没动只换了下面的字幕。' },
    { text: '第三句：整幅画面只变化了百分之二。' },
    { text: '第四句：所以整屏去重会把它当成同一屏。' },
  ];
  // four screens is under the old floor of five, and the old code threw them away
  const kept = usableScreens(four, { minScreens: 3 });
  assert.equal(kept.usable.length, 4);
  assert.ok(kept.chars > 40);

  const noise = [{ text: '亿 天 小' }, { text: '丿 束 攵' }];
  const dropped = usableScreens(noise, { minScreens: 3, minChars: 40 });
  assert.equal(dropped.usable.length, 0);
});

test('OCR sections parse whatever the file was called', () => {
  // The dense pass writes d00001.png and the keyframe pass f000123.png; a parser
  // that only accepted the second kind silently returned nothing for the first.
  const section = '@@ 1228 636\n58 8 619 71\t固定版式 · 只换字幕\n236 542 963 584\t第一句：这一格的文字。\n';
  const rec = parseOcrSection(section);
  assert.equal(rec.width, 1228);
  assert.equal(rec.height, 636);
  assert.equal(rec.lines.length, 2);
  assert.deepEqual(rec.lines[1], { text: '第一句：这一格的文字。', x0: 236, y0: 542, x1: 963, y1: 584 });
});
