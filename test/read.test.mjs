import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanOcr, isChrome, isChatter, screenText, screenLines, contentChars, wordChars, dropBoilerplate, readableScreen,
  textSimilarity, mergeScreens, outline, gridChange, READ_DEFAULTS, capNotes,
  fallbackTimes, FALLBACK_CELLS,
} from '../src/read.js';

test('cleanOcr puts CJK prose back together', () => {
  const raw = '例 题 三 ， 已 知 数 列 是 等 差 数 列 ， 证 明 ： 对 任 意 , a_{n} 成 立 ．';
  const out = cleanOcr(raw);
  assert.match(out, /例题三/);
  assert.match(out, /等差数列/);
  assert.ok(!/[\u3400-\u9fff] [\u3400-\u9fff]/.test(out), 'no space left between two Han characters');
  assert.match(out, /a_\{n\}/, 'latin tokens are left alone');
});

test('cleanOcr keeps latin word spacing intact', () => {
  const out = cleanOcr('the  quick  brown  fox');
  assert.equal(out, 'the quick brown fox');
});

test('cleanOcr removes the toolbar residue that sits in front of real text', () => {
  const out = cleanOcr('00 00 囗 山 夕 例题四求证结论成立');
  assert.ok(!/^\s*\d/.test(out), `no leading digits, got ${JSON.stringify(out)}`);
  assert.match(out, /例题四求证结论成立/);
});

test('isChrome rejects meeting-app overlays and near-empty screens', () => {
  assert.equal(isChrome(''), true);
  assert.equal(isChrome('00 00'), true);
  assert.equal(isChrome('您正在共享屏幕 停止共享 共享设备音频 说点什么'), true);
  assert.equal(isChrome('例题 4 ．称 1 , 2 , … 的一个排列是拟正序排列'), false);
});

test('textSimilarity collapses OCR noise but separates different slides', () => {
  const a = '1.2 归纳计数 归纳计数的核心就是把 n 时候的数量转化为更小的时候的数量';
  const b = '1.2 归纳计数 归纳计数 核心就是把 n 时候 数量转化为更小的时候的数量';
  const c = '例题 7 证明存在四个无理数 其中任意三个数中均存在两个数的和是有理数';
  assert.ok(textSimilarity(a, b) > 0.6, `noisy repeat should be high, got ${textSimilarity(a, b)}`);
  assert.ok(textSimilarity(a, c) < 0.2, `different slides should be low, got ${textSimilarity(a, c)}`);
  assert.equal(textSimilarity('', a), 0);
});

test('mergeScreens joins a re-shown slide and keeps the longest text', () => {
  const screens = [
    { t: 10, tEnd: 10, text: '1.2 归纳计数 核心是把 n 的情况化小' },
    { t: 40, tEnd: 40, text: '1.2 归纳计数 核心是把 n 的情况化小 技巧在怎么划归' },
    { t: 80, tEnd: 80, text: '例题 5 编号为 1 到 n 的盒子依次放球 求方案数' },
  ];
  const out = mergeScreens(screens, { similarity: 0.6 });
  assert.equal(out.length, 2);
  assert.equal(out[0].t, 10);
  // spans are contiguous: the merged screen owns the time until the next one,
  // which is what the printed [mm:ss-mm:ss] ranges mean
  assert.equal(out[0].tEnd, 80);
  assert.match(out[0].text, /技巧在怎么划归/);
});

test('mergeScreens never merges across an intervening different screen', () => {
  const screens = [
    { t: 0, tEnd: 0, text: '第一张幻灯片的正文内容比较长一些用于测试' },
    { t: 10, tEnd: 10, text: '中间完全不同的另一页内容用于打断连续性' },
    { t: 20, tEnd: 20, text: '第一张幻灯片的正文内容比较长一些用于测试' },
  ];
  const out = mergeScreens(screens, { similarity: 0.6 });
  assert.equal(out.length, 3);
});

test('outline lifts 例题 and section numbers, ignoring OCR junk in front', () => {
  const screens = [
    { t: 0, tEnd: 0, text: '目录 1 新定义考情梳理' },
    { t: 17, tEnd: 17, text: '夕例题 3 ． A,B 二人玩如下游戏' },
    { t: 27, tEnd: 27, text: '例题 3 ．续 上一页' },
    { t: 300, tEnd: 300, text: '刂 2.1 必要条件引导的构造' },
  ];
  const heads = outline(screens);
  assert.deepEqual(heads.map((h) => h.head), ['例题3', '2.1']);
  assert.equal(heads[0].t, 17, 'the first sighting of a heading wins');
});

