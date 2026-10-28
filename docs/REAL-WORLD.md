# Real-world spot checks

The corpus in `bench/corpus/` is synthetic by design — it exists to have exact
ground truth. This page records what the pipeline does on videos that were
already on a machine, taken with no preparation and no tuning. It is a sanity
page, not a benchmark: three clips cannot establish a rate.

The clips are ordinary screen captures (two game captures and one desktop
capture): 60 fps HEVC, 60 fps H.264, and 30 fps H.264 at 1910×984. The media are
not redistributed here; the table is what the shipped code produced on them.

| clip | source | duration | frames | shots | cells | grid | sheet | tokens | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cs2-3s.mp4` | 1280×960 HEVC, 60 fps screen capture | 3.03 s | 182 | 2 | 2 | 1×2 | 447×699 | 206 | 1.08 s |
| `capture-34s.mp4` | 1724×1080 H.264, 60 fps desktop capture | 34.07 s | 2 044 | 15 | 15 | 3×5 | 1148×1202 | 872 | 4.06 s |
| `minecraft-70s.mp4` | 1910×984 H.264, 30 fps game capture | 70.05 s | 2 101 | 25 | 25 | 4×7 | 1393×1263 | 1 024 | 3.35 s |

Wall clock is one run on an i9-14900HX and moves ±30 % with machine load; the
ratios between clips are what matter. `detail` was `"auto"` throughout.

## What the sheets actually showed

**`cs2-3s`, 3 s.** Two shots (a cut at 1.33 s), two cells, 206 tokens. Both
frames are readable down to the HUD: money, health, armour, the radar and the
weapon in hand. This was the clip that exposed a real bug: with
`pick: "sharp"` the second cell's frame was a **muzzle flash** — a flash has an
enormous Laplacian variance, so "sharpest frame" selected the brightest instant
of the shot. The picker now measures the shot's median exposure and demotes
frames whose brightness is more than 1.8 MAD away from it
(`src/layout.js`, `bestFrameIndex`), which costs a few lines and fixed the pick.
The audio line also reports `speech 54 %` here — game voice chat lands in the
same syllable-modulation band as speech, which is the honest resolution limit of
an 8 kHz envelope plus spectral-centroid test.

**`capture-34s`, 34 s, 60 fps.** 14 cuts in 34 s (24.7 cuts/min — the capture
toggles a scope, which is a genuine scene change: the scoped view has a black
circular vignette and a magnified image). 15 cells, 872 tokens. Every cell's
HUD, money, ammo and radar can be read, and the scoped cells are clearly
distinguishable from the unscoped ones because the vignette dominates the frame.
Two cells are close to each other (same crouched position either side of a cut) —
a cut that returns to the same view produces two similar cells, which is correct
but redundant; the index tells the reader they are different shots, so nothing is
misrepresented.

**`minecraft-70s`, 70 s.** 24 cuts, 25 shots, 25 cells, 1 024 tokens — exactly
the per-image cap. Readable: the hotbar, the health bar, the chat lines and the
death screen (`你死了！` with the kill message and the `重生`/`标题画面` buttons) are
all legible in the rendered sheet. Most of the twenty-five cells show the same
meadow with different mobs, particles and chat: the player stood still for ~20 s,
so the frames genuinely differ (slimes, creepers, item pickups) but the
composition repeats. The cell budget is spent on novelty of *content*, not of
composition, and that is the honest limitation of a 12×7 luma block grid as a
similarity measure.

## Known rough edges these clips exposed

1. **Frame-pick sensitivity to flashes** — fixed (exposure-outlier demotion).
2. **Near-duplicate cells across shots** — a cut that returns to the same view
   yields two near-identical cells. The plan-level dedupe is per-shot
   (`sameAsCell`), because a global "macro composition" test would merge the
   six slides of corpus clip D, which differ only in their text block. This is a
   deliberate trade, not an oversight: text pages are the case where careful
   dedupe is most expensive.
3. **60 fps sources** — the analysis pass decimates to ≤30 effective fps for the
   cut scan (a cut cannot be missed by more than 33 ms) and the decode seeks are
   keyframe-accurate, so a 60 fps clip costs the same as a 30 fps one.
4. **`comfortable: false` on the Minecraft sheet** — at 25 cells the sheet is
   1393×1263, so burned-in text of a 1080p source lands at 8.3 px, above the
   7.5 px read-through floor but below 13 px. For subtitle-heavy material the
   tool description tells the model to use `detail: "high"` on fewer cells or
   `video_zoom` on the window. The readability numbers travel with every result
   (`subtitlePx`, `smallTextPx`), so the model can decide up front, rather than
   finding out after the fact that a sheet cannot be read.

## Reproduce

```bash
cd <repo>
node bench/final.mjs --reps 1          # corpus battery, writes bench/results/final.json
node bench/accuracy.mjs auto           # cut P/R/F1 and shot coverage
```

The three captures are not part of the repository. To run the same check on a
video of your own:

```bash
node bench/e2e.mjs /path/to/video.mp4 --detail auto
```

`bench/e2e.mjs` drives the real tool specs (`output.render` included) without a
harness, writes the PNG under `bench/out/`, and prints the manifest.
