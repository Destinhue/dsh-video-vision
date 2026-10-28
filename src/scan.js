/**
 * scan.js — one decode pass over the video, then everything is decided offline.
 *
 * The pass decodes at ~96x54 raw RGB and, per frame, keeps:
 *   - block-mean luma signatures (cut detection + "are these two cells the
 *     same picture?" dedupe),
 *   - sharpness / edge density / brightness / chroma scalars, so the
 *     representative frame of a cell can be chosen *without a second decode*.
 *
 * Cut detection avoids the two classic failure modes of frame differencing:
 *   1. a **global** threshold either misses cuts in calm footage or fires
 *      everywhere inside a montage, so the threshold comes from a robust
 *      estimate (median + k·MAD) and is then rate-capped by duration;
 *   2. camera motion produces a high difference for many consecutive frames,
 *      so candidates are re-scored after a small global-shift search — only
 *      candidates, which keeps the pass cheap.
 *
 * A hard cut between two equally bright, differently tinted shots is invisible
 * to luma-only differencing, so the difference is computed in (Y, Cr, Cb).
 */

import { spawnStream } from './media.js';

export const SCAN_DEFAULTS = {
  maxWidth: 96,
  maxHeight: 54,
  stride: 2,
  blockCols: 12,
  blockRows: 7,
  maxFrames: 48_000,
  capacity: 60_000,
  wPixel: 0.34,
  wChroma: 0.20,
  wBlock: 0.46,
  madK: 7,
  // The floor exists to reject compression noise, not to encode an opinion
  // about what a scene change looks like. A hard-coded 8 assumes every video
  // is as busy as a film; on a slide deck or a screen recording the *real*
  // cuts score 6-7 and the noise scores 0.02, so an absolute floor silently
  // drops half of them. Keep the floor low and let the distribution decide.
  floor: 1.6,
  p99K: 0.22,
  motionRatio: 0.6,
  motionPenalty: 0.25,
  minGap: 0.35,
  fadeWindow: 1.2,
  fadeMinDelta: 24,
  // A dissolve / blur transition never produces one big jump: it produces a
  // plateau of medium ones. Detect the plateau, not the jump.
  softWindow: 0.9,
  softCum: 26,
  softCumRatio: 2.6,
  softEndpoint: 2.6,
  softSettle: 0.55,
  // A cut has to move a lot of the picture, not a patch of it: a caption
  // appearing, a cursor blinking or a raised hand are local changes, and
  // cutting the shot there would spend cells on one continuous scene.
  blockFrac: 0.28,
  blockDelta: 14,
  blockFracEscape: 3.5,
  // A flash is a cut that undoes itself: the frame before and a few frames
  // after are the same picture again.
  flashWindow: 3,
  flashKeep: 0.35,
  // An overlay (caption, banner, logo, HUD) changes one region and leaves the
  // rest of the picture pixel-identical. A cut leaves almost nothing identical.
  sameDist: 6,
  sameFrac: 0.85,
  activeLuma: 12,
  // A light going on/off moves every block by a similar amount and leaves the
  // colours alone; that is a lighting event, not a new shot.
  lightChromaSame: 0.88,
  lightUniform: 0.45,
  lightMinDelta: 9,
  // Anything weaker than this is noise, not an event worth reporting.
  eventMinFrac: 0.10,
  // A scene change moves the whole picture. A third of it is the practical
  // floor: below that it is an object, an overlay or a bar sliding around.
  cutMinFrac: 0.35,
  // A very strong jump is believed even when it moves less of the frame —
  // slideshows change the text block and leave the card chrome alone.
  cutEscape: 4,
  cutEscapeFrac: 0.20,
};

const even = (v, min) => Math.max(min, Math.round(v / 2) * 2);

export function scanRaster(aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const { maxWidth, maxHeight } = SCAN_DEFAULTS;
  if (a >= maxWidth / maxHeight) return { width: maxWidth, height: even(maxWidth / a, 16) };
  return { width: even(maxHeight * a, 16), height: maxHeight };
}

