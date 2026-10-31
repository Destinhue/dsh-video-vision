# How dsh-video-vision looks at a video

This document is the reasoning behind the code. Every number in it was measured
on this machine, on the synthetic corpus in `bench/corpus` (nine clips with
frame-exact ground truth) and on real files, with `bench/accuracy.mjs`.

---

## 1. The problem with "one contact sheet"

A text-only agent cannot watch a video. The cheapest useful substitute is an
image: a grid of frames, one per moment, with the times written next to it. That
is what every storyboard tool does, and the whole craft is deciding **which
moments**, **how many**, and **how big**.

The naive answers are all wrong in a specific way:

| naive choice | what breaks |
| --- | --- |
| one frame every N seconds | cuts land between frames, two-cell-wide events get one cell, static scenes eat the budget |
| one cell per cut | a 25-cut montage becomes 25 cells smaller than a face; a two-hour film becomes unusable |
| a fixed 3x3 grid | a slow 30 s pan gets nine identical pictures; a dense action beat gets three |
| big cells, few of them | on-screen text is legible but the film's structure is invisible |
| small cells, many of them | the model can see *something happened* but cannot read it |

The design below replaces each of those with a decision that is measured, not
assumed.

---

## 2. Scan: one ffmpeg pass, then everything is arithmetic

`src/scan.js` decodes the whole window **once**, at 96x54, as raw RGB:

```
ffmpeg -ss S -t W -i FILE -vf fps=F,scale=96:54:flags=fast_bilinear,format=rgb24 -f rawvideo -
```

At 96x54 a 40 s clip is 4.6 MB and a two-hour film is 1.4 GB of raw bytes that
never leave the pipe — the analyser reduces each frame as it arrives, so memory
stays flat at `capacity x 96 x 54 x 3` bytes.

Per frame it keeps:

- **12x7 block means of luma** (`Int8Array`, 84 bytes/frame) — the geometry of
  the picture, coarse enough to survive noise.
- **12x7 block means of chroma**, as `(r-y)` and `(b-y)` — because a cut between
  two shots of *equal brightness* is invisible to a luma-only detector, and that
  is exactly the case a real film throws at you (a day scene to a differently
  graded day scene).
- A few scalars: Laplacian variance (`sharp`), edge energy, mean brightness,
  detail, saturation.

### 2.1 Score between consecutive frames

```
dY     = mean |luma_i - luma_{i-1}|                     normalised / 90
dC     = mean |chroma_i - chroma_{i-1}|                 normalised / 70
dBlock = mean |block_i - block_{i-1}|                   normalised / 100
score  = 0.34*dY + 0.20*dC + 0.46*dBlock
```

The block term carries the most weight because it is the one a *pan* does move
and a *cut* does not: a pan translates a gradient, a cut replaces it.

### 2.2 Threshold from the clip, not from a constant

```
thr = max(1.6, median + 7*MAD, p99*0.22)
```

A fixed floor of `8` (the obvious choice) silently deleted three of the five
real cuts in a slideshow whose cuts scored 7.0–11.2 against a background of
0.2 — a 40x gap that a constant cannot see. The MAD term adapts to noisy
footage; the `p99` term adapts to a clip that is *all* cuts.

### 2.3 Not every jump is a cut

Candidates (local maxima above `thr`) are classified by comparing the block
grid at `i-1` and `i+1` (`classifyJump`):

| verdict | test | example |
| --- | --- | --- |
| **cut** | ≥35 % of blocks changed by >14 luma | a new shot |
| **partial** | 10–35 % changed, but the jump is ≥4x the threshold | a slide whose text block changed |
| **overlay** | ≥85 % of active blocks unchanged | a caption appearing, a logo, a cursor |
| **light** | chroma almost identical, luma changed uniformly | a lamp switching on |
| **noise** | <10 % of blocks changed | a single frame of compression damage |

The "partial" escape is what lets a slideshow — six cards that share the same
chrome and differ only in the title — be recognised as six shots, while a bar
sliding across the frame is not.

### 2.4 Flashes are not shots

A camera flash, a lightning strike, a one-frame white flash: the picture returns
to itself within a few frames. A real cut does not. Checked directly:

```
after = blockSad(i-1, i+1+3)   ;   base = blockSad(i-1, i)
flash if after < 0.35 * base
```

