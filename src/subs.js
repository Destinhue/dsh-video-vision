/**
 * Burned-in subtitles: the words that are already part of the picture.
 *
 * Why this exists: a large share of the videos people ask to be read carry their
 * subtitles as pixels -- a talking head with a caption strip, a re-upload with
 * the captions baked in, a screen recording whose only moving text is the line
 * at the bottom. The container then holds no subtitle track at all
 * (`ffprobe` shows streams of video and audio and nothing else), so the text is
 * invisible to everything that reads a subtitle track and is thrown away by the
 * screen read: a caption strip is 2% of the frame, so the change gate never
 * opens and the screen read honestly reports "no readable text".
 *
 * The viewer of one such video named the three things that go wrong when a tool
 * tries anyway, and this module is built around them:
 *
 *   1. do not sample the whole file to find out whether there are captions --
 *      three stills across the window answer it;
 *   2. do not crop to the bottom by default -- captions sit at the bottom, the
 *      top, or in the middle, and a bilingual line can be two rows apart; the
 *      band is located from the OCR itself, not assumed;
 *   3. do not batch anything before one frame has been read -- a caption of 8 px
 *      comes back from the engine as invented characters, so a band whose glyphs
 *      are below the floor is refused with the measurement that refused it
 *      instead of a file full of guesses.
 *
 * Everything here is pure so the geometry, the merging and the document can be
 * tested without ffmpeg or an OCR engine; `readCaptions` in read.js is the part
 * that spawns processes.
 */

export const SUBS_DEFAULTS = {
  // three stills, spread across the window: the cheapest question that can
  // answer "are there captions here, and where"
  probeShares: [0.15, 0.45, 0.75],
  // a caption line: 0.8% of a 720p frame is 6 px (a hairline), 10% is a title
  // card; both bounds are ratios so a 360p re-upload and a 4K capture agree
  minLineHeight: 0.008,
  maxLineHeight: 0.10,
  minLineWidth: 0.05,
  // lines closer than this many line-heights are one band: a bilingual caption
  // is two rows 7 px apart on a 31 px line, a chapter heading is a different band
  bandJoin: 1.6,
  maxBandHeight: 0.22,
  // 15% of a 720p frame is 192 px: that rejected a five-character caption. 8%
  // (102 px) is still far wider than a UI label or a glyph, and the centring and
  // change tests do the rest of the rejecting.
  minBandWidth: 0.08,
  // below this the Windows engine stops recognising and starts inventing:
  // measured on the 720p test clip, a 31 px line reads exactly, an 8 px line
  // comes back as "先说墮论@ 字 0 其 实 是 面 果 最 便 直 的 篇 息"
  minGlyphPx: 11,
  minGlyphRatio: 0.015,
  // padding around the band, in line heights: OCR wants air above and below the
  // glyphs, but not the whole slide
  bandPad: 0.6,
  // two probe frames that still say the same thing are a watermark or a name
  // plate, not a caption: a caption changes on the clock
  changeSimilarity: 0.75,
  step: 1,
  // one OCR per second of video is ~24 ms on a caption band; 1800 frames keeps
  // a read under a minute and widens the step (not the cost) on longer files
  maxFrames: 1800,
  cueSimilarity: 0.62,
  minCueChars: 2,
  maxCues: 1500,
  docMaxChars: 40_000,
};

