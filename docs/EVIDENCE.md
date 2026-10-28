# Evidence

Every number here comes from `bench/final.mjs` (ours) and `bench/ab/run-upstream.mjs`
(the reference implementation), run on the same machine, against the same
corpus, in the same week. Nothing is estimated.

- Machine: Windows 11, Intel **i9-14900HX**, 15.6 GB RAM, 32 logical cores.
- ffmpeg: **8.0.1** (gyan.dev essentials) from `vendor/bin`; the fallback run
  below also uses **7.1** from an `imageio-ffmpeg` wheel.
- Reference: `github.com/SAOS-3624/dsh-video-storyboard` at commit
  `2a6fdc6` (`release: 0.3.0`), driven through its own `runStoryboard` with its
  host defaults (`pick: 'sharp'`, `burn: 'index'`, `minGap: 1.2`,
  `transcript: 'off'`).
- Ours: `src/` at the sha256 set printed by `sha256sum src/*.js`
  (`frames c4bd70b6…`, `index 8b7094c7…`, `layout 3c2ffa5b…`, `manifest 8bf118ef…`,
  `media 77d2abea…`, `pipeline f45d7c95…`, `png 6f98c9b3…`, `scan 549515a1…`,
  `sheet b8b5c859…`, `timeline 140ea562…`, `tools c0ba2a60…`). The battery was
  re-run after the bug-fix round (probe fallback, first-video-stream guard,
  shot-kind indexing, manifest window end) with every cell count, token count,
  cut match and coverage figure unchanged — those fixes moved metadata, not
  pictures.

  Two later changes do move the tables below, and they are the reason those
  hashes are quoted: the cell count became a **legibility limit** rather than a
  quota (`layout 3c2ffa5b…`), which put 25 cells on clip B at the same 1 024
  tokens and moved coverage 0.941 → 0.963, and audio gained a syllabic test so a
  music bed is no longer called speech (`timeline 140ea562…`). Everything below
  is the post-change battery. Successive idle runs put cold wall at 581–648 ms
  (634 ms is the run quoted below; the fastest was 581, the slowest 648) and
  cached at 375–411 ms; that spread is the machine, so read the ratios and not
  the milliseconds.

## Protocol

Both pipelines are driven directly as modules (no hosted model in the loop — the
tool *result* is what is being measured). Per clip, three calls:

| run | what it measures |
| --- | --- |
| cold | first call in the process: probe + scan + frame decode + compose |
| warm (median of 2) | repeat call, analysis cached: formatting only |
| — | cells, sheet geometry, PNG bytes, manifest chars, vision tokens, cut matches |

Cut matching is greedy nearest within **0.5 s**. Two averages appear below and
they are not interchangeable: **micro** F1 pools every cut in the corpus
(41 truth / 59 found for the reference), **macro** F1 is the mean of nine
per-clip F1s. The reference scores 0.720 micro / 0.56 macro, this plugin 0.872
micro / 0.67 macro; both are reported so neither side can pick the flattering
one. The gap between micro and macro is entirely the four clips where the ground
truth has zero cuts and a detector that emits any boundary scores 0 there. Vision tokens use the host's
formula `gridH*(gridW+1)+2` at 42 px cells with the 1024 cap
(see `docs/TOKENS.md`); the reference implementation's own constant says 384,
which understates its real cost by 6–9 %.

The corpus is nine generated clips with frame-exact ground truth
(`bench/corpus/index.json`, `bench/corpus/gt/`): hard cuts including a pair with
**identical luma and different hue**, a 24-cut montage, a slow pan, a bilingual
text slideshow, a 1 s crossfade, 12 single-frame flashes, SAPI speech with
banners, four-level music, and a portrait interlaced phone clip. 235 s total.

## Provenance

The comparison was run twice, by two independent workers, with different scripts
(`bench/final.mjs` + `bench/accuracy.mjs`, and `bench/ab/run-upstream.mjs` +
`compare.mjs`). Cut counts, cell counts, sheet dimensions, tokens and coverage
came out identical both times; only the wall clocks differ by 15–25 %, because
one of the two runs happened while the other was compiling. The frozen snapshot
is `bench/ab/snapshot.json` (combined `src/` hash `1682103d…`, re-hashed before
and after the run so a concurrent edit would have been flagged, and was not).
Where this page quotes a single timing, it is the idle-machine one.

## Headline