Twelve flashes in a clip now produce zero cuts instead of nine.

### 2.5 Dissolves and blur transitions

A dissolve is a *plateau* of medium scores, not a spike. Detected as a window of
0.9 s where the cumulative change is ≥ `max(26, 2.6 × the clip's median window
change)` **and**:

1. no hard cut or flash inside the window (those inflate the sum — without this
   test every real cut in a clip grew a phantom "fade" 0.32 s before it);
2. the two ends of the window differ across ≥35 % of the grid (a sliding square
   changes few blocks);
3. it is a **transient**: the change rate *after* the window is less than 0.55x
   the rate inside it. Continuous motion keeps the same rate before and after,
   which is how two phantom fades in a flicker clip were removed.

A slow pan fails all three by construction, which is why it produces no cuts.

---

## 3. Cells: the budget is pixels, and pixels are not cells

The host bills an image by **area**, not by content:

```
tokens = gridH * (gridW + 1) + 2      with 42 px cells
gridW  = ceil((w/3)/14)   gridH = ceil((h/3)/14)
```

capped at 1024 tokens per image, with anything under 544x544 upscaled to 544x544
before billing. That single fact reorganises the whole layout problem:

> **Ten cells in a 1.25 Mpx sheet cost exactly what four cells cost.**
> The question is not "how many cells can I afford" but "how many cells fit
> before a cell stops being legible".

So the sheet is sized **per cell**, not per sheet:

```js
sheetPixelsFor(n, detail) = clamp(n * perCell, 300_000, preset.max)
```

with `perCell ≈ 92 000` at `auto` and a ceiling at the 1024-token cap (≈1.76 Mpx).
Six cells get 552 kpx (≈350 tokens); twenty cells get 1.76 Mpx (≈1000 tokens).
A cheap clip stays cheap; a dense clip spends more because it has more to show.

### 3.2 A cutless stretch is not one moment

Every rule above assumes a cut tells you where the picture changed. A lecture
breaks that assumption: eleven minutes of video, one shot, and the thing the
agent came for is what appeared minute by minute.

The distance used elsewhere — mean movement over the whole frame — cannot answer
this. Two frames of the same slide differ by a few grey levels on average even
though a whole formula was added, so the planner correctly concluded "same
picture" and spent one cell on the window.

So for a unit longer than `boardMinSeconds` (90 s) the planner switches question,
from *how far apart are these pictures* to *is there anything new to read*:

```js
pictureChangeFraction(scan, i, j)   // share of the 12x7 block grid whose luma
                                    // moved >14, skipping blocks dark in both
findBoardMoments(unit, scan)        // local peaks of the frame score, above
                                    // max(1.6, threshold/2), 30 s apart
boardCandidate(unit, scan, chosen)  // strongest unused peak, sampled 0.2 s after
                                    // it so the new line is complete, kept when
                                    // >= 2% of the picture is new
```

Cap: `min(24, 1 + floor(dur/30))` cells. Spans are then rebuilt from the
midpoints between chosen frames, so the timeline stays gapless and a cell's
`[t0, t1)` still means "this picture was on screen then".

Measured on the 19-minute window of a lecture: **four cells became twenty-two**,
at the same 1 024-token sheet budget. The corpus is untouched (no clip has a
cutless stretch that long), so a talking head, a still, a slideshow and a music
video plan exactly as before.

### 3.1 Which moments (`planCells`)

1. **Floor**: one cell per shot. A shot is the unit of "the picture changed",
   which is the only signal that is both robust and cheap.
2. **Merge only when the pixels run out**: the budget is
   `min(asked, preset.maxCells, maxCellsByPixels(preset, aspect))`, where
   `maxCellsByPixels` keeps every cell at least 240 px wide for this clip's
   aspect. A 25-shot montage therefore shows **25 cells** at the same 1 024
   tokens a four-cell sheet costs (coverage 0.80 → 1.00 on clip B), while a 9:16
   portrait clip merges sooner because 240 px wide is a quarter of its frame.
   Counting cells was the wrong control: area is what is billed.
3. **Spill**: leftover budget goes to a shot that has (a) room
   (`1 + floor(dur/10)` cells, max 6) and (b) a frame that is *2.5x further* from
   every chosen frame than the "same picture" threshold. A static talking head
   never earns a second cell; a long pan does. A single-shot clip is exempt from
   (b) — there is nothing else to spend the budget on, so it spreads over time.
