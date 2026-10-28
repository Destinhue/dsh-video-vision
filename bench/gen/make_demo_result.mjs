#!/usr/bin/env node
/**
 * make_demo_result.mjs - build a synthetic "plugin result" so measure.mjs can be
 * exercised end to end before the real plugin exists.
 *
 * It reads a corpus clip, cuts it into N uniform time cells, grabs one real
 * frame per cell with ffmpeg (so the image paths, sizes and byte counts are
 * genuine), and writes a result JSON in exactly the documented contract.
 *
 *   node make_demo_result.mjs --clip A --cells 12 --out out/demo_a.json
 *   node make_demo_result.mjs --clip A --cells 12 --shift 0.4   # bad alignment
 *   node make_demo_result.mjs --clip D --cells 9 --no-times     # no time info
 *
 * Options
 *   --clip       corpus clip id (A..I) or full name          [required]
 *   --cells      number of cells                             [default 12]
 *   --shift      seconds added to every cell window           [default 0]
 *   --text-times put the windows in the text instead of images[].tStart
 *   --no-times   omit all time information (tests the n/a path)
 *   --scale      tile width in px                             [default 640]
 *   --out        output json                                  [required]
 *   --framesdecoded  pretend this many frames were decoded     [default clip frames]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, "..");
const FFMPEG = process.env.FFMPEG ||
  join(BENCH, "..", "vendor", "bin", "ffmpeg.exe");

function args(argv) {
  const a = { clip: null, cells: 12, shift: 0, scale: 640, out: null,
    textTimes: false, noTimes: false, framesDecoded: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--clip") a.clip = v();
    else if (k === "--cells") a.cells = Number(v());
    else if (k === "--shift") a.shift = Number(v());
    else if (k === "--scale") a.scale = Number(v());
    else if (k === "--out") a.out = v();
    else if (k === "--framesdecoded") a.framesDecoded = Number(v());
    else if (k === "--text-times") a.textTimes = true;
    else if (k === "--no-times") a.noTimes = true;
    else throw new Error("unknown argument: " + k);
  }
  if (!a.clip || !a.out) throw new Error("--clip and --out are required");
  return a;
}

const a = args(process.argv.slice(2));
const index = JSON.parse(readFileSync(join(BENCH, "corpus", "index.json"), "utf8"));
const wq = a.clip.trim().toLowerCase();
const clip = index.clips.find((c) => c.name.toLowerCase() === wq) ||
  index.clips.find((c) => c.name.toLowerCase().startsWith(wq)) ||
  index.clips.find((c) => c.name.split("_")[0].toLowerCase() === wq);
if (!clip) throw new Error(`no corpus clip matching "${a.clip}"`);

const dur = Number(clip.duration_s);
const n = Math.max(1, a.cells | 0);
const win = dur / n;
const outPath = resolve(a.out);
const imgDir = join(dirname(outPath), "frames", clip.name.split(".")[0]);
mkdirSync(imgDir, { recursive: true });

const h = Math.round((a.scale * clip.height) / clip.width / 2) * 2;
const images = [];
const cellLines = [];

const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const start = Math.max(0, i * win + a.shift);
  const end = Math.min(dur, (i + 1) * win + a.shift);
  const mid = Math.min(dur - 1e-3, (start + end) / 2);
  const file = join(imgDir, `c${String(i + 1).padStart(2, "0")}.jpg`);
  execFileSync(FFMPEG, ["-hide_banner", "-nostdin", "-loglevel", "error",
    "-ss", mid.toFixed(3), "-i", resolve(BENCH, clip.file),
    "-frames:v", "1", "-vf", `scale=${a.scale}:${h}`, "-q:v", "3", "-y", file]);
  const st = existsSync(file) ? statSync(file) : null;
  const img = {
    path: file,
    width: a.scale,
    height: h,
    bytes: st ? st.size : null,
  };
  if (!a.noTimes && !a.textTimes) {
    img.tStart = +start.toFixed(3);
    img.tEnd = +end.toFixed(3);
    img.t = +mid.toFixed(3);
  }
  images.push(img);
  cellLines.push(`  #${i + 1} t=${start.toFixed(2)}-${end.toFixed(2)}s `
    + `frame@${mid.toFixed(2)}s ${basename(file)}`);
}
const elapsed = Date.now() - t0;

const text = [
  `Clip ${clip.name}: ${n} uniform cells over ${dur.toFixed(2)}s ` +
  `(${(win).toFixed(2)}s per cell), tiles ${a.scale}x${h}.`,
  ...(a.textTimes ? cellLines : []),
  `The video shows ${clip.category.replace(/_/g, " ")}.`,
].join("\n");

const result = {
  images,
  text,
  meta: {
    elapsedMs: elapsed,
    framesDecoded: a.framesDecoded ?? clip.frames,
    strategy: "uniform-midpoint",
    clip: clip.name,
  },
};
if (!a.noTimes && !a.textTimes) {
  result.meta.cells = images.map((im, i) => ({
    index: i + 1, tStart: im.tStart, tEnd: im.tEnd, path: im.path,
  }));
}

writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(`${n} cells of ${win.toFixed(3)}s -> ${outPath} ` +
  `(${a.scale}x${h}, ${images.length} frames, ${elapsed} ms)` +
  (a.shift ? `  [shift +${a.shift}s]` : "") +
  (a.noTimes ? "  [no time info]" : "") +
  (a.textTimes ? "  [times only in text]" : ""));
