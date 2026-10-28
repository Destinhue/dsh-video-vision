#!/usr/bin/env node
/**
 * Final battery: one measurement script, one table, no hand-copied numbers.
 *
 *   node bench/final.mjs [--reps 3] [--out bench/out/final.json]
 *
 * For every corpus clip it runs the plugin's own storyboard pipeline the way the
 * host tool would call it (detail 'auto', whole file) and records wall time,
 * cell count, sheet bytes, manifest size, vision tokens (host formula), and cut
 * detection against the ground truth in bench/corpus/index.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PLUGIN = join(ROOT, 'src', 'pipeline.js');

const argv = process.argv.slice(2);
const num = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const reps = Math.max(1, num('reps', 3));
const outPath = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : join(ROOT, 'bench', 'out', 'final.json');
})();

const corpus = JSON.parse(readFileSync(join(ROOT, 'bench', 'corpus', 'index.json'), 'utf8'));
const clips = corpus.clips ?? corpus;

const { runStoryboard } = await import(pathToFileURL(PLUGIN).href);

/** Host vision accounting: 42 px cells of 14 px patches, 3x downscale, 1024 cap. */
function visionTokens(w, h) {
  const PATCH = 14;
  const CELL = PATCH * 3;
  const MIN = 544;
  let width = w;
  let height = h;
  if (width * height < MIN * MIN) {
    const scale = (MIN * MIN) / (width * height);
    const k = Math.sqrt(scale);
    width = Math.round(width * k);
    height = Math.round(height * k);
  }
  const gw = Math.ceil(width / CELL);
  const gh = Math.ceil(height / CELL);
  return Math.min(1024, gh * (gw + 1) + 2);
}