4. **Frame choice inside the shot** (`bestFrameIndex`):
   `log1p(sharp)*0.55 + log1p(detail*100)*0.30 + central*0.45`, where `central`
   penalises the frames nearest the cut — the ones most likely to be a
   transition blend. Motion-blurred and mid-dissolve frames are never picked.

### 3.2 Which shape (`planGrid`)

Grid and cell size are solved together from the area budget and the cell aspect:
for every `(cols, rows)` that fits, solve the quadratic for the cell width, then
score by squareness (a squarish sheet tiles better) minus padding waste. A
16:9 clip with six cells lands on 2 cols x 3 rows with 16:9 cells, not on a 3x3
grid with two empty holes.

---

## 4. Decoding: one process per sheet, not one per frame

The obvious implementation spawns ffmpeg once per cell (and once per candidate
when it wants the sharpest of three). For a 20-cell sheet that is 60 process
launches and 60 seeks.

`src/frames.js` opens **several inputs in a single ffmpeg process**, one output
each:

```
ffmpeg -ss 12.0 -i clip.mp4 -ss 31.5 -i clip.mp4 ... \
       -map 0:v:0 -frames:v 1 -vf scale=W:H:flags=lanczos+accurate_rnd,format=rgb24 -f rawvideo -y c0.bin \
       -map 1:v:0 -frames:v 1 -vf ... -y c1.bin ...
```

Six inputs per process, three processes in flight. A 20-cell sheet costs 2–4
process launches instead of 60. Failed cells are retried 80 ms earlier (the
`-ss` before `-i` seek can land a frame short on some containers), then reported
as missing rather than fatal.

`lanczos` is not decoration: `fast_bilinear` on a 1280→330 px downscale destroys
exactly the small text the cells exist to preserve.

---

## 5. The text index: where the tokens go to die

The manifest (`src/manifest.js`) is the half of the tool that a text-only caller
actually reads. Rules:

- **One line per cell, fixed shape** so a caller can parse it with a regex and a
  model can scan it with one glance:
  `3 r2c1 00:08.00-00:12.00 (2) @00:10.02 =cell 2 · "dialogue"`
- **Timecodes are centiseconds**, never burned into pixels. Pixels are the
  scarce resource; a five-glyph timestamp costs ~140 px of a cell that could be
  showing the film.
- **No prose.** Reading instructions live in the tool description, which is part
  of the cached prompt prefix and is paid once, not in every result. The
  the design that repeats its reading rules in every result spends ~700 tokens
  per call re-explaining how to read its own
  output; this one spends zero, and the description is shorter than the prose it
  replaced.
- **`=cell N` for duplicates.** When a merged group's picture repeats one
  already on the sheet it is referenced, not redrawn — the timings stay, the
  pixels do not.
- **`textOnly` + `cellRange` for paging.** The first call on a long film returns
  a truncated index; re-calling with `textOnly:true` costs no image at all, and
  the analysis is cached (`CACHE_LIMIT=6`, keyed by path+size+mtime+window+
  detail) so the second call is formatting only.

---

## 6. Audio, because silence is information

`src/timeline.js` decodes the audio track once at 8 kHz mono and computes 40 ms
RMS bins, plus a per-bin spectral-centroid ratio `sum((x[i]-x[i-1])^2) / sum(x[i]^2)`
— the cheapest available stand-in for "how bright is this bin". It is
**not** speech recognition — no model, no network, no key.

Three decisions were forced by clips, not by taste:

- **Double-threshold span detection.** A single threshold fragments a sentence
  into one span per word: clip G measured 8.12 s of "speech" out of 15.1 s of
  real speech. Spans now enter at `floor` and leave only below `floor - 12 dB`
  after 0.3 s of quiet, which bridges syllable closures while still splitting
  sentences at their 1.4–1.8 s pauses.
- **A floor that tracks the recording.** `p55` is the obvious floor and it fails
  on a clip that is loud end to end — it reported *nothing* for a vlog. The floor
  is `max(-42 dB, min(p20 + 10 dB, -28 dB))`: above the noise bed, below
  everything worth counting.
