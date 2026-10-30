/**
 * layout.js — which moments of the video deserve a picture, and how big each
 * one is. Everything here works off the scan pass, so no extra decode.
 *
 * Two decisions that matter far more than they look:
 *
 * 1. HOW MANY pictures a shot is worth. Upstream equalises cut density, which
 *    is a good proxy for "where things change" but a bad proxy for "where
 *    there is something to see": a 30 s static talking head eats four cells
 *    while a 3 s title card with legible text gets one and its text becomes
 *    unreadable. Here the budget follows measured content — internal motion,
 *    fine detail (text-like structure), speech, and novelty against frames
 *    already chosen — with a hard floor of one cell per surviving shot so no
 *    part of the film goes unseen.
 *
 * 2. WHERE inside a shot the picture comes from. Frames adjacent to a cut are
 *    disproportionately fade/transition frames, so picks are biased toward the
 *    middle of the span and toward frames that are sharp and detailed. The
 *    scan already scored every frame, so this costs nothing.
 */
import { SCAN_DEFAULTS } from './scan.js';

export const LAYOUT_DEFAULTS = {
  minCells: 3,
  minShotForCell: 0.12,
  gutter: 2,
  maxSheetPixels: 1_450_000,
  maxSheetSide: 3072,
  minCellWidth: 240,
  // A second cell in the same shot has to buy new content, and the shot has to
  // be long enough that something can have happened: one cell per ten seconds
  // is the ceiling before the sheet turns into frame soup.
  longShotSpan: 10,
  maxCellsPerUnit: 6,
  // Except when there is only one shot to spend the budget on. Minutes of
  // board work, slides or a screen share belong in a storyboard even though no
  // cut ever separates them: one cell per half minute, up to this many.
  boardSpan: 30,
  maxCellsSingleShot: 24,
  // A stretch this long with no cut is a different kind of video: a lecture, a
  // screen share, a board being written on. There the picture changes a little
  // at a time — a line appears, a slide advances — so "is this a different
  // picture?" has to be asked per block, not over the whole frame.
  boardMinSeconds: 90,
  boardMinChange: 0.02,
  spillNoveltyK: 2.5,
};

/**
 * Pixel budgets. The host bills an image at roughly one token per 42x42 px
 * tile, with a hard cap of 1024 tokens — which lands at about 1.8 M px. So a
 * sheet smaller than that wastes accuracy, and a sheet larger than it wastes
 * pixels that are thrown away before the model ever sees them.
 */
export const VISION_TOKEN_CAP = 1024;
export const VISION_PIXELS_CAP = 1_800_000;

/**
 * Vision tokens scale with the sheet's AREA, not with the number of cells on
 * it, so the sheet is sized per cell rather than per sheet: six cells do not
 * need a million pixels to be readable, and twenty cells at 640k px would be
 * blurry dots. `perCell` is the pixel budget one cell is worth for that level
 * of detail, and `max` is the hard ceiling the model's 1024-token cap implies.
 */
export const DETAIL_PRESETS = {
  low: { maxCells: 6, perCell: 130_000, max: 900_000 },
  auto: { maxCells: 28, perCell: 92_000, max: 1_760_000 },
  high: { maxCells: 32, perCell: 118_000, max: VISION_PIXELS_CAP },
  ultra: { maxCells: 24, perCell: 240_000, max: VISION_PIXELS_CAP },
};

/**
 * How many cells the pixel cap can still keep above `minCellWidth`.
 *
 * Extra cells are free in *tokens* (the sheet is charged by area) but not in
 * *legibility*: on a portrait clip a wide grid squeezes each cell under the
 * width at which a face is still a face. This is the rail that keeps a merged
 * 30-shot montage from turning into 30 stamps.
 */
export function maxCellsByPixels(preset, aspect = 16 / 9) {
  const w = LAYOUT_DEFAULTS.minCellWidth;
  const ratio = Math.max(0.2, Math.min(6, Number.isFinite(aspect) ? aspect : 16 / 9));
  const cellArea = w * (w / ratio);
  return Math.max(LAYOUT_DEFAULTS.minCells, Math.floor(preset.max / cellArea));
}