test('gridChange ignores blocks that are black in both frames', () => {
  const a = new Int16Array(84).fill(0);
  const b = new Int16Array(84).fill(0);
  assert.equal(gridChange(a, b), 0);
  const lit = new Int16Array(84).fill(100);
  for (let i = 0; i < 12; i++) lit[i] = 0;
  assert.ok(gridChange(b, lit) > 0.8, 'a lit screen is a big change');
  const nudged = Int16Array.from(lit);
  nudged[40] += 60;
  assert.ok(gridChange(lit, nudged) < 0.05, 'one block moving is not a new screen');
});

test('the documented defaults are the ones in use', () => {
  assert.equal(READ_DEFAULTS.gridWidth, 96);
  assert.equal(READ_DEFAULTS.gridHeight, 54);
  assert.ok(READ_DEFAULTS.screenChange > 0 && READ_DEFAULTS.screenChange < 0.2);
  assert.ok(READ_DEFAULTS.maxScreens >= 3);
});

const NL = String.fromCharCode(10);

test('screenText drops the tab strip at the top and the status bar at the bottom', () => {
  const rec = {
    width: 1000,
    height: 1000,
    lines: [
      { text: '第二次讲义 · 2', x0: 20, y0: 20, x1: 200, y1: 60 },
      { text: '事实上，归纳推理不仅仅是利用数学归纳法，许多时候是以递推的方式解决问题。', x0: 60, y0: 300, x1: 940, y1: 360 },
      { text: '24 fps', x0: 20, y0: 970, x1: 120, y1: 995 },
    ],
  };
  const text = screenText(rec);
  assert.ok(text.includes('归纳推理'), 'the paragraph survives');
  assert.ok(!text.includes('第二次讲义'), 'the tab strip is gone');
  assert.ok(!text.includes('24 fps'), 'the status bar is gone');
});

test('a chat panel is chrome, a slide is not', () => {
  const chat = ['微信', '嗨', '好的', '收到', '嗯', '在吗', '晚点聊'].join(NL);
  assert.equal(isChatter(chat), true);
  const slide = [
    '事实上，归纳推理不仅仅是利用数学归纳法来完成证明，许多时候是以递推或找规律的方式解决问题。',
    '例题 1．用数学归纳法证明：凸 n 边形的内角和为 (n-2)×180 度。',
  ].join(NL);
  assert.equal(isChatter(slide), false);
});

test('a frame the teacher was scribbling on carries too little text to keep', () => {
  const scribble = ['亿天小', '一 0', '立去干', '凸到', '。'].join(NL);
  // not "chrome" any more -- chrome is furniture, and this is content the OCR
  // could not read. The keep/reject decision now lives in the content count.
  assert.equal(isChrome(scribble), false);
  assert.equal(readableScreen(scribble.split(NL)), false);
  assert.equal(readableScreen(['例题 1 求函数的定义域与值域']), true);
  assert.equal(readableScreen(['十 ^ 十一一十', 'h < m']), false);
  // invented characters: long enough, but no punctuation, no formula marks
  assert.equal(readableScreen(['亿天小釒一 0 立去千凸到']), false);
  // a page of bare formulas does not carry words: it is left to the pictures
  assert.equal(readableScreen(['例题 1 求 (n-2)x180 的值']), false);
  // a page that mixes a formula with a sentence is kept
  assert.equal(readableScreen(['例题 3 证存在 2024 点集使 M(P)=44·m(P)']), true);
  // a bare title is not rejected just because it is short, if the page adds up
  assert.equal(readableScreen(['导数的定义', '极 限 的 定 义', '连 续']), false);
  assert.equal(wordChars('BENCHMARK OVERVIEW'), 17);
  assert.equal(readableScreen(['BENCHMARK OVERVIEW']), true);
});

test('lines every screen carries are furniture, lines one screen carries are content', () => {
  const screens = [
    { t: 0, lines: ['11月24日周日', '正在共享屏幕', '第一节 极限的定义'] },
    { t: 60, lines: ['11月24日周日', '正在共享屏幕', '例题 1 求函数的定义域'] },
    { t: 120, lines: ['11月24日周日', '正在共享屏幕', '例题 2 讨论间断点'] },
  ];
  const { screens: kept, dropped } = dropBoilerplate(screens);
  assert.deepEqual(dropped.sort(), ['11月24日周日', '正在共享屏幕'].sort());
  assert.deepEqual(kept.map((s) => s.lines), [['第一节 极限的定义'], ['例题 1 求函数的定义域'], ['例题 2 讨论间断点']]);
});