| metric | dsh-video-storyboard 0.3.0 | dsh-video-vision | delta |
| --- | --- | --- | --- |
| mean wall, cold | 1450 ms | **634 ms** | **2.3× faster** |
| mean wall, cached | 1168 ms | **411 ms** | **2.8× faster** |
| vision tokens, whole corpus | 3 644 | 3 648 | +0.1 % |
| moments shown (cells) | 36 | **67** | **1.9× more** |
| vision tokens per moment | 101.2 | **54.5** | **46 % cheaper per moment** |
| cut F1 (micro, 0.5 s) | 0.720 | **0.872** | +0.152 |
| cut recall | 0.878 | **1.000** | 5 missed cuts → 0 |
| cut precision | 0.610 | **0.774** | 23 false → 12 |
| shot coverage | 0.766 | **0.963** | +0.197 |
| manifest text per call | 928 chars | **477 chars** | 1.9× less prose |
| sheet PNG | 141 777 B | 152 688 B | similar |

The point of the last five rows: **the same money buys 1.9× more of the video.**
Tokens are spent per moment (54.5 each) instead of per call (a flat 4-cell sheet
no matter what the clip contains).

## Per clip

### Cut detection

| clip | truth | upstream | | | ours | | |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | found | hit | F1 | found | hit | F1 |
| A hard cuts (9 cuts, one luma-flat pair) | 9 | 9 | 9 | 1.00 | 9 | 9 | 1.00 |
| B montage (24 cuts in 20 s) | 24 | 24 | 24 | 1.00 | 24 | 24 | 1.00 |
| C slow pan | 0 | 0 | 0 | 1.00 | 0 | 0 | 1.00 |
| D text slideshow | 5 | **0** | 0 | **0.00** | 5 | 5 | **1.00** |
| E 1 s crossfade | 0 | 0 | 0 | 1.00 | 1 (dissolve) | – | 0.00 |
| F 12 single-frame flashes | 0 | **12** | 0 | **0.00** | 0 | 0 | **1.00** |
| G speech + banners | 0 | 8 | 0 | 0.00 | 8 | 0 | 0.00 |
| H music, 4 sections | 0 | 3 | 0 | 0.00 | 3 | 0 | 0.00 |
| I portrait interlaced | 3 | 3 | 3 | 1.00 | 3 | 3 | 1.00 |
| **total** | **41** | 59 | 36 | **0.720** | 53 | **41** | **0.872** |

Reading the failures:

- **D (upstream 0/5)**. Its scan threshold is `max(12, …)` with an absolute
  floor of 12; a slide that changes its title and bullets but keeps identical
  chrome scores 6.7–11.7, so *every* slide change is invisible. Ours classifies
  the same jump as `partial` (a minority of the 12×7 grid changed) and accepts
  it when the jump is well above the local threshold — 5/5, no false positives.
  Verified by looking: the six cells are CARD 01/06 … CARD 06/06, every title,
  bullet and footer legible at 359 tokens.
- **F (upstream 12 false)**. Twelve one-frame white flashes become 24 score
  spikes; `suppressClose(0.35 s)` merges each on/off pair into a "cut". Ours
  tests whether the picture *restores* within three frames and drops the cut.
  Result: 0 cuts, 1 shot, and the frame picker also stops choosing a flashed
  frame (exposure-outlier penalty).
- **E, G, H are ground-truth artefacts on both sides**, not a win for either.
  E's truth is "3 shots, 0 cuts" where shots 2 is a 1 s crossfade — a dissolve
  boundary is the useful answer, so ours emits one `fade` (counted as 1 false
  positive above). In G and H the *entire frame* changes (title cards, and the
  music sections have different pictures), so a shot detector with no audio
  understanding calls them cuts; both pipelines do. Ours at least spends the
  cells on it: G gets 9 cells alternating SILENCE / SPEECH n/4 cards, which
  reads correctly against the audio band.

### What the sheet shows

| clip | shots | upstream cells (coverage) | ours cells (coverage) |
| --- | --- | --- | --- |
| A | 10 | 4 (0.40) | 10 (1.00) |
| B | 25 | 4 (0.16) | 25 (1.00) |
| C | 1 | 4 (1.00) | 4 (1.00) |
| D | 6 | 4 (0.67) | 6 (1.00) |
| E | 3 | 4 (0.67) | 2 (0.67) |
| F | 1 | 4 (1.00) | 3 (1.00) |
| G | 1 | 4 (1.00) | 9 (1.00) |
| H | 1 | 4 (1.00) | 4 (1.00) |
| I | 4 | 4 (1.00) | 4 (1.00) |