/** Images below this are upscaled by the host to 544x544 before billing. */
export const MIN_SHEET_PIXELS = 300_000;

/** Pixels worth spending on a sheet that carries `n` cells at `detail`. */
export function sheetPixelsFor(n, detail = 'auto') {
  const preset = DETAIL_PRESETS[detail] ?? DETAIL_PRESETS.auto;
  return Math.round(clamp(n * preset.perCell, MIN_SHEET_PIXELS, preset.max));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const SCAN_EPS = 0.04;
const BW = 12;
const BH = 7;

/* ------------------------------------------------------------------ shots */

/** Turn cut timestamps into shot spans over the scan frame grid. */
export function buildShots(scan) {
  const { cuts = [], duration = 0, effFps = 25 } = scan;
  const bounds = [0];
  for (const c of cuts) if (c.t > SCAN_EPS && c.t < duration - SCAN_EPS) bounds.push(c.t);
  bounds.push(duration);
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const t0 = bounds[i];
    const t1 = bounds[i + 1];
    if (t1 - t0 < SCAN_EPS) continue;
    // Shot i is opened by cuts[i - 1]; cuts[i] is the cut that closes it.
    const fromCut = i > 0 ? cuts[i - 1] : null;
    shots.push({
      t0, t1, dur: t1 - t0,
      i0: clamp(Math.round(t0 * effFps), 0, Math.max(0, scan.frames - 1)),
      i1: clamp(Math.round(t1 * effFps) - 1, 0, Math.max(0, scan.frames - 1)),
      kind: i === 0 ? 'start' : fromCut && fromCut.t === t0 ? fromCut.kind : 'cut',
    });
  }
  if (shots.length === 0 && duration > 0) {
    shots.push({ t0: 0, t1: duration, dur: duration, i0: 0, i1: Math.max(0, scan.frames - 1), kind: 'cut' });
  }
  return shots;
}

/* --------------------------------------------------------------- features */

export function shotFeatures(shot, scan) {
  const { vectors, scores = new Float32Array(0) } = scan;
  const a = shot.i0;
  const b = Math.max(a, shot.i1);
  let sharpMax = 0, sharpSum = 0, detailMax = 0, detailSum = 0, edgeSum = 0, brightSum = 0, n = 0;
  for (let i = a; i <= b; i++) {
    const s = vectors.sharp[i] ?? 0;
    const d = vectors.detail[i] ?? 0;
    if (s > sharpMax) sharpMax = s;
    if (d > detailMax) detailMax = d;
    sharpSum += s;
    detailSum += d;
    edgeSum += vectors.edge[i] ?? 0;
    brightSum += vectors.bright[i] ?? 0;
    n += 1;
  }
  n = Math.max(1, n);
  let motionSum = 0, motionN = 0;
  for (let i = a; i <= b && i < scores.length; i++) { motionSum += scores[i]; motionN += 1; }
  return {
    sharpMax: +sharpMax.toFixed(1),
    sharpMean: +(sharpSum / n).toFixed(1),
    detailMax: +detailMax.toFixed(3),
    detailMean: +(detailSum / n).toFixed(3),
    edgeMean: +(edgeSum / n).toFixed(1),
    brightMean: +(brightSum / n).toFixed(1),
    motion: +(motionN ? motionSum / motionN : 0).toFixed(2),
    frames: n,
  };
}

/* ---------------------------------------------------------------- weights */

function overlap(spans, t0, t1) {
  let sum = 0;
  for (const s of spans) {
    const a = Math.max(s.t, t0);
    const b = Math.min(s.t + (s.dur ?? 0), t1);
    if (b > a) sum += b - a;
  }
  return sum;
}

function countIn(list, t0, t1) {
  let n = 0;
  for (const e of list) if (e.t >= t0 && e.t < t1) n += 1;
  return n;
}

/**
 * How much a shot is worth, in cells. Deliberately monotone and readable:
 * duration (diminishing), internal motion, fine detail, and speech each add.
 */