test('a short read says so instead of pretending the video was empty', () => {
  const one = [{ t: 0, lines: ['例题 1 求函数的定义域与值域'] }];
  assert.equal(dropBoilerplate(one).dropped.length, 0);
  assert.ok(contentChars('例题 1 求函数的定义域与值域') >= 8);
});

test('the read crop keeps the bottom edge, where subtitles live', () => {
  const { crop } = READ_DEFAULTS;
  assert.ok(crop.y + crop.h >= 0.999, `crop stops at ${crop.y + crop.h}, above the subtitle band`);
  assert.ok(crop.y > 0, 'the top strip is still trimmed');
  assert.ok(crop.x <= 0.05 && crop.x + crop.w >= 0.95, 'the full width is kept');
});

test('a wide line near the bottom survives, a short one is a status bar', () => {
  const W = 1228;
  const H = 636;
  // burned-in subtitle: one wide line at 86% of the crop
  const subtitle = screenLines({
    width: W,
    height: H,
    lines: [{ text: '明明是那些中国用户违反了我的使用条例！', x0: 101, y0: 546, x1: 1095, y1: 598 }],
  });
  assert.equal(subtitle.length, 1);
  assert.match(subtitle[0], /使用条例/);
  // status bar: short text hugging the bottom
  const status = screenLines({
    width: W,
    height: H,
    lines: [{ text: '输入搜索内容', x0: 200, y0: 610, x1: 330, y1: 634 }],
  });
  assert.equal(status.length, 0);
  // an even shorter line that is not near an edge is kept
  const caption = screenLines({
    width: W,
    height: H,
    lines: [{ text: '例题 1', x0: 300, y0: 300, x1: 420, y1: 340 }],
  });
  assert.equal(caption.length, 1);
});

test('capNotes stays quiet when every changed frame fit', () => {
  assert.deepEqual(capNotes({ changed: 10, maxScreens: 400 }), []);
  assert.deepEqual(capNotes({}), []);
});

test('capNotes names the cap instead of silently stopping', () => {
  const notes = capNotes({ changed: 900, maxScreens: 400 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /capped at 400 of 900 changed frames/);
  assert.match(notes[0], /raise maxScreens, or read a window/);
});

test('capNotes reports a request that the hard ceiling trimmed', () => {
  const notes = capNotes({ askedScreens: 900, changed: 5, maxScreens: 400 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /maxScreens 900 capped at 400/);
});

test('fallbackTimes spreads the pictures across the window, never on its edges', () => {
  const cells = fallbackTimes({ start: 10, end: 70, count: 6 });
  assert.equal(cells.length, 6);
  assert.equal(cells[0].index, 1);
  assert.ok(cells[0].frameT > 10 && cells[0].frameT < 20);
  assert.ok(cells[5].frameT < 70 && cells[5].frameT > 60);
  // ascending, so the sheet reads left to right like a timeline
  for (let i = 1; i < cells.length; i++) assert.ok(cells[i].frameT > cells[i - 1].frameT);
});

test('fallbackTimes prefers keyframes the scan already decoded', () => {
  const stamps = [0.5, 4, 9.25, 12, 30, 44.5, 51];
  const cells = fallbackTimes({ start: 2, end: 60, stamps, count: 4 });
  assert.equal(cells.length, 4);
  for (const c of cells) {
    const offset = c.frameT - 2;
    assert.ok(stamps.some((s) => Math.abs(s - offset) < 1e-6), `${c.frameT} is a decoded keyframe`);
  }
  assert.ok(cells[cells.length - 1].frameT > cells[0].frameT);
});

test('fallbackTimes survives a window shorter than the cell count', () => {
  const cells = fallbackTimes({ start: 4, end: 4.5, count: 6 });
  assert.equal(cells.length, 6);
  for (const c of cells) assert.ok(c.frameT >= 4 && c.frameT <= 4.5);
});

test('the fallback sheet is six cells unless asked otherwise', () => {
  assert.equal(FALLBACK_CELLS, 6);
});
