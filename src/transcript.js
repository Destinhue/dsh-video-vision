/**
 * transcript.js — a transcript the caller already has.
 *
 * Tried before the container's subtitle track and before ASR, because it is the
 * cheapest and the best: a B站 video whose captions you downloaded is exact, and
 * paying a download plus a recogniser to re-derive it would be silly. SRT, VTT
 * and JSON are accepted; the JSON shapes are `[{start,end,text}]` (seconds) and
 * `{segments:[…]}`, which is what whisper-family tools emit.
 */

import { readFileSync } from 'node:fs';
import { parseSubtitleText } from './timeline.js';

/**
 * @returns {{cues: Array<{t0:number,t1:number,text:string}>, source: 'srt'|'vtt'|'json'}}
 */
export function loadTranscriptFile(file, opts = {}) {
  const read = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  let text;
  try {
    text = read(file);
  } catch (err) {
    throw new Error(`transcriptFile could not be read: ${err.message}`);
  }
  const trimmed = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) throw new Error('transcriptFile is empty');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`transcriptFile is not valid JSON: ${err.message}`);
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.segments) ? parsed.segments
        : Array.isArray(parsed?.cues) ? parsed.cues : [];
    const cues = list
      .map((s) => ({
        t0: Number(s.start ?? s.t0 ?? s.begin),
        t1: Number(s.end ?? s.t1),
        text: String(s.text ?? s.line ?? '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((c) => Number.isFinite(c.t0) && Number.isFinite(c.t1) && c.t1 > c.t0 && c.text)
      .map((c) => ({ t0: +c.t0.toFixed(2), t1: +c.t1.toFixed(2), text: c.text }));
    if (!cues.length) throw new Error('transcriptFile JSON had no usable {start,end,text} entries');
    return { cues, source: 'json' };
  }

  const cues = parseSubtitleText(trimmed).filter((c) => c.text && c.t1 > c.t0);
  if (!cues.length) throw new Error('transcriptFile has no subtitle cues (expected SRT or WebVTT)');
  return { cues, source: /^\s*WEBVTT/m.test(trimmed) ? 'vtt' : 'srt' };
}
