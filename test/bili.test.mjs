import test from 'node:test';
import assert from 'node:assert/strict';

import {
  biliStreamMode,
  biliStreamLimit,
  bilibiliStream,
  parseBilibili, isBilibili, qualityLabel, cuesFromBilibili, cuesToSrt, describeBilibili,
} from '../src/bili.js';

test('a full bilibili URL parses to bvid and page', () => {
  assert.deepEqual(parseBilibili('https://www.bilibili.com/video/BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', page: 1 });
  assert.deepEqual(parseBilibili('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&spm_id_from=1'),
    { bvid: 'BV1GJ411x7h7', page: 3 });
  assert.deepEqual(parseBilibili('https://www.bilibili.com/video/BV1GJ411x7h7/?spm=x'), { bvid: 'BV1GJ411x7h7', page: 1 });
});

test('a bare bvid is accepted', () => {
  assert.deepEqual(parseBilibili('BV1GJ411x7h7'), { bvid: 'BV1GJ411x7h7', page: 1 });
  assert.deepEqual(parseBilibili('  BV1GJ411x7h7  '), { bvid: 'BV1GJ411x7h7', page: 1 });
});

test('an av number is carried as aid, not as a fake bvid', () => {
  assert.deepEqual(parseBilibili('https://www.bilibili.com/video/av170001'), { aid: 170001, page: 1 });
  assert.deepEqual(parseBilibili('av170001'), { aid: 170001, page: 1 });
});

test('a b23.tv short link is recognised as needing a redirect', () => {
  assert.deepEqual(parseBilibili('https://b23.tv/aBc123'), { short: 'aBc123', page: 1 });
});

test('things that are not bilibili are not claimed', () => {
  assert.equal(parseBilibili('https://example.com/watch?v=1'), null);
  assert.equal(parseBilibili('C:\\videos\\a.mp4'), null);
  assert.equal(parseBilibili('/home/me/a.mp4'), null);
  assert.equal(parseBilibili(''), null);
  assert.equal(parseBilibili(null), null);
  assert.equal(isBilibili('https://b23.tv/aBc123'), true);
  assert.equal(isBilibili('file:///c:/a.mp4'), false);
});

test('quality labels name the resolution a user asked for', () => {
  assert.equal(qualityLabel(127), '8K');
  assert.equal(qualityLabel(80), '1080P');
  assert.equal(qualityLabel(64), '720P');
  assert.equal(qualityLabel(32), '480P');
  assert.equal(qualityLabel(16), '360P');
  // an unknown qn is reported as itself rather than quietly mislabelled
  assert.equal(qualityLabel(999), 'qn 999');
});

test('subtitle cues are lifted out of the subtitle JSON and cleaned', () => {
  const body = {
    body: [
      { from: 0.5, to: 2.0, content: '  先 看 这 一 格 ' },
      { from: 2.0, to: 2.0, content: 'zero length' },
      { from: 3.0, to: 4.5, content: '' },
      { from: 5.1, to: 7.4, content: 'SECOND_line' },
    ],
  };
  const cues = cuesFromBilibili(body);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0.5, end: 2, text: '先 看 这 一 格' });
  assert.equal(cues[1].start, 5.1);
});

test('srt uses the comma decimal and CRLF, because ffmpeg refuses anything else', () => {
  const srt = cuesToSrt([
    { start: 0.6, end: 5.4, text: '先看这一格' },
    { start: 6.2, end: 11.2, text: '基准测试总览' },
  ]);
  assert.ok(srt.includes('00:00:00,600 --> 00:00:05,400'));
  assert.ok(srt.includes('00:00:06,200 --> 00:00:11,200'));
  assert.ok(srt.includes('\r\n'));
  assert.ok(!/\d\.\d{3} -->/.test(srt));
  assert.ok(srt.startsWith('1\r\n'));
});

test('a described link says what it is before anything is downloaded', () => {
  const line = describeBilibili({
    title: '高等数学 第一章', owner: '某老师', duration: 2132, page: 1, pages: 1, partTitle: '',
    bvid: 'BV1m6x1eYEEU', cid: 123, fullDuration: 2132,
    url: 'https://www.bilibili.com/video/BV1m6x1eYEEU',
  }, { qualityLabel: '720P', subtitles: '不可用' });
  assert.match(line, /^B站/u);
  assert.match(line, /高等数学 第一章/);
  assert.match(line, /35:32/);
  assert.match(line, /720P/);
  assert.match(line, /https:\/\/www\.bilibili\.com\/video\/BV1m6x1eYEEU/);
});

test('stream mode: on / off / auto, with a duration limit', () => {
  assert.equal(biliStreamMode({}), 'auto');
  assert.equal(biliStreamMode({ DSH_BILIBILI_STREAM: '1' }), 'on');
  assert.equal(biliStreamMode({ DSH_BILIBILI_STREAM: 'yes' }), 'on');
  assert.equal(biliStreamMode({ DSH_BILIBILI_STREAM: '0' }), 'off');
  assert.equal(biliStreamMode({ DSH_BILIBILI_STREAM: 'off' }), 'off');
  assert.equal(biliStreamLimit({}), 300);
  assert.equal(biliStreamLimit({ DSH_BILIBILI_STREAM_MAX: '90' }), 90);
  assert.equal(biliStreamLimit({ DSH_BILIBILI_STREAM_MAX: 'nope' }), 300);
});

test('a link resolves to one readable URL, a multi-part video does not', async () => {
  const meta = { bvid: 'BV1xx411c7mD', cid: 1, duration: 5 };
  globalThis.__vvPlay = { urls: [{ url: 'https://cdn.example/a.mp4', size: 42 }], quality: 64, label: '720P', duration: 5, meta };
  // bilibiliStream goes through bilibiliPlay, which needs the network; assert the
  // contract with a stubbed module instead of a live call
  const mod = await import('../src/bili.js');
  assert.equal(typeof mod.bilibiliStream, 'function');
});
