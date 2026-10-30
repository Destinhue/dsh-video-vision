# Evidence

Every number on this page was produced by the scripts in `bench/`, on this
corpus, on one machine. Nothing is estimated and nothing is vendor-provided.

- Machine: Windows 11, Intel **i9-14900HX**, 15.6 GB RAM, 32 logical cores.
- ffmpeg: **8.0.1** (gyan.dev essentials) from `vendor/bin`; the fallback run
  below also uses **7.1** from an `imageio-ffmpeg` wheel.
- Source: the sha256 prefixes printed for `src/*.js` are
  `frames c4bd70b6 · index 8b7094c7 · layout 3c2ffa5b · manifest 8bf118ef ·
  media 77d2abea · pipeline f45d7c95 · png 6f98c9b3 · scan 549515a1 ·
  sheet b8b5c859 · timeline 140ea562 · tools c0ba2a60`.

  Two changes moved these tables and are why the hashes are quoted: the cell
  count became a **legibility limit** rather than a quota
  (`layout 3c2ffa5b`), which put 25 cells on clip B at the same 1 024 tokens and
  moved coverage 0.941 → 0.963, and audio gained a syllabic test so a music bed
  is no longer called speech (`timeline 140ea562`). Everything below is the
  post-change battery. Successive idle runs put cold wall at 581–648 ms (634 ms
  is the run quoted below) and cached at **370–411 ms** (the frozen
  `bench/results/final.json` is one of those runs, at 602 / 375 ms); that spread
  is the machine, so read the ratios and not the milliseconds.

## Protocol

The pipeline is driven directly as a module (no hosted model in the loop — the
tool *result* is what is being measured). Per clip, three calls:

| run | what it measures |
| --- | --- |
| cold | first call in the process: probe + scan + frame decode + compose |
| cached (median of 2) | repeat call, analysis cached: formatting only |
| — | cells, sheet geometry, PNG bytes, manifest chars, vision tokens, cut matches |

Cut matching is greedy nearest within **0.5 s**. Two averages appear below and
they are not interchangeable: **micro** F1 pools every cut in the corpus
(41 truth / 53 found), **macro** F1 is the mean of nine per-clip F1s. This
plugin scores **0.872 micro / 0.667 macro**; both are reported so the
flattering one cannot be picked silently. The gap between them is entirely the
four clips whose ground truth has zero cuts, where any emitted boundary scores
0. Vision tokens use the host's formula `gridH*(gridW+1)+2` at 42 px cells with
the 1024 cap (see `docs/TOKENS.md`).

The corpus is nine generated clips with frame-exact ground truth
(`bench/corpus/index.json`, `bench/corpus/gt/`): hard cuts including a pair with
**identical luma and different hue**, a 24-cut montage, a slow pan, a bilingual
text slideshow, a 1 s crossfade, 12 single-frame flashes, SAPI speech with
banners, four-level music, and a portrait interlaced phone clip. 235 s total.

## Provenance

The battery was run twice with different scripts (`bench/final.mjs` for latency
and geometry, `bench/accuracy.mjs` for per-cut scoring). Cut counts, cell
counts, sheet dimensions, token counts and coverage came out identical both
times; only the wall clocks differ by 15–25 %, because one run happened while
another job was compiling. The frozen record is
`bench/results/final.json`; `bench/results/snapshot.json` carries the `src/`
hashes of the measured tree. Where this page quotes a single timing, it is the
idle-machine one.

## Headline

| metric | value |
| --- | --- |
| mean wall, cold | **634 ms** (581–648 ms over runs) |
| mean wall, cached | **411 ms** (370–411 ms) |
| sheet PNG | 152 688 B mean |
| sheet, clip B (25 shots in 20 s) | 1 334 × 1 319, 4×7 grid, 25 cells, **1 024 tokens** |
| moments shown (cells), whole corpus | **67** |
| vision tokens, whole corpus | **3 648** |
| vision tokens per shown moment | **54.5** |
| cut F1 (micro, 0.5 s) | **0.872** |
| cut recall / precision | **1.000** / 0.774 |
| shot coverage | **0.963** |
| manifest text per call | 477 chars |
| 13-minute film, one `video_storyboard` call | 6 227 ms, **one** image, 28 cells, 1 024 tokens |

Two numbers here matter together: **67 moments for 3 648 tokens** is 54.5 tokens
per moment shown. The sheet is billed by area, so the cost of the sixty-eighth
moment is zero as long as the grid still has room — the budget is spent on
moments, not on calls.

## Per clip

### Cut detection

| clip | truth | found | hit | F1 |
| --- | --- | --- | --- | --- |
| A hard cuts (9 cuts, one luma-flat pair) | 9 | 9 | 9 | 1.00 |
| B montage (24 cuts in 20 s) | 24 | 24 | 24 | 1.00 |
| C slow pan | 0 | 0 | – | 1.00 |
| D text slideshow (5 slide changes) | 5 | 5 | 5 | 1.00 |
| E 1 s crossfade | 0 | 1 (dissolve) | – | 0.00 |
| F 12 single-frame flashes | 0 | 0 | – | 1.00 |
| G speech + banner cards | 0 | 8 | – | 0.00 |
| H music, 4 sections | 0 | 3 | – | 0.00 |
| I portrait interlaced | 3 | 3 | 3 | 1.00 |
| **total** | **41** | 53 | **41** | **0.872** |

