# dsh-video-vision

Look at a video instead of being told about one: **one addressable storyboard
grid per view**, tuned for `deepseek-v4.1-flash` vision. Drop-in replacement for
`dsh-video-storyboard` / `dsh-video-understand` — same three tool names, same
argument shapes, a different engine underneath.

```
video_probe       metadata + a reading plan, no frames decoded
video_storyboard  one contact sheet + a text index binding every cell to a timecode
video_zoom        1-9 large cells over a short window
video_read        the whole video as timestamped TEXT — for lectures, slides, screen recordings

Input can be a file path, a direct media URL, or a **B站 link** (`bilibili.com/video/BV…`, a bare
BV id, an `av` id, or a `b23.tv` short link) — the video is downloaded to a cache once and read like
any other file.
```

Picture paths are for film, sport, gameplay, anything where the picture *is* the
content. When the content is text on the screen, `video_read` wins outright: a
two-hour lecture becomes ~7.6k characters of `[mm:ss] text` plus an outline of its
eleven worked examples, which the model can quote, search and rewrite into notes —
where a 1024-token contact sheet is unreadable at that size. It costs 87 s for two
hours of video, 5.6 s for a 95-second subtitled clip, and 1.3 s for a 36-second one.

> Design notes with the measurements behind every decision: [docs/DESIGN.md](docs/DESIGN.md).
> Measured behaviour, per-clip tables and error margins: [docs/EVIDENCE.md](docs/EVIDENCE.md).

<table>
<tr>
<td width="50%"><img src="docs/demo/storyboard-text-cards.png" alt="Six text cards, each a cell of one contact sheet"><br>
<em>Clip D: six slides that differ only in their text block. Six cells, 359 vision tokens, every bullet readable.</em></td>
<td width="50%"><img src="docs/demo/storyboard-audio.png" alt="Storyboard with an audio envelope band along the bottom"><br>
<em>Clip G: nine cells plus an audio band — teal envelope, orange speech spans, yellow cut ticks. One image, 542 tokens.</em></td>
</tr>
<tr>
<td colspan="2"><img src="docs/demo/zoom-transition.png" alt="Three large cells across a one-second crossfade"><br>
<em><code>video_zoom</code> over a 1 s crossfade: before, mid-transition, after — three cells at full width.</em></td>
</tr>
</table>

---

## Why it is better

**It sees cuts a luma-only detector cannot.** Every frame is reduced to a 12x7
grid of luma *and* chroma block means in a single ffmpeg pass, so a cut between
two shots of identical brightness — a day scene to a differently graded day
scene — is still a cut. Jumps are then classified five ways: `cut`, `partial`
(a slide changing only its text block), `overlay` (a caption appearing),
`light` (a lamp switching on) and `noise`; only the first two become cells.

**Flashes and fades are not shots.** A one-frame white flash restores the
picture within three frames and is rejected; a dissolve is recognised as a
*transient* — a plateau of change that stops afterwards — so it yields one
boundary instead of a burst of tiny shots, while a slow pan yields none.

**The sheet is sized per cell, not per sheet.** The host bills an image by area
(`tokens = gridH*(gridW+1)+2`, 1024 cap). Ten cells in a 1.25 Mpx sheet cost
exactly what four cost, so the budget buys *more moments at smaller cells* until
cells stop being legible — six cells get ~350 tokens, twenty get ~1000, and a
cheap clip stays cheap.

**Cells are earned, not evenly spaced.** One cell per shot is the floor; extra
cells go only to shots that are long enough *and* have a frame 2.5x further from
every chosen frame than the "same picture" threshold. A static talking head
never earns a second cell; a 30 s pan spreads over four.

**A cutless stretch is planned by what changed inside it.** A lecture, a screen
share, a board being written on: one shot for eleven minutes, and the whole point
is what appeared minute by minute. Past 90 s the planner switches question — from
"how far apart are these pictures" to "did any part of the frame gain something
new" — measured on the same 12×7 block grid, one cell per change, 30 s apart at
most, capped at 24. A 19-minute window goes from four cells to twenty-two at the
same 1 024-token budget.

**Decoding is batched.** Six cell extractions share one ffmpeg process (several
inputs, one output each), three processes in flight — a 20-cell sheet costs 2-4
process launches instead of 60.

**No prose in results.** Reading instructions live in the tool description,
which sits in the cached prompt prefix and is paid once; the result itself is
only the index and the image. `textOnly` + `cellRange` pages a long film at zero
image cost, and repeat calls are cached.

---

## Numbers

