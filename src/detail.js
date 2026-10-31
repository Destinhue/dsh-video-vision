/**
 * detail.js — how much of a picture survives the trip into a contact sheet.
 *
 * A storyboard cell is small on purpose: twenty-two moments in one image costs
 * the same as four. The cost is that fine content — a subtitle line, a line of
 * code, a HUD counter — turns into a grey smear at cell size while the cell as
 * a whole still looks like a perfectly good picture.
 *
 * The client cannot fix that by looking harder. So each cell is decoded at twice
 * the cell size, the ink in it is measured at that finer scale, and the index
 * says which cells are worth a separate zoom. This is arithmetic on pixels that
 * were already being decoded, not a guess about the content.
 *
 * Everything here is pure: no ffmpeg, no I/O.
 */

/** Box-downsample by exactly 2 in both axes (rgb24). */
export function downsample2(rgb, width, height) {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * width;
    const r1 = r0 + width;
    let o = y * w * 3;
    for (let x = 0; x < w; x++) {
      const i0 = (r0 + x * 2) * 3;
      const i1 = i0 + 3;
      const j0 = (r1 + x * 2) * 3;
      const j1 = j0 + 3;
      for (let c = 0; c < 3; c++) {
        out[o++] = (rgb[i0 + c] + rgb[i1 + c] + rgb[j0 + c] + rgb[j1 + c]) >> 2;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Rec.601 luma of one rgb24 buffer, as a Float32Array. */
export function luma(rgb, width, height) {
  const n = width * height;
  const y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    y[i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
  }
  return y;
}

/** Below this shrink factor a cell is simply too small to hold a subtitle. */
export const ZOOM_MIN_SCALE = 3.4;

/**
 * Share of pixels that stand out from their own 5x5 neighbourhood.
 *
 * Deliberately not a text detector — it answers "is there fine detail here at
 * all". An empty frame, a letterbox bar and a flat colour score 0; a slide of
 * prose and a screenshot score high; a landscape sits in between. A zoom is only
 * ever recommended when the cell is too small for that detail to survive.
 *
 * Uses an integral image and samples every other row and column: a 5x5 mean per
 * pixel is 25 operations a naive way and 4 the summed-area way, and this runs on
 * every cell of every sheet.
 */
export function inkFraction(rgb, width, height, threshold = 16, stride = 2) {
  const y = luma(rgb, width, height);
  const w = width;
  const h = height;
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let j = 0; j < h; j++) {
    let rowSum = 0;
    for (let i = 0; i < w; i++) {
      rowSum += y[j * w + i];
      integral[(j + 1) * iw + (i + 1)] = integral[j * iw + (i + 1)] + rowSum;
    }
  }
  const box = (x0, y0, x1, y1) => integral[y1 * iw + x1] - integral[y0 * iw + x1] - integral[y1 * iw + x0] + integral[y0 * iw + x0];
  let hits = 0;
  let seen = 0;
  for (let j = 0; j < h; j += stride) {
    const y0 = j - 2 < 0 ? 0 : j - 2;
    const y1 = j + 3 > h ? h : j + 3;
    for (let i = 0; i < w; i += stride) {
      const x0 = i - 2 < 0 ? 0 : i - 2;
      const x1 = i + 3 > w ? w : i + 3;
      const area = (x1 - x0) * (y1 - y0);
      const mean = box(x0, y0, x1, y1) / area;
      const c = y[j * w + i] - mean;
      if (c > threshold || c < -threshold) hits += 1;
      seen += 1;
    }
  }
  return +(seen ? hits / seen : 0).toFixed(4);
}

/** How many source pixels one sheet pixel covers. */
export function cellScale(srcHeight, cellHeight) {
  // A cell can be bigger than a tiny source; it cannot un-shrink it.
  return Math.max(1, Math.max(1, srcHeight) / Math.max(1, cellHeight));
}

/**
 * Which cells are worth zooming, given how hard the sheet shrank them.
 *
 * The rule is a statement about the sheet, not a guess about the picture: at
 * `scale` source pixels per sheet pixel, a glyph 12 px tall in the source is
 * `12/scale` px here, and anything under roughly a pixel and a half is gone.
 * Cells with no fine detail at all (black frame, flat title card, letterbox) are
 * left out because zooming them would not add anything.
 */
export function zoomMarkers(metrics, scale, opts = {}) {
  const { minInk = 0.004, minScale = ZOOM_MIN_SCALE } = opts;
  const list = [];
  if (!metrics || !metrics.size) return { list, total: 0, all: false, scale: +scale.toFixed(2) };
  for (const [index, m] of metrics) {
    if (m && m.ink >= minInk && scale >= minScale) list.push(index);
  }
  list.sort((a, b) => a - b);
  const total = metrics.size;
  return { list, total, all: list.length === total, scale: +scale.toFixed(2) };
}

/** One line for the index header, sized to what was actually measured. */
export function zoomNote(plan, { maxList = 10 } = {}) {
  if (!plan || !plan.list.length) return null;
  const px = Math.round(12 * plan.scale);
  if (plan.all) {
    return `zoom: every cell is shrunk ${plan.scale}x, so text under ~${px}px in the source is gone (${plan.list.length}/${plan.total}) — call video_zoom for the cells you need, or re-run with detail "low" for bigger cells`;
  }
  const shown = plan.list.slice(0, maxList).join(', ') + (plan.list.length > maxList ? ', …' : '');
  if (plan.list.length > plan.total * 0.6) {
    return `zoom: most cells (${plan.list.length}/${plan.total}) are shrunk ${plan.scale}x, below what a subtitle needs — cells ${shown} are marked; zoom the ones you need or re-run with detail "low"`;
  }
  return `zoom: ${plan.list.length}/${plan.total} cells carry detail finer than the sheet can show at ${plan.scale}x — cells ${shown} are marked, the rest read fine as they are`;
}
