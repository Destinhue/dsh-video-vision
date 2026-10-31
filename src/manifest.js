/**
 * manifest.js — the text that travels with the picture.
 *
 * This file is the token bill. Everything in it is paid on every call, so the
 * rules are: one line per cell, no repeated advice, no column that cannot be
 * used. Guidance about how to read the sheet lives in the tool description,
 * where the prompt cache pays for it once instead of once per call.
 *
 * What stays is what the picture cannot say:
 *   - when each cell happens, to the centisecond;
 *   - whether the cut inside it is a cut or a fade;
 *   - what is being said at that moment, if anything;
 *   - where the audio does something worth looking at.
 */

import { timecode, timecodeShort } from './timeline.js';
import { zoomNote } from './detail.js';

const ROW = (i) => i.toFixed(0);

/** `r1c2` style position label for a slot index. */
export function slotLabel(slot, cols) {
  const r = Math.floor(slot / cols) + 1;
  const c = (slot % cols) + 1;
  return `r${r}c${c}`;
}

function fmtRatio(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * @param {object} p
 * @param {object} p.probe
 * @param {object} p.scan
 * @param {object} p.plan
 * @param {object} p.sheet   { pages: [{grid, cells}], count }
 * @param {object} [p.audio]
 * @param {object} [p.transcript] { cues, segments, source }
 * @param {object} [p.limits] { maxChars, maxCellChars }
 * @param {number[]} [p.only]  restrict to these cell indices
 */
export function formatManifest(p) {
  const { probe, scan, plan, sheet, audio, transcript } = p;
  const limits = { maxChars: 24_000, maxCellChars: 160, ...(p.limits ?? {}) };
  const cells = p.only
    ? plan.cells.filter((c) => p.only.includes(c.index))
    : plan.cells;

  const out = [];
  const dur = probe.duration || plan.duration || 0;
  const cutCount = scan.cuts ? scan.cuts.length : 0;
  const median = scan.summary ? scan.summary.medianShot : 0;

  out.push(`${p.name ?? probe.path} · ${timecode(dur, { hours: true })} · ${probe.width}x${probe.height} · ${Math.round(probe.fps)}fps · ${cutCount} cuts · median shot ${median.toFixed(2)}s`);

  const pages = sheet?.pages ?? [];
  if (pages.length) {
    const g = pages[0].grid;
    // A windowed scan ends at start + its own length, not at the clip length.
    const start = scan.start ?? 0;
    const span = plan.duration > 0 ? plan.duration : Math.max(0, dur - start);
    out.push(`sheet ${pages.length > 1 ? `1/${pages.length}` : '1'} · ${g.cols}x${g.rows} grid · ${g.width}x${g.height} · ${cells.length} cells · window ${timecode(start)}-${timecode(start + span)}`);
    out.push(`cols: cell · pos · span · (cuts) · frame@${p.zoom?.list?.length ? ' · zoom' : ''}`);
    const note = p.zoom ? zoomNote(p.zoom) : null;
    if (note) out.push(note);
  }
  if (scan.degraded) {
    out.push(`note: ${DEGRADED[scan.degraded] ?? scan.degraded}`);
  }
  // What a request asked for and did not get (a window past the end, a cell
  // count over the cap). Silent clamping is indistinguishable from a short file.
  for (const n of p.notes ?? []) out.push(`note: ${n}`);

  let chars = out.join('\n').length;
  let truncated = false;

  for (const c of cells) {
    const pos = pages[0] ? slotLabel(c.index - 1, pages[0].grid.cols) : '';
    const cuts = cutsIn(scan.cuts, c.t0, c.t1);
    const cutNote = cuts.length
      ? ` (${cuts.length}${cuts.some((x) => x.kind === 'fade') ? 'fade' : ''})`
      : '';
    const dup = c.dupOf ? ` =cell ${c.dupOf}` : '';
    // `pos` is empty when there is no sheet; do not leave a doubled separator.
    const needsZoom = p.zoom && !p.zoom.all && p.zoom.list.includes(c.index);
    let line = `${c.index}${pos ? ` ${pos}` : ''} ${timecode(c.t0)}-${timecode(c.t1)}${cutNote} @${timecode(c.frameT)}${dup}${needsZoom ? ' zoom' : ''}`;
    const quote = transcript ? transcriptFor(transcript, c.t0, c.t1, limits.maxCellChars) : null;
    if (quote) line += ` · "${quote}"`;
    if (chars + line.length > limits.maxChars) {
      truncated = true;
      out.push(`[text truncated at cell ${c.index}]`);
      break;
    }
    out.push(line);
    chars += line.length + 1;
  }

  const extra = [];
  if (audio && audio.hasAudio) {
    const bits = [];
    const durSec = Math.max(1, dur);
    const speechTotal = (audio.speech ?? []).reduce((s, x) => s + (x.dur ?? 0), 0);
    const activityTotal = (audio.activity ?? audio.speech ?? []).reduce((s, x) => s + (x.dur ?? 0), 0);
    if (speechTotal > 0) bits.push(`speech ${fmtRatio(speechTotal / durSec)}`);
    else if (activityTotal > 0) bits.push(`no speech · sound ${fmtRatio(activityTotal / durSec)}`);
    if (audio.loudnessDb != null) bits.push(`${audio.loudnessDb} dBFS`);
    const loud = loudestMoment(audio);
    if (loud) bits.push(`loudest ${timecode(loud)}`);
    if ((audio.silences ?? []).length) bits.push(`${audio.silences.length} silences`);
    if ((audio.events ?? []).length) bits.push(`${audio.events.length} onsets`);
    if (bits.length) extra.push(`audio: ${bits.join(' · ')}`);
  } else if (probe.hasAudio === false) {
    extra.push('audio: none');
  }
  if (transcript && transcript.source) {
    const bits = [`transcript: ${transcript.source}`];
    // Cues are what gets quoted, so count those; `segments` is the merged view
    // and reporting it here read as "one line" for a six-card slideshow.
    if (Array.isArray(transcript.cues) && transcript.cues.length) bits.push(`${transcript.cues.length} lines`);
    else if (transcript.segments) bits.push(`${transcript.segments.length} segments`);
    // What the client-side filters did, in the same breath as the transcript:
    // "3 lines dropped" is information, and hiding it would make a hallucination
    // filter look like a silent recogniser.
    if (transcript.dropped) bits.push(`${transcript.dropped} suspect line(s) dropped`);
    if (transcript.terms) bits.push(`${transcript.terms} term(s) fixed`);
    if (transcript.chunked) bits.push(`${transcript.chunks} chunk(s) cut on silence`);
    extra.push(bits.join(' · '));
  } else if (p.asrNote) {
    // A configured engine that failed must say so; silence reads as "no speech".
    extra.push(`asr: unavailable · ${String(p.asrNote).slice(0, 120)}`);
  }
  if (scan.motion && scan.motion.cuts > 0) {
    // nothing to add; kept out to save tokens
  }

  return { text: [...out, ...extra].join('\n'), truncated };
}

const DEGRADED = {
  motion: 'heavy camera motion — cuts may be under-detected',
  flat: 'low-detail footage — cells may be less informative',
  empty: 'no decodable frames in this window',
};

function cutsIn(cuts, t0, t1) {
  if (!cuts) return [];
  return cuts.filter((c) => c.t > t0 + 0.001 && c.t < t1 - 0.001);
}

/**
 * Dialogue for one cell.
 *
 * Each subtitle line is attributed to the cell whose span contains its MIDPOINT,
 * so a line is quoted exactly once even when it straddles a cut. Grouped
 * segments (merged for a summary) would otherwise be quoted on every cell they
 * touch — the whole film's dialogue on every cell.
 */
function transcriptFor(transcript, t0, t1, maxChars) {
  if (!transcript) return null;
  const cues = Array.isArray(transcript.cues) ? transcript.cues : null;
  if (cues && cues.length) {
    const picked = [];
    for (const c of cues) {
      const mid = (c.t0 + c.t1) / 2;
      if (mid < t0 || mid >= t1) continue;
      picked.push(c.text);
    }
    if (!picked.length) return null;
    const text = picked.join(' ').replace(/\s+/g, ' ').trim();
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }
  // Fallback for callers that only pass grouped segments.
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  if (!segments.length) return null;
  let text = '';
  for (const s of segments) {
    if (s.t1 < t0 || s.t0 > t1) continue;
    text += (text ? ' ' : '') + s.text;
    if (text.length > maxChars) return `${text.slice(0, maxChars - 1)}…`;
  }
  return text ? text.trim() : null;
}

function loudestMoment(audio) {
  if (!audio.envelope || !audio.binsPerSecond) return null;
  let best = 0;
  let bestV = -1;
  for (let i = 0; i < audio.envelope.length; i++) {
    const v = audio.envelope[i];
    if (v > bestV) { bestV = v; best = i; }
  }
  return best / audio.binsPerSecond;
}

/** Compact one-line summary for tool results that carry no sheet. */
export function formatShotList(scan, plan, { maxShots = 200 } = {}) {
  const lines = [];
  for (const s of (plan?.shots ?? []).slice(0, maxShots)) {
    const kind = s.kind === 'fade' ? 'fade' : 'cut';
    const cells = s.cells ? ` ·${s.cells} cell${s.cells > 1 ? 's' : ''}` : '';
    const same = s.sameAsCell ? ` =cell ${s.sameAsCell}` : '';
    lines.push(`${timecodeShort(s.t0)}-${timecodeShort(s.t1)} ${kind}${cells}${same}`);
  }
  return lines.join('\n');
}

export { ROW };
