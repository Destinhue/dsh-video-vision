# Changelog

## 1.3.2

### Added

- **A B站 link no longer has to be downloaded.** The CDN hands out a signed mp4
  link, so ffmpeg reads it in place: `video_probe` never touched the stream,
  and now `video_storyboard`, `video_zoom` and `video_read` can work on the URL
  too. `DSH_BILIBILI_STREAM=1` forces it, `=0` forces a download, and the
  default is `auto` — clips up to `DSH_BILIBILI_STREAM_MAX` seconds (300) are
  read from the network, longer ones are downloaded once and cached, because
  streaming a two-hour lecture twice costs more than keeping it.
- Every ffmpeg/ffprobe call site now passes the Referer and User-Agent the CDN
  requires, as one `-headers` argument with CRLF separators (a bare newline is
  parsed as a separate option and the CDN answers 403).
- `DSH_HTTP_REFERER` / `DSH_HTTP_UA` override those headers for other hosts.

### Measured

| | |
| --- | --- |
| `video_probe`, link, no download | 251 ms |
| `video_storyboard`, 57 s link, streamed | 5.7 s (1.9 s when cached locally) |
| `video_read`, 57 s link, streamed | 8.3 s (2 161 characters out of 14 screens) |
| 20 s of video decoded from the CDN | 1.6 s |
| one frame seeked at 40 s over HTTP | 0.5 s |

### Tests

`190 → 192` (stream mode parsing, header plumbing).

## 1.3.1

### Added — the transcript, and what is owed to it

- `transcriptFile` accepts SRT, WebVTT, or JSON (`[{start,end,text}]` /
  `{"segments":[…]}`) and is consulted **before** the embedded subtitle track and
  before `DSH_ASR_CMD`. Re-deriving captions you already have is the most
  expensive way to get them wrong.
- `~/.dsh/asr.json` can hold the command as well as a `terms` dictionary
  (`{"cmd": "…", "terms": {"地规": "递推"}}`). The environment still wins; the file
  exists because a desktop host does not inherit `setx` variables.
- Hallucinations are filtered client-side, because every engine invents speech
  over music: punctuation-only lines are dropped, and so are lines longer than 8 s
  at under 0.8 characters per second (real speech runs 2–6).
- The term dictionary is tried in both scripts. Measured: whisper `small`
  returns **Traditional** characters for Mandarin, so a key typed `地规` missed the
  `地規` it was written for — every key now also tries its Simplified/Traditional
  twins (≈50 pairs of characters a lecture actually contains).
- The term dictionary is tried in both scripts. Measured: whisper `small`
  returns **Traditional** characters for Mandarin, so a key typed `地规` missed the
  `地規` it was written for — every key now also tries its Simplified/Traditional
  twins (≈50 pairs of characters a lecture actually contains).
- The manifest reports what the filters did — `transcript: asr · 40 lines · 2
  suspect line(s) dropped · 3 term(s) fixed` — and now counts **cues**, not merged
  segments (a six-card slideshow used to say "1 segments").

### Changed

- Cell boundaries snap to silence midpoints (±1.5 s) once a transcript exists, so
  a card no longer ends in the middle of a sentence; a move that would leave a
  cell under 0.3 s is refused.
- `transcript: <source>` is printed with `file:srt` / `file:vtt` / `file:json`
  when a supplied file was used.

### Rejected after measuring

- Feeding speech density back into the cell count. A talking head is the same
  picture whether or not somebody is talking, so extra cells there buy nothing
  visible — `video_read` is the answer for a face and a voice, and `docs/DESIGN.md`
  §11 records the attempt and why it was dropped.

### Tests

- `219` tests (`node --test test/`), `--smoke` 17/17, `--smoke --host` 32/32, and
  the corpus battery unchanged at 67 cells / 3 648 tokens / F1 0.872 / coverage
  0.963.
## 1.3.0

### Added — speech, by proxy

- `DSH_ASR_CMD` is a speech-to-text hook: `src/asr.js` extracts the window's audio
  once (16 kHz mono PCM), runs the command with `{wav}` and `{out}` substituted,
  parses the SRT it writes or prints, and shifts the cues onto the file's clock so
  a cell at 40:00 is quoted by a line that says 40:00.
- Quotes go to the cell containing each line's midpoint — the rule the subtitle
  track already used, so a sentence is quoted once, on the right tile.
- A configured engine that fails now says so: `asr: unavailable · <reason>`.
  Before, a broken engine looked exactly like a video with no speech.
- `docs/DESIGN.md` §10 records why no model is bundled: package size, licence, and
  the measured 1.7 %-confidence result from the host's own recogniser.

### Fixed — windowed sheets disagreed with themselves

- With `start`/`end`, cell spans were printed on the window's clock while `frame@`
  and the `(cuts)` count were on the file's clock: a window at 40:00 showed
  `00:00.00-00:45.16`, claimed zero cuts, and never quoted a line of dialogue.
  Spans are now shifted once, after planning, in `src/pipeline.js`.

### Measured — two minutes of a 1:59:54 lecture, 2560x1440, 16 threads

| engine | transcript time | two hours, extrapolated | output |
|---|---|---|---|
| `faster-whisper` tiny (int8) | 2.5 s | ~2.5 min | garbled (`選抜` for 选法) |
| `faster-whisper` small (int8) | 15.5 s | ~15 min | readable, Traditional, `地规` for 递推 |
| `System.Speech` zh-CN (host) | 1.4 s | — | one 60-character line at 1.7 % confidence |

