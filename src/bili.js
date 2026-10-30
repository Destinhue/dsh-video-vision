/**
 * Bilibili as a video source.
 *
 * A `bilibili.com` link is not a file: it is an id that has to be exchanged for
 * a playable URL that expires in a couple of hours, and the exchange decides
 * what quality you are allowed to ask for. This module does that exchange, keeps
 * the result on disk, and hands the rest of the plugin a local path -- so
 * `video_probe`, `video_storyboard`, `video_zoom` and `video_read` all work on a
 * B站 link without knowing anything about B站.
 *
 * Whatever is downloaded is cached under the DSH home directory and reused on
 * the next call; the file is named after the video so a cache listing is
 * readable, and the sidecar records the size so a truncated download is never
 * mistaken for a complete one.
 *
 * No dependencies: `node:https` for the transfer, `node:fs` for the cache, and
 * ffmpeg only when there is a subtitle track worth muxing in.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:https';
import { run } from './media.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VIEW = 'https://api.bilibili.com/x/web-interface/view';
const PLAYURL = 'https://api.bilibili.com/x/player/playurl';
const PLAYER = 'https://api.bilibili.com/x/player/v2';

/** Quality ids B站 uses, in the order we would like them. */
export const QUALITIES = [
  { qn: 127, height: 4320, label: '8K' },
  { qn: 126, height: 2160, label: '杜比视界' },
  { qn: 125, height: 2160, label: 'HDR' },
  { qn: 120, height: 2160, label: '4K' },
  { qn: 116, height: 1080, label: '1080P60' },
  { qn: 112, height: 1080, label: '1080P+' },
  { qn: 80, height: 1080, label: '1080P' },
  { qn: 74, height: 720, label: '720P60' },
  { qn: 64, height: 720, label: '720P' },
  { qn: 32, height: 480, label: '480P' },
  { qn: 16, height: 360, label: '360P' },
];

export function qualityLabel(qn) {
  const hit = QUALITIES.find((q) => q.qn === qn);
  return hit ? hit.label : `qn ${qn}`;
}

/**
 * Recognise a B站 link (or a bare id) without touching the network.
 * Returns `{ bvid | aid, page, part }` or `null`.
 */
export function parseBilibili(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  let page = 1;
  const pageMatch = /[?&]p=(\d+)/.exec(text);
  if (pageMatch) page = Number(pageMatch[1]) || 1;

  // `b23.tv/xxxx` is a redirect that has to be followed on the network
  const short = /^https?:\/\/b23\.tv\/([A-Za-z0-9]+)/.exec(text);
  if (short) return { short: short[1], page };

  // an `av` id is exchanged for a bvid by the view API
  const avUrl = /bilibili\.com\/video\/av(\d+)/i.exec(text) || /^av(\d+)$/i.exec(text);
  if (avUrl) return { aid: Number(avUrl[1]), page };

  const bv = /(BV[0-9A-Za-z]{10})/.exec(text);
  if (bv) return { bvid: bv[1], page };

  const av = /(?:^|[^a-z])av(\d+)/i.exec(text) || /^(\d{1,12})$/.exec(text);
  if (av) return { aid: Number(av[1]), page };

  return null;
}

export function isBilibili(input) {
  return parseBilibili(input) != null;
}

function cookieHeader(cookie) {
  if (!cookie) return null;
  const raw = String(cookie).trim();
  if (!raw) return null;
  return /[=;]/.test(raw) && raw.includes('=') ? raw : `SESSDATA=${raw}`;
}

async function readCookie(env = process.env) {
  if (env.DSH_BILIBILI_COOKIE) return cookieHeader(env.DSH_BILIBILI_COOKIE);
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  for (const name of ['bilibili-cookies.txt', 'bilibili.cookie']) {
    try {
      const raw = await readFile(join(home, name), 'utf8');
      const line = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      const cooked = cookieHeader(line);
      if (cooked) return cooked;
    } catch {
      // not there: anonymous it is
    }
  }
  return null;
}

/**
 * One HTTP request. `node:https` rather than `fetch`: B站's edge answers
 * undici's client with HTTP 412 often enough that the difference matters, while
 * this shape (plain GET, explicit headers, no ALPN games) goes through. Handles
 * redirects and reports 412 as a rate limit rather than a mystery.
 */
function httpGetText(url, { headers = {}, redirects = 5, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (target, hops) => {
      const request = httpGet(target, { headers }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && hops > 0) {
          res.resume();
          attempt(new URL(res.headers.location, target).href, hops - 1);
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status,
          url: target,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
        res.on('error', reject);
      });
      request.on('error', reject);
      if (signal) {
        const stop = () => request.destroy(new Error('已取消'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }
    };
    attempt(url, redirects);
  });
}