/** characters that read as language rather than icon debris */
function languageChars(text) {
  if (!text) return 0;
  const m = String(text).match(/[\p{Script=Han}\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

function medianOf(values) {
  const sorted = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** character bigram Jaccard, punctuation and spacing ignored */
function similar(a, b) {
  const bigrams = (text) => {
    const bare = String(text ?? '').replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
    const set = new Set();
    for (let i = 0; i < bare.length - 1; i++) set.add(bare.slice(i, i + 2));
    return set;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / (A.size + B.size - shared);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** `mm:ss`, minutes deliberately past 59 on a long file */
export function tc(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * When to look at a still.
 *
 * Never the very first or very last frame: a title card lives there, and a title
 * card is not a caption. The window is sliced at fractions so a two-minute clip
 * and a two-hour lecture are probed the same way.
 *
 * @param {{start?:number, end?:number, count?:number}} p
 * @returns {number[]} seconds
 */
export function probeTimes({ start = 0, end = 0, count = 3 } = {}) {
  const from = Math.max(0, Number(start) || 0);
  const to = Number(end) > from ? Number(end) : from + 1;
  const shares = SUBS_DEFAULTS.probeShares;
  const n = Math.max(1, Math.min(shares.length, Math.round(count) || 3));
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + (to - from) * shares[i]);
  return out;
}

/**
 * The caption-shaped bands of one recognised frame.
 *
 * A band is not "the bottom of the picture": it is a run of OCR lines whose
 * boxes sit within `bandJoin` line-heights of each other, are wide and short,
 * and whose union is wider than `minBandWidth` of the frame. The geometry is
 * why a top-bilingual caption and a bottom caption are found by the same code
 * that a menu bar and a watermark are rejected by.
 *
 * @param {{lines?:{text:string,x0:number,y0:number,x1:number,y1:number}[], width?:number, height?:number}} rec
 * @param {{width?:number, height?:number}} [opts]
 * @returns {{x0:number,y0:number,x1:number,y1:number,glyphPx:number,text:string,lines:string[]}[]} normalised boxes
 */
export function subtitleBands(rec, { width = 0, height = 0 } = {}) {
  const W = Number(width) || Number(rec?.width) || 0;
  const H = Number(height) || Number(rec?.height) || 0;
  if (!rec || !(W > 0) || !(H > 0)) return [];
  const lines = [];
  for (const line of rec.lines ?? []) {
    const text = String(line.text ?? '').trim();
    if (languageChars(text) < 2) continue;
    const h = Math.max(1, line.y1 - line.y0);
    const w = Math.max(1, line.x1 - line.x0);
    if (h < SUBS_DEFAULTS.minLineHeight * H || h > SUBS_DEFAULTS.maxLineHeight * H) continue;
    if (w < SUBS_DEFAULTS.minLineWidth * W) continue;
    // a caption line is wider than it is tall; an icon or a single glyph is not
    if (w / h < 1.2) continue;
    if (line.y0 <= 0 || line.y1 >= H) continue;
    lines.push({ text, x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, h });
  }
  if (!lines.length) return [];
  lines.sort((a, b) => a.y0 - b.y0);
  const gap = SUBS_DEFAULTS.bandJoin * medianOf(lines.map((l) => l.h));
  const runs = [];
  for (const line of lines) {
    const run = runs[runs.length - 1];
    if (run && line.y0 - run.y1 <= gap) {
      run.y1 = Math.max(run.y1, line.y1);
      run.x0 = Math.min(run.x0, line.x0);
      run.x1 = Math.max(run.x1, line.x1);
      run.lines.push(line);
    } else {
      runs.push({ x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1, lines: [line] });
    }
  }
  const bands = [];
  for (const run of runs) {
    const bh = run.y1 - run.y0;
    const bw = run.x1 - run.x0;
    if (bh > SUBS_DEFAULTS.maxBandHeight * H) continue;
    if (bw < SUBS_DEFAULTS.minBandWidth * W) continue;
    const cx = (run.x0 + run.x1) / 2 / W;
    if (cx < 0.2 || cx > 0.8) continue;
    bands.push({
      x0: run.x0 / W,
      y0: run.y0 / H,
      x1: run.x1 / W,
      y1: run.y1 / H,
      glyphPx: medianOf(run.lines.map((l) => l.h)),
      text: run.lines.map((l) => l.text).join(' '),
      lines: run.lines.map((l) => l.text),
    });
  }
  return bands;
}

/**
 * The band the probes agree on: where the captions are, how tall the glyphs are,
 * and whether it is worth scanning the file for them.
 *
 * @param {{t:number, rec:object}[]} records the OCR of each probe frame
 * @param {{scale?:number, requireChange?:boolean}} [opts] scale > 1 for probes
 *        that were upscaled before OCR (glyph heights are divided back)
 */
export function pickSubtitleBand(records = [], { scale = 1, requireChange = true } = {}) {
  const seen = [];
  for (let i = 0; i < records.length; i++) {
    for (const band of subtitleBands(records[i].rec)) seen.push({ i, t: records[i].t, band });
  }
  if (!seen.length) {
    // Nothing had caption shape. Before saying "no captions", check whether the
    // engine handed back text that is merely too small to be trusted: an 8 px
    // line comes back as invented characters, and "invented characters" is a
    // better answer than "nothing here" -- it is the measurement the viewer
    // asked for.
    const miss = nearMissLines(records, { scale });
    if (miss) return miss;
    return { ok: false, code: 'no-band', reason: 'no line of caption shape was found in the probed frames' };
  }
  // One band per place on the picture: cluster the probes vertically. A caption
  // can shift up when a two-line line becomes one, so the window is generous.
  const clusters = [];
  for (const item of seen) {
    const cy = (item.band.y0 + item.band.y1) / 2;
    const bh = item.band.y1 - item.band.y0;
    const hit = clusters.find((c) => Math.abs(c.cy - cy) <= Math.max(0.02, Math.max(c.bh, bh) * 0.5)
      && Math.abs(c.bh - bh) <= Math.max(0.025, Math.max(c.bh, bh) * 0.6));
    if (hit) {
      hit.members.push(item);
      hit.cy = hit.members.reduce((n, m) => n + (m.band.y0 + m.band.y1) / 2, 0) / hit.members.length;
      hit.bh = hit.members.reduce((n, m) => n + (m.band.y1 - m.band.y0), 0) / hit.members.length;
    } else {
      clusters.push({ cy, bh, members: [item] });
    }
  }
  // A caption is on screen for seconds, so two independent stills should both
  // catch it; a band on a single still is a poster, a logo or an OCR accident.
  const need = Math.min(2, records.length);
  const found = clusters.filter((c) => new Set(c.members.map((m) => m.i)).size >= need);
  if (!found.length) {
    return {
      ok: false,
      code: 'single-frame',
      reason: `a text band appeared on only one of ${records.length} probed frames`,
    };
  }
  const rank = (c) => {
    const last = c.members[c.members.length - 1].band;
    const cy = (last.y0 + last.y1) / 2;
    const nearEdge = Math.min(cy, 1 - cy) < 0.25 ? 0.3 : 0;
    return (c.members.length / records.length) * 2 + Math.min(1, last.x1 - last.x0) + nearEdge;
  };
  found.sort((a, b) => rank(b) - rank(a));
  const best = found[0];
  const box = {
    x0: Math.min(...best.members.map((m) => m.band.x0)),
    y0: Math.min(...best.members.map((m) => m.band.y0)),
    x1: Math.max(...best.members.map((m) => m.band.x1)),
    y1: Math.max(...best.members.map((m) => m.band.y1)),
  };
  const glyphPx = medianOf(best.members.map((m) => m.band.glyphPx)) / Math.max(1, scale);
  const height = records[0].rec?.height || 0;
  // the floor and the picture size it is quoted against belong to the file, not
  // to a copy that was doubled before OCR
  const height0 = height / Math.max(1, scale);
  const floor = Math.max(SUBS_DEFAULTS.minGlyphPx, SUBS_DEFAULTS.minGlyphRatio * height0);
  // One text per probe frame, longest wins: OCR drops a character here and there
  const perFrame = new Map();
  for (const m of best.members) {
    const prev = perFrame.get(m.i);
    if (!prev || m.band.text.length > prev.length) perFrame.set(m.i, m.band.text);
  }
  const texts = [...perFrame.values()];
  const sample = texts.reduce((a, b) => (b.length > a.length ? b : a), '');
  let changes = false;
  for (let i = 0; i < texts.length && !changes; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (similar(texts[i], texts[j]) < SUBS_DEFAULTS.changeSimilarity) { changes = true; break; }
    }
  }
  if (requireChange && texts.length >= 2 && !changes) {
    return {
      ok: false,
      code: 'fixed',
      band: box,
      glyphPx,
      text: sample,
      reason: 'a fixed band of text held still across the probes — a caption changes on the clock',
    };
  }
  if (glyphPx < floor) {
    return {
      ok: false,
      code: 'small',
      band: box,
      glyphPx,
      text: sample,
      reason: `its lines are ${Math.round(glyphPx)} px tall on a ${Math.round(height0)} px picture, `
        + `under the ${Math.round(floor)} px floor where the engine starts guessing`,
    };
  }
  return {
    ok: true,
    band: box,
    glyphPx,
    frames: new Set(best.members.map((m) => m.i)).size,
    text: sample,
    reason: null,
  };
}

/**
 * Text that is there but too small to be read.
 *
 * The fallback to `no-band`: lines the engine did return, none of them caption
 * shaped, all of them short rows (not a title card) seen on at least two probes,
 * and a median height under the floor. That is what a caption strip of 8 px
 * looks like from the outside, and reporting the height is the difference
 * between "your file has no words" and "your words are 8 px tall".
 */
function nearMissLines(records, { scale = 1 } = {}) {
  const rows = [];
  let H = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i].rec;
    const h0 = Number(rec?.height) || 0;
    if (!h0) continue;
    H = H || h0;
    const W = Number(rec?.width) || 0;
    for (const line of rec.lines ?? []) {
      const text = String(line.text ?? '').trim();
      const chars = languageChars(text);
      // a caption line says something; two or three glyphs off a busy pattern are
      // engine noise and must not be reported as "your captions are too small"
      if (chars < 6) continue;
      const h = Math.max(1, line.y1 - line.y0);
      // a row taller than a caption is a title, a slide heading or a logo
      if (h > SUBS_DEFAULTS.maxLineHeight * h0) continue;
      const cx = W ? (line.x0 + line.x1) / 2 / W : 0.5;
      if (cx < 0.25 || cx > 0.75) continue;     // captions are centred
      rows.push({ i, h, text, cy: (line.y0 + line.y1) / 2 / h0 });
    }
  }
  if (rows.length < 2) return null;
  // One horizontal strip, on several stills: a caption band sits in the same
  // place every time it appears, while debris from a busy picture does not.
  const medCy = medianOf(rows.map((r) => r.cy));
  const near = rows.filter((r) => Math.abs(r.cy - medCy) <= 0.04);
  const frames = new Set(near.map((r) => r.i));
  const need = Math.min(2, records.length);
  if (near.length < 2 || frames.size < need) return null;
  const glyphPx = medianOf(near.map((r) => r.h)) / Math.max(1, scale);
  // the ratio floor belongs to the picture as it exists in the file, not to the
  // copy that was doubled before OCR
  const H0 = H / Math.max(1, scale);
  const floor = Math.max(SUBS_DEFAULTS.minGlyphPx, SUBS_DEFAULTS.minGlyphRatio * H0);
  if (!(glyphPx < floor)) return null;
  const sample = near.reduce((a, b) => (b.text.length > a.text.length ? b : a), near[0]).text;
  return {
    ok: false,
    code: 'small',
    glyphPx,
    text: sample,
    reason: `the only text in the probed frames is ${Math.round(glyphPx)} px tall on a ${Math.round(H0)} px `
      + `picture, under the ${Math.round(floor)} px floor where the engine stops reading and starts guessing`
      + ` (at that size it returned 「${sample.slice(0, 24)}」)`,
  };
}

/**
 * The band plus air, as a normalised crop rectangle.
 *
 * Padding is vertical and generous, horizontal and tight: the crop has to keep
 * the tallest ascender and the lowest descender, while pulling in a word or two
 * of the slide behind the caption only costs OCR accuracy.
 */
export function bandRect(band, { pad = SUBS_DEFAULTS.bandPad } = {}) {
  const h = Math.max(0.01, band.y1 - band.y0);
  const w = Math.max(0.01, band.x1 - band.x0);
  const y0 = clamp01(band.y0 - h * pad);
  const y1 = clamp01(band.y1 + h * pad);
  const x0 = clamp01(band.x0 - w * 0.04);
  const x1 = clamp01(band.x1 + w * 0.04);
  return { x: x0, y: y0, w: Math.max(0.01, x1 - x0), h: Math.max(0.01, y1 - y0) };
}

/** the ffmpeg crop expression for a normalised rectangle */
export function cropExpr(rect) {
  const f = (v) => Math.min(0.999, Math.max(0, v)).toFixed(4);
  return `crop=iw*${f(rect.w)}:ih*${f(rect.h)}:iw*${f(rect.x)}:ih*${f(rect.y)}`;
}

/**
 * How many frames to read, and how far apart.
 *
 * A caption on screen for less than a second is rare, so one frame per second is
 * the honest default and the viewer's own advice. Longer files widen the step
 * instead of the cost; the document says which step was used, because a step of
 * three seconds will miss short captions and that is a fact the reader needs.
 *
 * @param {{start?:number, end?:number, step?:number, maxFrames?:number}} p
 */
export function scanPlan({ start = 0, end = 0, step = SUBS_DEFAULTS.step, maxFrames = SUBS_DEFAULTS.maxFrames } = {}) {
  const from = Math.max(0, Number(start) || 0);
  const to = Number(end) > from ? Number(end) : from + 1;
  const span = Math.max(0.2, to - from);
  let use = Math.max(0.2, Number(step) || SUBS_DEFAULTS.step);
  const wanted = Math.ceil(span / use);
  if (wanted > maxFrames) {
    use = Math.max(0.5, Math.round((span / maxFrames) * 10) / 10);
  }
  const frames = Math.max(1, Math.min(maxFrames, Math.ceil(span / use)));
  return { step: use, frames, span };
}

/**
 * One cue per caption, not one per sampled frame.
 *
 * OCR of the same caption on four consecutive frames is four slightly different
 * strings, so the run is merged on similarity and the longest reading wins. An
 * empty frame ends the run: a gap in the OCR is a gap in the captions.
 *
 * @param {{i?:number, t:number, text:string}[]} samples in time order
 * @param {{step?:number, end?:number, similarity?:number, minChars?:number, maxCues?:number}} [opts]
 */
export function mergeSubtitleCues(samples = [], {
  step = SUBS_DEFAULTS.step,
  end = 0,
  similarity = SUBS_DEFAULTS.cueSimilarity,
  minChars = SUBS_DEFAULTS.minCueChars,
  maxCues = SUBS_DEFAULTS.maxCues,
} = {}) {
  const out = [];
  for (const s of samples) {
    const text = String(s.text ?? '').replace(/\s+/g, ' ').trim();
    if (languageChars(text) < minChars) continue;
    const prev = out[out.length - 1];
    // Only neighbouring samples can be the same caption: an empty frame between
    // them is a gap in the captions, not noise to be merged across.
    const consecutive = Boolean(prev) && (s.i === undefined || prev.lastIndex === undefined
      ? true
      : s.i === prev.lastIndex + 1);
    if (consecutive && similar(prev.text, text) >= similarity) {
      prev.lastIndex = s.i;
      prev.tEnd = s.t + step;
      if (text.length > prev.text.length) prev.text = text;
      continue;
    }
    out.push({ t: s.t, tEnd: s.t + step, text, lastIndex: s.i });
  }
  const raw = out.map((c) => ({ t: c.t, tEnd: c.tEnd, text: c.text }));
  const capped = Math.max(0, raw.length - maxCues);
  const cues = capped ? raw.slice(0, maxCues) : raw;
  if (end > 0) {
    for (const c of cues) if (c.tEnd > end) c.tEnd = Math.max(c.t + 0.2, end);
  }
  return { cues, capped };
}

/**
 * The document `video_read` returns when the captions came from the picture.
 *
 * Same shape as the screen read -- header, notes, then `[mm:ss] text` -- because
 * the caller treats both as text. The notes are what a subtitle track would have
 * told it for free: there is no track, this line was read off the pixels, here
 * is the band and the glyph height, and here is how densely the file was read.
 */
export function subsDocument({
  title = '',
  cues = [],
  band = null,
  glyphPx = 0,
  height = 0,
  frames = 0,
  step = SUBS_DEFAULTS.step,
  duration = 0,
  end = 0,
  screens = [],
  ms = 0,
  maxChars = SUBS_DEFAULTS.docMaxChars,
} = {}) {
  const lines = [];
  let chars = 0;
  for (const c of cues) {
    const text = String(c.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const span = c.tEnd > c.t + 1 ? `${tc(c.t)}–${tc(c.tEnd)}` : tc(c.t);
    const line = `[${span}] ${text}`;
    if (lines.length && chars + line.length + 1 > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const capped = cues.length - lines.length;
  const head = `# ${title || 'video'} — read as text · burned-in subtitles · ${cues.length} lines · `
    + `${tc(duration || end)}${ms ? ` · ${ms} ms` : ''}`;
  const body = [head];
  body.push('note: the container has no subtitle track — these lines were recognised from the picture itself');
  if (band) {
    const where = `y ${Math.round(band.y * 100)}%–${Math.round((band.y + band.h) * 100)}%`;
    const tall = height ? `, glyph height ${Math.round(glyphPx)} px of ${height}` : '';
    const dense = frames ? `, ${frames} frame${frames === 1 ? '' : 's'} read ${step > 1 ? `${step} s` : '1 s'} apart` : '';
    body.push(`note: caption band ${where}${tall}${dense}`);
  }
  if (screens.length) {
    body.push(`note: ${screens.length} whole-frame screen${screens.length === 1 ? '' : 's'} carried text too — `
      + 'quoted under "screens" below');
  }
  if (capped > 0) {
    body.push(`note: capped at ${lines.length} of ${cues.length} lines — read a window for the rest`);
  }
  if (!lines.length) body.push('note: no cue could be read from the caption band');
  body.push('');
  for (const line of lines) body.push(line);
  if (screens.length) {
    body.push('', '## screens');
    for (const s of screens) {
      body.push(`[${tc(s.t)}] ${String(s.text ?? '').replace(/\s+/g, ' ').trim()}`);
    }
  }
  body.push('');
  return { text: body.join('\n'), lines: lines.length, cues: cues.length, capped: Math.max(0, capped) };
}
