/**
 * index.js — plugin entry.
 *
 * Registers five tools into the host:
 *   video_probe       metadata only, no decode
 *   video_outline     the whole file as rows of text, no picture, no vision tokens
 *   video_storyboard  one contact sheet + a timecoded text index
 *   video_zoom        a short window at usable per-cell resolution
 *   video_read        the file as a timestamped text document
 *
 * Contract (verified against a plugin that runs on this host):
 *   apply(ctx) registers plain tool objects — no import from
 *   `@deepseek-ai/dsh-tools` is required — and returns a disposer.
 *   `execute` returns the canonical value declared by the tool's
 *   `output.schema`; `output.render(args, value)` turns it into content blocks.
 *   The only way to attach a picture is `ctx.attachments.saveImage()`, which
 *   re-encodes and validates the bytes, so we hand it a real PNG.
 */

import { runStoryboard, runZoom, runProbe, runOutline } from './pipeline.js';
import { findFfmpeg, findFfprobe, toolchainReport } from './media.js';
import { runRead } from './read.js';
import { probeSpec, storyboardSpec, zoomSpec, readSpec, outlineSpec, PROBE_TOOL, STORYBOARD_TOOL, ZOOM_TOOL, READ_TOOL, OUTLINE_TOOL } from './tools.js';

export const name = 'dsh-video-vision';
export const inject = ['tools', 'attachments'];

/** The model never sees a broken tool: every failure becomes a message. */
function fail(error) {
  const message = String(error?.message ?? error);
  return { text: `video error: ${message}`, images: [] };
}

async function attachImages(ctx, pngs) {
  const refs = [];
  for (const png of pngs) {
    try {
      refs.push(await ctx.attachments.saveImage({
        data: png.data,
        mediaType: 'image/png',
        name: png.name,
      }));
    } catch (error) {
      // A route without image input would reject the whole call; losing the
      // picture must not lose the timestamps.
      console.error(`[video-vision] image dropped: ${error?.message ?? error}`);
    }
  }
  return refs;
}