function biliHeaders(cookie) {
  const headers = {
    'User-Agent': UA,
    // NOT `https://www.bilibili.com/`: with the trailing slash the edge answers
    // 412 to every API call, which is easy to mistake for a rate limit.
    Referer: 'https://www.bilibili.com',
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'identity',
    Connection: 'close',
  };
  const cooked = cookieHeader(cookie);
  if (cooked) headers.Cookie = cooked;
  return headers;
}

/**
 * One JSON GET. Retries on transient failures and on 412 (the edge's throttle),
 * which it waits out instead of failing: a lecture analysis that dies after
 * three quick calls because a rate limiter blinked is worse than two seconds of
 * patience.
 */
export async function biliJson(url, { cookie = null, signal = null, tries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const res = await httpGetText(url, { headers: biliHeaders(cookie), signal });
      if (res.status === 412) {
        lastError = new Error('B站返回 HTTP 412（请求被限流拦截）');
        if (attempt + 1 < tries) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        throw lastError;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      let body;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new Error(`返回的不是 JSON（可能是风控页面，HTTP ${res.status}）`);
      }
      if (body && typeof body.code === 'number' && body.code !== 0) {
        throw new Error(`B站接口返回 ${body.code}: ${body.message || '未知错误'}`);
      }
      return body;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('请求失败');
}

/** Follow a `b23.tv/xxxx` short link to the video it points at. */
export async function resolveShortLink(short, { signal = null } = {}) {
  const url = `https://b23.tv/${short}`;
  try {
    const res = await httpGetText(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' },
      signal,
    });
    const parsed = parseBilibili(res.url);
    if (parsed) return parsed;
    throw new Error(`it redirects somewhere that is not a video (${res.url || url})`);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`short link b23.tv/${short} could not be resolved (${error.message}) — `
      + 'open it in a browser and paste the full bilibili.com URL instead');
  }
}

export function normalizeView(data, page = 1) {
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const wanted = Math.min(Math.max(1, page), Math.max(1, pages.length));
  const part = pages.find((p) => p.page === wanted) || pages[0] || null;
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: String(data.title || '').trim(),
    duration: Number(part?.duration ?? data.duration ?? 0),
    fullDuration: Number(data.duration ?? 0),
    page: wanted,
    pages: pages.length,
    partTitle: part ? String(part.part || '').trim() : '',
    cid: part ? Number(part.cid) : null,
    owner: data.owner ? String(data.owner.name || '') : '',
    pubdate: Number(data.pubdate || 0),
    cover: data.pic || null,
    url: `https://www.bilibili.com/video/${data.bvid}${wanted > 1 ? `?p=${wanted}` : ''}`,
  };
}

/** Metadata for a B站 link. No download: this is the cheap first call. */
export async function bilibiliView(input, { cookie = null, signal = null } = {}) {
  let target = parseBilibili(input);
  if (!target) throw new Error(`看不懂这个 B站 链接: ${input}`);
  if (target.short) {
    target = await resolveShortLink(target.short, { signal });
  }
  const query = target.bvid ? `bvid=${target.bvid}` : `aid=${target.aid}`;
  const body = await biliJson(`${VIEW}?${query}`, { cookie, signal });
  return normalizeView(body.data, target.page ?? 1);
}

/**
 * Exchange a video part for downloadable URLs. `fnval=1` asks for the plain
 * mp4 (`durl`) rather than DASH: one file that already has its audio, which is
 * exactly what this plugin reads. Big videos come back as several segments; we
 * concatenate them with the same `-c copy` trick as the subtitle mux.
 */
export async function bilibiliPlay(input, { cookie = null, signal = null, maxHeight = 1080 } = {}) {
  const meta = typeof input === 'object' && input ? input : await bilibiliView(input, { cookie, signal });
  if (!meta.cid) throw new Error('这个视频没有可播放的分P');
  const allowed = QUALITIES.filter((q) => q.height <= maxHeight);
  const params = new URLSearchParams({
    bvid: meta.bvid,
    cid: String(meta.cid),
    qn: String(allowed[0].qn),
    fnval: '1',
    fnver: '0',
    fourk: '1',
  });
  const body = await biliJson(`${PLAYURL}?${params}`, { cookie, signal });
  const data = body.data || {};
  const segs = Array.isArray(data.durl) ? data.durl : [];
  if (!segs.length) throw new Error('这个视频没有返回可下载地址（可能需要登录或大会员）');
  const urls = segs.map((s) => ({
    url: s.url,
    backup: Array.isArray(s.backup_url) ? s.backup_url : [],
    size: Number(s.size || 0),
    length: Number(s.length || 0),
  }));
  const size = urls.reduce((sum, u) => sum + u.size, 0) || null;
  return {
    meta,
    quality: Number(data.quality || 0),
    label: qualityLabel(Number(data.quality || 0)),
    accept: Array.isArray(data.accept_quality) ? data.accept_quality : [],
    urls,
    size,
    duration: Number(data.timelength ? data.timelength / 1000 : meta.duration),
  };
}

