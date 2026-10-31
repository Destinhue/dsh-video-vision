/**
 * tools.js — the tool specs.
 *
 * These descriptions live in the system prompt, so they are paid on *every*
 * request. That is why the reading instructions live here instead of in the
 * manifest: a cached description is ~free, while a repeated paragraph inside
 * every tool result is not. Keep this file short and concrete.
 */

import { runProbe } from './pipeline.js';

export const PROBE_TOOL = 'video_probe';
export const STORYBOARD_TOOL = 'video_storyboard';
export const ZOOM_TOOL = 'video_zoom';
export const READ_TOOL = 'video_read';
export const OUTLINE_TOOL = 'video_outline';

const INPUT_DESC = 'A video: a file path (absolute, or relative to the working directory), a direct http(s) URL '
  + 'to a media file that ffmpeg can fetch, or a B站 link (bilibili.com/video/BV…, a bare BV id, an av id, or a b23.tv '
  + 'short link). A B站 link is resolved and downloaded to a cache on first use, so the first call is slower. '
  + 'Other site pages (YouTube and friends) are not resolved: download those first.';

// Speech is quoted only when the caller configured an engine; saying so in the
// description costs nothing per call and prevents a "why is there no dialogue".
const ASR_NOTE = `
  Speech: a subtitle track is quoted when the file has one. Without one, point
  DSH_ASR_CMD at an engine that turns {wav} into an SRT at {out} and the same
  lines are quoted from speech. Long audio is cut on silence into
  DSH_ASR_CHUNK_SECONDS pieces (default 45) and transcribed in parallel, so a
  two-hour lecture works with an engine that only wants short files.`;

const BILI_NOTE = [
  '',
  'B站 links work directly, and short clips are read from the CDN without downloading at all: the link is',
  'opened in place (720P by default, DSH_BILIBILI_COOKIE for 1080P, DSH_BILIBILI_MAX_HEIGHT to cap it).',
  'Videos longer than DSH_BILIBILI_STREAM_MAX seconds (default 300) are downloaded once and cached under',
  '$DSH_HOME/cache/video-vision instead, because streaming a two-hour lecture twice costs more than keeping it.',
  'Force either way with DSH_BILIBILI_STREAM=1 (never download) or =0 (always download).',
].join('\n');


// The index marks cells whose detail is finer than the sheet can show. Saying how
// to use that here costs nothing per call; saying it in every result costs tokens.
const ZOOM_NOTE = `
  Cells: a dense sheet is small per cell, so when a cell cannot hold the text it
  contains the index says so — a "zoom:" line lists the cells worth a closer look,
  and those cell lines end in "zoom". Pass their frame@ times to video_zoom (or
  re-call with detail:"low" for bigger cells) instead of re-reading the whole sheet.`;

export function probeSpec() {
  return {
    name: PROBE_TOOL,
    description: [
      'Read a video\'s container metadata without decoding any frames: duration, resolution, frame rate,',
      'rotation, audio and subtitle tracks, a reading plan, and an estimate of what a storyboard will cost.',
      '',
      'Call this first when you do not know how long the video is — it is nearly free and tells you whether',
      'one storyboard covers the whole thing or you need to pick a window.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'Human-readable metadata and reading plan.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'probe video', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      const out = await runProbe({ input: args.input, signal: exec?.signal });
      return { text: out.text };
    },
  };
}

