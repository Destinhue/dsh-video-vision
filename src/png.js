/**
 * png.js — minimal PNG encoder (RGB24, 8 bit, no interlace).
 *
 * Why hand-rolled instead of an image library: the plugin must stay dependency
 * free (no sharp, no canvas, no ffmpeg-side encoding) so that installing it is
 * a single `npm i` on any platform. PNG is also the right container for a
 * storyboard: the model reads burned-in numbers and on-screen text, and JPEG
 * ringing around small glyphs measurably hurts that.
 *
 * The filter choice is deliberate: `Up` on every row is the cheapest filter
 * that still helps photographs a lot (vertical correlation), and PNG only
 * costs us when the buffer is big — so we keep the CPU cost low and let the
 * deflate level do the size/quality trade.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC32 over `buf[from, to)` — the PNG chunk checksum. */
export function crc32(buf, from = 0, to = buf.length) {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const out = Buffer.allocUnsafe(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  const crc = crc32(out, 4, 8 + len);
  out.writeUInt32BE(crc, 8 + len);
  return out;
}

/**
 * Apply the PNG "Up" filter (type 2) to the whole image.
 * Row 0 falls back to filter 0 (no predecessor).
 */
function filterUp(rgb, width, height) {
  const stride = width * 3;
  const out = Buffer.allocUnsafe((stride + 1) * height);
  const zero = Buffer.alloc(stride);
  let prev = zero;
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    out[dst] = y === 0 ? 0 : 2;
    for (let i = 0; i < stride; i++) out[dst + 1 + i] = (rgb[src + i] - prev[i]) & 0xff;
    prev = rgb.subarray(src, src + stride);
  }
  return out;
}

/**
 * Encode an RGB24 buffer as PNG.
 * @param {Buffer|Uint8Array} rgb row-major RGB, length >= width*height*3
 * @param {number} width
 * @param {number} height
 * @param {{level?:number, filter?:'up'|'none', raw?:boolean}} [opts]
 * @returns {Buffer}
 */
export function encodePng(rgb, width, height, opts = {}) {
  const { level = 6, filter = 'up', raw = false } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`encodePng: bad size ${width}x${height}`);
  }
  const need = width * height * 3;
  if (rgb.length < need) throw new RangeError(`encodePng: buffer too small (${rgb.length} < ${need})`);

  const body = raw ? rgb : filter === 'none'
    ? (() => {
      const stride = width * 3;
      const out = Buffer.allocUnsafe((stride + 1) * height);
      for (let y = 0; y < height; y++) {
        out[y * (stride + 1)] = 0;
        rgb.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
      }
      return out;
    })()
    : filterUp(rgb, width, height);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const idat = deflateSync(body, { level });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ], 8 + 25 + (12 + idat.length) + 12);
}

/** Read back the header of a PNG (used by tests and by the attachment guard). */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}