function fetchToFile(url, dest, { cookie = null, signal = null, onBytes = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const cooked = cookieHeader(cookie);
    const request = httpGet(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com',
        ...(cooked ? { Cookie: cooked } : {}),
        ...headers,
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: res.headers.location });
        return;
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${status}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      const out = createWriteStream(dest, { flags: 'w' });
      let seen = 0;
      res.on('data', (chunk) => {
        seen += chunk.length;
        if (onBytes) onBytes(chunk.length, total);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve({ bytes: seen, total }));
      res.pipe(out);
      if (signal) {
        const stop = () => {
          res.destroy();
          out.destroy();
          reject(new Error('已取消'));
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      }
    });
    request.on('error', reject);
    if (signal) {
      const stop = () => request.destroy(new Error('已取消'));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });
}

async function downloadSegments(urls, dest, opts = {}) {
  const parts = [];
  let done = 0;
  const size = urls.reduce((sum, u) => sum + (u.size || 0), 0);
  for (let i = 0; i < urls.length; i += 1) {
    const dest2 = `${dest}.part${urls.length > 1 ? `-${i}` : ''}`;
    const candidates = [urls[i].url, ...(urls[i].backup || [])];
    let failure = null;
    for (const candidate of candidates) {
      let current = candidate;
      for (let hop = 0; hop < 5; hop += 1) {
        try {
          const got = await fetchToFile(current, dest2, {
            ...opts,
            onBytes: (n) => {
              done += n;
              if (opts.onProgress) opts.onProgress({ bytes: done, size });
            },
          });
          if (got.redirect) {
            current = new URL(got.redirect, current).href;
            continue;
          }
          failure = null;
          break;
        } catch (error) {
          if (opts.signal?.aborted) throw error;
          failure = error;
          break;
        }
      }
      if (!failure) break;
    }
    if (failure) throw failure;
    parts.push(dest2);
  }
  return parts;
}