- **Speech is a shape, not a level.** Any sustained loud span used to be called
  speech, so a music-only clip reported `speech 45 %`. A span is dialogue when
  its level deviation is ≥ 4 dB (syllables swing) **and** its centroid ratio
  varies by ≥ 0.05 (consonants move the spectrum). Measured: dialogue 6.9–11.6 dB
  / 0.11–1.21 and music 0.9–1.5 dB / 0.00–0.01, so the thresholds sit in a wide
  empty gap rather than on a knife edge. The manifest keeps the two concepts
  apart: `speech 48 % · -23 dBFS` for narration, `no speech · sound 86 %` for a
  music bed.

What it buys:

- the manifest can say `audio: speech 48% · -23 dBFS · 5 silences · 28 onsets`,
  which is often the answer to "is this a talking-head clip or a music video";
- the sheet can carry a one-pixel-tall envelope band under the grid, so a musical
  build or a sudden silence is *visible* in the same image;
- `shotWeight` can prefer shots with speech when the budget is tight.

A real subtitle track, when the container has one, is extracted with
`-map 0:s:0` and quoted per cell — that is the only kind of transcription that
costs nothing and is exact. Cues are attributed by **midpoint**: grouping them
into sentences first is the obvious implementation and it quotes the whole film's
dialogue on every cell it touches.

---

## 7. What is unusual here, in one list

1. **Chroma-aware cut detection.** Equal-luma cuts are a real category, not an
   edge case, and a luma-only score cannot see them.
2. **Five-way jump classification** (cut / partial / overlay / light / noise)
   instead of one threshold.
3. **Flash rejection** by picture-restoration, not by brightness.
4. **Transient test for dissolves** — the change must stop afterwards.
5. **Per-cell pixel budgeting** — the sheet grows with the number of moments
   because tokens follow area, not cell count.
6. **Merging by weight** when shots outnumber cells, instead of shrinking cells
   below legibility.
7. **Batched decoding** — one process per group of six cells.
8. **Zero prose in results.** All guidance is in the (cached) tool description.
9. **Cache-first design** — `textOnly` paging and windowed re-reads are free.
10. **No OCR, no ASR, no model download.** The plugin is arithmetic over ffmpeg
    output; the only model in the loop is the one reading the sheet.

## 8. Measured and rejected

These were built or tried, measured, and dropped. They are here so nobody
re-implements them and expects a win.

**Sample the scene-change pass at 20 Hz instead of 30 Hz.** On paper a cut is a
whole-frame event and 20 Hz still leaves seven frames per 0.35 s gap, so a
lower rate should cost nothing and save a third of the work. Measured on the
corpus: the 40 s and 20 s clips did not speed up at all (decode is per-frame;
the `fps` filter drops frames *after* decoding them), and `E_blurtransition`
gained a phantom cut while `I_portrait_interlaced` lost a real one — micro F1
0.872 → 0.851 and recall 1.000 → 0.976 for no measurable time. A duration-based
rate ladder (30 / 24 / 15 Hz) restored the corpus exactly but still moved the
13-minute film's analysis by 0 ms (3 391 → 3 499, i.e. noise: ffmpeg decodes
every frame regardless). Reverted.

**Split the scan across N parallel ffmpeg processes.** Thirteen concurrent
60-second chunks of the 13-minute film finished in 4.98 s versus 4.15–4.30 s
serial: ffmpeg already saturates the machine's cores inside one process, so
chunking only adds seek overhead. Reverted before it was ever merged.

**Decode only keyframes (`-skip_frame nokey`) for cut detection.** Tempting —
cuts usually start a GOP — but a dissolve or a flash has no keyframes, so the
soft-transition and flash detectors would go blind, and the frame grid would
stop matching the timeline. Not built.

**Use `-threads` / `-filter_threads` to speed up the scan.** Measured: 60 s of
video scans in 1.08 s single-threaded and 0.37 s at 8 threads — but ffmpeg's
default already picks the core count, so there is nothing left to claim.

**A global "same picture" test across the whole clip** (to drop cells that
repeat a previous shot). It merges clip D's six text cards into one cell: they
differ only in a title and three bullet lines, which is exactly the content the
model was asked to read. The current rule compares only within a shot.

## 9. Reading text: what the agent needs from a lecture