Nine clips, frame-exact ground truth, one machine, driven directly as a module
(`bench/final.mjs`). Protocol, per-clip tables and threats to validity:
[docs/EVIDENCE.md](docs/EVIDENCE.md).

| | value |
| --- | --- |
| wall clock, cold | **634 ms** (581-648 ms over runs) |
| wall clock, cached | **411 ms** (370-411 ms) |
| moments shown | **67** cells |
| vision tokens | 3 648 |
| tokens per shown moment | **54.5** |
| cut F1 (micro, 0.5 s) | **0.872** |
| cut recall / precision | 1.000 / 0.774 |
| shot coverage | **0.963** |
| text in the result | 477 chars |
| a 2-hour lecture, read as text | **87 s**, 53 screens, 7.7k chars |
| a 36-second card clip, read as text | **1.3 s**, 6 screens |
| a 95-second subtitled clip, read as text | **5.6 s**, 11 screens |
| a B站 link, probe only (no download) | **226 ms** |

On a **13-minute** film one call returns **one** image: 28 cells at 331x186,
1 024 tokens, 6.2 s, ~1 353 tokens of context including the index. Full table
in EVIDENCE.md.

Where this plugin is weak is stated there rather than rounded away: a 1 s
crossfade is reported as one dissolve boundary and scored as a false positive
against a ground truth that calls it zero cuts, and two clips in the corpus
change their whole frame between sections, so they read as cuts. Real-world spot
checks with screenshots of what was actually readable:
[docs/REAL-WORLD.md](docs/REAL-WORLD.md).

---

## Install

The plugin has **no runtime dependencies**. It needs `ffmpeg`, and uses `ffprobe`
when present (without it, metadata is parsed from the `ffmpeg -i` banner).

```bash
cd /path/to/dsh-video-vision
node bin/install.mjs                 # patch ~/.dsh/profiles/desktop, then restart DSH
node bin/install.mjs --dry-run       # show what it would change, touch nothing
node bin/install.mjs --remove        # uninstall
```

The script does the three things by hand that a `pnpm` install would do — add
`"dsh-video-vision": "link:<abs path>"` to the profile's `dependencies`, append
the package to `dsh.profile.bundles`, and junction the package into the profile's
`node_modules`. It is idempotent; `--copy` vendors a snapshot instead of linking.
Either way the app must be **restarted** afterwards: `cordis.patch.yml` inserts
the plugin into the harness tree at boot, which is what makes the tools appear.

### ffmpeg

Resolution order (first hit wins): `$DSH_FFMPEG_PATH`, `$DSH_VIDEO_FFMPEG`,
`$FFMPEG_PATH`, the package's own `vendor/bin`, `ffmpeg-static` /
`@ffmpeg-installer` in node_modules, WinGet Links, `C:\ffmpeg\bin`, scoop shims,
the npm roaming prefix, `/usr/local/bin`, an `imageio-ffmpeg` wheel inside
`~/.dsh/dsh-runtimes/*/`, then plain `ffmpeg` on `PATH`.
`$DSH_FFPROBE_PATH` / `$FFPROBE_PATH` do the same for ffprobe.

Verify a machine end to end (no video needed — it builds one):

```bash
node bin/selfcheck.mjs --smoke          # 17 checks, builds its own clip
node bin/selfcheck.mjs --smoke --host   # 32 checks: validates all four tools against the
                                        # installed Harness's schema engine
node --test test/                       # 174 tests, no network, hermetic temp dirs
```

`--host` runs the exact assertions `ctx.tools.register` runs, then calls every
tool once and validates the result the way the runtime does. Run it with
Electron's node (`ELECTRON_RUN_AS_NODE=1`) — plain node cannot read inside
`app.asar`. This is not ceremony: a tool that returns `{ text: {…} }` instead of
`{ text: "…" }` is rejected by the host with `"value.text" must be a string`,
and nothing local notices until a user calls it.

---

## Use

```
video_storyboard input:"C:\clips\pv.mp4"
```

```
pv.mp4 · 0:00:40.00 · 1280x720 · 30fps · 9 cuts · median shot 4.00s
sheet 1 · 2x5 grid · 942x1328 · 10 cells · window 00:00.00-00:40.00
cols: cell · pos · span · (cuts) · frame@
1 r1c1 00:00.00-00:04.00 @00:01.98
2 r1c2 00:04.00-00:07.68 @00:05.85
...
audio: speech 42% · -18.2 dBFS · loudest 0:41.20 · 3 silences · 12 onsets
transcript: subtitle-track · 18 segments
```

The image arrives in the same tool result. `r2c1` is row 2, column 1 from the
top-left; the number burned into each cell is the cell index.