/** Cut matching at 0.5 s, the tolerance the corpus was built to. */
function scoreCuts(found, truth, tol = 0.5) {
  const used = new Set();
  let matched = 0;
  for (const t of truth) {
    let best = -1;
    let bestD = Infinity;
    found.forEach((f, i) => {
      if (used.has(i)) return;
      const d = Math.abs(f - t);
      if (d <= tol && d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) { used.add(best); matched += 1; }
  }
  return { truth: truth.length, found: found.length, matched, false: found.length - matched, missed: truth.length - matched };
}

const rows = [];
for (const clip of clips) {
  const file = resolve(ROOT, 'bench', clip.file);
  const gt = JSON.parse(readFileSync(resolve(ROOT, 'bench', clip.gt_file), 'utf8'));
  const gtCuts = (gt.cuts ?? gt.cut_times ?? []).map(Number).sort((a, b) => a - b);
  const gtShots = gt.shots?.length ?? gt.shot_count ?? 1;

  // Each clip is measured once cold (first call: probe + scan + decode) and the
  // remaining reps warm (in-process analysis cache: format only). Both are
  // reported, because a number that silently averages cache hits is a lie.
  const times = [];
  let last = null;
  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();
    last = await runStoryboard({ input: file, detail: 'auto' });
    times.push(Math.round(performance.now() - t0));
  }
  const cold = times[0];
  const warmTimes = times.slice(1).sort((a, b) => a - b);
  const ms = warmTimes.length ? warmTimes[warmTimes.length >> 1] : cold;

  const found = (last.scan.cuts ?? []).map((c) => +c.t.toFixed(3)).sort((a, b) => a - b);
  const cuts = scoreCuts(found, gtCuts);
  const tol = 0.5;
  const p = cuts.found ? cuts.matched / cuts.found : 1;
  const rr = cuts.truth ? cuts.matched / cuts.truth : 1;
  const f1 = p + rr ? (2 * p * rr) / (p + rr) : 0;

  // coverage: share of gt shots that hold at least one chosen frame
  const frames = last.plan.cells.map((c) => c.frameT);
  let covered = 0;
  const shots = gt.shots ?? [];
  if (shots.length) {
    for (const s of shots) {
      const a = s.start ?? s.t0 ?? 0;
      const b = s.end ?? s.t1 ?? a;
      // strict containment: a frame belongs to exactly one gt shot, otherwise a
      // dense-cut clip would report coverage it does not have.
      if (frames.some((t) => t >= a && t < b)) covered += 1;
    }
  } else {
    covered = frames.length ? gtShots : 0;
  }

  rows.push({
    clip: clip.name,
    ms,
    coldMs: cold,
    times,
    cells: last.plan.cells.length,
    tokens: visionTokens(last.sheet.width, last.sheet.height),
    sheet: `${last.sheet.width}x${last.sheet.height}`,
    grid: `${last.sheet.grid.cols}x${last.sheet.grid.rows}`,
    pngBytes: last.png.length,
    manifestChars: last.manifest.length,
    cutsFound: cuts.found,
    cutsTruth: cuts.truth,
    matched: cuts.matched,
    falseCuts: cuts.false,
    missed: cuts.missed,
    cutF1: +f1.toFixed(3),
    shotsGt: gtShots,
    coverage: shots.length ? +(covered / shots.length).toFixed(3) : null,
    cellsPerShot: +(last.plan.cells.length / Math.max(1, gtShots)).toFixed(2),
  });
  console.log(`${clip.name.padEnd(24)} ${String(ms).padStart(5)}ms  cells ${String(last.plan.cells.length).padStart(2)}  `
    + `tok ${String(rows.at(-1).tokens).padStart(4)}  cuts ${cuts.found}/${cuts.truth} (hit ${cuts.matched}) f1 ${f1.toFixed(2)}  `
    + `cov ${(rows.at(-1).coverage ?? 1).toFixed(2)}`);
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const tot = {
  ms: sum('ms') / rows.length,
  coldMs: sum('coldMs') / rows.length,
  cells: sum('cells'),
  tokens: sum('tokens'),
  matched: sum('matched'),
  truth: sum('cutsTruth'),
  falseCuts: sum('falseCuts'),
  missed: sum('missed'),
};
const microP = tot.matched / Math.max(1, tot.matched + tot.falseCuts);
const microR = tot.matched / Math.max(1, tot.truth);
const table = {
  schema: 'v4video.bench.final/1',
  generatedAt: new Date().toISOString(),
  reps,
  rows,
  aggregate: {
    meanWarmMs: +tot.ms.toFixed(1),
    meanColdMs: +tot.coldMs.toFixed(1),
    cells: tot.cells,
    tokens: tot.tokens,
    tokensPerCell: +(tot.tokens / tot.cells).toFixed(2),
    microPrecision: +microP.toFixed(3),
    microRecall: +microR.toFixed(3),
    microF1: +((2 * microP * microR) / Math.max(1e-9, microP + microR)).toFixed(3),
    meanCutF1: +(rows.reduce((a, r) => a + r.cutF1, 0) / rows.length).toFixed(3),
    meanCoverage: +(rows.reduce((a, r) => a + (r.coverage ?? 1), 0) / rows.length).toFixed(3),
    meanPngBytes: Math.round(rows.reduce((a, r) => a + r.pngBytes, 0) / rows.length),
    meanManifestChars: Math.round(rows.reduce((a, r) => a + r.manifestChars, 0) / rows.length),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');

const a = table.aggregate;
console.log('');
console.log(`mean cold ${a.meanColdMs} ms · warm ${a.meanWarmMs} ms · ${a.cells} cells · ${a.tokens} vision tokens (${a.tokensPerCell}/cell) · `
  + `micro P ${a.microPrecision} R ${a.microRecall} F1 ${a.microF1} · mean clip F1 ${a.meanCutF1} · coverage ${a.meanCoverage}`);
console.log(`sheet PNG ${a.meanPngBytes} B · manifest ${a.meanManifestChars} chars · ${basename(outPath)}`);
