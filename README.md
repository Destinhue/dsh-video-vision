# dsh-video-vision

Look at a video instead of being told about one: **one addressable storyboard
grid per view**, tuned for `deepseek-v4.1-flash` vision. Drop-in replacement for
`dsh-video-storyboard` / `dsh-video-understand` — same three tool names, same
argument shapes, a different engine underneath.

```
video_probe       metadata + a reading plan, no frames decoded
video_storyboard  one contact sheet + a text index binding every cell to a timecode
video_zoom        1-9 large cells over a short window
```

> Design notes with the measurements behind every decision: [docs/DESIGN.md](docs/DESIGN.md).
> Numbers against the reference implementation: [docs/EVIDENCE.md](docs/EVIDENCE.md).

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

**Decoding is batched.** Six cell extractions share one ffmpeg process (several
inputs, one output each), three processes in flight — a 20-cell sheet costs 2-4
process launches instead of 60.

**No prose in results.** Reading instructions live in the tool description,
which sits in the cached prompt prefix and is paid once; the upstream design
repeats ~700 tokens of guidance in every result. `textOnly` + `cellRange` pages
a long film at zero image cost, and repeat calls are cached.

---

## Numbers

Nine clips, frame-exact ground truth, same machine, same week, both pipelines
driven as modules (`bench/final.mjs` and `bench/ab/run-upstream.mjs`). Full
protocol, per-clip tables and threats to validity: [docs/EVIDENCE.md](docs/EVIDENCE.md).

| | dsh-video-storyboard 0.3.0 | here |
| --- | --- | --- |
| wall clock, cold | 1 450 ms | **634 ms** (2.3x) |
| wall clock, cached | 1 168 ms | **411 ms** (2.8x) |
| moments shown | 36 | **67** |
| vision tokens | 3 644 | 3 648 |
| tokens per covered moment | 165.6 | **54.5** (3.0x cheaper) |
| cut F1 (0.5 s) | 0.720 | **0.872** |
| shot coverage | 0.766 | **0.963** |
| text in the result | 8 356 chars | **4 292 chars** |

Same money, 1.9x more of the video, and half the prose.

On a **13-minute** film the gap widens, because length is where the two designs
diverge: 18.1 s → **6.2 s**, two sheets → **one**, 265x145 tiles → **331x186**,
and 1 511 → **1 353** tokens of context for the same question (the manifest is
1 315 chars instead of 2 787). Full table in EVIDENCE.md.

Where the reference
scores better (E, a 1 s crossfade we call one dissolve boundary) and where the
ground truth is wrong for both (G, H) are spelled out in EVIDENCE.md rather than
rounded away. Real-world spot checks with screenshots of what was actually
readable: [docs/REAL-WORLD.md](docs/REAL-WORLD.md).

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
node bin/selfcheck.mjs --smoke          # 16 checks (17 with ffprobe), builds its own clip
node bin/selfcheck.mjs --smoke --host   # + validates all three tools against the
                                        # installed Harness's schema engine (29 checks)
node --test test/                       # 155 tests, no network, hermetic temp dirs
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

---

## What it cannot do

- **No OCR and no ASR.** Reading text is the model's job, done from pixels;
  speech is not transcribed unless the file carries a subtitle track of its own.
  There is no model download, no API key, no network call.
- **No downloader.** Site pages (YouTube, Bilibili) are not resolved: that needs
  `yt-dlp`, which this plugin neither ships nor shells out to. Download the file
  and pass the path. Direct `http(s)` URLs to a media file do work, through
  ffmpeg itself.
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

docs/EVIDENCE.md     measured against the reference implementation, with scripts
docs/DESIGN.md       why each threshold exists; mechanisms that were rejected
docs/REAL-WORLD.md   three untouched screen captures, inspected by eye
docs/TOKENS.md       how DeepSeek prices an image, and what the grid size costs
bench/               the corpus, its generator, and every script that made a number
test/                155 unit tests, no network, hermetic temp dirs
```

MIT licensed. ffmpeg is GPL/LGPL depending on the build you point it at; this
package ships none.
