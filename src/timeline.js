/**
 * timeline.js — the text half of the storyboard: timecodes, audio evidence,
 * subtitles, and the manifest the model actually reads.
 *
 * The picture cannot say *when* anything happened, and a contact sheet without
 * timestamps is a bag of stills. So time lives in text at 0.01 s precision, and
 * the audio analysis exists to back claims the pictures cannot make on their
 * own: where speech is, where music starts, where a loud hit lands.
 *
 * Audio is decoded once to 8 kHz mono PCM and analysed here, which keeps the
 * numbers honest and needs no ffmpeg filter gymnastics. The envelope is stored
 * at 25 bins per second — the same order as the scan frame rate — so it can be
 * drawn as a band under the sheet and queried by time without resampling.
 */

import { netInputArgs } from './media.js';

export const AUDIO_DEFAULTS = {
  sampleRate: 8000,
  binMs: 40,
  speechFloorDb: -42,
  minSpeech: 0.30,
  mergeGap: 0.28,
  onsetK: 2.6,
};

/* ------------------------------------------------------------- timecodes */

/** `mm:ss.cc`, or `h:mm:ss.cc` past an hour. */
export function timecode(t, { hours = 'auto' } = {}) {
  const sign = t < 0 ? '-' : '';
  const v = Math.abs(t);
  const totalCs = Math.round(v * 100);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const showHours = hours === true || (hours === 'auto' && h > 0);
  return `${sign}${showHours ? `${h}:${pad(m)}` : pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** `mm:ss` without centiseconds, for ranges that are read quickly. */
export function timecodeShort(t) {
  const totalSec = Math.floor(t);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ audio */

const DB_FLOOR = -80;

function rmsToDb(rms) {
  if (rms <= 1e-7) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(rms));
}

const sd = (values) => {
  if (!values.length) return 0;
  const mu = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mu) ** 2, 0) / values.length);
};

const round1 = (v, digits = 1) => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

/**
 * @returns {Promise<{hasAudio:boolean, envelope:Float32Array|null, speech:Array, events:Array,
 *   loudnessDb:number|null, silences:Array, binsPerSecond:number, ms:number}>}
 */
export async function analyzeAudio({ input, ffmpegPath, signal, duration = 0, run }) {
  const started = Date.now();
  const sr = AUDIO_DEFAULTS.sampleRate;
  const binSamples = Math.round((sr * AUDIO_DEFAULTS.binMs) / 1000);
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    ...netInputArgs(input), '-i', input, '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(sr), '-f', 's16le', '-acodec', 'pcm_s16le', '-',
  ];
  const res = await run(ffmpegPath, args, { signal, maxBuffer: 512 * 1024 * 1024 });
  const pcm = res.stdout;
  if (!pcm || pcm.length < binSamples * 2) {
    return {
      hasAudio: false, envelope: null, speech: [], activity: [], voiceDetected: false,
      events: [], loudnessDb: null,
      silences: [], binsPerSecond: 1000 / AUDIO_DEFAULTS.binMs, ms: Date.now() - started,
      note: res.code === 0 ? 'no audio samples' : (res.stderr || '').slice(-200),
    };
  }

  const nsamples = Math.floor(pcm.length / 2);
  const nBins = Math.floor(nsamples / binSamples);
  const bins = new Float32Array(nBins);
  // `hf` is the bin's spectral centroid as a ratio: sum of squared first
  // differences over signal energy. A 1 kHz tone at 8 kHz lands near 0.6, a
  // 100 Hz hum near 0.006. Speech swings between them as syllables open and
  // close; sustained music does not move.
  const hf = new Float32Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let sum = 0;
    let diff = 0;
    let prev = 0;
    const start = b * binSamples;
    for (let i = 0; i < binSamples; i++) {
      const v = pcm.readInt16LE((start + i) * 2) / 32768;
      if (i > 0) { const d = v - prev; diff += d * d; }
      prev = v;
      sum += v * v;
    }
    bins[b] = Math.sqrt(sum / binSamples);
    hf[b] = sum > 1e-9 ? diff / sum : 0;
  }

  // ---- envelope normalised to a robust peak, so a quiet recording still reads
  const sorted = Float32Array.from(bins).sort();
  const p95 = sorted[Math.min(nBins - 1, Math.floor(nBins * 0.95))] || 1e-4;
  const envelope = new Float32Array(nBins);
  for (let i = 0; i < nBins; i++) envelope[i] = Math.min(1, bins[i] / p95);

  const dbOf = (i) => rmsToDb(bins[i]);
  const totalRms = Math.sqrt(bins.reduce((s, v) => s + v * v, 0) / Math.max(1, nBins));
  const loudnessDb = +rmsToDb(totalRms).toFixed(1);

  // ---- speech-ish spans: sustained energy above the clip's own speech floor
  const binSec = AUDIO_DEFAULTS.binMs / 1000;
  // The activity floor tracks the recording's own noise bed (20th percentile)
  // but never drops below -42 dBFS nor climbs above -28 dBFS. A percentile-only
  // floor — the obvious choice — reports nothing at all on a clip that is loud
  // the whole way through, which is exactly what a vlog sounds like.
  const noiseDb = rmsToDb(sorted[Math.floor(nBins * 0.2)]);
  const floor = Math.max(AUDIO_DEFAULTS.speechFloorDb, Math.min(noiseDb + 10, -28));
  // Double-threshold VAD. One threshold fragments a sentence into one span per
  // word, because the level falls under it between syllables; entering at
  // `floor` and only leaving 12 dB lower, after 0.3 s of quiet, keeps a sentence
  // whole while still ending a span in a real pause.
  const exitDb = floor - 12;
  const hangover = Math.max(2, Math.round(0.30 / binSec));

  const speech = [];
  const activeSpans = [];
  let span0 = -1;
  let quietRun = 0;
  for (let i = 0; i < nBins; i++) {
    const level = dbOf(i);
    if (span0 < 0) {
      if (level > floor) { span0 = i; quietRun = 0; }
      continue;
    }
    if (level > exitDb) { quietRun = 0; continue; }
    quietRun += 1;
    if (quietRun >= hangover) {
      const end = i - quietRun + 1;
      const t0 = span0 * binSec;
      const dur = (end - span0) * binSec;
      if (dur >= AUDIO_DEFAULTS.minSpeech) {
        const last = speech[speech.length - 1];
        if (last && t0 - (last.t + last.dur) <= AUDIO_DEFAULTS.mergeGap) {
          last.dur = t0 + dur - last.t;
        } else {
          speech.push({ t: +t0.toFixed(2), dur: +dur.toFixed(2) });
        }
      }
      span0 = -1;
      quietRun = 0;
    }
  }
  if (span0 >= 0) {
    const t0 = span0 * binSec;
    const dur = (nBins - span0) * binSec;
    if (dur >= AUDIO_DEFAULTS.minSpeech) speech.push({ t: +t0.toFixed(2), dur: +dur.toFixed(2) });
  }
  // `speech` so far is "sustained loud activity", which loud music also is. Split
  // it: a span is dialogue only when the level modulates like syllables and the
  // spectral centroid swings with them. Sustained music sits flat on both.
  for (const span of speech) {
    const i0 = Math.max(0, Math.round(span.t / binSec));
    const i1 = Math.min(nBins, Math.round((span.t + span.dur) / binSec));
    const levels = [];
    const ratios = [];
    for (let i = i0; i < i1; i++) { levels.push(dbOf(i)); ratios.push(hf[i]); }
    const spanSec = Math.max(0.1, span.dur);
    let dips = 0;
    for (let k = 1; k < levels.length - 1; k++) {
      if (levels[k] < levels[k - 1] - 5 && levels[k] < levels[k + 1] - 5) dips += 1;
    }
    const voice = {
      levelSd: round1(sd(levels)),
      dipsPerSec: round1(dips / spanSec),
      hfSd: round1(sd(ratios), 2),
    };
    // Measured on the corpus: dialogue sits at levelSd 6.9-8.7 dB and hfSd
    // 0.11-1.21, a steady music bed at 0.9-1.4 dB and 0.00-0.01. `dipsPerSec`
    // is reported for debugging but is not a gate — a 0.3 s interjection has no
    // room for a dip yet is still a word.
    const isSpeech = voice.levelSd >= 4 && voice.hfSd >= 0.05;
    activeSpans.push({ ...span, voice, speech: isSpeech });
  }

  // ---- onsets: sharp rises against the local mean (hits, cuts in music)
  const events = [];
  const localWin = Math.max(3, Math.round(0.5 / binSec));
  for (let i = 1; i < nBins; i++) {
    let acc = 0;
    let count = 0;
    for (let k = Math.max(0, i - localWin); k < i; k++) { acc += envelope[k]; count += 1; }
    const local = count ? acc / count : 0;
    if (envelope[i] > 0.35 && envelope[i] - local > 0.28 * AUDIO_DEFAULTS.onsetK / 2.6) {
      const t = +(i * binSec).toFixed(2);
      if (!events.length || t - events[events.length - 1].t > 0.25) events.push({ t, kind: 'onset', strength: +(envelope[i] - local).toFixed(2) });
    }
  }

  // ---- silences (worth one line: "the room goes quiet at 3:10")
  const silences = [];
  let quiet0 = -1;
  for (let i = 0; i <= nBins; i++) {
    const quiet = i < nBins ? dbOf(i) < Math.min(-50, floor - 6) : false;
    if (quiet && quiet0 < 0) quiet0 = i;
    if (!quiet && quiet0 >= 0) {
      const dur = (i - quiet0) * binSec;
      if (dur >= 0.6) silences.push({ t: +(quiet0 * binSec).toFixed(2), dur: +dur.toFixed(2) });
      quiet0 = -1;
    }
  }

  return {
    hasAudio: true,
    envelope,
    binsPerSecond: 1000 / AUDIO_DEFAULTS.binMs,
    // `speech` is dialogue only; `activity` is every sustained loud span, which
    // is what music and effects look like. Reporting "speech 45 %" over a music
    // bed is a lie the model would act on, so the two are kept apart.
    speech: activeSpans.filter((s) => s.speech).map((s) => ({ t: s.t, dur: s.dur })),
    activity: activeSpans.map((s) => ({ t: s.t, dur: s.dur, voice: s.voice })),
    voiceDetected: activeSpans.some((s) => s.speech),
    events: events.slice(0, 400),
    loudnessDb,
    silences: silences.slice(0, 60),
    ms: Date.now() - started,
    duration: +((nBins * AUDIO_DEFAULTS.binMs) / 1000).toFixed(2),
    durationHint: duration,
  };
}

/* -------------------------------------------------------------- subtitles */

const TS = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

function parseTimestamp(h, m, s, frac) {
  const f = Number(frac.padEnd(3, '0')) / 1000;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + f;
}

/** Parse SRT/WebVTT text (ffmpeg can emit either) into cues. */
export function parseSubtitleText(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const m = [...lines[arrowIdx].matchAll(TS)];
    if (m.length < 2) continue;
    const t0 = parseTimestamp(...m[0].slice(1));
    const t1 = parseTimestamp(...m[1].slice(1));
    const body = lines.slice(arrowIdx + 1).join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    cues.push({ t0: +t0.toFixed(2), t1: +t1.toFixed(2), text: body });
  }
  return cues;
}

/** Pull the first subtitle track out of the container, if any. */
export async function extractSubtitles({ input, ffmpegPath, signal, run, probe }) {
  // `probeVideo()` reports `hasSubtitle` and deliberately does not return the
  // whole stream table. Reading only `probe.streams` here meant the feature was
  // dead on every real file while its unit test passed a hand-built fixture.
  const hasSub = Boolean(probe && (probe.hasSubtitle === true
    || (Array.isArray(probe.streams) && probe.streams.some((s) => s.kind === 'subtitle'))));
  if (!hasSub) return { cues: [], source: null };
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    ...netInputArgs(input), '-i', input, '-map', '0:s:0', '-f', 'srt', '-',
  ];
  const res = await run(ffmpegPath, args, { signal, maxBuffer: 64 * 1024 * 1024 });
  if (res.code !== 0) return { cues: [], source: null, error: (res.stderr || '').slice(-160) };
  const cues = parseSubtitleText(res.stdout.toString('utf8'));
  return { cues, source: 'subtitle-track' };
}

/* ------------------------------------------------------------- transcript */

/**
 * Group subtitle cues into readable chunks of at most `maxChars`, keeping the
 * earliest cue's start time. Long films produce a subtitle every two seconds;
 * quoting all of them would drown the sheet manifest.
 */
export function groupCues(cues, { maxChars = 180, maxGap = 1.2 } = {}) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) { cur = { t0: c.t0, t1: c.t1, text: c.text }; continue; }
    const gap = c.t0 - cur.t1;
    const wouldBe = cur.text.length + 1 + c.text.length;
    if (gap <= maxGap && wouldBe <= maxChars) {
      cur.text = `${cur.text} ${c.text}`;
      cur.t1 = Math.max(cur.t1, c.t1);
    } else {
      out.push(cur);
      cur = { t0: c.t0, t1: c.t1, text: c.text };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Silence midpoints between consecutive cues.
 *
 * This is where a cell boundary belongs: cutting inside a sentence quotes half
 * a sentence on both cards, and the reader has no way to tell which card the
 * words were actually spoken over.
 */
export function sentenceGaps(cues, { minGap = 0.25 } = {}) {
  const gaps = [];
  for (let i = 1; i < (cues?.length ?? 0); i++) {
    const gap = cues[i].t0 - cues[i - 1].t1;
    if (gap < minGap) continue;
    gaps.push({ t: +((cues[i - 1].t1 + cues[i].t0) / 2).toFixed(3), gap: +gap.toFixed(2) });
  }
  return gaps;
}

/**
 * Move cell boundaries onto silence midpoints, in place.
 *
 * Only boundaries within `maxShift` of a real gap move, and a move that would
 * leave either neighbour shorter than `minCellSeconds` is refused - a snapping
 * pass that can create a zero-length cell is a bug generator.
 *
 * @returns {number} how many boundaries moved
 */
export function snapCellsToSpeech(cells, cues, { maxShift = 1.5, minGap = 0.25, minCellSeconds = 0.3 } = {}) {
  const gaps = sentenceGaps(cues, { minGap });
  if (!gaps.length || !cells || cells.length < 2) return 0;
  let moved = 0;
  for (let i = 0; i < cells.length - 1; i++) {
    const here = cells[i].t1;
    let best = null;
    for (const g of gaps) {
      const d = Math.abs(g.t - here);
      if (d <= maxShift && d > 0.001 && (!best || d < best.d)) best = { d, t: g.t };
    }
    if (!best) continue;
    if (best.t - cells[i].t0 < minCellSeconds) continue;
    if (cells[i + 1].t1 - best.t < minCellSeconds) continue;
    cells[i].t1 = +best.t.toFixed(3);
    cells[i + 1].t0 = +best.t.toFixed(3);
    moved++;
  }
  return moved;
}

/**
 * Characters per second of speech.
 *
 * A planning signal, not a statistic: a stretch where somebody talks steadily
 * is a stretch where each sentence deserves its own cell, and forty seconds of
 * silence does not.
 */
export function speechRate(cues) {
  const list = Array.isArray(cues) ? cues : [];
  if (!list.length) return 0;
  let chars = 0;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const c of list) {
    chars += String(c.text ?? '').replace(/\s+/g, '').length;
    if (c.t0 < t0) t0 = c.t0;
    if (c.t1 > t1) t1 = c.t1;
  }
  const span = t1 - t0;
  if (!(span > 0) || !chars) return 0;
  return +(chars / span).toFixed(2);
}

/**
 * Which transcript segment covers `t`. Used by the manifest so each cell line
 * can quote the dialogue that belongs to it.
 */
export function segmentAt(segments, t) {
  // NaN compares false against every bound and would fall through to a cue.
  if (!Number.isFinite(t)) return null;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.t0) hi = mid - 1;
    else if (t > s.t1) lo = mid + 1;
    else return s;
  }
  return null;
}