A picture of a slide is a lossy re-encoding of text that is already digital. When
the video is a lecture, a screen recording or a slide deck, the useful output is
not a grid of thumbnails but the words, each stamped with when it was on screen.

`video_read` decodes **only keyframes** (`-skip_frame nokey`, positioned before
`-i`), because a slide cannot change between two of them. On the 2-hour corpus
lecture that is 975 frames instead of 216 000: **11 s of decoding for the whole
video**. Neighbouring keyframes are clustered by picture change on a 96x54 luma
grid, one frame per cluster is grabbed 0.35 s after the keyframe (a keyframe can
land mid-scroll), and all of them go through one OCR process.

The judgement calls, in the order they failed on real files:

1. **Geometry beats a crop list.** A fixed slide-area crop learned from one
   recorder cuts the first character off a card that starts at the left edge.
   The crop is now a conservative top/bottom trim; the filtering is per OCR line,
   by position: short line near the top edge, short line at the bottom edge.
2. **Furniture is whatever is on most screens.** A clock reads a different time
   on every frame, so an exact-line test never fires. Lines are keyed twice, with
   and without digits; the digit-free key may only delete short lines that appear
   on nearly every screen, which is why `例题 1` and `例题 2` survive together.
3. **Shape, not length, separates text from strokes.** Hand-writing OCRs into
   eight-to-ten invented characters in a row --- long enough to pass a length
   test, useless as a quote. Real text arrives with punctuation, a decimal point,
   a bracket or an `=`.
4. **Under three readable screens, quote nothing — but do not return nothing.**
   Two fragments of strokes are not a reading, so the result says what was
   probably going on; and because the caller asked for a file and got no
   document, it now also returns six changed frames composed into one sheet. The
   honest answer to "there is no text here" is the pictures that are there.

Cost of a 2-hour lecture: **87 s** wall clock (the instrumented run split it as
11 s scan, 39 s grab, 40 s OCR), 53 screens, 7 663 characters, plus an outline
that finds all eleven worked examples. A 36-second text-card clip is 1.1 s.
Against the storyboard path on the same lecture (163 s, one 1 024-token image,
text unreadable at that size) this is the cheaper and more useful answer whenever
the content is text on screen.

## 10. Why speech-to-text is a hook and not a feature

The obvious next step after reading the screen is reading the soundtrack, and it
is the one thing this plugin deliberately does not do by itself.

Three reasons, each measured on this machine against a real 1:59:54 lecture at
2560x1440:

1. **The host's built-in recogniser is not usable.** `System.Speech` zh-CN (which
   ships with Windows and needs no download) turned 60 s of this lecture into a
   single 60-character line of nonsense at **1.7 % confidence**. Shipping that
   behind an "ASR" label would be worse than returning nothing.
2. **A usable model is a download.** `faster-whisper` int8 on 16 threads takes
   2.5 s for two minutes with `tiny` — and writes `選抜` for 选法. With `small` it
   takes 15.5 s for the same two minutes (about 15 min for two hours) and is
   readable. That is a 75 MB or 484 MB artifact with its own licence, inside a
   plugin that is 600 KB of code with zero dependencies.
3. **It would break the latency promise.** Two hours of lecture costs 87 s through
   `video_read` today. Adding `small` ASR to every call makes it ~16 minutes, for
   text that is often *worse* than the slides it would be attached to: OCR reads
   递推 and 阶乘 correctly, the recogniser writes 地规 and 階層.

So the split follows the content: slides and screen recordings go through the OCR
path, speech-only material goes through whatever engine the user points
`DSH_ASR_CMD` at, and a file with both gets the cheap path first plus `start`/`end`
windows for the parts that matter.

The adapter is a hundred lines because the hard parts are not the model: they are
extracting the audio once, keeping timestamps on the file's clock instead of the
window's, and attributing each line to the cell whose span contains its midpoint —
the same rule the subtitle track uses, which already had a test for the sentence
that straddles a cut.

## 11. What the client owes the recogniser

A recogniser is asked one question — "what was said" — and it answers with three
things you did not ask for: invented speech over music, a vocabulary of its own,
and segment boundaries that land wherever the model felt like stopping. The first
two are fixed here because they are cheaper to fix once than to notice later; the
third is fixed by the part of the pipeline that already knows where sentences end.

