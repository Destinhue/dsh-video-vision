/**
 * outline.js — the text-only pass: the whole file as a handful of rows, and no
 * picture anywhere in the answer.
 *
 * Why a separate pass: the expensive part of every other tool is the frame that
 * is drawn for the model to look at. A two-hour lesson has about forty stretches
 * worth a look and one sheet cannot hold them, so the question "where should I
 * look at all" has to be answerable for free. This module answers it from what
 * the scan already computed — where the picture changes, whether the camera
 * moves, and how much of the window is speech — and prints it as rows the model
 * can read in one glance.
 *
 * Nothing here decodes: runOutline (pipeline.js) feeds it the per-frame arrays
 * from scanShots and the spans from analyzeAudio. Everything in this file is
 * pure, so the shape of the answer is testable without a video.
 */

export const OUTLINE_DEFAULTS = {
  windows: 24,
  minWindows: 4,
  maxWindows: 60,
  top: 3,
  maxTop: 8,
  // Eight characters per row: enough to see that a window has two busy stretches
  // and a pause between them, short enough to keep the table scannable.
  sparkWidth: 8,
  // The same band scan.js uses for "a mark moved, the picture did not". Kept in
  // step by hand: this module is pure and imports nothing, so the shape of the
  // answer can be tested without a video or a scan.
  microMin: 0.005,
  microMax: 0.15,
};

/** Blocks, weakest to strongest. A row with no movement is all ▁. */
const RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Tags are printed in this order, at most two per row.
 *
 * `text` sits beside `static` because they are the two halves of the same
 * question: a window whose picture does not change either does nothing at all,
 * or moves nothing but its marks. Saying "static" about a lecture slide that
 * re-draws a line of its own text is the one answer that sends the next call to
 * the wrong tool.
 */
const TAG_ORDER = ['dark', 'static', 'text', 'quiet', 'busy', 'talk'];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A time as it is read aloud: 04:50, or 1:56:09 past the first hour.
 *
 * Whole seconds on purpose — a row of the outline is about "somewhere here", and
 * centiseconds in twenty-four rows are noise.
 */
export function outlineClock(t) {
  const v = Math.max(0, Math.round(Number(t) || 0));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const s = v % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

/**
 * Cut the file into equal windows.
 *
 * Windows are equal on purpose: the answer is a map of the file, and a map whose
 * cells change size cannot be compared row to row. A six-second clip cannot
 * carry twenty-four slices either, so the count never exceeds one per second.
 *
 * @returns {{duration:number, span:number, count:number, asked:number, capped:boolean,
 *   windows:Array<{index:number, t0:number, t1:number}>}}
 */
export function planOutline({ duration = 0, windows = OUTLINE_DEFAULTS.windows } = {}) {
  const total = Math.max(0, Number(duration) || 0);
  const asked = Math.round(Number(windows) || OUTLINE_DEFAULTS.windows);
  const want = Math.min(OUTLINE_DEFAULTS.maxWindows, Math.max(OUTLINE_DEFAULTS.minWindows, asked));
  const count = total > 0 ? Math.min(want, Math.max(1, Math.floor(total))) : 1;
  const span = total > 0 ? total : 0.01;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      index: i + 1,
      t0: +((span * i) / count).toFixed(3),
      t1: +((span * (i + 1)) / count).toFixed(3),
    });
  }
  return { duration: total, span, count, asked, capped: count < asked, windows: rows };
}

/** How much of [t0,t1) the given spans cover, in seconds. */
export function spanOverlap(spans, t0, t1) {
  let sum = 0;
  for (const s of spans || []) {
    const a = Math.max(t0, s.t);
    const b = Math.min(t1, s.t + s.dur);
    if (b > a) sum += b - a;
  }
  return sum;
}

/**
 * What happens inside each window.
 *
 * The inputs are exactly what the scan and the audio pass produce, so a row can
 * be explained from the row itself: cuts are the scan's cut list, movement is
 * the fraction of frames the scan flagged as camera motion, speech and activity
 * are the VAD spans, silence is where the room goes quiet, and brightness is the
 * mean luma (a black stretch is worth its own tag).
 *
 * @param {{plan:object, effFps?:number, cuts?:Array, motion?:Uint8Array|null,
 *   vectors?:object|null, speech?:Array, activity?:Array, silence?:Array,
 *   micro?:{frac:Float32Array}|null, textMotion?:object|null}} opts
 */
