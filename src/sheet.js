/**
 * sheet.js — compose decoded frames into one contact sheet.
 *
 * Everything is raw RGB24 in plain Buffers; there is no image library here on
 * purpose. A sheet is a few hundred kilobytes of pixels and the operations are
 * blit / fill / a bitmap font / a bar chart, so pulling a decoder dependency
 * (and its native binary) would be pure weight.
 *
 * Design constraints that come from the model, not from taste:
 *   - the sheet must be READ, so the cell index has to be unambiguous and
 *     must not be confused with picture content → high-contrast badge in a
 *     corner, never a caption line under every cell;
 *   - timecodes belong in the text manifest at 0.01 s precision. Burning them
 *     into pixels wastes the scarcest resource (readable pixels) and encodes
 *     them at ~8 bits of precision in a font the model has to OCR;
 *   - background between cells is a flat near-black with a hairline gutter,
 *     which keeps the model from reading the gaps as picture content.
 */

export const COLORS = {
  bg: [11, 11, 14],
  gutter: [38, 38, 46],
  badgeBg: [0, 0, 0],
  badgeFg: [255, 235, 59],
  stripBg: [8, 8, 11],
  stripBar: [63, 184, 175],
  stripCut: [255, 235, 59],
  stripSpeech: [255, 120, 90],
  pad: [30, 30, 36],
};

/* ------------------------------------------------------------ bitmap font */

const FONT5x7 = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ':': [0b00000, 0b00100, 0b00100, 0b00000, 0b00100, 0b00100, 0b00000],
  '.': [0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00110, 0b00110],
  '-': [0b00000, 0b00000, 0b00000, 0b01110, 0b00000, 0b00000, 0b00000],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};

export const TEXT_HEIGHT = 7;
export const TEXT_WIDTH = 5;

/** Width in pixels of `text` at `scale`, including inter-glyph spacing. */
export function textWidth(text, scale) {
  return Math.max(0, text.length * (TEXT_WIDTH + 1) * scale - scale);
}

/* ---------------------------------------------------------------- canvas */

export function newSheet(width, height, color = COLORS.bg) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
  }
  return { data, width, height };
}

export function fillRect(sheet, x, y, w, h, color, alpha = 1) {
  const { data, width, height } = sheet;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    let p = (yy * width + x0) * 3;
    for (let xx = x0; xx < x1; xx++, p += 3) {
      if (alpha >= 1) {
        data[p] = color[0]; data[p + 1] = color[1]; data[p + 2] = color[2];
      } else {
        data[p] = Math.round(data[p] * (1 - alpha) + color[0] * alpha);
        data[p + 1] = Math.round(data[p + 1] * (1 - alpha) + color[1] * alpha);
        data[p + 2] = Math.round(data[p + 2] * (1 - alpha) + color[2] * alpha);
      }
    }
  }
}