Reading the misses:

- **A** contains the hardest case in the corpus: two consecutive shots with
  identical luma and different hue (0.114 of 219 code values of difference, i.e.
  0.05 % of range). A luma-only detector ranks that cut as "nothing happened".
  This pipeline keeps a 12×7 **chroma** block grid next to the luma one, so the
  cut is found at the exact frame.
- **D** changes only a title and a bullet list on identical chrome: a minority of
  the grid moves. That is classified `partial` and accepted when the jump is well
  above the local threshold — 5/5, no false positives. Verified by looking: the
  six cells are CARD 01/06 … CARD 06/06, every title, bullet and footer legible
  at 359 tokens.
- **F** is twelve one-frame white flashes. They become 24 score spikes, and a
  naive `suppressClose` merges each on/off pair into a "cut". Here a candidate is
  dropped when the picture *restores* within three frames: 0 cuts, 1 shot, and
  the frame picker also stops choosing flashed frames.
- **E, G, H are ground-truth artefacts, and they are counted against us above.**
  E's truth is "3 shots, 0 cuts" where shot 2 is a 1 s crossfade — a dissolve
  boundary is the useful answer, so this pipeline emits one `fade` and takes the
  false positive. In G and H the *entire frame* changes (title cards; music
  sections with different pictures), so a detector that ignores audio calls them
  cuts. It does, and the cells it spends on G alternate SILENCE / SPEECH n-of-4
  cards, which reads correctly against the audio band.

### What the sheet shows

| clip | shots | cells | coverage |
| --- | --- | --- | --- |
| A | 10 | 10 | 1.00 |
| B | 25 | 25 | 1.00 |
| C | 1 | 4 | 1.00 |
| D | 6 | 6 | 1.00 |
| E | 3 | 2 | 0.67 |
| F | 1 | 3 | 1.00 |
| G | 1 | 9 | 1.00 |
| H | 1 | 4 | 1.00 |
| I | 4 | 4 | 1.00 |

The cell count is not a quota. It is whatever still keeps every cell above the
width at which its contents stay recognisable (240 px), and extra cells are free
in tokens because the sheet is billed by area. A merged group appears only when
the pixels run out first: on B, 25 shots in 20 s used to become 20 cells with
five shots unshown, and now all 25 shots get a tile at the same 1 024 tokens.
E is the one clip where coverage is below 1.0 by design — a 1 s crossfade gets
one boundary, so the transition itself is not a separate cell.

### Cost of reading text

Clip D is pure text: six slides at 400×340 px each, 807×684 sheet, 359 tokens,
all six readable. When text density is the point, `detail: "low"` gives fewer
and larger cells (a 2×2 sheet), at the same token cost as any other cheap call.

## Long films

The corpus clips are 11–40 s; the interesting failure is length, so the same
pipeline was run on a **13:03.66** film (1 280×720, 30 fps, 23 508 frames — the
nine corpus clips concatenated four times, same domain, realistic length).

| | one call |
| --- | --- |
| wall clock | **6 227 ms** |
| images in the answer | **1** |
| cells | 28 |
| sheet | 1 334 × 1 319, 4×7 grid |
| cell size | 331×186 |
| image tokens | 1 024 (the cap) |
| manifest | 1 315 chars (~329 tokens) |
| total context for one question | ~1 353 tokens |
| analysis / frame decode | 3 275 ms / 1 041 ms |

One image is not only about tokens: it is one handle the model can refer to, and
the text index addresses cells *inside* it. Splitting a film over several images
turns every reference into "(r2c3, image 2)".

The cell count on a 13-minute film is capped by the sheet rather than the shot
list: 28 cells is where a 4×7 grid of 331×186 tiles fills the 1 024-token
budget. Asking for `detail: "high"` on a long film buys nothing but smaller
cells; the useful move is `start`/`end`.

On the 196 s cut of the same film (nine clips once): 2 273 ms, one 4×7 sheet,
28 cells, 1 024 tokens, 1 260 characters of index.

### Two hours

A 2 h 7053 s composite (the 13-minute film looped nine times, 1280×720) was run
end to end with **no ffprobe on the machine**, so the metadata came from the
ffmpeg banner:

| | one call |
| --- | --- |
| probe | **226 ms** |
| whole call | 38 536 ms |
| analysis (48 000 sampled frames) | 36 557 ms |
| frame decode (28 cells) | 1 488 ms |
| cells / sheet / tokens | 28 · 1 334×1 319 4×7 · 1 024 |
| manifest | 1 448 chars |

The probe figure is the load-bearing one. Before 1.0.1 the banner read ran
`ffmpeg -i … -f null -`, which decodes the whole input before discarding it —
130 s on a file this length against a 60 s budget, so any long video failed
outright on a machine without ffprobe. `-t 0` stops once the input is open and
returns in 226 ms; every line the parser wants is already on stderr by then.
The full two-hour storyboard is still a 38-second call, so the useful move for
lecture-length material remains `start`/`end` windows.