export function outlineRows({
  plan,
  effFps = 25,
  cuts = [],
  motion = null,
  vectors = null,
  speech = [],
  activity = [],
  silence = [],
  micro = null,
  textMotion = null,
} = {}) {
  const rate = Number(effFps) > 0 ? Number(effFps) : 25;
  const frames = motion ? motion.length : (vectors?.bright?.length ?? 0);
  const brightArr = vectors?.bright ?? null;

  const range = (a, b) => {
    if (!frames) return [0, 0];
    const i0 = Math.max(0, Math.floor(a * rate));
    const i1 = Math.min(frames, Math.ceil(b * rate));
    return [i0, Math.max(i0, i1)];
  };
  const meanOf = (arr, a, b) => {
    if (!arr || !arr.length) return 0;
    const [i0, i1] = range(a, b);
    let sum = 0;
    for (let i = i0; i < i1; i += 1) sum += arr[i];
    return i1 > i0 ? sum / (i1 - i0) : 0;
  };

  // Per-window share of "a sliver of the picture moved" pairs, and how many of
  // them there were. Read straight off the scan's own per-pair measurement.
  const microOf = (a, b) => {
    const arr = micro?.frac;
    if (!arr || !arr.length) return { mean: 0, events: 0 };
    const [i0, i1] = range(a, b);
    let sum = 0, n = 0, events = 0;
    for (let i = i0; i < i1 && i < arr.length; i += 1) {
      sum += arr[i];
      n += 1;
      if (arr[i] >= OUTLINE_DEFAULTS.microMin && arr[i] < OUTLINE_DEFAULTS.microMax) events += 1;
    }
    return { mean: n ? sum / n : 0, events };
  };

  const rows = [];
  for (const w of plan.windows) {
    const span = Math.max(0.001, w.t1 - w.t0);
    let cutCount = 0;
    for (const c of cuts) if (c.t >= w.t0 && c.t < w.t1) cutCount += 1;
    const motionShare = meanOf(motion, w.t0, w.t1);
    const bright = meanOf(brightArr, w.t0, w.t1);
    const speechShare = Math.min(1, spanOverlap(speech, w.t0, w.t1) / span);
    const activityShare = Math.min(1, spanOverlap(activity, w.t0, w.t1) / span);
    const silentShare = Math.min(1, spanOverlap(silence, w.t0, w.t1) / span);
    const cutsPerMin = cutCount / (span / 60);

    const sw = OUTLINE_DEFAULTS.sparkWidth;
    let bar = '';
    for (let k = 0; k < sw; k += 1) {
      const a = w.t0 + (span * k) / sw;
      const b = w.t0 + (span * (k + 1)) / sw;
      let cutHere = false;
      for (const c of cuts) {
        if (c.t >= a && c.t < b) { cutHere = true; break; }
      }
      const slice = Math.max(0.001, b - a);
      const level = Math.max(
        cutHere ? 1 : 0,
        meanOf(motion, a, b),
        (spanOverlap(speech, a, b) / slice) * 0.95,
        (spanOverlap(activity, a, b) / slice) * 0.85,
      );
      const step = Math.min(RAMP.length - 1, Math.max(0, Math.round(Math.min(1, level) * (RAMP.length - 1))));
      bar += RAMP[step];
    }

    const microStats = microOf(w.t0, w.t1);

    const tags = [];
    if (span >= 1 && bright > 0 && bright < 28) tags.push('dark');
    // A window whose picture stays put has two possible truths, and they lead to
    // two different tools: nothing happens at all (static), or the marks on the
    // picture keep being redrawn (text). Checking the marks first means a slide
    // that re-writes a line of itself is never called still.
    //
    // The window's own sample is a thin one — a 1 s window holds one or two
    // adjacent pairs, and a sentence that swaps between them leaves the next
    // window looking untouched. So a file-wide verdict that the marks are the
    // content outranks the local count; without it the repro clip alternated
    // 'text' and 'static' down a file that is nothing but text.
    const marksMove = Boolean(textMotion) || microStats.events > 0;
    if (cutCount === 0 && motionShare < 0.03 && marksMove) tags.push('text');
    else if (cutCount === 0 && motionShare < 0.03 && speechShare < 0.05) tags.push('static');
    if (silentShare >= 0.6) tags.push('quiet');
    if (cutsPerMin >= 4 || motionShare >= 0.45) tags.push('busy');
    if (speechShare >= 0.45) tags.push('talk');

    // How much a window would teach a viewer who watched only it. Cuts and
    // movement are what a still picture cannot show; speech is what a transcript
    // would carry; music and effects are the weakest signal of the four.
    const score = +(
      0.45 * Math.min(1, cutsPerMin / 6)
      + 0.25 * motionShare
      + 0.20 * speechShare
      + 0.10 * activityShare
    ).toFixed(3);

    rows.push({
      index: w.index,
      t0: +w.t0.toFixed(3),
      t1: +w.t1.toFixed(3),
      span: +span.toFixed(3),
      cuts: cutCount,
      cutsPerMin: +cutsPerMin.toFixed(2),
      motionShare: +motionShare.toFixed(3),
      speechShare: +speechShare.toFixed(3),
      activityShare: +activityShare.toFixed(3),
      silentShare: +silentShare.toFixed(3),
      bright: Math.round(bright),
      microShare: +microStats.mean.toFixed(3),
      microEvents: microStats.events,
      bar,
      score,
      tags: tags.sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b)),
    });
  }
  return rows;
}

