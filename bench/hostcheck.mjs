/**
 * hostcheck.mjs — validate the plugin against the host's own schema engine.
 *
 * The unit tests cannot catch the one failure that matters most: a tool that
 * looks fine locally and is rejected (or silently dropped) by the real
 * registry. So this imports the shipped `@deepseek-ai/dsh-tools` out of the
 * application archive and puts our definitions through the exact assertions
 * `ctx.tools.register` runs, then validates a real call's return value, then
 * renders it and checks the blocks survive lossless-JSON snapshotting.
 *
 *   node bench/hostcheck.mjs [video]
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const APP = process.env.DSH_APP_ASAR
  || 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
const TOOLS = `${APP}/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`;

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'src', 'index.js');
const CLIP = process.argv[2] ?? path.join(ROOT, 'bench', 'corpus', 'A_hardcuts_720p.mp4');

if (!existsSync(TOOLS.replace(/^\//, '')) && !process.env.DSH_APP_ASAR) {
  // Electron's fs can read inside asar; plain node cannot. Say so plainly.
  console.error('note: reading app.asar requires the Electron runtime (ELECTRON_RUN_AS_NODE=1)');
}

const host = await import(pathToFileURL(TOOLS).href);
const { assertSupportedJsonSchema, validateJsonSchemaValue } = host;

let failures = 0;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => { failures += 1; console.log(`  FAIL ${msg}`); };

/* 1. register against a fake ctx, exactly like apply() would */
const registered = [];
const saved = [];
const ctx = {
  effect: () => {},
  tools: { register: (spec) => { registered.push(spec); return () => {}; } },
  attachments: {
    async saveImage({ data, mediaType, name }) {
      saved.push({ name, bytes: data.length });
      // The real store decodes the bytes; a PNG magic check is the cheap part
      // of the same claim and catches "we forgot to encode".
      const magic = data.subarray(0, 8).toString('hex');
      if (magic !== '89504e470d0a1a0a') throw new Error('not a PNG');
      return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType, bytes: data.length, width: 1, height: 1, name };
    },
  },
};

const plugin = await import(pathToFileURL(PLUGIN).href);
console.log(`plugin ${plugin.name}, inject [${(plugin.inject ?? []).join(', ')}]`);
await plugin.apply(ctx);

console.log('\n1. registration');
if (registered.length !== 3) bad(`expected 3 tools, got ${registered.length}`);
else ok('3 tools registered');

for (const spec of registered) {
  try { assertSupportedJsonSchema(spec.parameters); ok(`${spec.name}: parameters accepted`); }
  catch (e) { bad(`${spec.name}: parameters rejected — ${e.message}`); }
  try { assertSupportedJsonSchema(spec.output.schema); ok(`${spec.name}: output.schema accepted`); }
  catch (e) { bad(`${spec.name}: output.schema rejected — ${e.message}`); }
  if (typeof spec.output.render !== 'function') bad(`${spec.name}: render missing`);
  if (typeof spec.execute !== 'function') bad(`${spec.name}: execute missing`);
}

/* 2. a real call, validated the way the runtime validates it */
console.log('\n2. live call');
const storyboard = registered.find((s) => s.name === 'video_storyboard');
if (!storyboard) {
  bad('video_storyboard not registered');
} else {
  const t0 = Date.now();
  const value = await storyboard.execute({ input: CLIP, detail: 'auto' }, {});
  const ms = Date.now() - t0;
  const violations = validateJsonSchemaValue(storyboard.output.schema, value);
  const list = Array.isArray(violations) ? violations : [];
  if (list.length) bad(`output invalid: ${JSON.stringify(list).slice(0, 300)}`);
  else ok('execute() value satisfies output.schema');

  // snapshot must be lossless JSON: no undefined, NaN, Date, Map, Buffer
  let snapshot;
  try {
    snapshot = JSON.parse(JSON.stringify(value));
    ok('value survives JSON round-trip');
  } catch (e) { bad(`value not serialisable: ${e.message}`); }

  if (snapshot && snapshot.text !== undefined) {
    const blocks = storyboard.output.render({}, value);
    ok(`render -> ${blocks.length} block(s): ${blocks.map((b) => b.type).join(' + ')}`);
    for (const b of blocks) {
      if (b.type === 'image' && !b.attachment?.attachmentId) bad('image block without attachment ref');
      if (b.type === 'text' && typeof b.text !== 'string') bad('text block without text');
    }
    console.log(`\n   ${ms} ms · ${value.sheet?.width}x${value.sheet?.height} · ${value.visionTokens} vision tokens · ${saved.length} image(s)`);
    console.log('   ' + String(value.text).split('\n').slice(0, 6).join('\n   '));
  }
  // no undefined-valued keys anywhere in the top level
  const undef = Object.entries(value).filter(([, v]) => v === undefined).map(([k]) => k);
  if (undef.length) bad(`undefined top-level keys: ${undef.join(', ')}`);
  else ok('no undefined top-level keys');
}

/* 2b. every tool's SUCCESS path, validated like the runtime does it.
   This is the check that was missing: `video_probe` used to return
   { text: {text, probe, plan} } and the host answered
   `"value.text" must be a string` — a bug the storyboard-only run could not see. */
console.log('\n2b. every tool, success path');
const liveCalls = [
  ['video_probe', { input: CLIP }],
  ['video_zoom', { input: CLIP, start: 4, duration: 4, cells: 3 }],
];
for (const [nm, args] of liveCalls) {
  const spec = registered.find((s) => s.name === nm);
  if (!spec) { bad(`${nm} not registered`); continue; }
  const t0 = Date.now();
  const value = await spec.execute(args, {});
  const ms = Date.now() - t0;
  const violations = validateJsonSchemaValue(spec.output.schema, value);
  const list = Array.isArray(violations) ? violations : [];
  if (list.length) {
    bad(`${nm}: output invalid — ${JSON.stringify(list).slice(0, 220)}`);
    continue;
  }
  const blocks = spec.output.render(args, value);
  const img = blocks.filter((b) => b.type === 'image').length;
  ok(`${nm}: schema ok · ${blocks.length} block(s) (${img} image) · ${ms} ms`);
  console.log('   ' + String(value.text).split('\n').slice(0, 3).join('\n   '));
}

/* 3. the other two tools must not throw on a missing file */
console.log('\n3. failure paths');
for (const nm of ['video_probe', 'video_zoom']) {
  const spec = registered.find((s) => s.name === nm);
  if (!spec) { bad(`${nm} not registered`); continue; }
  try {
    const v = await spec.execute({ input: path.join(ROOT, 'bench', 'nope-does-not-exist.mp4') }, {});
    if (typeof v.text === 'string' && v.text.length > 0) ok(`${nm}: missing file reported, not thrown`);
    else bad(`${nm}: missing file produced no message`);
  } catch (e) { bad(`${nm}: threw on a missing file — ${e.message}`); }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
