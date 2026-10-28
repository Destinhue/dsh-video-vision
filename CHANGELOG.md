# Changelog

## 1.1.1

The first cut of `video_read` was tuned on one lecture, and the tuning was the
kind that looks fine on the file you tuned it on. Run against a second lecture it
kept the recorder's tab strip as if it were a slide title, and it dropped whole
screens whose text had come out of a hand-written frame.

### Fixed

- **Chrome removal is geometric, not a crop.** The slide area used to be a fixed
  crop of the frame, learned from the first lecture; on the next one it sliced
  the first character off a card whose text started at the left edge. The crop is
  now a conservative top/bottom trim, and the real filtering happens per OCR
  line: a short line near the top edge is a tab strip, a short line at the bottom
  is a status bar, a screen made of many very short lines is a chat panel, and a
  screen with no line long enough to be a sentence is a frame of hand-writing.
  None of those rules know which app was on screen.
- **Duplicates are merged twice.** OCR noise makes two readings of the same slide
  differ; the first pass merges at the documented similarity, a second pass at a
  looser one catches the pair whose second reading came out degraded.
- **Frames are grabbed a beat after the keyframe.** A keyframe can land
  mid-scroll or mid-dissolve, and OCR of a half-drawn screen is garbage that
  survives every similarity test.
- The chrome list matches case-insensitively — `Goodnotes` is not `goodnotes`.
- The screen count in the header was the pre-dedupe count.

### Measured

| | 1.1.0 | 1.1.1 |
| --- | --- | --- |
| 1:59:54 lecture, wall clock | 87 s | 112 s |
| screens quoted | 146 (with tab strips) | 56 |
| characters | 16 817 | 10 134 |
| examples found in the outline | 11 | 11 |

The older build quoted more text because it was quoting the recorder too, and
because it kept several degraded readings of the same slide. The number that
matters is the last row.

### Tests

174 tests (`node --test test/`), `--smoke` 18/18, `--smoke --host` 33/33.

## 1.1.0

### Added

- **`video_read` — read a video as timestamped text.** When the content is text
  on the screen (lectures, slide decks, screen recordings, coding sessions) a
  picture of it is the wrong representation: the contact sheet is capped at 1024
  vision tokens and unreadable at that size, while the text is what a model can
  quote, search and rewrite. The tool decodes **only keyframes**
  (`-skip_frame nokey`, ~6x cheaper than a full decode), clusters them by
  picture change, OCRs the slide area of each cluster once, merges screens that
  say the same thing (character-bigram similarity, because OCR noise makes exact
  matching useless), and emits an outline plus `[mm:ss] text` lines.

  Measured on a real 1:59:54 lecture at 2560x1440: **87 s**, 975 keyframes →
  388 clustered screens → 146 screens, **16.8k characters** — against 163 s for
  the same file through `video_storyboard`, which returns one 1024-token sheet
  whose slide text is too small to read.

  OCR uses the Windows engine (`Windows.Media.Ocr`, no download, no model). On
  other platforms the tool reports that it is unavailable and the picture path
  remains the answer.

### Changed

- The tool descriptions say which path to use when: `video_read` for text,
  `video_storyboard`/`video_zoom` when the picture *is* the content.

### Tests

- 171 tests (10 new for the pure parts of `read.js`: OCR cleanup, UI-chrome
  rejection, bigram similarity, screen merging, outline extraction, block-grid
  change).

## 1.0.1

### Fixed

- **A long file failed to probe when only ffmpeg was available.** The banner
  fallback ran `ffmpeg -i … -f null -`, and the null muxer decodes the whole
  input before discarding it — 130 s on a two-hour lecture against a 60 s
  budget, so the call died. It now passes `-t 0` and stops once the input is
  open, because every line the parser reads is already on stderr. Same 2 h
  file: **226 ms** end-to-end probe (measured on a 7053 s / 2 h composite with
  no ffprobe present). A full storyboard of that file now completes in 38.5 s.
- The banner parser let a **later audio stream overwrite the first**, so a file
  carrying AAC followed by a PCM/commentary track was reported as
  `pcm_s16le`. It is first-wins now, matching the rule already used for video
  streams. Both defects are pinned by `test/media.test.mjs`.
- `bin/install.mjs` no longer trusts a `node_modules` entry that resolves to a
  *different* checkout — it relinks it, the same way a stale `link:` dependency
  is repointed. Leaving it alone made edits appear to do nothing.
- `bin/install.mjs` removes a link with `rmdir`/`unlink` instead of a recursive
  delete. On Windows a recursive delete follows the junction and empties the
  checkout it was replacing, which is the one thing an installer must not do.
  Both paths are covered by `test/install.test.mjs`.

`161` tests, `--smoke` 16/16 (17 with ffprobe), `--smoke --host` 29/29.

## 1.0.0

First release. Drop-in replacement for `dsh-video-storyboard` / `dsh-video-understand`
(the tool names `video_probe`, `video_storyboard`, `video_zoom` and their argument
shapes are unchanged).

