# What an image costs

This is the one external fact that shapes the whole layout algorithm, so it is
written down here with the numbers that were measured rather than assumed.

## The formula

The DeepSeek adapter prices an image from the grid it is sent as, not from its
file size:

```js
PATCH_SIZE = 14;  DOWNSAMPLE = 3;  CELL = 42;  MAX_TOKENS = 1024;
MIN_PIXELS = 544 * 544;

tokens(gridH, gridW) = gridH * (gridW + 1) + 2
gridCells(padded)    = ceil(floor(padded / 14) / 3)
```

1. Images under 544×544 total pixels are **upscaled** to 544×544 before billing,
   so the floor for any image is ≈184 tokens, not 1.
2. Each axis is padded up to a multiple of 14, then three patches per axis make
   one token cell.
3. If the result exceeds 1 024, the largest aspect-preserving grid under the cap
   is solved instead, and those dimensions are what get sent.

The consequence, and the reason this plugin is laid out the way it is:

> **Cost follows sheet area, not sheet content.** Ten cells in one 1.25 Mpx sheet
> cost exactly what four cells cost in the same sheet.

## Measured

| source | sent as | vision tokens |
| --- | --- | --- |
| 256×256 | 256×256 | 184 |
| 640×360 | 640×360 | 192 |
| 1024×1024 | 1024×1024 | 652 |
| 1280×720 | 1280×720 | 578 |
| 1920×1080 | 1 708×961 | 968 |
| 2048×2048 | 1 302×1 302 | 994 |

A 2048×2048 image costs ≈5.2× what 640×360 costs, and the ceiling is 1 024
regardless of the file. There is also a per-image handle text (`Image
"name" (sha256:…); request preview …px`) of roughly 40–80 tokens, so the real
per-image cost is `vision tokens + ~50`.

## What that implies here

- One sheet per call, sized `n × perCell` pixels (`src/layout.js`
  `sheetPixelsFor`), capped at the 1 024-token ceiling (≈1.76 Mpx). Six cells get
  ≈350 tokens; twenty cells get ≈1 000. A quiet clip stays cheap; a dense clip
  spends more **because it has more to show**, not because it is longer.
- Adding moments to an existing sheet is nearly free; adding a second sheet is
  not (another 184–1 024 tokens, re-priced on every later turn). Hence: one
  image, `cellRange` + `textOnly` for paging.
- Two independent estimates of the same thing disagree, so both are quoted in
  EVIDENCE.md: this plugin's own arithmetic (`estimateVisionTokens` in
  `src/pipeline.js`, matching the formula above, and `visionTokensFor` in
  `src/layout.js` for planning) and the harness's `dsh-token-meter` fallback
  (`JSON.stringify(ref).length / 4`), which is a text heuristic over the
  attachment handle rather than the pixels. Budget with the formula, not with
  the meter.

Every image that stays in the conversation is re-priced on **every** subsequent
request, because the whole history is resent. A frame set is a recurring cost.