/** Turn B站's subtitle JSON into cues the plugin's transcript code understands. */
export function cuesFromBilibili(body) {
  const list = Array.isArray(body?.body) ? body.body : [];
  return list
    .map((line) => ({
      start: Number(line.from) || 0,
      end: Number(line.to) || 0,
      text: String(line.content || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((cue) => cue.text && cue.end > cue.start);
}

export function cuesToSrt(cues) {
  const stamp = (t) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    const frac = ms % 1000;
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    // ffmpeg rejects a dot as the millisecond separator, so this is a comma.
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`;
  };
  return cues
    .map((cue, i) => `${i + 1}\r\n${stamp(cue.start)} --> ${stamp(cue.end)}\r\n${cue.text}`)
    .join('\r\n\r\n') + '\r\n';
}

export async function bilibiliSubtitles(meta, { cookie = null, signal = null } = {}) {
  try {
    const body = await biliJson(`${PLAYER}?bvid=${meta.bvid}&cid=${meta.cid}`, { cookie, signal, tries: 2 });
    const list = body?.data?.subtitle?.subtitles || [];
    const usable = list.filter((s) => s && s.subtitle_url);
    if (!usable.length) return { cues: [], language: null, available: [] };
    const pick = usable.find((s) => /zh|cn/i.test(`${s.lan} ${s.lan_doc}`)) || usable[0];
    const url = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
    const payload = await biliJson(url, { cookie, signal, tries: 2 });
    return {
      cues: cuesFromBilibili(payload),
      language: pick.lan_doc || pick.lan || null,
      available: usable.map((s) => s.lan_doc || s.lan),
    };
  } catch {
    // Subtitles are a bonus: a video without them is still a video.
    return { cues: [], language: null, available: [] };
  }
}

export function cacheDirFor(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'cache', 'video-vision', 'bilibili');
}

function safeName(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'video';
}

/**
 * Download (or reuse) the playable file for a B站 link.
 *
 * Returns `{ path, meta, quality, label, bytes, cached, seconds, subtitle }`.
 * The cache file name carries bvid/part/quality, and the sidecar records the
 * size so a half-finished download from a killed run is retried rather than
 * decoded.
 */
export async function bilibiliFile(input, {
  cookie = null,
  signal = null,
  ffmpegPath = 'ffmpeg',
  maxHeight = 1080,
  cacheDir = cacheDirFor(),
  log = null,
  fresh = false,
  subtitles = true,
} = {}) {
  const started = Date.now();
  const cooked = cookie === null ? await readCookie() : cookieHeader(cookie);
  const play = await bilibiliPlay(input, { cookie: cooked, signal, maxHeight });
  const { meta } = play;
  const base = `${meta.bvid}-p${meta.page}-q${play.quality}`;
  const dir = join(cacheDir, meta.bvid);
  await mkdir(dir, { recursive: true });
  const final = join(dir, `${base}.mp4`);
  const sidecar = join(dir, `${base}.json`);

  if (!fresh) {
    try {
      const info = await stat(final);
      const saved = JSON.parse(await readFile(sidecar, 'utf8'));
      if (info.size > 0 && (!play.size || Math.abs(info.size - play.size) <= 1024 || info.size === saved.bytes)) {
        return {
          path: final,
          meta,
          quality: play.quality,
          label: play.label,
          bytes: info.size,
          cached: true,
          seconds: (Date.now() - started) / 1000,
          subtitle: saved.subtitle ?? null,
        };
      }
    } catch {
      // no cache entry: fall through and download
    }
  }

  if (log) log(`下载 ${meta.bvid} p${meta.page} ${play.label}${play.size ? ` · ${(play.size / 1048576).toFixed(1)} MB` : ''}`);
  // progress is a heartbeat, not a ticker: a log line per 16 KB chunk would
  // drown the transcript the model actually reads
  let lastReport = 0;
  const parts = await downloadSegments(play.urls, final, {
    cookie: cooked,
    signal,
    onProgress: (p) => {
      if (!log || !p.size) return;
      const now = Date.now();
      const pct = Math.floor((p.bytes / p.size) * 20) * 5;
      if (now - lastReport < 2000 && pct < 100) return;
      lastReport = now;
      log(`下载 ${pct}% · ${(p.bytes / 1048576).toFixed(1)}/${(p.size / 1048576).toFixed(1)} MB`);
    },
  });

  let assembled = parts[0];
  if (parts.length > 1) {
    const listPath = `${final}.txt`;
    await writeFile(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const merged = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
      '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-y', final], { signal });
    await rm(listPath, { force: true });
    if (merged.code !== 0) throw new Error(`拼接下载分片失败: ${merged.stderr.toString('utf8').slice(0, 200)}`);
    for (const part of parts) await rm(part, { force: true });
    assembled = final;
  } else {
    await rename(parts[0], final);
  }

  let subtitle = null;
  if (subtitles) {
    const subs = await bilibiliSubtitles(meta, { cookie: cooked, signal });
    if (subs.cues.length) {
      const srt = join(dir, `${base}.srt`);
      await writeFile(srt, cuesToSrt(subs.cues), 'utf8');
      const muxed = join(dir, `${base}.sub.mp4`);
      const res = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', assembled, '-i', srt,
        '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi',
        '-movflags', '+faststart', '-y', muxed], { signal });
      if (res.code === 0) {
        await rm(assembled, { force: true });
        await rename(muxed, final);
      } else {
        await rm(muxed, { force: true });
      }
      subtitle = { language: subs.language, cues: subs.cues.length, file: srt };
    } else {
      subtitle = { language: null, cues: 0, available: subs.available };
    }
  }

  const info = await stat(final);
  await writeFile(sidecar, JSON.stringify({
    bvid: meta.bvid, page: meta.page, quality: play.quality, label: play.label,
    bytes: info.size, meta, subtitle, at: new Date().toISOString(),
  }, null, 2), 'utf8');
  if (log) log(`下载完成 ${(info.size / 1048576).toFixed(1)} MB · ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return {
    path: final,
    meta,
    quality: play.quality,
    label: play.label,
    bytes: info.size,
    cached: false,
    seconds: (Date.now() - started) / 1000,
    subtitle,
  };
}

/**
 * A one-line summary of a B站 video, for `video_probe`. Deliberately does not
 * download anything: asking "what is this" should cost one HTTP call.
 */
export function describeBilibili(meta, extra = {}) {
  const parts = [];
  parts.push(`B站 · ${meta.title || meta.bvid}`);
  if (meta.owner) parts.push(`UP 主 ${meta.owner}`);
  const clock = (s) => {
    const total = Math.max(0, Math.round(Number(s) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };
  parts.push(`时长 ${clock(meta.duration)}`);
  if (meta.pages > 1) parts.push(`共 ${meta.pages} 个分P（本次第 ${meta.page} 个）`);
  if (meta.partTitle) parts.push(`分P 标题 ${meta.partTitle}`);
  if (extra.qualityLabel) parts.push(`可下载清晰度 ${extra.qualityLabel}`);
  if (extra.subtitles) parts.push(`字幕 ${extra.subtitles}`);
  parts.push(meta.url);
  return parts.join(' · ');
}

export { readCookie as bilibiliCookie };
