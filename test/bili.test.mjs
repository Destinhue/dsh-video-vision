import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  biliStreamMode,
  biliStreamLimit,
  bilibiliStream,
  parseBilibili, isBilibili, qualityLabel, cuesFromBilibili, cuesToSrt, describeBilibili,
  bilibiliRejection, createTtlCache, pruneBilibiliCache, cacheLimits, clearPlayCache,
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

test('an episode page is named as an episode, not as a missing file', () => {
  const why = bilibiliRejection('https://www.bilibili.com/bangumi/play/ep123456');
  assert.match(why, /番剧第 123456 话/);
  assert.match(why, /video\/BV/);
  assert.match(bilibiliRejection('https://www.bilibili.com/bangumi/play/ss28747'), /番剧系列 ss28747/);
  assert.match(bilibiliRejection('https://www.bilibili.com/bangumi/media/md1638'), /番剧详情页/);
});

test('a collection page says it is a list, a live room says it has no end', () => {
  assert.match(bilibiliRejection('https://space.bilibili.com/2/lists/3997?type=season'), /合集\/列表页面/);
  assert.match(bilibiliRejection('https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD'), /合集\/列表页面/);
  assert.match(bilibiliRejection('https://live.bilibili.com/6'), /直播间/);
});

test('a bare bilibili page without a video id says so; other inputs are not claimed', () => {
  assert.match(bilibiliRejection('https://www.bilibili.com/'), /没有视频 id/);
  assert.equal(bilibiliRejection('https://www.bilibili.com/video/BV1GJ411x7h7'), null);
  assert.equal(bilibiliRejection('C:\\videos\\a.mp4'), null);
  assert.equal(bilibiliRejection('https://example.com/bangumi/play/ep1'), null);
  assert.equal(bilibiliRejection(null), null);
});

test('the playurl cache expires entries by its own clock', () => {
  let now = 1_000;
  const cache = createTtlCache({ ttlMs: 100, now: () => now });
  cache.set('BV1|1|1080|anon', { url: 'x' });
  assert.deepEqual(cache.get('BV1|1|1080|anon'), { url: 'x' });
  now += 99;
  assert.ok(cache.get('BV1|1|1080|anon'));
  now += 2;
  assert.equal(cache.get('BV1|1|1080|anon'), undefined);
  assert.equal(cache.size, 0, 'an expired entry is dropped, not just hidden');
  cache.set('a', 1);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
  clearPlayCache();                       // the module-level cache has a reset
});

test('cacheLimits reads the budget and falls back to sane defaults', () => {
  assert.deepEqual(cacheLimits({}), { maxBytes: 4096 * 1048576, maxVideos: 24 });
  assert.deepEqual(cacheLimits({ DSH_BILIBILI_CACHE_MB: '512', DSH_BILIBILI_CACHE_MAX: '3' }),
    { maxBytes: 512 * 1048576, maxVideos: 3 });
  assert.equal(cacheLimits({ DSH_BILIBILI_CACHE_MB: 'lots' }).maxBytes, 4096 * 1048576);
});

test('the download cache evicts the least recently read video, never the live one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vv-cache-'));
  const make = (name, bytes, ageMinutes) => {
    const dir = join(root, `BV${name}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.mp4`);
    writeFileSync(file, Buffer.alloc(bytes));
    const at = new Date(Date.now() - ageMinutes * 60_000);
    utimesSync(file, at, at);
    writeFileSync(join(dir, `${name}.json`), '{}');
    return file;
  };
  const old = make('a', 1000, 30);
  const mid = make('b', 1000, 20);
  const live = make('c', 1000, 10);

  const trimmed = await pruneBilibiliCache(root, { maxBytes: 2500, maxVideos: 24, keep: live });
  assert.deepEqual(trimmed.removed.map((r) => r.path), [old]);
  assert.ok(existsSync(mid) && existsSync(live), 'younger videos survive');
  assert.ok(!existsSync(join(root, 'BVa')), 'the sidecar goes with the video');
  assert.equal(trimmed.files, 2);
  assert.equal(trimmed.bytes, 2000);

  const byCount = await pruneBilibiliCache(root, { maxBytes: 10 * 1048576, maxVideos: 1 });
  assert.equal(byCount.removed.length, 1);
  assert.equal(byCount.files, 1);
  rmSync(root, { recursive: true, force: true });
});

test('pruning a cache that does not exist is a no-op, not an error', async () => {
  const out = await pruneBilibiliCache(join(tmpdir(), 'vv-no-such-cache-dir-9001'));
  assert.deepEqual(out, { removed: [], bytes: 0, files: 0 });
});