**Invented speech is the dangerous one**, because it is plausible. A 90-second PV
with one spoken line came back with a fake 29-second segment over the
instrumental; cells quote dialogue by time overlap, so that single fake line was
printed on five cards — the same garbage five times, which reads as confidence.
Two measurements separate the cases: real speech runs 2–6 characters per second,
and a hallucinated line runs under 0.8 over eight seconds or more. Both shapes are
dropped, and the count is printed, because a silent filter is indistinguishable
from a broken recogniser.

**The vocabulary belongs to the user.** `递推 → 地规` and `阶乘 → 階層` are not
model errors you can prompt away; they are the training distribution showing
through. A dictionary in `~/.dsh/asr.json`, applied longest-key-first in one pass,
fixes the words that matter for the cost of one JSON file. `String.replaceAll`
would expand `$&` in the replacement, so the replacement is literal by
construction.

**Boundaries belong to silence.** A cell that ends inside a sentence quotes half a
sentence on both of its neighbours, and the model reading the manifest has no way
to tell which card the words were spoken over. Silence midpoints are exactly the
right place to cut, so boundaries within 1.5 s of one move there — with a floor of
0.3 s per cell, so the snapping can never manufacture a zero-length tile.

**What was tried and dropped:** feeding speech density back into the cell count.
It sounds right — talk-heavy stretches deserve more pictures — and it is wrong for
the material at hand: a talking head is the same picture whether or not somebody is
speaking, so the extra cells are near-duplicates. Slides earn cells from *picture*
change (board mode, §9), narration earns its own tool (`video_read`), and the two
meet in the manifest, where each cell quotes the lines that were spoken over it.

## 12. Telling the client which cells are too small

A dense sheet is the whole point: twenty-two moments for the price of four. The
bill comes due on the cell — a subtitle line 34 px tall in a 720P source is
10.6 px in a 400x225 cell, and a line of prose on a 1440P slide is 4 px, which is
not text any more, it is texture.

The client cannot tell by looking. It sees a perfectly good picture of a slide
and does not know that the equation in the middle is a grey bar. Asking it to
"read the sheet" produces confident nonsense; asking it to re-read the whole
sheet at a bigger size costs a second image for one cell's worth of information.

So the sheet comes with an opinion. Each cell is decoded at twice the cell size
anyway (the measurement rides on a decode that was already happening), the ink in
it is measured at that finer scale, and the shrink factor of the sheet turns that
into a sentence about the cell: at 6.4x, anything under about 77 source pixels is
gone from this sheet.

Three decisions worth recording:

- **The rule is about the sheet, not about the content.** "This cell is shrunk
  6.4x" is arithmetic. "This cell contains text" would be a guess, and a guess
  that has to be right per cell or the marker becomes noise. The ink measure only
  gates out cells where zooming cannot add anything (black frames, flat cards).
- **Images are priced by area, so the marker is free.** The measurement adds no
  tokens and no image; it adds one line to the text index, and only when some
  cell is actually below the line.
- **When every cell needs a zoom, say it once.** Twenty-two "zoom" tags is
  noise; one line that says "every cell is shrunk 7x, text under 84px is gone —
  zoom the ones you need, or re-call with detail low" is an instruction.

Measured: 5 cells of a 1440P lecture at 7.02x, all flagged; 28 cells of a 720P
music video at 3.87x, 27 flagged (the one of pure sky is not); the 720P corpus at
3.2x flags nothing, and the decode path there is byte-for-byte the old one.

## 13. A map of the file that draws nothing

Every question about a long video arrives before anybody knows which minute matters.
A contact sheet answers "what does this look like", and it answers it for one window at
1024 tokens; asked about two hours, that is the wrong shape of answer twice: too expensive
to run broadly, and it still does not say *where* to look.

`video_outline` is that first question answered in rows. The file is cut into equal
windows (4–60, default 24), each row prints the window's span, its cut count, the share of
it that is speech, an eight-slice intensity bar and at most two tags — `dark`, `static`,
`quiet`, `busy`, `talk` — and the tail of the answer names the windows worth opening with
the exact `start`/`end` to open them with:

```
dsh-video-vision-promo.mp4 · 00:57 · 13 cuts · speech 97% · 8 windows of 00:07
   4  00:21-00:28  ████████  cuts 3  speech 100%  busy talk
watch first: 4 (00:21-00:28, 3 cuts, speech 100%) · 2 (00:07-00:14, 2 cuts, speech 100%)
next: video_storyboard start=21 end=28 for the pictures, video_read start=21 end=28 for the words
```