export function shotWeight(shot, f, audio, duration) {
  const durN = clamp(Math.sqrt(shot.dur / Math.max(1, duration)) * 1.6, 0, 1.4);
  const motionN = clamp(f.motion / 26, 0, 1);
  const detailN = clamp(f.detailMean / 0.22, 0, 1);
  const sharpN = clamp(f.sharpMax / 900, 0, 1);
  const speech = audio && audio.speech ? overlap(audio.speech, shot.t0, shot.t1) / Math.max(0.2, shot.dur) : 0;
  const events = audio && audio.events ? countIn(audio.events, shot.t0, shot.t1) : 0;
  const w = 0.30 + durN * 0.90
    + motionN * 0.45
    + detailN * 0.55
    + sharpN * 0.10
    + clamp(speech, 0, 1) * 0.35
    + clamp(events / 3, 0, 1) * 0.25;
  return {
    w,
    parts: { durN: +durN.toFixed(2), motionN: +motionN.toFixed(2), detailN: +detailN.toFixed(2), speech: +speech.toFixed(2), events },
  };
}

/* -------------------------------------------------------------- selection */

function medianOf(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Best frame inside [i0,i1] by sharpness/detail, biased away from the edges
 * and away from exposure spikes.
 *
 * Sharpness alone is a trap: a muzzle flash, a camera flash or a white frame in
 * a dissolve has enormous Laplacian energy, so the "sharpest" frame of a shot
 * is regularly the single worst frame to show. Frames whose brightness sits far
 * from the shot's own median are demoted, which keeps the pick inside the
 * picture the shot is actually about.
 */
export function bestFrameIndex(i0, i1, vectors) {
  const a = Math.max(0, i0);
  const b = Math.max(a, i1);
  const span = Math.max(1, b - a);
  const brights = [];
  for (let i = a; i <= b; i += 1) brights.push(vectors.bright[i] ?? 0);
  const medBright = medianOf(brights);
  const spread = medianOf(brights.map((v) => Math.abs(v - medBright))) * 1.4826;
  const exposureScale = Math.max(10, spread);
  let bestI = a;
  let bestV = -Infinity;
  for (let i = a; i <= b; i++) {
    const sharp = vectors.sharp[i] ?? 0;
    const detail = vectors.detail[i] ?? 0;
    const pos = (i - a) / span;
    const central = 1 - Math.abs(pos - 0.5) * 1.4;
    const dev = Math.abs((vectors.bright[i] ?? medBright) - medBright) / exposureScale;
    const exposure = dev > 1.8 ? -(dev - 1.8) * 0.62 : 0;
    const v = Math.log1p(sharp) * 0.55 + Math.log1p(detail * 100) * 0.30 + central * 0.45 + exposure;
    if (v > bestV) { bestV = v; bestI = i; }
  }
  return { i: bestI, score: bestV };
}

/** Mean absolute difference between two frames' 12x7 block signatures. */
export function pictureDistance(scan, i, j) {
  const blocks = scan.blocks;
  const stride = BW * BH;
  if (!blocks || blocks.length < (Math.max(i, j) + 1) * stride) return 255;
  let sad = 0;
  for (let k = 0; k < stride; k++) sad += Math.abs(blocks[i * stride + k] - blocks[j * stride + k]);
  return sad / stride;
}

/**
 * Threshold under which two frames count as "the same picture". Scaled by the
 * clip's own noise floor: a screen recording of a static slide has a floor near
 * 1 and must still dedupe, while grainy film with a floor near 10 should not.
 */
export function samePictureThreshold(scan) {
  const floor = scan && scan.stats ? scan.stats.median : 4;
  return clamp(4.5 + floor * 1.6, 4.5, 22);
}

/** Are two scan frames the same picture? */
export function samePicture(scan, i, j, maxSad = null) {
  const d = pictureDistance(scan, i, j);
  return d <= (maxSad ?? samePictureThreshold(scan));
}

function splitShot(shot, count, effFps) {
  if (count <= 1) return [{ t0: shot.t0, t1: shot.t1, i0: shot.i0, i1: shot.i1 }];
  const out = [];
  const len = shot.dur / count;
  for (let i = 0; i < count; i++) {
    const t0 = shot.t0 + len * i;
    const t1 = i === count - 1 ? shot.t1 : shot.t0 + len * (i + 1);
    out.push({
      t0, t1,
      i0: clamp(Math.round(t0 * effFps), shot.i0, shot.i1),
      i1: clamp(Math.round(t1 * effFps) - 1, shot.i0, shot.i1),
    });
  }
  return out;
}

/**
 * One more cell for `shot`, given the frames already on the sheet.
 *
 * The shot is re-split into (have + 1) equal spans and the most *novel* span
 * wins: a span whose best frame repeats something already chosen is not
 * eligible at all. That single rule is what stops a static talking head from
 * eating the pixel budget and pushes the freed cells toward shots that do have
 * new content.
 */
/**
 * Share of the frame that changed between two frames, measured on the 12x7
 * block grid.
 *
 * The global distance used everywhere else answers "how far apart are these two
 * pictures", which is the wrong question for board work: two frames of the same
 * slide differ by a few grey levels on average even though a whole formula was
 * added. Counting blocks that actually moved answers "is there anything new to
 * read here", and black bars are excluded so letterboxing cannot fake a change.
 */
export function pictureChangeFraction(scan, i, j) {
  const { blockCols: bw, blockRows: bh } = SCAN_DEFAULTS;
  const blocks = scan.blocks;
  if (!blocks) return 1;
  const a = i * bw * bh;
  const b = j * bw * bh;
  let active = 0;
  let moved = 0;
  for (let k = 0; k < bw * bh; k++) {
    const ya = blocks[a + k];
    const yb = blocks[b + k];
    if (ya < 12 && yb < 12) continue;
    active += 1;
    if (Math.abs(ya - yb) > 14) moved += 1;
  }
  return active ? moved / active : 0;
}

/**
 * Where a long cutless stretch actually changed, strongest first.
 *
 * Board work changes in one place at a time (a line written, a slide advanced),
 * so the useful moments are local peaks of the frame-to-frame score, not an
 * even split of the clock. Peaks closer together than `boardSpan` are dropped so
 * a burst of strokes does not eat the budget.
 */
function findBoardMoments(unit, scan) {
  const minGap = Math.round(LAYOUT_DEFAULTS.boardSpan * scan.effFps);
  const peaks = [];
  const floor = Math.max(1.6, (scan.stats?.threshold ?? 1.6) * 0.5);
  for (let i = unit.i0 + 1; i <= unit.i1; i++) {
    const s = scan.scores[i] ?? 0;
    if (s < floor) continue;
    if (s < (scan.scores[i - 1] ?? 0) || s < (scan.scores[i + 1] ?? 0)) continue;
    peaks.push({ i, score: s });
  }
  peaks.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const p of peaks) {
    if (kept.some((q) => Math.abs(q.i - p.i) < minGap)) continue;
    kept.push(p);
  }
  return kept.sort((a, b) => a.i - b.i);
}

