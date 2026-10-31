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
};

/** Blocks, weakest to strongest. A row with no movement is all ▁. */
const RAMP = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Tags are printed in this order, at most two per row. */
const TAG_ORDER = ['dark', 'static', 'quiet', 'busy', 'talk'];

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
 *   vectors?:object|null, speech?:Array, activity?:Array, silence?:Array}} opts
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

    const tags = [];
    if (span >= 1 && bright > 0 && bright < 28) tags.push('dark');
    if (cutCount === 0 && motionShare < 0.03 && speechShare < 0.05) tags.push('static');
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
  if (uniform) {
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
    lines.push(hasAudio
      ? `next: video_storyboard start=${a} end=${b} for the pictures, video_read start=${a} end=${b} for the words`
      : `next: video_storyboard start=${a} end=${b} — the pictures of the window above`);
  }
  return lines.join('\n');
}