export function emptyVectors(n) {
  return {
    sharp: new Float32Array(n),
    edge: new Float32Array(n),
    bright: new Float32Array(n),
    detail: new Float32Array(n),
    sat: new Float32Array(n),
  };
}

/**
 * The analysis pass.
 *
 * @param {object} opts
 * @param {string} opts.input
 * @param {string} opts.ffmpegPath
 * @param {number} [opts.fps] source fps (drives the step factor)
 * @param {number} [opts.start]
 * @param {number} [opts.end]
 * @param {number} [opts.duration]
 * @param {number} [opts.aspect]
 * @param {boolean} [opts.fullRate] ignore the frame cap (zoom windows)
 */
export async function scanShots(opts) {
  const {
    input, ffmpegPath, fps = 25, start = 0, aspect, signal, onProgress, fullRate = false,
  } = opts;
  // `duration` is a length and `end` is an absolute time; both are accepted,
  // and passing a length used to be read as an end (a 5 s window at 4 s became
  // 1 s of video).
  const duration = Math.max(0.2, opts.duration != null
    ? Number(opts.duration)
    : (Number(opts.end ?? 0) - start));
  const srcFps = Math.max(1, fps);
  const totalFrames = Math.max(1, Math.round(duration * srcFps));
  const cap = fullRate ? Number.POSITIVE_INFINITY : SCAN_DEFAULTS.maxFrames;
  const step = Math.max(1, Math.ceil(totalFrames / cap));
  const effFps = Math.max(1, srcFps / step);
  const { width, height } = scanRaster(aspect ?? 16 / 9);

  const args = ['-hide_banner', '-nostdin', '-v', 'error'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', input, '-t', duration.toFixed(3));
  args.push('-an', '-sn', '-dn');
  // Interlaced sources are combed: the two fields hold different moments, so a
  // block grid sees them alternate. Deinterlacing costs almost nothing at this
  // size and removes a whole class of phantom cuts.
  const chain = [];
  if (opts.deinterlace) chain.push('bwdif=mode=send_frame:deint=all');
  chain.push(`fps=${effFps.toFixed(5)}`);
  chain.push(`scale=${width}:${height}:flags=fast_bilinear`);
  chain.push('format=rgb24');
  args.push('-vf', chain.join(','));
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');

  const frameBytes = width * height * 3;
  const analyzer = makeAnalyzer({ width, height, capacity: SCAN_DEFAULTS.capacity });
  let tail = Buffer.alloc(0);
  let n = 0;

  const result = await spawnStream(ffmpegPath, args, (chunk) => {
    let buf = chunk;
    if (tail.length) { buf = Buffer.concat([tail, chunk]); tail = Buffer.alloc(0); }
    let off = 0;
    while (off + frameBytes <= buf.length) {
      analyzer.push(buf.subarray(off, off + frameBytes));
      off += frameBytes;
      n += 1;
      if (onProgress && n % 500 === 0) onProgress({ frames: n, t: start + n / effFps });
    }
    if (off < buf.length) tail = Buffer.from(buf.subarray(off));
  }, { signal });

  const base = {
    width, height, fps: srcFps, effFps, step, start, duration, frames: n,
    code: result.code, stderr: result.stderr.toString('utf8').slice(-400),
  };
  if (n === 0) {
    return {
      ...base, scores: new Float32Array(0), pairParts: null, cuts: [],
      vectors: emptyVectors(0), blocks: new Uint8Array(0), chromaBlocks: new Int8Array(0), stats: null,
      summary: { frames: 0, shots: 0, medianShot: 0, cuts: 0 }, degraded: 'empty', motion: null,
      overlays: [], lights: [],
    };
  }

  const analyzed = analyzer.finalize(n);
  const pairs = scorePairs(analyzed, width, height);
  const stats = robustStats(pairs.score);
  const { cuts, motion, overlays, lights } = pickCuts({
    score: pairs.score, blocks: analyzed.blocks, chromaBlocks: analyzed.chromaBlocks,
    stats, effFps, start, frames: n,
  });

  return {
    ...base,
    scores: pairs.score,
    pairParts: { dY: pairs.dY, dC: pairs.dC, dBlock: pairs.dBlock },
    vectors: analyzed.vectors,
    blocks: analyzed.blocks,
    chromaBlocks: analyzed.chromaBlocks,
    stats,
    cuts,
    overlays,
    lights,
    summary: summarizeShots(cuts, duration, effFps),
    degraded: assessDegraded({ duration, cuts, vectors: analyzed.vectors, cutCount: cuts.length }),
    motion,
  };
}

/* -------------------------------------------------------------- analyzer */

function makeAnalyzer({ width, height, capacity }) {
  const pixels = width * height;
  const { blockCols: bw, blockRows: bh, stride } = SCAN_DEFAULTS;
  const bwPx = Math.max(1, Math.floor(width / bw));
  const bhPx = Math.max(1, Math.floor(height / bh));

  let prevY = new Uint8Array(pixels);
  let curY = new Uint8Array(pixels);
  let prevC = new Int16Array(pixels * 2);
  let curC = new Int16Array(pixels * 2);
  let prevBlocks = new Uint8Array(bw * bh);
  let curBlocks = new Uint8Array(bw * bh);
  let prevCB = new Int8Array(bw * bh * 2);
  let curCB = new Int8Array(bw * bh * 2);

  const blocksBuf = new Uint8Array(capacity * bw * bh);
  const chromaBuf = new Int8Array(capacity * bw * bh * 2);
  const clampi8 = (v) => (v < -128 ? -128 : v > 127 ? 127 : Math.round(v));
  const vectors = emptyVectors(capacity);
  const dY = new Float32Array(capacity);
  const dC = new Float32Array(capacity);
  const dBlock = new Float32Array(capacity);
  let n = 0;

  function push(frame) {
    for (let p = 0, i = 0; p < pixels; p++, i += 3) {
      const r = frame[i], g = frame[i + 1], b = frame[i + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      curY[p] = y;
      curC[p * 2] = r - y;
      curC[p * 2 + 1] = b - y;
    }
    for (let by = 0; by < bh; by++) {
      const y0 = by * bhPx;
      const y1 = Math.min(height, y0 + bhPx);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * bwPx;
        const x1 = Math.min(width, x0 + bwPx);
        let sum = 0, sumU = 0, sumV = 0, count = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) {
            const p = row + x;
            sum += curY[p];
            sumU += curC[p * 2];
            sumV += curC[p * 2 + 1];
            count += 1;
          }
        }
        const slot = by * bw + bx;
        if (count) {
          curBlocks[slot] = Math.round(sum / count);
          curCB[slot * 2] = clampi8(sumU / count);
          curCB[slot * 2 + 1] = clampi8(sumV / count);
        } else {
          curBlocks[slot] = 0;
          curCB[slot * 2] = 0;
          curCB[slot * 2 + 1] = 0;
        }
      }
    }
    let lapSum = 0, lapSq = 0, lapN = 0, strong = 0, gradSum = 0, gradN = 0;
    let brightness = 0, satSum = 0, sampled = 0;
    for (let y = 1; y < height - 1; y += stride) {
      const row = y * width;
      for (let x = 1; x < width - 1; x += stride) {
        const p = row + x;
        const c = curY[p];
        const lap = 4 * c - curY[p - 1] - curY[p + 1] - curY[p - width] - curY[p + width];
        lapSum += lap; lapSq += lap * lap; lapN += 1;
        if (lap > 18 || lap < -18) strong += 1;
        gradSum += Math.abs(curY[p + 1] - curY[p - 1]) + Math.abs(curY[p + width] - curY[p - width]);
        gradN += 1;
        brightness += c;
        satSum += Math.abs(curC[p * 2]) + Math.abs(curC[p * 2 + 1]);
        sampled += 1;
      }
    }
    const mean = lapN ? lapSum / lapN : 0;
    vectors.sharp[n] = lapN ? Math.max(0, lapSq / lapN - mean * mean) : 0;
    vectors.edge[n] = gradN ? gradSum / gradN : 0;
    vectors.bright[n] = sampled ? brightness / sampled : 0;
    vectors.detail[n] = lapN ? strong / lapN : 0;
    vectors.sat[n] = sampled ? satSum / sampled / 2 : 0;
    blocksBuf.set(curBlocks, n * bw * bh);
    chromaBuf.set(curCB, n * bw * bh * 2);

    if (n > 0) {
      let sY = 0, sC = 0, cnt = 0;
      for (let y = 0; y < height; y += stride) {
        const row = y * width;
        for (let x = 0; x < width; x += stride) {
          const p = row + x;
          sY += Math.abs(curY[p] - prevY[p]);
          sC += Math.abs(curC[p * 2] - prevC[p * 2]) + Math.abs(curC[p * 2 + 1] - prevC[p * 2 + 1]);
          cnt += 1;
        }
      }
      let sB = 0;
      for (let k = 0; k < bw * bh; k++) sB += Math.abs(curBlocks[k] - prevBlocks[k]);
      const idx = n - 1;
      dY[idx] = cnt ? sY / cnt : 0;
      dC[idx] = cnt ? sC / cnt / 2 : 0;
      dBlock[idx] = sB / (bw * bh);
    }

    const t = prevY; prevY = curY; curY = t;
    const tc = prevC; prevC = curC; curC = tc;
    const tb = prevBlocks; prevBlocks = curBlocks; curBlocks = tb;
    const tcb = prevCB; prevCB = curCB; curCB = tcb;
    n += 1;
  }

  function finalize(count) {
    return {
      vectors: {
        sharp: vectors.sharp.subarray(0, count),
        edge: vectors.edge.subarray(0, count),
        bright: vectors.bright.subarray(0, count),
        detail: vectors.detail.subarray(0, count),
        sat: vectors.sat.subarray(0, count),
      },
      blocks: blocksBuf.subarray(0, count * bw * bh),
      chromaBlocks: chromaBuf.subarray(0, count * bw * bh * 2),
      dY: dY.subarray(0, Math.max(0, count - 1)),
      dC: dC.subarray(0, Math.max(0, count - 1)),
      dBlock: dBlock.subarray(0, Math.max(0, count - 1)),
    };
  }

  return { push, finalize };
}

