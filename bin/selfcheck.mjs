#!/usr/bin/env node
/**
 * selfcheck.mjs — prove the install works, without needing a video to look at.
 *
 *   node bin/selfcheck.mjs            # toolchain + registration + schema
 *   node bin/selfcheck.mjs --smoke    # ...and one real end-to-end storyboard
 *   node bin/selfcheck.mjs --host     # validate all five tools against the
 *                                     # installed Harness's own schema engine
 *                                     # (needs Electron's node: ELECTRON_RUN_AS_NODE=1)
 *
 * `--host` exists because the failure mode that matters is not a wrong picture,
 * it is a tool the registry rejects: `video_probe` once returned
 * `{ text: { text, probe, plan } }` and the host answered
 * `"value.text" must be a string`. Locally everything looked fine.
 *
 * It is deliberately dependency-free and throws nothing it can report: a
 * failed check prints a line and sets a non-zero exit code at the end.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BS = String.fromCharCode(92); // a single backslash, spelled so no escaping layer can eat it
const args = new Set(process.argv.slice(2));
const checks = [];
const record = (ok, label, detail = '') => {
  checks.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
/** Informational: printed, never counted as a pass or a failure. */
const note = (label, detail = '') => {
  console.log(`--   ${label}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  record(Number(process.versions.node.split('.')[0]) >= 20, 'node >= 20', `v${process.versions.node}`);

  const { findFfmpeg, findFfprobe, run, toolchainReport } = await import('../src/media.js');
  const ffmpeg = await findFfmpeg();
  const ffprobe = await findFfprobe();
  record(Boolean(ffmpeg), 'ffmpeg found', ffmpeg ?? 'set DSH_FFMPEG_PATH or put ffmpeg on PATH');
  // ffprobe is genuinely optional: without it the metadata comes from the ffmpeg
  // banner, and the probe check further down proves that path still gets the
  // right numbers. Failing here would mean punishing a correct install.
  if (ffprobe) record(true, 'ffprobe found', ffprobe);
  else note('ffprobe not found (optional)', 'metadata will come from the ffmpeg banner');
  if (!ffmpeg) return finish();

  const version = await run(ffmpeg, ['-hide_banner', '-version']);
  const first = version.stdout.toString('utf8').split('\n')[0].trim();
  record(version.code === 0, 'ffmpeg runs', first);
  if (args.has('--verbose')) console.log(toolchainReport());

  const plugin = await import('../src/index.js');
  record(plugin.name === 'dsh-video-vision', 'plugin exports a name', plugin.name);
  record(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'plugin injects tools', plugin.inject.join(','));

  const registered = [];
  const fake = {
    tools: { register: (spec) => { registered.push(spec); return () => {}; } },
    attachments: { saveImage: async () => ({ type: 'image', id: 'selfcheck' }) },
    logger: { info() {}, warn() {}, error() {} },
  };
  await plugin.apply(fake);
  const want = ['video_probe', 'video_outline', 'video_storyboard', 'video_zoom', 'video_read'];
  const names = registered.map((s) => s.name);
  record(names.length === want.length && want.every((n) => names.includes(n)),
    'five tools registered', names.join(', '));
  for (const spec of registered) {
    const okSchema = spec?.parameters?.type === 'object' && spec?.output?.schema;
    const okShape = typeof spec.execute === 'function' && typeof spec.output?.render === 'function';
    record(Boolean(okSchema && okShape), `tool shape: ${spec.name}`, okSchema ? '' : 'parameters must be an object-root schema');
  }

  if (!args.has('--smoke') && !args.has('--host')) return finish();

  // A 4 s clip with two hard cuts at 1.5 s and 3 s, built on the spot.
  const dir = await mkdtemp(join(tmpdir(), 'video-vision-'));
  const clip = join(dir, 'smoke.mp4');
  const built = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:d=1.5:r=30',
    '-f', 'lavfi', '-i', 'color=c=0xd0a040:s=640x360:d=1.5:r=30',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=1:r=30',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map', '[out]', '-pix_fmt', 'yuv420p', clip,
  ]);
  record(built.code === 0, 'synthetic clip built', built.code === 0 ? clip : built.stderr.toString('utf8').slice(0, 300));
  if (built.code !== 0) return finish();

  if (args.has('--host')) await hostCheck(registered, clip);

  const { runStoryboard } = await import('../src/pipeline.js');
  const started = Date.now();
  const result = await runStoryboard({ input: clip, ffmpegPath: ffmpeg, ffprobePath: ffprobe, detail: 'auto' });
  const ms = Date.now() - started;
  const cuts = result.scan.cuts.map((c) => c.t.toFixed(2));
  const probe = result.probe;
  record(Math.abs(probe.duration - 4) < 0.25 && probe.width === 640 && probe.fps > 25,
    'metadata correct', `${probe.probeMode}: ${probe.duration}s ${probe.width}x${probe.height} ${probe.fps}fps`);
  record(cuts.length === 2, 'two cuts found', cuts.join(', '));
  record(Math.abs(cuts[0] - 1.5) < 0.2 && Math.abs(cuts[1] - 3.0) < 0.2, 'cuts land on the edits', cuts.join(', '));
  record(result.sheet.width > 0 && result.png.length > 0, 'sheet rendered', `${result.sheet.width}x${result.sheet.height}, ${result.png.length} B`);
  const text = typeof result.manifest === 'string' ? result.manifest : result.manifest.text;
  record(text.includes('sheet 1'), 'manifest has the index header', `${text.length} chars`);
  record(result.visionTokens <= 1024, 'within the per-image token cap', `${result.visionTokens} tokens`);
  console.log(`\n${text}`);

  const { runOutline } = await import('../src/pipeline.js');
  const outline = await runOutline({ input: clip, ffmpegPath: ffmpeg, ffprobePath: ffprobe, windows: 4, top: 2 });
  const outlineCuts = outline.rows.reduce((sum, row) => sum + row.cuts, 0);
  record(outline.rows.length === 4 && outlineCuts === 2, 'outline divides the clip',
    `${outline.rows.length} windows, ${outlineCuts} cuts`);
  record(outline.text.startsWith('smoke.mp4') && outline.text.includes('note: text only'),
    'outline answers in text only', `${outline.text.length} chars`);
  console.log(`\nsmoke: ${ms} ms total, ${result.plan.cells.length} cells, ${result.visionTokens} vision tokens`);
  await rm(dir, { recursive: true, force: true });
  return finish();
}

/**
 * Validate the definitions against the host's own schema engine: the exact
 * assertions `ctx.tools.register` runs, then a SUCCESS-path call of every tool
 * validated the way the runtime validates a result.
 */
async function hostCheck(registered, clip) {
  const { existsSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { dirname, join: j } = await import('node:path');

  const candidates = [
    process.env.DSH_APP_ASAR,
    process.resourcesPath ? j(process.resourcesPath, 'app.asar') : null,
    process.execPath ? j(dirname(process.execPath), 'resources', 'app.asar') : null,
    process.env.LOCALAPPDATA ? j(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar') : null,
  ].filter(Boolean);
  const asar = candidates.find((p) => { try { return existsSync(p.split(BS).join('/')); } catch { return false; } });
  if (!asar) {
    record(false, 'host schema engine found', 'set DSH_APP_ASAR to your app.asar');
    return;
  }
  const lib = `${asar.split(BS).join('/')}/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`;
  let host;
  try {
    host = await import(pathToFileURL(lib).href);
  } catch (error) {
    record(false, 'host schema engine importable',
      `run this with Electron's node (ELECTRON_RUN_AS_NODE=1). ${String(error.message).slice(0, 120)}`);
    return;
  }
  record(true, 'host schema engine found', asar);

  for (const spec of registered) {
    try { host.assertSupportedJsonSchema(spec.parameters); record(true, `host accepts parameters: ${spec.name}`); }
    catch (error) { record(false, `host accepts parameters: ${spec.name}`, error.message); }
    try { host.assertSupportedJsonSchema(spec.output.schema); record(true, `host accepts output schema: ${spec.name}`); }
    catch (error) { record(false, `host accepts output schema: ${spec.name}`, error.message); }
  }

  const calls = {
    video_probe: { input: clip },
    video_outline: { input: clip, windows: 4 },
    video_storyboard: { input: clip, detail: 'low' },
    video_zoom: { input: clip, start: 1, duration: 2, cells: 2 },
  };
  for (const spec of registered) {
    const args = calls[spec.name];
    if (!args) continue;
    try {
      const value = await spec.execute(args, {});
      const violations = host.validateJsonSchemaValue(spec.output.schema, value);
      const list = Array.isArray(violations) ? violations : [];
      record(list.length === 0, `host accepts a real ${spec.name} result`,
        list.length ? JSON.stringify(list).slice(0, 160) : '');
      const blocks = spec.output.render(args, value);
      const bad = blocks.filter((b) => (b.type === 'text' && typeof b.text !== 'string')
        || (b.type === 'image' && !b.attachment));
      record(bad.length === 0, `${spec.name} renders valid blocks`, `${blocks.length} block(s): ${blocks.map((b) => b.type).join(' + ')}`);
    } catch (error) {
      record(false, `host accepts a real ${spec.name} result`, String(error.message).slice(0, 160));
    }
  }
}

function finish() {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('selfcheck crashed:', error);
  process.exitCode = 1;
});