export async function apply(ctx) {
  const state = { ffmpeg: null, ffprobe: null, ready: null };

  const ensureBinaries = async () => {
    if (!state.ready) {
      state.ready = (async () => {
        state.ffmpeg = await findFfmpeg();
        state.ffprobe = await findFfprobe();
      })();
    }
    await state.ready;
    if (!state.ffmpeg) {
      throw new Error('ffmpeg not found — set DSH_FFMPEG_PATH, or drop ffmpeg.exe next to the plugin in vendor/bin/');
    }
    return { ffmpegPath: state.ffmpeg, ffprobePath: state.ffprobe };
  };

  const debugLog = process.env.DSH_VIDEO_VISION_DEBUG
    ? (message) => { try { console.error('[video-vision]', message); } catch { /* stderr gone */ } }
    : undefined;

  const handlers = {
    async read(args, exec) {
      try {
        const bins = await ensureBinaries();
        const out = await runRead({
          ffmpegPath: bins.ffmpegPath,
          input: args.input,
          start: args.start ?? 0,
          end: args.end ?? 0,
          maxScreens: args.maxScreens,
          transcriptFile: typeof args.transcriptFile === 'string' ? args.transcriptFile : undefined,
          out: typeof args.out === 'string' ? args.out : undefined,
          signal: exec?.signal,
        });
        // A file with no readable text comes back with a few pictures instead:
        // the same answer, one attachment, no second round trip.
        const images = out.png
          ? await attachImages(ctx, [{ data: out.png, name: `read-pictures-${out.pictures?.length ?? 0}.png` }])
          : [];
        return { text: out.text, images };
      } catch (error) {
        return { text: `video error: ${String(error?.message ?? error)}`, images: [] };
      }
    },

    async storyboard(args, exec) {
      try {
        const bins = await ensureBinaries();
        const result = await runStoryboard({
          ...bins,
          input: args.input,
          start: args.start ?? args.from ?? 0,
          end: args.end ?? args.to,
          duration: args.duration,
          detail: args.detail ?? 'auto',
          maxCells: args.cells,
          textOnly: args.textOnly === true,
          transcriptFile: typeof args.transcriptFile === 'string' ? args.transcriptFile : undefined,
          cellRange: Array.isArray(args.cellRange) ? args.cellRange : null,
          pick: args.pick === 'middle' ? 'middle' : 'sharp',
          dedupe: args.dedupe === 'global' ? 'global' : undefined,
          signal: exec?.signal,
          log: debugLog,
        });
        if (result.empty) {
          return { text: `no frames could be read from ${args.input}: ${result.reason}`, images: [] };
        }
        const images = result.png
          ? await attachImages(ctx, [{ data: result.png, name: `storyboard-${result.sheet.grid.cols}x${result.sheet.grid.rows}.png` }])
          : [];
        return { text: result.manifest, images };
      } catch (error) {
        return fail(error);
      }
    },

    async zoom(args, exec) {
      try {
        const bins = await ensureBinaries();
        const result = await runZoom({
          ...bins,
          input: args.input,
          start: args.start ?? args.from ?? 0,
          end: args.end ?? args.to,
          duration: args.duration,
          cells: args.cells ?? 3,
          at: args.at,
          detail: args.detail ?? 'ultra',
          signal: exec?.signal,
        });
        const images = await attachImages(ctx, [{ data: result.png, name: 'zoom.png' }]);
        return { text: result.manifest, images };
      } catch (error) {
        return fail(error);
      }
    },

    async outline(args, exec) {
      try {
        const bins = await ensureBinaries();
        const result = await runOutline({
          ...bins,
          input: args.input,
          windows: args.windows,
          top: args.top,
          signal: exec?.signal,
        });
        return { text: result.text, images: [] };
      } catch (error) {
        return fail(error);
      }
    },

    async probeLocal(args, exec) {
      try {
        // runProbe() returns { text, probe, plan }; the tool's canonical value is
        // { text, images }. Returning the wrapper made the host reject the call
        // with `"value.text" must be a string`.
        const probe = await runProbe({ ...(await ensureBinaries()), input: args.input, signal: exec?.signal });
        return { text: probe.text, images: [] };
      } catch (error) {
        return { text: `video error: ${String(error?.message ?? error)}`, images: [] };
      }
    },
  };

  const toolCtx = {
    storyboard: handlers.storyboard,
    zoom: handlers.zoom,
    read: handlers.read,
    outline: handlers.outline,
  };

  const disposers = [];
  const register = (spec, label) => {
    try {
      disposers.push(ctx.tools.register(spec));
    } catch (error) {
      // A failed registration must not take the plugin down: report and go on.
      console.error(`[video-vision] failed to register ${label}: ${error?.message ?? error}`);
    }
  };

  // Probe needs its own handler shape; keep it next to the others.
  const probeTool = probeSpec();
  probeTool.execute = (args, exec) => handlers.probeLocal(args, exec);

  register(probeTool, PROBE_TOOL);
  register(outlineSpec(toolCtx), OUTLINE_TOOL);
  register(storyboardSpec(toolCtx), STORYBOARD_TOOL);
  register(zoomSpec(toolCtx), ZOOM_TOOL);
  register(readSpec(toolCtx), READ_TOOL);

  // Warm the binary lookup in the background so the first real call is fast.
  findFfmpeg().then((bin) => { state.ffmpeg = bin; }).catch(() => {});
  findFfprobe().then((bin) => { state.ffprobe = bin; }).catch(() => {});

  if (process.env.DSH_VIDEO_VISION_DEBUG) {
    console.error(`[video-vision] ${JSON.stringify(await toolchainReport().catch(() => ({})))}`);
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose?.(); } catch { /* ignore */ }
    }
  };
}

/** `node src/index.js --self-test` — register against a fake ctx, no host. */
const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch { return false; }
})();

if (isMain && process.argv.includes('--self-test')) {
  const registered = [];
  const fake = {
    effect: () => {},
    tools: { register: (spec) => { registered.push(spec); return () => {}; } },
    attachments: {
      saveImage: async ({ data, mediaType, name }) => ({ data, mediaType, name, kind: 'image-ref' }),
    },
  };
  await apply(fake);
  for (const spec of registered) {
    if (!spec.name || !spec.execute || !spec.output?.render) throw new Error(`incomplete tool ${spec.name}`);
    if (!spec.parameters?.type) throw new Error(`${spec.name}: parameters must be a JSON Schema object`);
  }
  const names = registered.map((s) => s.name).join(', ');
  console.log(`PASS self-test: registered ${registered.length} tools (${names})`);
}
