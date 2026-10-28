import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng, crc32, pngSize } from '../src/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parseChunks(buf) {
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function pixel(rgb, width, x, y) {
  const i = (y * width + x) * 3;
  return [rgb[i], rgb[i + 1], rgb[i + 2]];
}

function unfilter(filtered, width, height) {
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const raw = filtered[rowStart + x];
      const prev = y > 0 ? out[(y - 1) * stride + x] : 0;
      if (filter === 0) out[y * stride + x] = raw;
      else if (filter === 1) out[y * stride + x] = (raw + (x >= 3 ? out[y * stride + x - 3] : 0)) & 0xff;
      else if (filter === 2) out[y * stride + x] = (raw + prev) & 0xff;
      else if (filter === 3) {
        const left = x >= 3 ? out[y * stride + x - 3] : 0;
        out[y * stride + x] = (raw + ((left + prev) >> 1)) & 0xff;
      } else if (filter === 4) {
        const left = x >= 3 ? out[y * stride + x - 3] : 0;
        const upLeft = x >= 3 && y > 0 ? out[(y - 1) * stride + x - 3] : 0;
        const p = left + prev - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - prev);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? prev : upLeft;
        out[y * stride + x] = (raw + pred) & 0xff;
      } else throw new Error(`unexpected filter ${filter}`);
    }
  }
  return out;
}

test('every PNG starts with the 8-byte signature', () => {
  const png = encodePng(Buffer.alloc(3 * 3, 7), 3, 1);
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
});

test('the IHDR carries the exact width and height', () => {
  const png = encodePng(Buffer.alloc(3 * 7 * 4, 0), 7, 4);
  const chunks = parseChunks(png);
  assert.equal(chunks[0].type, 'IHDR');
  assert.equal(chunks[0].data.length, 13);
  assert.equal(chunks[0].data.readUInt32BE(0), 7);
  assert.equal(chunks[0].data.readUInt32BE(4), 4);
  assert.equal(chunks[0].data[8], 8, 'bit depth');
  assert.equal(chunks[0].data[9], 2, 'truecolour');
});

test('inflating the IDAT and undoing the row filters reproduces every pixel', () => {
  const width = 7;
  const height = 4;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) % 256;
  const png = encodePng(rgb, width, height);
  const chunks = parseChunks(png);
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const filtered = inflateSync(idat);
  assert.equal(filtered.length, height * (1 + width * 3));
  assert.equal(filtered[0], 0, 'first row keeps filter 0');
  for (let y = 1; y < height; y++) {
    assert.equal(filtered[y * (width * 3 + 1)], 2, 'later rows use the up filter');
  }
  const decoded = unfilter(filtered, width, height);
  assert.deepEqual(decoded, rgb);
});

test('the none filter writes a zero filter byte on every row', () => {
  const width = 5;
  const height = 2;
  const rgb = Buffer.alloc(width * height * 3, 200);
  const png = encodePng(rgb, width, height, { filter: 'none' });
  const chunks = parseChunks(png);
  const filtered = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  for (let y = 0; y < height; y++) {
    assert.equal(filtered[y * (width * 3 + 1)], 0);
  }
  assert.deepEqual(unfilter(filtered, width, height), rgb);
});

test('a 1x1 image is a valid PNG', () => {
  const png = encodePng(Buffer.from([255, 0, 255]), 1, 1);
  const size = pngSize(png);
  assert.deepEqual(size, { width: 1, height: 1, bitDepth: 8, colorType: 2 });
  const chunks = parseChunks(png);
  const filtered = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.deepEqual(Array.from(unfilter(filtered, 1, 1)), [255, 0, 255]);
});

test('odd widths keep their stride', () => {
  const width = 5;
  const height = 3;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = i % 256;
  const png = encodePng(rgb, width, height);
  assert.equal(pngSize(png).width, width);
  const chunks = parseChunks(png);
  const filtered = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  assert.deepEqual(unfilter(filtered, width, height), rgb);
});

test('the image ends with an empty IEND chunk', () => {
  const chunks = parseChunks(encodePng(Buffer.alloc(12, 1), 2, 2));
  assert.equal(chunks.at(-1).type, 'IEND');
  assert.equal(chunks.at(-1).data.length, 0);
});

test('crc32 matches the published PNG check value', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  assert.equal(crc32(Buffer.from('xIENDy'), 1, 5), crc32(Buffer.from('IEND')));
});

test('pngSize rejects anything that is not a PNG header', () => {
  assert.equal(pngSize(Buffer.alloc(16)), null);
  const png = encodePng(Buffer.alloc(3, 0), 1, 1);
  const tampered = Buffer.from(png);
  tampered[0] = 0;
  assert.equal(pngSize(tampered), null);
  assert.deepEqual(pngSize(png), { width: 1, height: 1, bitDepth: 8, colorType: 2 });
});

test('bad dimensions are rejected before any bytes are written', () => {
  const rgb = Buffer.alloc(300);
  for (const width of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => encodePng(rgb, width, 1), TypeError);
  }
  for (const height of [0, -2, 2.5]) {
    assert.throws(() => encodePng(rgb, 1, height), TypeError);
  }
});

test('too few pixels is a RangeError, not a corrupt image', () => {
  assert.throws(() => encodePng(Buffer.alloc(2), 2, 2), RangeError);
});

test('different pixels produce different files', () => {
  const a = encodePng(Buffer.from([1, 2, 3]), 1, 1);
  const b = encodePng(Buffer.from([3, 2, 1]), 1, 1);
  assert.ok(!a.equals(b));
});

test('a full-white 8x8 block survives the round trip', () => {
  const rgb = Buffer.alloc(8 * 8 * 3, 255);
  const png = encodePng(rgb, 8, 8);
  const chunks = parseChunks(png);
  const filtered = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const decoded = unfilter(filtered, 8, 8);
  assert.deepEqual(pixel(decoded, 8, 0, 0), [255, 255, 255]);
  assert.deepEqual(pixel(decoded, 8, 7, 7), [255, 255, 255]);
});