/** The windows worth looking at first, strongest first. */
export function outlineHighlights(rows, top = OUTLINE_DEFAULTS.top) {
  const limit = Math.max(0, Math.min(OUTLINE_DEFAULTS.maxTop, Math.round(Number(top) || 0)));
  if (!limit) return [];
  return (rows || [])
    .filter((r) => r.span >= 1 && r.score > 0)
    .slice()
    .sort((a, b) => b.score - a.score || b.cuts - a.cuts || a.index - b.index)
    .slice(0, limit);
}

/**
 * The answer itself.
 *
 * One line per window, then the three worth opening first and the exact call
 * that opens one. Everything here is a summary of numbers already in the rows:
 * no sentence claims something the row cannot back up.
 */
export function outlineReport({
  title = 'video',
  duration = 0,
  plan,
  rows = [],
  top = OUTLINE_DEFAULTS.top,
  totalCuts = rows.reduce((s, r) => s + r.cuts, 0),
  speechShare = 0,
  hasAudio = false,
  keyframeGap = null,
  notes = [],
  // Windows whose picture stays put while their marks move. Counted here rather
  // than passed in when the rows already say it.
  textWindows = rows.filter((r) => (r.tags ?? []).includes('text')).length,
} = {}) {
  const lines = [];
  const bits = [
    title,
    outlineClock(duration),
    `${totalCuts} ${plural(totalCuts, 'cut')}`,
  ];
  if (hasAudio) bits.push(`speech ${Math.round(speechShare * 100)}%`);
  const windowSpan = plan.count > 0 ? plan.span / plan.count : plan.span;
  bits.push(`${plan.count} ${plural(plan.count, 'window')} of ${outlineClock(windowSpan)}`);
  lines.push(bits.join(' · '));

  lines.push('note: text only — nothing was drawn, so this answer costs no image tokens; ask video_storyboard for a window once this says which one');
  if (!hasAudio) lines.push('note: no audio track — this outline reads the picture only');
  if (keyframeGap) {
    lines.push(`note: analysis read keyframes only (one every ${keyframeGap.toFixed(1)} s) — a change shorter than that gap is not seen; set DSH_SCAN_KEYFRAMES=off to decode every frame`);
  }
  for (const note of notes) lines.push(`note: ${note}`);
  if (textWindows > 0) {
    // The row tags say which windows, this says what to do about them: the one
    // mistake this map can cause is reading "no cuts" as "nothing here".
    const one = textWindows === 1;
    lines.push(`note: ${textWindows} of ${rows.length} ${plural(rows.length, 'window')} `
      + `${one ? 'keeps its picture and redraws its marks' : 'keep their picture and redraw their marks'} — `
      + 'that is text, not a still frame: video_read reads those marks as text, and it costs no image tokens');
  }

  for (const r of rows) {
    const parts = [`${String(r.index).padStart(4)}  ${outlineClock(r.t0)}-${outlineClock(r.t1)}  ${r.bar}  cuts ${r.cuts}`];
    if (hasAudio) parts.push(`speech ${String(Math.round(r.speechShare * 100)).padStart(3)}%`);
    const tags = r.tags.slice(0, 2).join(' ');
    if (tags) parts.push(tags);
    lines.push(parts.join('  '));
  }

  const best = rows.reduce((m, r) => Math.max(m, r.score), 0);
  const uniform = !rows.length || best < 0.05;
  const picks = uniform ? [] : outlineHighlights(rows, top);
  if (uniform && textWindows > 0) {
    lines.push('note: nothing stands out to look at — the picture hardly changes while the marks on it do, so ask video_read for the words instead of video_storyboard for the pictures');
  } else if (uniform) {
    lines.push('note: nothing stands out — the picture and the sound barely change over the whole file, so any window looks like any other');
  } else if (picks.length) {
    const where = picks.map((p) => {
      const inner = [`${outlineClock(p.t0)}-${outlineClock(p.t1)}`, `${p.cuts} ${plural(p.cuts, 'cut')}`];
      if (hasAudio) inner.push(`speech ${Math.round(p.speechShare * 100)}%`);
      return `${p.index} (${inner.join(', ')})`;
    });
    lines.push(`watch first: ${where.join(' · ')}`);
  }

  const pick = picks[0] ?? rows[0];
  if (pick) {
    const a = Math.round(pick.t0);
    const b = Math.round(pick.t1);
    // With no cuts and no movement anywhere, the pictures hold nothing the mark
    // layer does not: send the next call where the content actually is.
    if (textWindows > 0 && !picks.length) {
      // No window is better than another: the whole file is text, and the read's own
      // timecodes are the only structure it has to offer.
      lines.push('next: video_read — the whole file is like this; it reads the marks, spends no image tokens, and the timecodes it prints are the structure');
    } else {
      lines.push(hasAudio
        ? `next: video_storyboard start=${a} end=${b} for the pictures, video_read start=${a} end=${b} for the words`
        : `next: video_storyboard start=${a} end=${b} — the pictures of the window above`);
    }
  }
  return lines.join('\n');
}