Measured: 1.9 s for that 57-second clip, 2.6 s for a 70-second gameplay capture
(24 cuts in 8 windows), 0.9 s for a 40-second corpus clip. **Zero vision tokens** — not
"few", zero, because no frame is composited and no image is attached.

Four decisions:

- **Equal windows, not shots.** A shot list of a lecture is one row ("00:00–1:59:54"), which
  is true and useless. Equal windows guarantee the answer covers the file and that every
  row is comparable with every other row.
- **The bar is arithmetic on what the scan already computed.** Cuts, motion, speech share
  and loud events are all in the single analysis pass that the storyboard would run anyway,
  so the map costs one pass and nothing else. It is not a second decoder.
- **Ranking is cuts first, speech second.** "Which minute is busy" is mostly "which minute
  has new pictures"; speech breaks ties, which is why a talking-head segment with no cutting
  still surfaces. The order is fixed and printed, not a score the reader has to trust.
- **The answer ends with the next call.** A map that does not say `start=21 end=28` leaves
  the client to convert timecodes into arguments, and it will get that arithmetic wrong.

## 14. When there is no picture to look at

Two files break the assumption that a video is pictures: one has none at all, and one has
only pictures that a recogniser cannot read.

**Sound without a picture.** An mp3, m4a or wav used to fail inside the probe with
"no video stream" — correct, and useless. `video_read` now probes first and, if the stream
list has audio but no video, reads the file as a transcript: the container's subtitle track
first, then `DSH_ASR_CMD`, then a `transcriptFile` the caller already has. With none of the
three it refuses with all three ways out in one sentence, naming the codec and duration so
the caller knows the file was understood. `video_probe` returns the same metadata with
`plan: null`, and the two picture tools say "there is no picture to sample; `video_read`
transcribes audio" rather than failing on a frame that will never arrive. The document is
the same shape as a lecture reading — `[mm:ss] text` lines, a note that says this is speech
and not screen, and `out` writes SRT or VTT.

**Pictures that are not text.** A camera pointed at a whiteboard, handwriting, a capture of
a game whose only "text" is a chat overlay: OCR returns stubs, the furniture filter removes
the rest, and the old answer was an empty document plus advice to call `video_storyboard`.
That is two round trips to arrive at "there is no text here". Now, when zero usable screens
remain, the six most-changed frames are decoded and composed into **one sheet** and returned
as images, with a note that these are the evidence the file carries. The rule is unchanged
about *what* counts as text — the fallback changes only what is done with the answer "none".

Measured on a synthetic 480x270 colour-bar clip with no text: six cells, one PNG, and a
document that says `no readable text` instead of an empty one. The path this was built for
is a real screen capture whose chat panel OCR'd into 37 screens of two-character stubs —
that file still goes down the text path, because its "text" is garbage, not absent; the
fallback is for files with no text at all.

## 15. A cell is never a smear

`auto` used to fill a 1.76 Mpx sheet with 28 cells whatever the source was. The budget is
right — a bigger sheet would cost more tokens, and tokens are the thing to conserve — but
the arithmetic ignored what the sheet is *made of*: 28 cells of a 1440P source are 188 px
tall, one seventh of the source height, and no amount of budget fixes a cell that no longer
resolves a line of text.

The rail is one sentence of arithmetic: **no cell smaller than a fifth of the source
height**. Cells are laid out on a grid, so the cell height fixes the count, and the count
fixes the sheet's pixels; the sheet keeps its token budget and spends it on fewer, larger
cells:

| source | cells | sheet | cell height | vision tokens |
|---|---|---|---|---|
| 720p | 28 | 1334x1319 | 188 | 1 024 |
| 1080p | 21 | 1441x1221 | 204 | 1 024 |
| 1440p | 11 | 1468x1105 | 276 | 974 |
| 2160p | 5 | 1400x1185 | 395 | 1 017 |

Three things worth recording:

- **A fifth, not a half.** At half the source height a 1440P sheet holds two cells; the
  sheet stops being a sheet. At a fifth the smallest text that was legible in the source
  survives, and 4K still gets five moments rather than one.