`--test` 197 passing. Corpus unchanged: 67 cells, 3 648 vision tokens, micro F1
0.872, coverage 0.963.

## 1.2.2

A 95-second clip of burned-in anime subtitles came back as "no text here". It is
text all the way through, and the two reasons it was missed both matter beyond
that clip.

### Fixed

- **The read crop cut the subtitle off.** It stopped at 91.5% of the frame
  height, which is exactly where burned-in subtitles sit, so a video whose whole
  content is a subtitle line produced nothing and `video_read` honestly reported
  the wrong thing. The crop now trims only the recorder's top bar and keeps the
  bottom edge; the geometric rules that drop a status bar (short line, very close
  to the edge) still apply, and a subtitle is a wide line, so it survives.
- **Short videos are sampled on the clock, not on keyframes.** Keyframes arrive
  every ~5 s, so a 95 s clip that cuts 28 times yielded ~20 looks at ~80 lines of
  dialogue. Under 15 minutes the frames are now sampled every 1.2 s; longer
  material keeps the keyframe path, where the cost is OCR rather than decode.

### Measured

| | 1.2.1 | 1.2.2 |
|---|---|---|
| 95 s subtitled B站 clip | 0 screens, "no text here" | **11 screens, 539 chars, 5.6 s** |
| 36 s text-card clip | 6 screens, 584 chars, 1.1 s | 6 screens, 593 chars, 1.3 s |
| 1:59:54 lecture | 91 s, 56 screens, 7 588 chars | **87 s, 53 screens, 7 663 chars** |

## 1.2.1

Board work — a lecture, a screen share, a whiteboard being written on — is one
shot from beginning to end. The planner took that literally and asked for one
cell, so eleven minutes of a lecture became one picture.

### Fixed

- **A cutless stretch is planned by what changed inside it.** Stretches longer
  than 90 s are now planned on a 12×7 block grid instead of on the whole-frame
  distance: a cell is added for each local peak of frame-to-frame change, at
  least 30 s apart, capped at 24 cells, and only when at least 2 % of the
  picture is new compared with every cell already chosen. Cell spans are rebuilt
  from the midpoints between those frames, so the timeline stays gapless.
- The global distance stays in charge everywhere else: a talking head, a still
  shot, a music video and a slideshow plan exactly as before (67 cells, 3 648
  vision tokens, cut F1 0.872, coverage 0.963 — unchanged).

### Measured

| | 1.2.0 | 1.2.1 |
|---|---|---|
| 19-minute lecture window | 4 cells (2×2) | **22 cells (4×6)** |
| its vision tokens | 1 024 | 1 024 (same sheet budget) |
| corpus battery | — | unchanged |

## 1.2.0

A video is raw material for the work that comes after it, not something to be
watched by proxy. This release follows that: `video_read` stops being a
deduplicator of frames and becomes a text extractor that knows when a screen has
nothing to say, and the plugin accepts a B站 link wherever it accepted a file.

### Added

- **B站 links as a source.** `video_probe`, `video_storyboard`, `video_zoom` and
  `video_read` all accept `bilibili.com/video/BV…`, a bare `BV…` id, an `av` id, or a
  `b23.tv` short link. The video is fetched from the public endpoints (one `durl`
  mp4 that already carries its audio), written to `$DSH_HOME/cache/video-vision/
  bilibili/` with a sidecar, and reused on the next call. `video_probe` on a link
  costs one HTTP call and **no download**.
- `DSH_BILIBILI_COOKIE` / `$DSH_HOME/bilibili-cookies.txt` raises the quality
  (720P anonymously, 1080P with a login cookie), `DSH_BILIBILI_MAX_HEIGHT` caps
  what gets downloaded, and a subtitle track published by B站 is muxed in and
  quoted per cell like any embedded subtitle.
- `video_read` says what it found instead of guessing: under three readable
  screens the result is a header, a note naming the likely reason (hand-writing,
  camera recording, no slides) and a pointer to `video_storyboard`.

### Fixed

- **Screen text is judged by shape, not by length.** A frame of hand-writing
  reaches OCR as eight to ten invented characters in a row, which passed every
  length test. Text that was actually read arrives with punctuation, a decimal
  point, a bracket or an `=`; that is the test now, so `亿天小釒一 0 立去千凸到` is
  dropped while `例题 3 … M(P)=44·m(P)` is kept.
- **Furniture is found by frequency.** The recorder's clock reads a different
  time on every frame, so an exact-line test never fired. Lines that occupy most
  screens are dropped on a digits-stripped key, but only when they are short and
  on nearly every screen, so `例题 1` and `例题 2` stay distinct.
- The header's screen count and the reported statistics now describe the same
  list (the post-dedupe one).

### Measured

| | 1.1.1 | 1.2.0 |
| --- | --- | --- |
| 2-hour lecture (`第二次课`) | 112 s · 56 screens · 10 134 chars | **91 s** · 56 screens · **7 588 chars** |
| 36-second text-card clip | 1.4 s · 6 screens | 1.1 s · 6 screens |
| hand-written summary video (B站, 34 min) | 4 screens of strokes | **0 screens**, one honest note |
| outline of the 2-hour lecture | examples 1-11 | examples 1-11, unchanged |

The character count went down while the screens stayed the same: what left was
the recorder, not the lecture. 188 tests, `--smoke` 17/17 (18 with ffprobe),
`--smoke --host` 32/32 (33 with ffprobe).

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