export function storyboardSpec(ctx) {
  return {
    name: STORYBOARD_TOOL,
    description: [
      'Watch a video by looking at it: samples the whole file (or a window of it) and returns ONE contact',
      'sheet whose cells are automatically placed on the cuts, plus a text index that binds every cell to a',
      'timecode. This is how you answer questions about content, shot composition, on-screen text, action,',
      'pacing and continuity.',
      '',
      'How to read the result:',
      '  - `cols:` line names the columns; each cell line is `N rXcY start-end (cuts) @frame · "dialogue"`.',
      '  - `r1c2` is row 1, column 2 of the image, counted from the top-left. The number burned into the',
      '    cell is the cell index N.',
      '  - The picture shows *what*; the text gives *when*, how many cuts land inside the cell, and any',
      '    dialogue the file carries. A cell marked `=cell 2` is a picture already shown in cell 2 — it is',
      '    listed for timing, not redrawn.',
      '  - Audio line: speech share, loudness, loudest moment, silences, onsets. Read limits: `subtitlePx`',
      '    under ~13 means small burned-in subtitles will be hard to read, so use video_zoom on the window.',
      '',
      'Cost: the sheet is billed by pixels (about 600-1000 tokens for a full frame of cells). Cells are',
      'deduplicated, so a static talking head does not spend a frame per second — while a long cutless',
      'stretch that keeps adding something (a lecture, a screen share, a board being written on) earns a',
      'cell per change instead of one cell per shot.',
      '',
      'Use `detail` to trade coverage against per-cell sharpness, `cells` to force a count, `textOnly` to',
      're-read the index of a long film at no image cost, and video_zoom when one window needs real detail.',
      'Re-calling the same window is cached: the text index is free, so paging with `textOnly` + `cellRange`',
      'or asking for one window at a time is the intended way to work through a long file.',
      ].join('\n') + BILI_NOTE + ZOOM_NOTE + ASR_NOTE,

    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        start: { type: 'number', description: 'Window start in seconds (default 0).' },
        end: { type: 'number', description: 'Window end in seconds (default: end of file).' },
        duration: { type: 'number', description: 'Window length in seconds; alternative to `end`.' },
        detail: {
          type: 'string',
          enum: ['low', 'auto', 'high'],
          description: 'low = up to 6 cells, for a quick overview. auto = default, up to 20 cells sized by content. '
            + 'high = up to 28 cells for dense edits or long films. The sheet keeps a roughly constant token cost per '
            + 'cell, so more cells means more moments at a smaller size — pick high when you need coverage, low when '
            + 'you need a big readable picture of a few moments.',
        },
        cells: { type: 'number', description: 'Force an exact cell count (1-24). Overrides `detail`.' },
        pick: {
          type: 'string',
          enum: ['sharp', 'middle'],
          description: 'Which frame inside a shot becomes its cell. `sharp` (default) takes the crispest moment, '
            + 'which avoids motion-blurred and mid-transition frames.',
        },
        dedupe: {
          type: 'string',
          enum: ['shots', 'global'],
          description: 'Which pictures are allowed to repeat. `shots` (default) folds repeats inside one shot but '
            + 'keeps a picture that comes back after a cut — a slide deck that reopens slide 1 usually keeps '
            + 'talking while it is up, so that second cell carries its own narration. `global` folds those too: '
            + 'the shot is then listed in the cell index against the cell that shows the same picture, so the '
            + 'sheet spends its budget on pictures it does not already have.',
        },
        transcriptFile: {
          type: 'string',
          description: 'Path to a transcript you already have (SRT, VTT, or JSON [{start,end,text}]). '
            + 'Tried before the embedded subtitle track and before speech recognition: there is no reason '
            + 'to re-derive what you can paste.',
        },
        textOnly: { type: 'boolean', description: 'Return only the text index; no image, no frame decode. Cheap paging for long films.' },
        cellRange: {
          type: 'array',
          items: { type: 'number' },
          description: 'With textOnly: [first, last] 1-based cell indices to list.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'The addressable cell index.' },
          images: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Contact sheet images (0 or 1).' },
        },
      },
      render(args, value) {
        const blocks = [];
        for (const attachment of value.images || []) blocks.push({ type: 'image', attachment });
        blocks.push({ type: 'text', text: value.text });
        return blocks;
      },
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'storyboard', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      return ctx.storyboard(args, exec);
    },
  };
}

export function zoomSpec(ctx) {
  return {
    name: ZOOM_TOOL,
    description: [
      'Look closely at a short window of a video: a few large cells (default 3), or one full frame when',
      '`cells` is 1. Use it after video_storyboard when a single moment needs real detail — reading',
      'on-screen text, identifying a face, judging an effect, checking what an object actually is.',
      '',
      'The window should be short (a few seconds to ~20 s): the point is per-cell pixels, not coverage.',
      'Cells are still placed on cuts inside the window, so a 3-cell zoom over a 6 s ACTION BEAT shows',
      'three distinct shots rather than three near-identical frames.',
      ].join('\n') + BILI_NOTE + ASR_NOTE,

    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        start: { type: 'number', description: 'Window start in seconds.' },
        end: { type: 'number', description: 'Window end in seconds.' },
        duration: { type: 'number', description: 'Window length in seconds (default 20).' },
        cells: { type: 'number', description: 'Cells to return, 1-9 (default 3). 1 returns a single full-resolution frame.' },
        at: { type: 'number', description: 'With cells=1: exact timestamp to grab (default: middle of the window).' },
        detail: {
          type: 'string',
          enum: ['high', 'ultra'],
          description: 'Pixel budget. `ultra` (default) spends the full per-image token allowance on fewer, larger cells.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'What each cell is and when.' },
          images: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Zoom images (exactly 1).' },
        },
      },
      render(args, value) {
        const blocks = [];
        for (const attachment of value.images || []) blocks.push({ type: 'image', attachment });
        blocks.push({ type: 'text', text: value.text });
        return blocks;
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'zoom', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      return ctx.zoom(args, exec);
    },
  };
}