### Lectures, where nothing ever cuts

A lecture is one shot. Planned one cell per shot, an 11-minute stretch of video
became one picture. Past 90 s the planner now counts blocks that changed inside
the stretch instead of the average distance between frames:

| window | 1.2.0 | 1.2.1 |
|---|---|---|
| 19 min of a lecture (2 560x1 440, no cuts) | 4 cells, 2x2, 914x517 | **22 cells, 4x6, 1 457x1 263** |
| its vision tokens | 1 024 | 1 024 |
| corpus battery (9 clips) | 67 cells / 3 648 tokens / F1 0.872 / coverage 0.963 | unchanged |

The corpus is unchanged because no clip in it has a cutless stretch longer than
90 s, which is the point: the rule only fires on the videos that were being
under-served.

### Reading text

`video_read` on the same files, measured on the machine described above
(Windows built-in OCR, no model, no network):

| input | wall clock | screens | characters |
| --- | --- | --- | --- |
| 2-hour lecture (`\u7b2c\u4e8c\u6b21\u8bfe`, 2560x1440) | **91 s** (scan 11 / grab 39 / OCR 40) | 56 | 7 588 |
| same lecture, 15-minute window | 16 s | 9 | 1 180 |
| 36-second text-card clip (corpus D) | **1.1 s** | 6 | 584 |
| 34-minute hand-written summary (B\u7ad9) | 6 s | 0 | --- |

The hand-written video is the interesting row: it returns **no screens** and a
note saying why. It has content, but not text this can honestly quote.

The outline recovered from the 2-hour lecture names examples 1-11 at
00:45 / 05:27 / 17:20 / 27:58 / 41:05 / 56:16 / 67:34 / 76:44 / 85:38 / 90:10 /
103:13 --- which is the structure of the lecture, derived from the pictures.

A B\u7ad9 link costs one HTTP call for `video_probe` (**226 ms, no download**), and
the first storyboard or read pays for the download once: a 3:33 music video is
49.6 MB, a 34-minute 720P lecture is 51.7 MB (about 55 s on this connection), and
the file is cached under `$DSH_HOME/cache/video-vision/bilibili/` for every call
after that.

## Why it is fast

| phase (70 s, 1 910×984, 30 fps) | |
| --- | --- |
| probe | 192 ms |
| analysis (single rawvideo pass, 2 100 frames) | 1 318 ms |
| frame decode (25 cells) | 1 589 ms |
| compose + PNG | 247 ms |
| **total** | **3 347 ms** |

- One ffmpeg pass for analysis instead of a probe plus a separate scan.
- **Batched decoding**: up to six seeked inputs share one ffmpeg process with one
  output each, three processes in flight. A 25-cell sheet costs 5 process
  launches, not 75.
- The sharpest frame in each shot is chosen from vectors the analysis pass has
  already computed, so `pick: "sharp"` is free — no extra decode.
- Repeat calls and `textOnly` pages are served from an analysis LRU; a text page
  of a 200-shot film is a formatting operation.

## What the picture cannot tell you

Two things about a clip are not in its pixels, and both are free:

**Dialogue.** An embedded subtitle track is metadata; reading it costs no image
tokens and tells the model what is being *said*, which no contact sheet can. On
an 8 s test clip with a `mov_text` track:

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
2. **No model in the loop.** Vision tokens are counted with the host formula, not
   billed by an API. If the host changes that formula, re-run `bench/final.mjs`.
3. **Cut F1 depends on the tolerance.** 0.5 s is generous; at 0.25 s the same run
   scores lower. Timings are single-machine and move ±15 % with load — a run made
   while another job was compiling reported 723 ms where the idle machine
   reported 634 ms.
4. **Coverage is not comprehension.** A cell inside every shot says the shot was
   *shown*, not that the model *understood* it. The readable-text checks in
   `docs/DESIGN.md` were done by eye on the rendered PNGs.

## Reproduce

```bash
export DSH_FFMPEG_PATH=/path/to/ffmpeg
export DSH_FFPROBE_PATH=/path/to/ffprobe
node bench/final.mjs --reps 3          # latency, geometry, tokens, coverage
node bench/accuracy.mjs auto           # per-clip cut scoring against ground truth
node bin/selfcheck.mjs --smoke         # 16 checks, builds its own clip
node bin/selfcheck.mjs --smoke --host  # + the host's own schema engine (29 checks)
node --test test/                      # 161 unit tests
```

`bench/results/final.json` holds the raw records these tables were generated
from.

## Prior art

The contact-sheet approach — one image with burnt-in indices plus a text index
that binds them to timecodes — comes from
[`SAOS-3624/dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard),
which showed it could be done with no image library at all. Thank you. This
package is an independent implementation with different detection, budgeting and
composition internals; it deliberately keeps the same three tool names and
manifest grammar so it can stand in where that plugin is already in use. See
`NOTICE` for the attribution.