Upstream's overview branch is a fixed 2×2 grid: **four cells, always**, no matter
whether the clip has 1 shot or 25. On B its sheet is a legible picture of M06,
M12, M18 and M25 and nothing else — 21 of 25 shots are never shown, even though
it detected all 24 cuts. Ours spends the pixel budget on moments instead, so B
gets 25 cells holding all 25 shots. The number of cells is not a quota: it is
whatever still keeps every cell above the width at which its contents stay
recognisable, and extra cells are free in tokens because the sheet is billed by
area. A merged group only appears when the pixels run out first — on B that used
to be 20 cells for 25 shots, now all 25 shots get a tile at the same 1 024
tokens.

### Cost of reading text

Upstream's cells are bigger for a given sheet, so pure text pages are *easier*
there — the trade is real and worth stating: its D sheet is 1066×600 with four
530×290 cells; ours is 807×684 with six 400×340 cells. Both are legible at their
token cost (359 vs 407); ours shows 6 of 6 slides, upstream 4 of 6. When text
density is the point, `detail: "low"` gives fewer, larger cells.

## Long films

The corpus clips are 11–40 s, which is why the reference implementation's fixed
four-cell overview looks affordable there. Long video is where the two designs
diverge, so both were run on a **13:03.66** film (`bench/tmp/long/film12.mp4`,
1280x720, 30 fps, 23 508 frames — the nine corpus clips concatenated four times,
so the content is the same domain but the length is realistic).

| | reference | ours |
| --- | --- | --- |
| wall clock | **18 116 ms** | **6 227 ms** (2.9× faster) |
| images in the answer | 2 | **1** |
| cells | 32 | 28 |
| cell size | 265×145 | **331×186** (1.6× the area) |
| image tokens | 814 | 1024 |
| manifest | 2 787 chars (~697 tok) | **1 315 chars (~329 tok)** |
| total context for one question | ~1 511 tok | **~1 353 tok** |
| analysis / decode, ours | — | 3 275 ms / 1 041 ms |


Read the number that is not in the reference's favour first: it spends 814
image tokens where we spend 1024, because it splits the film into two sheets of
sixteen 265×145 tiles, while we put 28 cells at 331×186 on one sheet. At 265×145
a burned-in subtitle is unreadable and a talking head is a smudge. Spending 26 %
more image tokens to make the same moments readable is the trade this plugin is
built around, and it is still cheaper end-to-end (1 353 vs 1 511 tokens of
context) because our manifest is 47 % of its length.

The cell count on a 13-minute film is capped by the sheet rather than the shot
list: 28 cells is the point where a 4×7 grid of 331×186 tiles fills the 1 024
token budget, which is why the 60 remaining shots of the four-times-repeated
film are not given their own tiles. Asking for `detail: "high"` on a long film
buys nothing but a smaller cell; the useful move there is `start`/`end`.

The single image also matters beyond tokens: one image is one attachment the
model can refer to by name, and our index addresses cells inside it. Two sheets
turn every reference into "(r2c3, image 2)".

On the 196 s cut of the same film (nine clips once) the reference takes
3 667 ms, one 2×2 sheet, 4 cells and 881 characters of index; ours 2 273 ms, one
4×7 sheet, 28 cells, 1 024 tokens and 1 260 characters of index.

## Why it is faster

| phase (70 s, 1910×984, 30 fps) | ours |
| --- | --- |
| probe | 192 ms |
| analysis (single rawvideo pass, 2 100 frames) | 1 318 ms |
| frame decode (25 cells) | 1 589 ms |
| compose + PNG | 247 ms |
| **total** | **3 347 ms** |

- One ffmpeg pass for analysis instead of a separate probe-plus-scan.
- **Batched decoding**: up to six seeked inputs share one ffmpeg process with
  one output each, three processes in flight. A 25-cell sheet costs 5 process
  launches, not 75. That is the single biggest win over the reference, whose
  `pick: 'sharp'` decodes three candidates per cell.
- The sharpest frame is chosen from vectors the analysis pass already computed,
  so `pick: 'sharp'` is free (upstream charges +433 ms per clip for it).
- Repeat calls and `textOnly` pages are served from an analysis LRU; a text page
  of a 200-shot film is a formatting operation.

## What the picture cannot tell you

