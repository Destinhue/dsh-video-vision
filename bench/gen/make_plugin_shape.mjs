// generate a result JSON in the v4video plugin's real shape: ONE contact sheet
// image + a manifest whose cell lines are `N rXcY mm:ss.cc-mm:ss.cc (cuts) @mm:ss.cc`
// used only for testing measure.mjs, not part of the deliverable corpus.
import { execFileSync } from "node:child_process";
import { writeFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";

const BENCH = "F:\\ai\\v4video\\bench";
const FFMPEG = "F:\\ai\\v4video\\vendor\\bin\\ffmpeg.exe";
const out = path.join(BENCH, "out", "plugin_shape.json");
const sheet = path.join(BENCH, "out", "sheet_A.png");
mkdirSync(path.join(BENCH, "out"), { recursive: true });

const clip = path.join(BENCH, "corpus", "A_hardcuts_720p.mp4");
// 2 cols x 5 rows of 4s windows = 10 cells covering 40s, sheet 942x1328 (like theirs)
const COLS = 2, ROWS = 5, W = 471, H = 265;
execFileSync(FFMPEG, ["-v", "error", "-y", "-i", clip,
  "-vf", `fps=1/4,scale=${W}:${H},tile=${COLS}x${ROWS}`,
  "-frames:v", "1", sheet], { stdio: "inherit" });

const tc = (t) => {
  const totalCs = Math.round(t * 100), cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100), s = totalSec % 60, m = Math.floor(totalSec / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
};

const lines = [];
lines.push(`${clip} · 00:00:40.00 · 1280x720 · 30fps · 9 cuts · median shot 4.00s`);
lines.push(`sheet 1 · 2x5 grid · 942x1328 · 10 cells · window 00:00.00-00:40.00`);
lines.push(`cols: cell · pos · span · (cuts) · frame@`);
for (let i = 0; i < 10; i++) {
  const t0 = i * 4, t1 = t0 + 4;
  const r = Math.floor(i / COLS) + 1, c = (i % COLS) + 1;
  lines.push(`${i + 1} r${r}c${c} ${tc(t0)}-${tc(t1)} (${i === 0 ? 0 : 1}) @${tc(t0 + 2)}`);
}

writeFileSync(out, JSON.stringify({
  images: [{ path: sheet, width: 942, height: 1328, bytes: statSync(sheet).size }],
  text: lines.join("\n"),
  meta: { elapsedMs: 902, framesDecoded: 1200, grid: "2x5" },
}, null, 2));
console.log("wrote", out, statSync(sheet).size, "bytes sheet");