/* ------------------------------------------------------------------ score */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function scorePairs({ dY, dC, dBlock }, width, height) {
  const { wPixel, wChroma, wBlock } = SCAN_DEFAULTS;
  const n = dY.length;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Normalise each term to 0..1 against a "big change" reference, then mix.
    // The references are in 8-bit units and were tuned on the bench corpus.
    const cy = clamp01(dY[i] / 90);
    const cc = clamp01(dC[i] / 70);
    const cb = clamp01(dBlock[i] / 100);
    score[i] = (wPixel * cy + wChroma * cc + wBlock * cb) * 100;
  }
  void width; void height;
  return { score, dY, dC, dBlock };
}

export function robustStats(scores) {
  const n = scores.length;
  if (n === 0) return { median: 0, mad: 0, p90: 0, p99: 0, threshold: SCAN_DEFAULTS.floor };
  const sorted = Float32Array.from(scores).sort();
  const median = sorted[n >> 1];
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(scores[i] - median);
  dev.sort();
  const mad = dev[n >> 1];
  const p = (q) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const p99 = p(0.99);
  // Three independent reasons to raise the bar: a hard floor for quantisation
  // noise, the noise band of *this* footage (median + k*MAD), and the top of
  // this clip's own distribution (so a film with a hundred medium jumps does
  // not call every one of them a cut).
  const threshold = Math.max(
    SCAN_DEFAULTS.floor,
    median + SCAN_DEFAULTS.madK * mad,
    p99 * SCAN_DEFAULTS.p99K,
  );
  return { median, mad, p90: p(0.9), p99, threshold };
}

