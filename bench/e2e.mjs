/**
 * e2e.mjs — drive the plugin exactly the way the host does, without the host.
 *
 * A fake ctx implements just enough of the plugin API: `tools.register` collects
 * the specs, `attachments.saveImage` writes the PNG to disk so it can be looked
 * at. Everything below that is the real pipeline, the real ffmpeg, the real
 * bytes.
 *
 *   node bench/e2e.mjs <video> [--detail auto] [--cells 12] [--start 0] [--end 30]
 *                     [--zoom 12,6] [--probe] [--textonly] [--out dir]
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'src', 'index.js');

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--') && !/^\d/.test(a) && argv[argv.indexOf(a) - 1]?.startsWith('--') === false);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const numeric = (s) => (s == null || s === '' ? null : Number(s));

const target = val('input') ?? argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

if (!target) {
  console.error('usage: node bench/e2e.mjs <video> [--detail auto] [--cells 12] [--start 0] [--end 30] [--zoom start,len] [--probe] [--textonly]');
  process.exit(2);
}

const outDir = path.resolve(ROOT, val('out') ?? 'bench/out');
await mkdir(outDir, { recursive: true });

const registered = [];
const images = [];
const ctx = {
  effect: () => {},
  tools: { register: (spec) => { registered.push(spec); return () => {}; } },
  attachments: {
    async saveImage({ data, mediaType, name }) {
      const file = path.join(outDir, name);
      await writeFile(file, data);
      images.push(file);
      return { kind: 'image', name: file, mediaType, bytes: data.length };
    },
  },
};

const mod = await import(pathToFileURL(PLUGIN).href);
await mod.apply(ctx);
const spec = (name) => registered.find((s) => s.name === name);

const t0 = Date.now();
let out;

if (flag('probe')) {
  out = await spec('video_probe').execute({ input: target }, {});
  console.log(out.text);
} else if (flag('zoom')) {
  const [start, len] = (val('zoom', '0,6') || '0,6').split(',').map(Number);
  out = await spec('video_zoom').execute({
    input: target,
    start,
    duration: len,
    cells: numeric(val('cells')) ?? 3,
    at: numeric(val('at')) ?? undefined,
  }, {});
} else {
  out = await spec('video_storyboard').execute({
    input: target,
    start: numeric(val('start')) ?? 0,
    end: numeric(val('end')) ?? undefined,
    duration: numeric(val('duration')) ?? undefined,
    detail: val('detail', 'auto'),
    cells: numeric(val('cells')) ?? undefined,
    textOnly: flag('textonly'),
  }, {});
}

const elapsed = Date.now() - t0;
const blocks = spec(flag('zoom') ? 'video_zoom' : flag('probe') ? 'video_probe' : 'video_storyboard')
  .output.render({}, out);

console.log('--- blocks ---');
for (const b of blocks) {
  if (b.type === 'text') console.log(b.text);
  else console.log(`[image ${b.attachment.name} ${b.attachment.bytes ?? '?'} B]`);
}
console.log(`--- wall ${elapsed} ms ---`);
if (images.length) console.log('saved:', images.join(', '));