### Fixed after release-candidate testing
- `video_probe` returned the wrong shape (`{ text: { text, probe, plan } }`);
  the host answered `"value.text" must be a string`. The tool now returns the
  documented `{ text, images }`, and `bench/hostcheck.mjs` exercises the SUCCESS
  path of all three tools against the host's own schema engine, which is what
  would have caught it.
- `scanShots` treated `duration` as an absolute end time, so a windowed call
  (`start: 4, duration: 5`) scanned one second instead of five.
- Subtitle quoting never ran on a real file: `extractSubtitles` gated on
  `probe.streams`, and `probeVideo` returns only `hasSubtitle`. Fixed, and the
  branch is now covered by a test that passes a probe without a `streams` array.
- Dialogue was quoted on every cell it touched, because cues were grouped into
  sentences before attribution. Each raw cue is now attributed to the cell whose
  span holds its **midpoint** — a line that straddles a cut is quoted once.
- Speech detection called any sustained loud span "speech" (a music-only clip
  reported `speech 45 %`). Spans now carry a syllabic-modulation test
  (`levelSd >= 4 dB`, `hfSd >= 0.05`), so the manifest says
  `no speech · sound 86 %` over a music bed and `speech 48 %` over narration.
- The cell count was a quota. It is now a legibility limit: every shot gets a
  cell while cells stay at least 240 px wide, so a 25-shot montage shows 25 cells
  at the same 1 024 tokens a 4-cell sheet used to cost, and a portrait clip still
  merges. Corpus coverage moved 0.941 → 0.963.
- An unreadable file used to produce 400 characters of ffmpeg banner; errors are
  now `no video stream (this file is audio only)`, `file not found`,
  `not a file (it is a directory)`, and the path is stat-ed before any spawn.
- `runZoom` read `cell.data` where the compositor reads `cell.frame`, so every
  zoom sheet came back flat black; the `wanted` count also crashed on a TDZ
  reference before the fix.
- The sharpest-frame picker chose muzzle flashes and other exposure outliers;
  frames more than 1.8 MAD from a shot's median brightness are now demoted.
- `suggestDetail` claimed 20 cells / 1024 tokens for a 3 s clip; it now scales
  at 6 s per cell with a floor of 3.

### Docs and evidence
- `docs/EVIDENCE.md`: measured latency, sheet geometry, token cost, per-clip cut
  and coverage tables, edge cases and a threats-to-validity section.
- `docs/REAL-WORLD.md`: three unmodified captures from the machine, with what
  was actually readable in the rendered sheets.
- `docs/DESIGN.md`: why each threshold exists, including the clips that forced
  it.

### Analysis
- One ffmpeg pass reduces each frame to a 12x7 grid of luma **and** chroma block
  means, plus sharpness / detail / brightness scalars.
- Cut threshold derived per clip from `max(1.6, median + 7*MAD, p99*0.22)` — a
  fixed floor silently deleted real cuts from low-contrast footage.
- Five-way jump classification: `cut` / `partial` / `overlay` / `light` / `noise`.
- Flash rejection by picture restoration; dissolve detection as a transient
  (change that stops afterwards); hard cuts and flashes excluded from dissolve
  windows so a real cut cannot grow a phantom fade next to it.
- Optional deinterlace (`bwdif`) for interlaced sources.

### Layout
- The sheet is sized **per cell** (`sheetPixelsFor`), because the host bills an
  image by area, not by cell count: more moments cost the same tokens until a
  cell stops being legible.
- One cell per shot is the floor; shots are merged by weight when they outnumber
  the budget; extra cells must be 2.5x more novel than the "same picture"
  threshold.
- Cells are placed on the sharpest, most central frame of their span.
- Grid shape solved together with cell size from the area budget.

### Decoding and output
- Batched extraction: six cells per ffmpeg process, three processes in flight,
  one retry 80 ms earlier for stragglers.
- Pure-JS PNG encoder (no image library), hairline gutters, small corner badges,
  optional audio envelope band.
- Manifest: one fixed-shape line per cell, centisecond timecodes, no prose,
  `=cell N` for duplicate pictures, `textOnly` + `cellRange` paging, `24000`
  character budget.
- Analysis cache (6 entries, keyed by path+size+mtime+window+detail) so paging
  and repeats cost only formatting.

### Audio
- 8 kHz mono decode: 40 ms RMS envelope, speech spans, onsets, silences,
  loudness. No ASR model, no network, no key.
- Real subtitle tracks are extracted and quoted per cell.

### Evidence
- Nine synthetic clips with frame-exact ground truth (`bench/corpus`), a
  13-minute composite, and three unmodified screen captures from this machine.
- `bench/final.mjs` and `bench/accuracy.mjs` share a token estimator and a 0.5 s
  cut scorer against the corpus ground truth.
- `bin/selfcheck.mjs --smoke --host` runs 29 assertions, including the host's
  own `assertSupportedJsonSchema` and `validateJsonSchemaValue` on every tool.
- `node --test test/` — 161 tests, no network, hermetic temp dir.