/**
 * One more cell for a board stretch: the strongest change peak that is still
 * unused and that actually differs from what the sheet already shows.
 */
function boardCandidate(unit, scan, chosenIdx, moments, used) {
  const effFps = scan.effFps;
  let best = null;
  for (const m of moments) {
    if (used.has(m.i)) continue;
    // a fifth of a second after the peak, so the new line is complete
    const at = Math.min(unit.i1, m.i + Math.round(effFps * 0.2));
    let change = 1;
    if (chosenIdx.length) {
      change = 0;
      for (const ci of chosenIdx) change = Math.max(change, pictureChangeFraction(scan, ci, at));
    }
    if (change < LAYOUT_DEFAULTS.boardMinChange) continue;
    if (!best || m.score > best.score) {
      best = { score: m.score, at, novelty: +(change * 100).toFixed(1), moment: m };
    }
  }
  if (!best) return null;
  used.add(best.moment.i);
  return { pick: { i: best.at, score: best.score }, novelty: best.novelty, at: best.at };
}

function nextCandidate(shot, have, scan, chosenIdx, maxSad) {
  const parts = splitShot(shot, have + 1, scan.effFps);
  let best = null;
  for (const p of parts) {
    const pick = bestFrameIndex(p.i0, p.i1, scan.vectors);
    let novelty = 255;
    for (const ci of chosenIdx) {
      const d = pictureDistance(scan, ci, pick.i);
      if (d < novelty) novelty = d;
    }
    if (novelty <= maxSad) continue;
    const v = novelty * 0.55 + pick.score * 5;
    if (!best || v > best.v) best = { v, pick, part: p, novelty: +novelty.toFixed(2) };
  }
  return best;
}