- **It reports itself.** When the rail binds, the result says `sheet reduced from N to M
  cells so text stays legible`, because a silent clamp reads exactly like a sheet that was
  always planned that way.
- **An explicit `cells` argument still wins.** The rail is a default, not a ceiling: asking
  for 24 cells from a 4K file is a decision, and it is honoured without a note.

The corpus is 720p, so the rail does not touch the measured numbers: same 67 cells, same
3648 tokens, same sheet bytes.

## 16. Ten minutes in, read the keyframes

Cut detection wants every frame; a long file does not have the budget for that. Above ten
minutes, when keyframes are at least a second apart, the analysis pass decodes **keyframes
only** (`-skip_frame nokey`) and treats each keyframe as standing for its interval. Measured
on the two-hour lecture: **2.7× faster** for the analysis pass, with the same storyboard
plan.

Two guards, both from failure modes:

- **Short windows decode fully.** Below 600 s the picture changes faster than the keyframe
  interval — a 95-second clip has ~20 keyframes but ~80 real changes — so the dense path is
  kept and only long files take the fast one.
- **Dense keyframes are not worth skipping.** If the measured keyframe gap is under 1 s,
  decoding keyframes saves nothing and costs accuracy; the full decode runs.

The result says which pass produced it, prints the measured gap, and names the knob
(`DSH_SCAN_KEYFRAMES=off` to force the full decode, `=force` to force keyframes). A change
shorter than the gap is invisible in keyframe mode, and that is a real limitation of a real
speedup, so it is stated in the answer rather than hidden in a doc.

## 17. Engines and links are somebody else's problem, until they are not

Three things this plugin refuses to own — the OCR engine, the recogniser, the video site —
and what it does instead when they are missing.

**OCR: three backends behind one interface.** `Windows.Media.Ocr` is built in and needs no
download, which is why it was the only backend for a year. It is also Windows-only, so a
Linux host got a refusal for a job that `tesseract` could do. `ocrBackend()` now answers
with one of three: the Windows engine, `tesseract` from `PATH` (TSV output keeps the line
boxes the furniture filter needs), or whatever `DSH_OCR_CMD` points at. All three return
the same shape — text plus line boxes plus image size — because everything downstream
depends on boxes, not on the engine. `DSH_OCR_BACKEND` pins or disables one
(`windows`/`tesseract`/`off`), and `DSH_OCR_LANG` passes `-l` through. With no engine the
tool still says so, in one sentence that names all three ways to get one.

**ASR: the chunking is the client's job.** Handing a recogniser one 230 MB hour-long wav
is how a two-hour lecture turns into an OOM. Windows longer than 45 s are therefore cut
before the engine sees them: one decode pass listens for pauses, each 45 s aim is walked
back to the last silence midpoint at least 12 s into the chunk so a cut lands in a pause
rather than in a word, a sliver at the end folds into the chunk before it, and chunks are
transcribed two at a time. Timestamps are shifted back per chunk so a cue's time is the
file's time, and a line repeated on both sides of a cut is merged once. A failed chunk does
not lose the rest of the transcript: the survivors are kept and the reason says how many
and where. All of it is environment-tunable (`DSH_ASR_CHUNK_SECONDS`, `_CHUNK_MIN`,
`_PARALLEL`, `_SILENCE_DB`, `_SILENCE_MIN`); `DSH_ASR_CHUNK_SECONDS=0` turns it off for an
engine that wants the whole file.

**B站: cached playurls, a bounded disk, and a reason per link kind.** The playurl exchange
is the slow part and its answer is a signed URL valid for hours, so it is cached in memory
for ten minutes (`DSH_BILIBILI_PLAY_TTL_MS`) keyed on `bvid|cid|maxHeight|auth` — six
tools over one file otherwise ask six times. Downloads live under the DSH home and are
pruned to a budget (`DSH_BILIBILI_CACHE_MB`, default 4096; `DSH_BILIBILI_CACHE_MAX`,
default 24 videos) by least-recent use, never evicting the file being written. And a link
that is not one video is refused with what it is: an episode or season of a 番剧 (with the
episode number), a whole work (`md`), a live room with no ending, a collection that has to
be pointed at one video, or a picture post with no video in it. "Unsupported" after a
download attempt tells the caller nothing they can act on.