| argument | meaning |
| --- | --- |
| `input` | file path, or a direct `http(s)` URL that ffmpeg can fetch |
| `start` / `end` / `duration` | read one window instead of the whole file |
| `detail` | `low` (≤6 cells) · `auto` (≤20, default) · `high` (≤28) |
| `cells` | force an exact count (1–24) |
| `pick` | `sharp` (default) or `middle` |
| `textOnly` | text index only: no image, no decode |
| `cellRange` | with `textOnly`, `[first, last]` to list |

`video_zoom` takes the same window arguments plus `cells` (1–9) and `at`; a
single cell is returned at full resolution.

### Reading a lecture

```
video_read input:"C:\clips\lecture.mp4"
```

```
# lecture.mp4 — read as text · 56 screens · 975 keyframes · 112 s

## outline
00:45 1.1
17:20 例题3
41:05 例题5
56:16 例题6
74:00 例题8

[00:45–01:44] 1.1 归纳证明 事实上，数学归纳法的使用是很灵活的…
[17:20–18:54] 例题 3 ．A、B 二人玩如下游戏：初始时有两堆硬币，各 2ⁿ 个…
```

It decodes **only keyframes** (`-skip_frame nokey`), clusters them by picture
change, OCRs the slide area of each cluster once, then merges screens that say
the same thing. Near-identical slides are collapsed from both ends: OCR noise
makes exact matching useless, so sameness is a character-bigram similarity test.

Lines that appear on most screens are dropped as furniture — that is how the
recorder's own header goes away without this plugin knowing which recorder it was.
When a video has almost no readable text (handwriting, a camera pointed at a room)
it says so instead of quoting strokes: `0 screens · note: this video may be
handwritten … try video_storyboard`.

What gets thrown away is the recorder, not the lecture: a tab strip is a short
line near the top edge, a status bar is a short line at the bottom, a chat panel
is a screen made of very short lines, and a frame where the teacher is writing
by hand OCRs into a pile of two-character stubs with no sentence in it. Those
tests are geometric, so they work whatever app the recording came from.

Measured on a real 1:59:54 lecture at 2560x1440: **112 s**, 975 keyframes → 388
clusters → **56 screens → 10 134 characters**, with all eleven worked examples
in the outline. The same file through `video_storyboard` takes 163 s and returns
one 1 024-token sheet whose slide text is unreadable. A 15-minute window reads in
**16 s**; a 36-second clip in **1.4 s**.

| argument | meaning |
| --- | --- |
| `input` | file path, or a direct `http(s)` URL that ffmpeg can fetch |
| `start` / `end` | read one window only |
| `maxScreens` | cap on distinct screens read, 3–400 (default 400) |

Needs an OCR engine. The Windows one is built in (no download, no model);
elsewhere the tool says so and you fall back to `video_storyboard`.

---

### Speech, when you have an engine

`video_storyboard` and `video_read` can quote what is being **said** as well as
what is written, if you point `DSH_ASR_CMD` at an engine you already trust:

```
set DSH_ASR_CMD=C:\python\python.exe F:\asr\engine.py --model small {wav} {out}
```

The window's audio is extracted once (16 kHz mono), your command runs, and the SRT
it writes to `{out}` — or prints on stdout — is parsed. Each line is quoted on the
cell that contains its midpoint, so nothing is repeated. A subtitle track, when
present, always wins: it was captioned by a human and costs no decode.

No engine is bundled, deliberately. This package is 600 KB of code with zero
dependencies, and the accuracy lives in the model (tiny 75 MB, small 484 MB,
medium 1.5 GB). Measured on two minutes of a real lecture on 16 threads:

| engine | transcript time | two hours, extrapolated | what comes out |
|---|---|---|---|
| `tiny` | 2.5 s | ~2.5 min | garbled: `選抜` for 选法, `按摩機束` for 枚举 |
| `small` | 15.5 s | ~15 min | readable, Traditional output, `地规` for 递推 |

The host's own offline recogniser was tried and rejected: `System.Speech` zh-CN
turned the same minute into one 60-character line at **1.7 % confidence**. That is
worse than returning nothing, which is why this is a hook and not a feature.

So the split is: slides and screen recordings go through `video_read` (87–112 s
for two hours), speech-only material through ASR, and when you need both, read
first and run ASR on the window you care about by passing `start`/`end`.

**The client owns two of the recogniser's failure modes**, because every engine has
them and every caller would otherwise reinvent them badly:

- *Music is not speech.* Asked to transcribe an instrumental, a recogniser does
  not return nothing — it invents a sentence and gives it a long timestamp. On a
  90-second PV that produced a fake 29-second line, and since cells are quoted by
  time overlap the same garbage landed in five cards. Lines that are
  punctuation-only, or longer than 8 s at under 0.8 characters per second (real
  speech runs 2–6), are dropped; **the count is reported** in the manifest line as
  `2 suspect line(s) dropped`, because a filter nobody can audit is
  indistinguishable from a recogniser that stopped working.
- *The vocabulary is yours, not the internet's.* `递推` comes back `地规`, `阶乘`
  comes back `階層`. Put the corrections in `~/.dsh/asr.json` beside the command:

  ```json
  {
    "cmd": "C:\\python\\python.exe F:\\asr\\engine.py --model small {wav} {out}",
    "terms": { "地规": "递推", "階層": "阶乘" }
  }
  ```

  The environment still wins over the file (`DSH_ASR_CMD`); the file exists because
  a desktop host does not inherit `setx` variables. Longest key first, single pass,
  and the manifest reports `1 term(s) fixed`.

  Each key is tried in **both scripts** (≈50 Simplified/Traditional pairs a
  lecture actually contains), because whisper transcribes Mandarin into
  Traditional: a key written `地规` has to match the `地規` that comes back, and
  before this it silently did nothing. Write the dictionary in the characters you
  think in; the other spelling works too.

**Cell boundaries move onto silence.** Dialogue already knows where its sentences
end, so a boundary within 1.5 s of a silence midpoint is moved there instead of
splitting a card an arbitrary tenth of a second into the next word. No card gets
shorter than 0.3 s in the process.

**If you already have a transcript, pass it.** `transcriptFile` takes SRT, WebVTT,
or JSON (`[{start,end,text}]`, or `{"segments":[…]}` as whisper-family tools emit)
and is tried **before** the subtitle track and before ASR:

```
video_storyboard({"input": "lecture.mp4", "transcriptFile": "lecture.srt"})
```

The B站 case is the one that pays: the captions are already there, and paying for
a download plus a recogniser to re-derive them would be silly.

## What it cannot do

- **No bundled ASR.** Speech is transcribed only when the file carries a subtitle
  track or when you point `DSH_ASR_CMD` at an engine (above). With neither, you
  still get the audio summary: speech share, loudness, silences, onsets.
  `video_read` does OCR, but only with the Windows built-in engine behind
  `Windows.Media.Ocr`: on Linux and macOS it reports that it is unavailable instead
  of pretending. No model download, no API key.
- **B站 only, and only what it hands out without an account.** A B站 link is
  resolved through the public endpoints, which means 720P unless you supply a
  cookie; there is no `yt-dlp`, so other sites still have to be downloaded first.
  Paywalled and members-only parts are not readable.
- **Cuts are detected, not understood.** A whip pan and a cut can look alike in
  a 96x54 grid; the classifier prefers "not a cut" when the change is local.
- **It is not a player.** One call = one still image of up to 28 moments.

---

## Layout

```
src/index.js     plugin entry: registers the three tools, resolves binaries
src/tools.js     tool specs (descriptions are prompt-cached, so they are short)
src/pipeline.js  orchestration + analysis cache
src/scan.js      one-pass decode, cut/overlay/light/flash/dissolve detection
src/layout.js    shot building, cell budget, grid geometry, token math
src/frames.js    batched frame extraction
src/sheet.js     contact-sheet compositor (no image library, raw RGB)
src/png.js       PNG encoder (zlib)
src/manifest.js  the text index
src/timeline.js  audio envelope, speech spans, subtitle extraction
src/media.js     ffmpeg/ffprobe discovery, probing, process helpers

docs/EVIDENCE.md     measured behaviour, with the scripts that produced it
docs/DESIGN.md       why each threshold exists; mechanisms that were rejected
docs/REAL-WORLD.md   three untouched screen captures, inspected by eye
docs/TOKENS.md       how DeepSeek prices an image, and what the grid size costs
bench/               the corpus, its generator, and every script that made a number
test/                161 unit tests, no network, hermetic temp dirs
```

---

## Thanks

The idea this plugin starts from — one contact sheet with burnt-in cell indices,
plus a text index binding cells to timecodes, put together without an image
library — comes from
[SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard),
whose documentation is the clearest statement of why it works. Thank you.

This is an independent implementation: no code is copied, and detection, cell
budgeting, decoding and composition differ. The three tool names, their argument
shapes and the manifest grammar are kept compatible on purpose, so it can stand
in where that plugin is already installed. See [NOTICE](NOTICE).

MIT licensed. ffmpeg is GPL/LGPL depending on the build you point it at; this
package ships none.