/**
 * Choose cells.
 *
 * Greedy on purpose. Every additional cell has to *earn* its slot against the
 * pixels already on the sheet, so the answer to "this shot is static" is
 * "spend the budget elsewhere", not "draw the same frame three times".
 *
 * @param {object} opts
 * @param {object} opts.scan     result of scanShots()
 * @param {object} [opts.audio]  { speech:[{t,dur}], events:[{t,kind}] }
 * @param {number} [opts.maxCells]
 * @param {string} [opts.detail] low|auto|high|ultra
 * @param {boolean} [opts.dedupe]
 */
/** Two adjacent groups become one wider group; the union is the whole span. */
function mergeUnits(a, b) {
  const feats = {};
  for (const key of Object.keys(a.feats)) feats[key] = Math.max(a.feats[key] ?? 0, b.feats[key] ?? 0);
  return {
    i0: a.i0,
    i1: b.i1,
    t0: a.t0,
    t1: b.t1,
    dur: +(b.t1 - a.t0).toFixed(3),
    kind: a.kind,
    weight: a.weight + b.weight,
    feats,
    members: [...a.members, ...b.members],
  };
}

/**
 * When shots outnumber the cell budget, merge neighbours until they fit.
 * Boundaries land where the weight runs out, so the long or eventful part of
 * the clip keeps its share of the sheet instead of every shot shrinking below
 * the size at which anything in it is recognisable.
 */
