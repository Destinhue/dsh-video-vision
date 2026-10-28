# bench

Everything in `docs/EVIDENCE.md` comes from scripts in this directory. No number
in the docs is typed by hand from a terminal scrollback: each one is a field in a
JSON file under `results/`, and the scripts that write those files are here.

```
corpus/          9 synthetic clips with frame-exact ground truth (6.1 MB)
gen/             the generator + verifier that built the corpus
results/         frozen measurements quoted by docs/EVIDENCE.md
final.mjs        the battery: per clip, cold + cached, cells, tokens, cuts, coverage
accuracy.mjs     cut precision/recall/F1 and shot coverage against ground truth
measure.mjs      sheet-level checks: tile size, text legibility, duplicate payloads
e2e.mjs          drive the real tool specs on any video, no harness needed
hostcheck.mjs    the same specs through the installed Harness's schema engine
ab/run-upstream.mjs   the reference implementation, same corpus, same metrics
```

## Run it

```bash
node bench/final.mjs --reps 3        # writes bench/out/final.json
node bench/accuracy.mjs auto         # writes bench/out/accuracy-auto.json
node bench/measure.mjs               # per-clip sheet diagnostics
node bench/e2e.mjs path/to/clip.mp4 --detail auto
```

`final.mjs` reports **cold** (first call, empty cache) and **cached** (median of
the remaining reps) separately, because a number that silently averages cache
hits is a lie about latency. Wall clock moves ±10–20 % between runs on the same
machine; ratios are the point.

## The corpus

Nine clips, 235 s total, each with `gt/*.gt.json` describing shots, cuts, text
cards, speech and (where relevant) flash frames. They exist to make failures
*provable*, so they are adversarial on purpose:

| clip | what it is for |
| --- | --- |
| A_hardcuts_720p | ten shots, including a pair with identical luma and different hue |
| B_montage_360p | 25 shots in 20 s — tests cell budgeting, not detection |
| C_slowpan_720p | continuous motion that must not be cut into pieces |
| D_slideshow_720p | six text cards that change only inside the text block |
| E_blurtransition_720p | 1 s crossfade with motion blur — no hard cut exists |
| F_flicker_360p | twelve single-frame white flashes — spikes, not shots |
| G_speech_360p | real speech with pauses, plus on-screen banners |
| H_music_360p | music with loud/quiet sections, no speech at all |
| I_portrait_interlaced | 480×852 true interlaced, with a moving white bar |

Regenerating it needs python3 + numpy + Pillow and is **Windows-only** (system
CJK/Consolas fonts, and the SAPI desktop voice for clip G):

```bash
python bench/gen/build_corpus.py      # writes bench/corpus/
python bench/gen/verify.py            # re-decodes the mp4s and re-checks the truth
```

The corpus ships with the repository so the evidence is checkable without
regeneration. See `NOTICE` for its provenance.

## Frozen results

`results/final.json` is the battery quoted in `docs/EVIDENCE.md`;
`results/upstream.array.json` is the reference implementation's run of the same
corpus through its own `runStoryboard()`; `results/snapshot.json` records the
sha256 of every `src/*.js` file **at the moment the numbers were produced**, so a
later reader can tell whether the numbers describe the code they are looking at.
`bench/ab/run-upstream.mjs` re-hashes and prints a warning when the checkout has
drifted from the snapshot.

The reference side needs a checkout of
[SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)
(v0.3.0):

```bash
git clone https://github.com/SAOS-3624/dsh-video-storyboard .upstream/dsh-video-storyboard
node bench/ab/run-upstream.mjs
```