/* ------------------------------------------------------------------- cuts */

function blockSad(a, b, offsetA, offsetB, bw, bh, dx, dy) {
  let sum = 0, count = 0;
  for (let y = 0; y < bh; y++) {
    const yy = y + dy;
    if (yy < 0 || yy >= bh) continue;
    for (let x = 0; x < bw; x++) {
      const xx = x + dx;
      if (xx < 0 || xx >= bw) continue;
      sum += Math.abs(a[offsetA + y * bw + x] - b[offsetB + yy * bw + xx]);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Compare two frames block by block.
 * `sameFrac`  share of the *lit* picture that did not change at all — an
 *             overlay leaves most of it identical, a cut leaves almost none.
 * `chromaSameFrac` the same question asked of colour only, which is how a
 *             lighting change is told apart from a change of subject.
 * `dyMean`/`dyStd` how much luma moved and how evenly.
 */
export function blockStats(yb, cb, ia, ib, bw, bh) {
  const total = bw * bh;
  const { sameDist, activeLuma } = SCAN_DEFAULTS;
  let same = 0, active = 0, changed = 0, chromaSame = 0;
  let sumDy = 0, sumDy2 = 0;
  for (let b = 0; b < total; b++) {
    const ya = yb[ia + b], yc = yb[ib + b];
    const dy = ya > yc ? ya - yc : yc - ya;
    const du = Math.abs(cb[(ia + b) * 2] - cb[(ib + b) * 2]);
    const dv = Math.abs(cb[(ia + b) * 2 + 1] - cb[(ib + b) * 2 + 1]);
    const dist = dy + 0.6 * (du + dv);
    if (dist > SCAN_DEFAULTS.blockDelta) changed += 1;
    if (ya > activeLuma || yc > activeLuma) {
      active += 1;
      if (dist <= sameDist) same += 1;
      if (du + dv <= 5) chromaSame += 1;
      sumDy += dy; sumDy2 += dy * dy;
    }
  }
  const mean = active ? sumDy / active : 0;
  const variance = active ? Math.max(0, sumDy2 / active - mean * mean) : 0;
  return {
    active,
    sameFrac: active ? same / active : 0,
    changedFrac: changed / total,
    chromaSameFrac: active ? chromaSame / active : 1,
    dyMean: mean,
    dyStd: Math.sqrt(variance),
  };
}

/** Decide what a jump between frame i and i+1 actually is. */
export function classifyJump(blocks, chromaBlocks, i, bw, bh) {
  const total = bw * bh;
  const a = Math.max(0, i - 1) * total;
  const b = Math.min(Math.floor(blocks.length / total) - 1, i + 1) * total;
  const st = blockStats(blocks, chromaBlocks, a, b, bw, bh);
  const d = SCAN_DEFAULTS;
  if (st.active < 8) return { kind: 'cut', stat: st };          // too dark to judge
  if (st.sameFrac >= d.sameFrac) return { kind: 'overlay', stat: st };
  if (st.changedFrac < d.eventMinFrac) return { kind: 'noise', stat: st };
  if (st.changedFrac < d.cutMinFrac) return { kind: 'partial', stat: st };
  const even = st.dyMean > 0 ? st.dyStd / st.dyMean : 1;
  if (st.chromaSameFrac >= d.lightChromaSame && even <= d.lightUniform && st.dyMean >= d.lightMinDelta) {
    return { kind: 'light', stat: st };
  }
  return { kind: 'cut', stat: st };
}

function pickCuts({ score, blocks, chromaBlocks, stats, effFps, start, frames }) {
  const n = score.length;
  const { blockCols: bw, blockRows: bh, motionRatio, motionPenalty, minGap, fadeWindow, fadeMinDelta } = SCAN_DEFAULTS;
  const motion = new Uint8Array(n);
  if (n === 0) return { cuts: [], motion, overlays: [], lights: [] };

  const thr = stats.threshold;
  // ---- 1. motion compensation on candidates only
  const adjusted = Float32Array.from(score);
  for (let i = 0; i < n; i++) {
    if (score[i] <= thr * 0.55) continue;
    const aOff = i * bw * bh;
    const bOff = (i + 1) * bw * bh;
    const base = blockSad(blocks, blocks, aOff, bOff, bw, bh, 0, 0);
    if (base <= 0) continue;
    let best = base, bestDx = 0, bestDy = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const v = blockSad(blocks, blocks, aOff, bOff, bw, bh, dx, dy);
        if (v < best) { best = v; bestDx = dx; bestDy = dy; }
      }
    }
    if ((bestDx || bestDy) && best < base * motionRatio) {
      adjusted[i] = score[i] * motionPenalty;
      motion[i] = 1;
    }
  }

  // ---- 2. local maxima above threshold
  const candidates = [];
  const overlays = [];
  const lights = [];
  for (let i = 0; i < n; i++) {
    if (adjusted[i] <= thr) continue;
    const left = i > 0 ? adjusted[i - 1] : -1;
    const right = i < n - 1 ? adjusted[i + 1] : -1;
    if (adjusted[i] < left || adjusted[i] <= right) continue;
    const verdict = classifyJump(blocks, chromaBlocks, i, bw, bh);
    const t = start + (i + 1) / effFps;
    if (verdict.kind === 'overlay') {
      if (verdict.stat.changedFrac >= SCAN_DEFAULTS.eventMinFrac) {
        overlays.push({ i, t, score: adjusted[i], sameFrac: verdict.stat.sameFrac, changedFrac: verdict.stat.changedFrac });
      }
      continue;
    }
    if (verdict.kind === 'light') { lights.push({ i, t, score: adjusted[i], dyMean: verdict.stat.dyMean }); continue; }
    if (verdict.kind === 'noise') continue;
    if (verdict.kind === 'partial') {
      const strong = adjusted[i] >= thr * SCAN_DEFAULTS.cutEscape && verdict.stat.changedFrac >= SCAN_DEFAULTS.cutEscapeFrac;
      if (!strong) {
        if (verdict.stat.changedFrac >= SCAN_DEFAULTS.eventMinFrac) {
          overlays.push({ i, t, score: adjusted[i], sameFrac: verdict.stat.sameFrac, changedFrac: verdict.stat.changedFrac });
        }
        continue;
      }
    }
    candidates.push({ i, t, score: adjusted[i], kind: 'cut' });
  }

  // ---- 3. rate cap (never more cuts than the pacing budget allows)
  const duration = frames / effFps;
  const gap = Math.min(1.5, Math.max(0.5, duration / 60));
  const maxCuts = Math.max(1, Math.floor(duration / gap));
  let picked = candidates;
  if (candidates.length > maxCuts) {
    picked = [...candidates].sort((a, b) => b.score - a.score).slice(0, maxCuts)
      .sort((a, b) => a.t - b.t);
  }

  // ---- 4. minimum gap in time order (keep the stronger of two close cuts)
  const cuts = [];
  for (const c of picked) {
    const last = cuts[cuts.length - 1];
    if (last && c.t - last.t < minGap) {
      if (c.score > last.score) cuts[cuts.length - 1] = c;
      continue;
    }
    cuts.push(c);
  }

  // ---- 4b. flashes: a jump that undoes itself is not a new shot
  const flashIdx = [];
  if (cuts.length) {
    const pb = bw * bh;
    const nFrames = Math.floor(blocks.length / pb);
    for (let k = cuts.length - 1; k >= 0; k--) {
      const i = cuts[k].i;
      let flashed = false;
      // The spike can sit on either side of the flashed frame, so test both.
      for (const before of [i - 1, i]) {
        if (before < 0 || before + 1 >= nFrames) continue;
        const base = blockSad(blocks, blocks, before * pb, (before + 1) * pb, bw, bh, 0, 0);
        if (base <= 0.5) continue;
        const back = Math.min(nFrames - 1, before + 1 + SCAN_DEFAULTS.flashWindow);
        if (back <= before + 1) continue;
        const after = blockSad(blocks, blocks, before * pb, back * pb, bw, bh, 0, 0);
        if (after < base * SCAN_DEFAULTS.flashKeep) { flashed = true; break; }
      }
      if (flashed) { flashIdx.push(i); cuts[k].kind = 'flash'; cuts.splice(k, 1); }
    }
  }

  // ---- 5. gradual transitions: a dissolve has no jump to find
  // A dissolve, a blur or a wipe never produces one big jump, so rule 2 cannot
  // see it: it produces a *plateau* of medium ones, which rule 2 reports as a
  // burst of tiny shots. Two conditions separate a transition from ordinary
  // motion: the plateau must stand out from the rest of the clip
  // (concentration), and its two ends must be different pictures (endpoint).
  // A slow pan fails both — every window of it looks alike, and its ends
  // differ only by the steady per-frame drift.
  const softSpans = findSoftTransitions({
    adjusted, blocks, bw, bh, n, frames, effFps, start,
    flashIdx, cutIdx: cuts.map((c) => c.i),
  });
  if (softSpans.length) {
    // Inside a transition the per-frame jumps are part of it, not boundaries.
    // Keep the transition's own boundary and drop the debris around it.
    const inside = (c) => softSpans.some((s) => c.t >= s.t0 - 1e-6 && c.t <= s.t1 + 1e-6);
    for (let k = cuts.length - 1; k >= 0; k--) {
      if (cuts[k].kind === 'fade') continue;
      if (inside(cuts[k])) cuts.splice(k, 1);
    }
    for (const s of softSpans) {
      if (!cuts.some((c) => Math.abs(c.t - s.t) < Math.max(0.5, SCAN_DEFAULTS.minGap * 1.5))) {
        cuts.push({ i: s.i, t: s.t, score: s.score, kind: 'fade' });
      }
    }
    cuts.sort((a, b) => a.t - b.t);
  }

  return { cuts, motion, overlays, lights };
}

/** Fraction of the block grid whose mean changed by more than `delta`. */
function changedFraction(blocks, offA, offB, bw, bh, delta) {
  const total = bw * bh;
  let changed = 0;
  for (let b = 0; b < total; b++) {
    const d = blocks[offA + b] - blocks[offB + b];
    if (d > delta || d < -delta) changed += 1;
  }
  return changed / total;
}

/** Median per-frame block change: the clip's own idea of "nothing happened". */
function medianAdjacentSad(blocks, bw, bh, n) {
  const step = Math.max(1, Math.floor(n / 400));
  const sample = [];
  for (let i = 0; i + 1 < n; i += step) {
    sample.push(blockSad(blocks, blocks, i * bw * bh, (i + 1) * bw * bh, bw, bh, 0, 0));
  }
  if (!sample.length) return 0;
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

/**
 * Find spans where the picture is changing steadily and *fast* for this clip,
 * and whose ends really are different pictures. Returns one boundary per
 * span, at the strongest moment.
 */
function findSoftTransitions({ adjusted, blocks, bw, bh, n, frames, effFps, start, flashIdx = [], cutIdx = [] }) {
  const spanFrames = Math.max(4, Math.round(SCAN_DEFAULTS.softWindow * effFps));
  if (n < spanFrames * 2) return [];
  const cum = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += adjusted[i];
    if (i >= spanFrames) acc -= adjusted[i - spanFrames];
    cum[i] = acc;
  }
  const tail = Array.from(cum.subarray(spanFrames, n)).sort((a, b) => a - b);
  const medianCum = tail.length ? tail[tail.length >> 1] : 0;
  const bar = Math.max(SCAN_DEFAULTS.softCum, medianCum * SCAN_DEFAULTS.softCumRatio);
  if (!(bar > 0)) return [];
  const typical = medianAdjacentSad(blocks, bw, bh, n) + 0.02;
  const out = [];
  // A window that already contains a hard cut or a flash is not a dissolve:
  // those single spikes inflate the cumulative change and would look like one.
  const occupied = (a, b) => flashIdx.some((f) => f >= a - 2 && f <= b + 2)
    || cutIdx.some((f) => f >= a - 2 && f <= b + 2);
  for (let i = spanFrames; i < n; i++) {
    if (cum[i] < bar) continue;
    if (occupied(i - spanFrames, i)) continue;
    let peak = i;
    while (i + 1 < n && cum[i + 1] >= bar) {
      i += 1;
      if (cum[i] > cum[peak]) peak = i;
    }
    const j0 = Math.max(0, peak - spanFrames);
    const j1 = Math.min(frames - 1, peak);
    const steps = j1 - j0;
    if (steps < 3) continue;
    const endpoint = blockSad(blocks, blocks, j0 * bw * bh, j1 * bw * bh, bw, bh, 0, 0);
    if (endpoint / steps < typical * SCAN_DEFAULTS.softEndpoint) continue;
    // A transition changes the whole frame, so its two ends must differ across
    // most of the grid — a square sliding across a still picture does not.
    if (changedFraction(blocks, j0 * bw * bh, j1 * bw * bh, bw, bh, SCAN_DEFAULTS.blockDelta) < SCAN_DEFAULTS.cutMinFrac) continue;
    // ...and it is a transient: the picture must settle down afterwards. In
    // continuously moving footage the change rate after the window is the same
    // as inside it, which means nothing transitioned — the camera just kept
    // moving.
    const settle = Math.min(n - 1, j1 + Math.round(effFps * 0.6));
    if (settle > j1) {
      const after = blockSad(blocks, blocks, j1 * bw * bh, settle * bw * bh, bw, bh, 0, 0);
      const rateAfter = after / (settle - j1);
      if (rateAfter > (endpoint / steps) * SCAN_DEFAULTS.softSettle) continue;
    }
    if (process.env.DSH_SCAN_DEBUG) {
      console.error(`[soft] peak=${peak} t=${(start + (peak + 1) / effFps).toFixed(2)} cum=${cum[peak].toFixed(1)} bar=${bar.toFixed(1)} medCum=${medianCum.toFixed(1)} perStep=${(endpoint / steps).toFixed(2)} typical=${typical.toFixed(2)}`);
    }
    out.push({
      i: Math.round((j0 + j1) / 2),
      t0: start + j0 / effFps,
      t1: start + (j1 + 1) / effFps,
      t: start + ((j0 + j1) / 2 + 1) / effFps,
      score: +(cum[peak] / spanFrames).toFixed(2),
    });
  }
  return out;
}

export function summarizeShots(cuts, duration, effFps) {
  const shots = cuts.length + 1;
  const bounds = [0, ...cuts.map((c) => c.t), duration];
  const lens = [];
  for (let i = 1; i < bounds.length; i++) lens.push(Math.max(0, bounds[i] - bounds[i - 1]));
  lens.sort((a, b) => a - b);
  const medianShot = lens.length ? lens[lens.length >> 1] : duration;
  return {
    frames: Math.round(duration * effFps),
    shots,
    cuts: cuts.length,
    medianShot: +medianShot.toFixed(2),
    p10Shot: +(lens[Math.floor(lens.length * 0.1)] ?? medianShot).toFixed(2),
    cutsPerMin: +(cuts.length / Math.max(1 / 60, duration / 60)).toFixed(1),
  };
}

function assessDegraded({ duration, cuts, vectors, cutCount }) {
  if (!(duration > 0)) return 'empty';
  const medianShot = duration / Math.max(1, cutCount + 1);
  if (medianShot < 0.5 && cutCount > 10) return 'motion';
  if (vectors && vectors.sharp.length > 8) {
    let sum = 0;
    const k = Math.min(vectors.sharp.length, 600);
    for (let i = 0; i < k; i++) sum += vectors.sharp[i];
    if (sum / k < 1.5) return 'flat';
  }
  void cuts;
  return null;
}