function mergeToBudget(units, budget) {
  const total = units.reduce((a, u) => a + u.weight, 0) || 1;
  const target = total / budget;
  const out = [];
  let cur = null;
  let acc = 0;
  for (let k = 0; k < units.length; k++) {
    if (!cur) {
      cur = { ...units[k], members: [...units[k].members] };
      acc = units[k].weight;
    } else {
      cur = mergeUnits(cur, units[k]);
      acc += units[k].weight;
    }
    const remaining = units.length - k;        // including this one
    const slotsLeft = budget - out.length;     // cells still to emit
    if (remaining <= slotsLeft || acc >= target) {
      out.push(cur);
      cur = null;
      acc = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function planCells(opts) {
  const { scan, audio = null, detail = 'auto', dedupe = true } = opts;
  const preset = DETAIL_PRESETS[detail] ?? DETAIL_PRESETS.auto;
  // The ceiling on cell count is the one legibility imposes, not a fixed number:
  // a shot that is never sampled is a shot nobody can ask about. Merging only
  // starts when the pixels genuinely cannot keep every shot above the width at
  // which its contents are still recognisable.
  const legible = maxCellsByPixels(preset, opts.aspect);
  const asked = Number.isFinite(opts.maxCells) ? opts.maxCells : preset.maxCells;
  const budget = clamp(
    Math.min(asked, preset.maxCells, legible),
    LAYOUT_DEFAULTS.minCells, 64,
  );
  const maxSad = samePictureThreshold(scan);

  const shots = buildShots(scan);
  const duration = scan.duration ?? (shots.length ? shots[shots.length - 1].t1 : 0);
  const feats = shots.map((s) => shotFeatures(s, scan));
  const weights = shots.map((s, k) => shotWeight(s, feats[k], audio, duration));

  // A unit is what a cell represents: usually one shot, and one merged group
  // of shots when the cut rate outruns the budget.
  let units = shots.map((s, k) => ({
    i0: s.i0, i1: s.i1, t0: s.t0, t1: s.t1, dur: s.dur, kind: s.kind,
    weight: weights[k].w, feats: feats[k], members: [k],
  }));
  let mergedGroups = 0;
  if (units.length > budget) {
    units = mergeToBudget(units, budget);
    mergedGroups = units.filter((u) => u.members.length > 1).length;
  }
  const unitOfShot = new Map();
  units.forEach((u, ui) => { for (const m of u.members) unitOfShot.set(m, ui); });

  let eligible = units.map((u, k) => k).filter((k) => units[k].dur >= LAYOUT_DEFAULTS.minShotForCell);
  if (eligible.length === 0) eligible = units.map((u, k) => k);

  // ---- 1. floor: the single most representative frame of every eligible unit
  const chosen = [];
  const chosenIdx = [];
  const perUnit = new Map();
  const perShot = new Map();
  const add = (k, part, pick, novelty) => {
    chosen.push({
      unitIndex: k, t0: part.t0, t1: part.t1,
      frameIndex: pick.i, frameT: +((scan.start ?? 0) + (pick.i + 0.5) / scan.effFps).toFixed(3),
      pickScore: +pick.score.toFixed(3), novelty,
    });
    chosenIdx.push(pick.i);
    perUnit.set(k, (perUnit.get(k) ?? 0) + 1);
    for (const m of units[k].members) perShot.set(m, (perShot.get(m) ?? 0) + 1);
  };
  for (const k of eligible) {
    const pick = bestFrameIndex(units[k].i0, units[k].i1, scan.vectors);
    add(k, { t0: units[k].t0, t1: units[k].t1 }, pick, null);
  }

  // ---- 2. spill: hand out the remaining budget to whoever has NEW content
  // A cell beyond the first one in a shot costs the same tokens as any other,
  // so it has to show a picture the sheet does not already show. Two gates:
  // the shot must be long enough for that to be possible, and the candidate
  // must be clearly unlike every frame already chosen (2.5x the "same picture"
  // distance, not just above it).
  // With a single shot there is no other shot to spend the budget on, so the
  // bar drops to "a different picture" and the cells spread over time.
  const spillMax = !dedupe ? -1
    : units.length === 1 ? maxSad
      : Math.max(maxSad * LAYOUT_DEFAULTS.spillNoveltyK, maxSad + 6);
  const capForUnit = (u) => {
    const byTime = 1 + Math.floor(u.dur / LAYOUT_DEFAULTS.longShotSpan);
    if (u.dur >= LAYOUT_DEFAULTS.boardMinSeconds) {
      return Math.max(1, Math.min(LAYOUT_DEFAULTS.maxCellsSingleShot,
        1 + Math.floor(u.dur / LAYOUT_DEFAULTS.boardSpan)));
    }
    if (units.length === 1) {
      // One shot for the whole window is not the same thing as one picture for
      // the whole window: a talking head earns one cell, a board keeps changing.
      return Math.max(1, Math.min(4, byTime));
    }
    return Math.min(LAYOUT_DEFAULTS.maxCellsPerUnit, byTime);
  };
  const isBoard = (u) => u.dur >= LAYOUT_DEFAULTS.boardMinSeconds;
  const boardMoments = new Map();
  const boardUsed = new Map();
  for (const k of eligible) {
    if (!isBoard(units[k])) continue;
    boardMoments.set(k, findBoardMoments(units[k], scan));
    boardUsed.set(k, new Set());
  }
  while (chosen.length < budget) {
    let best = null;
    for (const k of eligible) {
      if ((perUnit.get(k) ?? 0) >= capForUnit(units[k])) continue;
      let cand = null;
      if (isBoard(units[k])) {
        cand = boardCandidate(units[k], scan, chosenIdx, boardMoments.get(k), boardUsed.get(k));
        if (cand) cand.part = { t0: units[k].t0, t1: units[k].t1 };
      } else {
        cand = nextCandidate(units[k], perUnit.get(k) ?? 0, scan, chosenIdx, spillMax);
      }
      if (!cand) continue;
      const score = units[k].weight * (0.55 + Math.min(cand.novelty, 80) / 80);
      if (!best || score > best.score) best = { score, k, cand };
    }
    if (!best) break;
    add(best.k, best.cand.part, best.cand.pick, best.cand.novelty);
    if (isBoard(units[best.k]) && best.cand.at != null) {
      chosen[chosen.length - 1].boardAt = best.cand.at;
    }
  }

  // Board cells are placed at change moments, so their spans are not known when
  // they are picked: each one represents the stretch between its neighbours.
  // Rebuild those spans here, in time order, so the manifest keeps saying which
  // part of the lecture each picture stands for.
  for (const [k, used] of boardUsed) {
    if (!used.size) continue;
    const unit = units[k];
    const mine = chosen
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => c.unitIndex === k)
      .sort((a, b) => a.c.frameIndex - b.c.frameIndex);
    if (!mine.length) continue;
    const cuts = mine.map(({ c }) => c.frameIndex / scan.effFps);
    mine.forEach(({ c }, n) => {
      const left = n === 0 ? unit.t0 : (cuts[n - 1] + cuts[n]) / 2;
      const right = n === mine.length - 1 ? unit.t1 : (cuts[n] + cuts[n + 1]) / 2;
      c.t0 = +left.toFixed(3);
      c.t1 = +right.toFixed(3);
    });
  }

  chosen.sort((a, b) => a.t0 - b.t0);

  // ---- 3. assemble cells
  const cells = chosen.map((c, i) => {
    const u = units[c.unitIndex];
    return {
      index: i + 1,
      shotIndex: u.members[0],
      shots: u.members.length,
      t0: +c.t0.toFixed(3),
      t1: +c.t1.toFixed(3),
      frameT: c.frameT,
      frameIndex: c.frameIndex,
      pickScore: c.pickScore,
      novelty: c.novelty,
      kind: u.kind,
      weight: +u.weight.toFixed(3),
      dupOf: null,
    };
  });

  // ---- 4. which units repeat a picture that is already on the sheet?
  for (let k = 0; k < units.length; k++) {
    if (cells.some((c) => c.shotIndex === units[k].members[0])) continue;
    const pick = bestFrameIndex(units[k].i0, units[k].i1, scan.vectors);
    let nearest = null;
    let dist = Infinity;
    for (const c of cells) {
      const d = pictureDistance(scan, c.frameIndex, pick.i);
      if (d < dist) { dist = d; nearest = c; }
    }
    if (nearest && dist <= maxSad) for (const m of units[k].members) shots[m].sameAsCell = nearest.index;
  }

  return {
    cells,
    shots: shots.map((s, k) => ({
      ...s, ...feats[k], weight: +weights[k].w.toFixed(3), cells: perShot.get(k) ?? 0,
    })),
    deduped: shots.filter((s) => s.sameAsCell).length,
    mergedGroups,
    duration,
    budget,
    pixelBudget: sheetPixelsFor(chosen.length, detail),
    budgetUsed: chosen.length,
  };
}

/* ------------------------------------------------------------------ grid */

/**
 * Human-readable cell geometry checks — used by the tool to report quality.
 * `srcH` is the source video height, so the numbers describe how much of a
 * real subtitle survives the downscale.
 */
export function cellReadability(cellW, cellH, srcH = 1080) {
  const scale = cellH / Math.max(1, srcH);
  const subtitlePx = 46 * scale;
  const smallTextPx = 24 * scale;
  return {
    subtitlePx: +subtitlePx.toFixed(1),
    smallTextPx: +smallTextPx.toFixed(1),
    legible: subtitlePx >= 7.5,
    comfortable: subtitlePx >= 10,
  };
}

/**
 * Grid geometry for `n` cells of `aspect`, inside a pixel budget.
 * Cells are packed with a hairline separator; every pixel over the budget is
 * traded for legibility, because a contact sheet that cannot be read is worse
 * than a smaller one that can.
 */
export function planGrid(n, aspect, opts = {}) {
  const { pixels = sheetPixelsFor(6, 'auto'), maxSide = LAYOUT_DEFAULTS.maxSheetSide, gutter = LAYOUT_DEFAULTS.gutter } = opts;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const count = Math.max(1, Math.round(n));
  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    // solve cellW for: (cols*cellW + gutters) * (rows*cellW/a + gutters) <= pixels
    const gw = gutter * (cols + 1);
    const gh = gutter * (rows + 1);
    const A = cols;
    const B = rows / a;
    // (A*w + gw)(B*w + gh) = pixels
    const qa = A * B;
    const qb = A * gh + B * gw;
    const qc = gw * gh - pixels;
    const w = (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
    const h = w / a;
    if (!(w > 0) || !(h > 0)) continue;
    const sheetW = Math.round(cols * w + gw);
    const sheetH = Math.round(rows * h + gh);
    if (sheetW > maxSide || sheetH > maxSide) continue;
    // prefer squarish sheets (better for both tiling and reading order)
    const squareness = Math.min(sheetW, sheetH) / Math.max(sheetW, sheetH);
    const eff = (rows * cols) / count; // wasted padding cells
    const score = Math.min(w, h) * 0.001 + squareness * 90 - (eff - 1) * 40;
    if (!best || score > best.score) {
      best = { cols, rows, cellW: Math.floor(w), cellH: Math.floor(h), sheetW, sheetH, score };
    }
  }
  if (!best) {
    const cellW = Math.floor(Math.sqrt(pixels * a / count));
    best = { cols: count, rows: 1, cellW, cellH: Math.floor(cellW / a), sheetW: cellW * count, sheetH: Math.floor(cellW / a), score: 0 };
  }
  return {
    cols: best.cols,
    rows: best.rows,
    cellW: best.cellW,
    cellH: best.cellH,
    width: best.sheetW,
    height: best.sheetH,
    count,
    padding: best.cols * best.rows - count,
  };
}


/* -------------------------------------------------------------- planning */

/** Rough vision-token cost of an image, mirroring the host's accounting. */
export function visionTokensFor(pixels) {
  // tokens ~= pixels / (42*42); the grid formula only adds a row of overhead.
  const side = Math.sqrt(Math.max(1, pixels));
  const gw = Math.max(1, Math.round(side * Math.sqrt(16 / 9) / 42));
  const gh = Math.max(1, Math.round(side * Math.sqrt(9 / 16) / 42));
  const tokens = gh * (gw + 1) + 2;
  return Math.min(VISION_TOKEN_CAP, Math.max(184, tokens));
}

/**
 * Reading plan for a film the model has not looked at yet.
 *
 * The interesting decision is not "how many cells" but "how long a window can
 * one sheet cover before the cells stop being readable". A 12-cell sheet over
 * a 2-hour film puts 10 minutes in each cell, and the model will narrate the
 * film as if it were ten minutes long. So past ~10 minutes we say so, and
 * suggest consecutive windows instead of lying with one sheet.
 */
export function suggestDetail({ duration = 0, aspect = 16 / 9, hasAudio = false, hasSubtitle = false } = {}) {
  // A cell is worth about 6 s of ordinary footage; a 3 s clip does not need
  // twenty cells, and a 10 min film needs windows rather than a taller grid.
  const spanPerCell = 6;
  const wanted = Math.ceil(Math.max(1, duration) / spanPerCell);
  const cells = Math.max(3, Math.min(DETAIL_PRESETS.auto.maxCells, wanted));
  const pixels = sheetPixelsFor(cells, 'auto');
  const tokens = visionTokensFor(pixels);
  const windows = Math.max(1, Math.ceil(duration / (DETAIL_PRESETS.auto.maxCells * 45)));
  const notes = [];
  if (duration > 600) {
    notes.push(`${Math.round(duration / 60)} min is longer than one sheet can honestly cover — call video_storyboard per window (start/end), about ${Math.ceil(duration / windows)} s each.`);
  }
  if (hasSubtitle) notes.push('a subtitle track exists, so dialogue will be quoted in the cell index for free.');
  else if (hasAudio) notes.push('no subtitle track: audio is summarised (speech/loudness/onsets) but not transcribed.');
  const ar = Number(aspect) || 16 / 9;
  if (ar < 1) notes.push('portrait video: cells are tall, so expect fewer per row.');
  if (ar < 1.2 || ar > 2.2) notes.push(`unusual aspect ${ar.toFixed(2)}: the sheet will letterbox rather than crop.`);

  return {
    detail: 'auto',
    cells,
    pixels,
    tokens,
    windows,
    perWindow: Math.ceil(duration / windows),
    note: notes.join(' '),
  };
}