Two things about a clip are not in its pixels, and both are free:

**Dialogue.** An embedded subtitle track is metadata; reading it costs no image
tokens and tells the model what is being *said*, which no contact sheet can.
`docs/EVIDENCE.md` measured it on an 8 s test clip with a `mov_text` track:

```
1 r1c1 00:00.00-00:04.00 @00:02.35 · "Hello from the subtitle track. Second line, still shot one."
2 r2c1 00:04.00-00:08.00 @00:05.98 · "Now we are in shot two."
transcript: subtitle-track · 1 segments
```

Each line is attributed to the cell whose span holds its **midpoint**, so a line
that straddles a cut is quoted once, on the cell it mostly belongs to. (Grouping
cues into sentences first — the obvious implementation — quotes the whole film's
dialogue on every cell it touches. There is a regression test for it.)

**Loudness.** A single 8 kHz mono decode gives speech spans, onsets, silences and
an RMS level; the sheet carries the same span as an envelope strip under the
grid, and the manifest carries one summary line. Clip G (22 s of Windows SAPI
speech, 15.1 s of it actual speech) reports
`speech 48 % · -23 dBFS · loudest 00:01.92 · 5 silences · 28 onsets`. Clip H
(four loud/quiet music sections, 26.85 dB contrast, no narration) reports
`no speech · sound 86 % · -12.9 dBFS` — the word *speech* is not used for a music
bed. The split is a per-span syllabic-modulation test (`levelSd >= 4 dB` and
`hfSd >= 0.05`), measured over the corpus: dialogue scores 6.9–11.6 dB of level
deviation with a moving spectral centroid, music scores 0.9–1.5 dB with a static
one.

## Edge cases that were run, not assumed

| input | behaviour |
| --- | --- |
| 3840×2160, 9 s | 3 cuts exact, 3 cells, 206 tokens, 1 935 ms (probe 256, analysis 549, decode 1 113) |
| 1280×720 with subtitle track | 2 cells, 198 tokens, dialogue quoted per cell |
| two near-black shots (`#050608` / `#090a0c`) | cut found at 4.00 s, `note:` says the clip is flat |
| audio-only `.m4a` | `no video stream (this file is audio only) — "…"` |
| missing path | `file not found — "…"` |
| a directory | `not a file (it is a directory) — "…"` |
| 60 fps source | decimated to ≤30 effective fps; cuts still land on the frame |
| interlaced H.264 (`tt`) | optional `bwdif` deinterlace, off by default (225 vs 169 ms) |
| 13-minute film | one sheet, 28 cells, 1 024 tokens, 6.2 s |

The three error strings are the whole point of the table: a video tool that
pastes 400 characters of ffmpeg stderr into a tool result costs tokens and buries
the cause. These name the mistake and stop.

## Threats to validity

1. **Synthetic corpus.** Nine clips, generated for their ground truth. They are
   adversarial by design (luma-flat cut, flashes, crossfade) but they are not
   film. Real-world spot checks are in `docs/REAL-WORLD.md` (gameplay capture,
   screen recording) — they show the sheets are readable, not that F1 holds.
2. **No model in the loop.** Vision tokens are counted with the host formula,
   not billed by an API. If the host changes its formula, re-run `bench/final.mjs`.
3. **Cut F1 depends on the tolerance.** 0.5 s is generous; at 0.25 s the same
   runs score lower on both sides (upstream reports this too). Timings are
   single-machine and move ±15 % with load; a run made while another job was
   compiling reported 723 ms where the idle machine reports 634 ms.
4. **Coverage is not comprehension.** A cell inside every shot says the shot was
   *shown*, not that the model *understood* it. The readable-text checks in
   `docs/DESIGN.md` were done by eye on the rendered PNGs.

## Reproduce

```bash
export DSH_FFMPEG_PATH=/path/to/ffmpeg
export DSH_FFPROBE_PATH=/path/to/ffprobe
node bench/final.mjs --reps 3                     # ours + table
node bench/ab/run-upstream.mjs                        # the reference, same corpus
node bench/accuracy.mjs auto                      # per-clip cut scoring
node bin/selfcheck.mjs --smoke             # 16 checks, builds its own clip
node bin/selfcheck.mjs --smoke --host      # + the host's own schema engine
node --test test/                          # 155 unit tests
```

`bench/final.json` and `bench/ab/upstream.array.json` hold the raw records these
tables were generated from.