export function readSpec(ctx) {
  return {
    name: READ_TOOL,
    description: [
      'Read a video as a timestamped TEXT document instead of looking at pictures of it.',
      '',
      'Use this, not video_storyboard, whenever the point is to understand what is being said or shown so',
      'you can then write something (notes, a handout, an exam, a summary, slides): lectures, slide decks,',
      'screen recordings, coding sessions, subtitled talks. Every distinct screen is found, its text is',
      'recognised, near-identical screens are merged, and you get `[mm:ss] text` lines plus an outline of',
      'the headings. Two hours of slides becomes ~20k characters at a fraction of the cost of one capped',
      'picture, and the characters are searchable and quotable in a way pixels are not.',
      '',
      'The trade: it reads TEXT, so it is blind to faces, motion, colour, composition and audio. For',
      'gameplay, film, sport, anything where the picture *is* the content, use video_storyboard.',
      'Needs an OCR engine: the Windows one is built in, `tesseract` on PATH is used elsewhere, and',
      'DSH_OCR_CMD can point at any command of your own. With no engine this tool says so — then use',
      'video_storyboard, or video_read with transcriptFile.',
      '',
      'A file with sound and no picture (mp3, m4a, a wav) is read as a transcript instead: a subtitle track',
      'if the container has one, DSH_ASR_CMD if it is configured, or the transcriptFile you pass.',
      '',
      'A video whose information is a picture rather than words — handwriting, a camera pointed at a screen,',
      'a whiteboard with no headings — has no text to quote. Instead of an empty document it returns a few',
      'frames as one image, with the note saying so; use video_storyboard if you want the cut index too.',
      '',
      'Pass `out` to keep the result as a file: `.srt` or `.vtt` writes subtitles, anything else',
      'writes one `[mm:ss] text` line per screen (or per cue, for an audio file). The document says',
      'where it went; the text is still returned, so nothing is lost by exporting.',
      '',
      'Repeats are cached: asking again for the same file and window costs only the wait.',
      ].join('\n') + BILI_NOTE + ASR_NOTE,

    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        start: { type: 'number', description: 'Start of the window in seconds (default 0).' },
        end: { type: 'number', description: 'End of the window in seconds (default: end of file).' },
        maxScreens: {
          type: 'number',
          description: 'Cap on distinct screens read, 3-400 (default 400). Lower it for a quick skim.',
        },
        transcriptFile: {
          type: 'string',
          description: 'Path to a transcript you already have (SRT, VTT, or JSON [{start,end,text}]). '
            + 'On an audio-only file this is what is read when no ASR engine is configured; on a video it '
            + 'is quoted before the subtitle track and before speech recognition.',
        },
        out: {
          type: 'string',
          description: 'Write the read result to this path. Extension decides the shape: .srt or .vtt is a '
            + 'subtitle file (one cue per screen, timed by the screen span), any other extension is plain '
            + '[mm:ss] text lines. Parent directories are created. Applies to video and audio reads; an '
            + 'export with nothing to write says so instead of creating an empty file.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'Timestamped transcript of everything on screen, plus an outline; the last note says where an `out` export went.' },
          images: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Pictures instead of text, when the file carried none (0 or 1).' },
        },
      },
      render(args, value) {
        const blocks = [];
        for (const attachment of value.images || []) blocks.push({ type: 'image', attachment });
        blocks.push({ type: 'text', text: value.text });
        return blocks;
      },
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'read video text', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      return ctx.read(args, exec);
    },
  };
}

/**
 * The navigation pass. Its whole reason to exist is that the other three tools
 * answer a question and this one answers "which question is worth asking".
 */
export function outlineSpec(ctx) {
  return {
    name: OUTLINE_TOOL,
    description: [
      'Read a whole video as a text map before spending picture tokens on it: the file is cut into equal',
      'windows (24 by default) and each row carries the cuts in it, the share of it that is speech, a bar',
      'drawn from the same numbers, and tags (busy / talk / static / quiet / dark). Nothing is rendered, so',
      'the call costs no vision tokens — it is the cheap first move on a file you know nothing about: a',
      'two-hour lesson, a recording, a gameplay clip.',
      '',
      'Read it as: rows in time order, `watch first:` the windows that carry the most, and `next:` the exact',
      'call that opens one. Then spend the budget where it matters — video_storyboard for a window that',
      'must be seen, video_read for the words in it.',
      '',
      'It is a summary, not the content: a window that scores low can still be the one you want (a title',
      'card is static and quiet), so treat `watch first` as a starting order, not a ranking of importance.',
    ].join('\n') + BILI_NOTE,

    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: INPUT_DESC },
        windows: {
          type: 'number',
          description: 'How many equal windows to cut the file into, 4-60 (default 24). A 2-hour file at 24 '
            + 'windows gives 5-minute rows; more windows put the map on a finer grid.',
        },
        top: {
          type: 'number',
          description: 'How many windows to name in `watch first`, 1-8 (default 3).',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: 'One line per window, the windows worth opening first, and the exact call that opens one.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'outline video', kind: 'read', rawInput: args }),
    async execute(args, exec) {
      if (!args?.input) throw new Error('input is required');
      return ctx.outline(args, exec);
    },
  };
}