export function drawText(sheet, x, y, text, scale, color, opts = {}) {
  const { shadow = null, shadowOffset = 1 } = opts;
  if (shadow) {
    for (const [dx, dy] of [[-shadowOffset, 0], [shadowOffset, 0], [0, -shadowOffset], [0, shadowOffset], [shadowOffset, shadowOffset]]) {
      drawText(sheet, x + dx * scale, y + dy * scale, text, scale, shadow);
    }
  }
  let cx = x;
  for (const ch of text) {
    const glyph = FONT5x7[ch] ?? FONT5x7[' '];
    for (let row = 0; row < TEXT_HEIGHT; row++) {
      const bits = glyph[row];
      if (!bits) continue;
      for (let col = 0; col < TEXT_WIDTH; col++) {
        if (!(bits & (1 << (TEXT_WIDTH - 1 - col)))) continue;
        fillRect(sheet, cx + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cx += (TEXT_WIDTH + 1) * scale;
  }
  return cx;
}

/* ------------------------------------------------------------------- blit */

/**
 * Copy a cell (raw RGB, possibly a different size) into the sheet.
 * Nearest-neighbour is used when sizes differ; the pipeline requests exact
 * cell sizes from ffmpeg, so this path is only a safety net.
 */
export function blitCell(sheet, cell, dx, dy, dw = cell.width, dh = cell.height) {
  const { data, width: sw, height: sh } = cell;
  const { data: dst, width: dw0, height: dh0 } = sheet;
  if (dw === cell.width && dh === cell.height) {
    const rows = Math.min(dh, dh0 - dy);
    for (let y = 0; y < rows; y++) {
      const s = y * sw * 3;
      const d = ((dy + y) * dw0 + dx) * 3;
      data.copy(dst, d, s, s + Math.min(sw, dw0 - dx) * 3);
    }
    return;
  }
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    const dyRow = dy + y;
    if (dyRow < 0 || dyRow >= dh0) continue;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const dxPix = dx + x;
      if (dxPix < 0 || dxPix >= dw0) continue;
      const s = (sy * sw + sx) * 3;
      const d = (dyRow * dw0 + dxPix) * 3;
      dst[d] = data[s]; dst[d + 1] = data[s + 1]; dst[d + 2] = data[s + 2];
    }
  }
}

/** Draw a small index badge in the top-left of a cell. */
export function drawBadge(sheet, x, y, label, cellW, cellH) {
  // Big enough to read from the model's downscaled view, small enough not to
  // sit on top of the frame's own title text.
  const scale = Math.max(2, Math.min(4, Math.floor(Math.min(cellW * 0.026, cellH * 0.046))));
  const pad = 2;
  const w = textWidth(label, scale) + pad * 2;
  const h = TEXT_HEIGHT * scale + pad * 2;
  fillRect(sheet, x, y, w, h, COLORS.badgeBg, 0.72);
  drawText(sheet, x + pad, y + pad, label, scale, COLORS.badgeFg);
  return { w, h };
}

/* ------------------------------------------------------------- audio band */

/**
 * A compact audio band under the grid: envelope bars, cut ticks, speech spans.
 * One band replaces several paragraphs of "the music builds around 1:12".
 */
export function drawAudioBand(sheet, x, y, w, h, opts) {
  const { envelope = null, cuts = [], speech = [], t0 = 0, t1 = 1, color = COLORS.stripBar } = opts;
  // An empty window draws nothing at all — not even the band background.
  if (t1 <= t0) return;
  fillRect(sheet, x, y, w, h, COLORS.stripBg);
  const span = t1 - t0;
  if (envelope && envelope.length) {
    const bars = Math.min(w, envelope.length);
    for (let i = 0; i < bars; i++) {
      const v = envelope[Math.floor((i / bars) * envelope.length)];
      const bh = Math.max(1, Math.round(v * (h - 2)));
      fillRect(sheet, x + i, y + h - bh, 1, bh, color);
    }
  }
  for (const s of speech) {
    const a = Math.max(t0, s.t);
    const b = Math.min(t1, s.t + (s.dur ?? 0));
    if (b <= a) continue;
    const xa = Math.round(((a - t0) / span) * w);
    const bw = Math.max(1, Math.round(((b - a) / span) * w));
    fillRect(sheet, x + xa, y, bw, 2, COLORS.stripSpeech, 0.85);
  }
  for (const c of cuts) {
    if (c.t < t0 || c.t > t1) continue;
    const xc = Math.round(((c.t - t0) / span) * w);
    fillRect(sheet, x + xc, y, 1, h, COLORS.stripCut, 0.7);
  }
}

/* --------------------------------------------------------------- compose */

/**
 * Compose the sheet.
 *
 * @param {object} p
 * @param {{cols:number,rows:number,cellW:number,cellH:number,width:number,height:number}} p.grid
 * @param {Array<{index:number, frame:Buffer, width:number, height:number, dupOf?:number|null}>} p.cells
 * @param {number} [p.gutter]
 * @param {object} [p.audio]  { envelope, cuts, speech, t0, t1, height }
 */
export function composeSheet({ grid, cells, gutter = 2, audio = null }) {
  const bandH = audio ? (audio.height ?? 26) : 0;
  const width = grid.width;
  const height = grid.height + (bandH ? bandH + gutter : 0);
  const sheet = newSheet(width, height);

  let slot = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++, slot++) {
      const x = c * (grid.cellW + gutter) + gutter;
      const y = r * (grid.cellH + gutter) + gutter;
      const cell = cells[slot];
      if (!cell) {
        fillRect(sheet, x, y, grid.cellW, grid.cellH, COLORS.pad);
        continue;
      }
      const raw = cell.frame ?? cell.data;
      if (raw) {
        blitCell(sheet, { data: raw, width: cell.width, height: cell.height }, x, y, grid.cellW, grid.cellH);
      } else {
        fillRect(sheet, x, y, grid.cellW, grid.cellH, COLORS.pad);
      }
      if (cell.index) drawBadge(sheet, x, y, String(cell.index), grid.cellW, grid.cellH);
      if (cell.dupOf) {
        // A repeat of an earlier cell is not worth pixels: mark the slot as a
        // reference instead of spending a decoding pass on it.
        const tx = x;
        const ty = y + grid.cellH - 12;
        fillRect(sheet, tx, ty - 2, 96, 12, COLORS.badgeBg, 0.8);
        drawText(sheet, tx + 2, ty, `=${cell.dupOf}`, 1, COLORS.badgeFg);
      }
    }
  }

  if (audio && bandH) {
    drawAudioBand(sheet, gutter, grid.height + gutter, width - gutter * 2, bandH, audio);
  }
  return sheet;
}

/** Is this sheet's geometry worth showing to the model? */
export function sheetQuality(grid, count) {
  const used = count / (grid.cols * grid.rows);
  return {
    usedRatio: +used.toFixed(3),
    cellW: grid.cellW,
    cellH: grid.cellH,
    width: grid.width,
    height: grid.height,
  };
}
