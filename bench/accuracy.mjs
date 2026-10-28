/**
 * accuracy.mjs — how well does the sheet actually cover the video?
 *
 * Three questions, scored per clip against hand-written ground truth:
 *   cuts   — did we find the boundaries, and did we invent any?
 *   shots  — is the shot count right?
 *   cells  — does every ground-truth shot get a representative frame?
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DETAIL = process.argv[2] ?? 'auto';
const { runStoryboard } = await import(pathToFileURL(path.join(ROOT, 'src', 'pipeline.js')).href);
const corpus = JSON.parse(await readFile(path.join(ROOT, 'bench', 'corpus', 'index.json'), 'utf8'));
const OUT = path.join(ROOT, 'bench', 'out');
await mkdir(OUT, { recursive: true });

const match = (found, truth, tol = 0.5) => {
  const used = new Set();
  let hit = 0;
  for (const t of found) {
    let bi = -1, bd = Infinity;
    truth.forEach((g, i) => { if (!used.has(i)) { const d = Math.abs(g - t); if (d < bd) { bd = d; bi = i; } } });
    if (bi >= 0 && bd <= tol) { used.add(bi); hit++; }
  }
  const p = found.length ? hit / found.length : (truth.length ? 0 : 1);
  const r = truth.length ? hit / truth.length : 1;
  return { hit, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
};

const rows = [];
for (const clip of corpus.clips) {
  const gt = JSON.parse(await readFile(path.join(ROOT, 'bench', clip.gt_file), 'utf8'));
  const t0 = Date.now();
  const r = await runStoryboard({ input: path.join(ROOT, 'bench', clip.file), detail: DETAIL });
  const ms = Date.now() - t0;
  const found = (r.scan.cuts ?? []).map((c) => +c.t.toFixed(2));
  const truth = gt.cuts ?? [];
  const m = match(found, truth);
  const shots = gt.shots ?? [];
  const covered = shots.filter((s) => r.plan.cells.some((c) => c.frameT >= s.start - 0.05 && c.frameT < s.end + 1e-6)).length;
  rows.push({
    clip: clip.name, ms, cuts: found.length, gtCuts: truth.length,
    cutP: +m.p.toFixed(2), cutR: +m.r.toFixed(2), cutF1: +m.f1.toFixed(2),
    shots: r.scan.summary.shots, gtShots: shots.length,
    cells: r.plan.cells.length, coverage: +(shots.length ? covered / shots.length : 1).toFixed(2),
    merged: r.plan.mergedGroups ?? 0, deduped: r.plan.deduped,
    tokens: r.visionTokens, bracket: r.plan?.cells ? '' : '',
  });
  console.log(`${clip.name.padEnd(24)} ${String(ms).padStart(5)}ms  cuts ${found.length}/${truth.length} F1 ${m.f1.toFixed(2)}  shots ${r.scan.summary.shots}/${shots.length}  cells ${String(r.plan.cells.length).padStart(2)}  coverage ${(shots.length ? covered / shots.length : 1).toFixed(2)}  ${r.visionTokens} tok`);
}

const mean = (k) => (rows.reduce((a, r) => a + r[k], 0) / rows.length);
console.log(`\nmean: cutF1 ${mean('cutF1').toFixed(3)} · coverage ${mean('coverage').toFixed(3)} · ${Math.round(mean('ms'))} ms · ${Math.round(mean('tokens'))} tokens`);
await writeFile(path.join(OUT, `accuracy-${DETAIL}.json`), JSON.stringify(rows, null, 2));
