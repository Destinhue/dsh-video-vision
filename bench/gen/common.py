#!/usr/bin/env python3
"""
common.py -- shared infrastructure for the v4video ground-truth corpus.

Design notes
------------
* Frames are produced with numpy (+Pillow only for text/cards), then piped as
  rawvideo rgb24 into ffmpeg. That makes every cut land on an exact frame index,
  so ground truth is `frame_index / fps` with zero rounding ambiguity.
* Static card sequences can alternatively go through the ffmpeg concat demuxer
  (`png_concat_video`) which is much cheaper for slideshows; both paths are
  validated by gen/verify.py which re-decodes the finished mp4.
* No OpenCV on this machine: motion blur is implemented with numpy cumsum box
  blur passes (fast, deterministic).

Requires python3 with numpy + Pillow. Corpus generation is Windows-only (it uses
the system CJK/Consolas fonts and, for the speech clip, the SAPI desktop voice);
the generated corpus is committed to the repository, so this is only needed if you
want to regenerate it.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- paths ----

ROOT = r"F:\ai\v4video"
BENCH = os.path.join(ROOT, "bench")
CORPUS = os.path.join(BENCH, "corpus")
POSTERS = os.path.join(CORPUS, "posters")
GEN = os.path.join(BENCH, "gen")
WORK = os.path.join(BENCH, "out", "work")

FFMPEG = os.path.join(ROOT, r"vendor\bin\ffmpeg.exe")
FFPROBE = os.path.join(ROOT, r"vendor\bin\ffprobe.exe")

FONTS = {
    "cjk": r"C:\Windows\Fonts\msyh.ttc",
    "cjkb": r"C:\Windows\Fonts\msyhbd.ttc",
    "sans": r"C:\Windows\Fonts\arial.ttf",
    "sansb": r"C:\Windows\Fonts\arialbd.ttf",
    "mono": r"C:\Windows\Fonts\consola.ttf",
    "monob": r"C:\Windows\Fonts\consolab.ttf",
    "hei": r"C:\Windows\Fonts\simhei.ttf",
}

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(key: str, size: int) -> ImageFont.FreeTypeFont:
    k = (key, size)
    if k not in _FONT_CACHE:
        _FONT_CACHE[k] = ImageFont.truetype(FONTS[key], size)
    return _FONT_CACHE[k]


def ensure_dirs() -> None:
    for d in (CORPUS, POSTERS, WORK, os.path.join(BENCH, "gt")):
        os.makedirs(d, exist_ok=True)


# --------------------------------------------------------------- ffmpeg ----

def ffmpeg(args: list[str], *, what: str = "ffmpeg", timeout: int = 1800) -> None:
    """Run ffmpeg; raise with stderr tail on failure."""
    cmd = [FFMPEG, "-y", "-hide_banner", "-nostdin", "-loglevel", "error"] + args
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{what} FAILED (rc={p.returncode})\ncmd: {' '.join(cmd)}\n"
                           f"stderr:\n{(p.stderr or '')[-4000:]}")
    dt = time.time() - t0
    print(f"  [{what}] ok in {dt:5.1f}s -> {args[-1]}")


def ffprobe_json(path: str, extra: list[str] | None = None) -> dict:
    cmd = [FFPROBE, "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams"] + (extra or []) + [path]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"ffprobe failed on {path}: {p.stderr[-2000:]}")
    return json.loads(p.stdout)


def count_frames(path: str) -> int:
    """Decode-count video frames (exact, slower than nb_frames header)."""
    cmd = [FFPROBE, "-v", "error", "-select_streams", "v:0", "-count_frames",
           "-show_entries", "stream=nb_read_frames", "-of",
           "default=nokey=1:noprint_wrappers=1", path]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return int(p.stdout.strip() or 0)


def probe_summary(path: str) -> dict:
    j = ffprobe_json(path)
    vs = next((s for s in j["streams"] if s["codec_type"] == "video"), {})
    aus = next((s for s in j["streams"] if s["codec_type"] == "audio"), {})
    num, _, den = (vs.get("r_frame_rate") or "0/1").partition("/")
    fps = round(float(num) / float(den or 1), 6) if float(den or 1) else 0.0
    return {
        "duration": float(j["format"]["duration"]),
        "bytes": int(j["format"]["size"]),
        "width": int(vs.get("width", 0)),
        "height": int(vs.get("height", 0)),
        "fps": fps,
        "vcodec": vs.get("codec_name"),
        "pix_fmt": vs.get("pix_fmt"),
        "color_space": vs.get("color_space"),
        "color_range": vs.get("color_range"),
        "field_order": vs.get("field_order"),
        "acodec": aus.get("codec_name"),
        "sample_rate": aus.get("sample_rate"),
        "channels": aus.get("channels"),
        "nb_frames_header": int(vs.get("nb_frames") or 0),
        "sha256": sha256(path),
    }


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------- frame writer ----

class VideoWriter:
    """Pipe rgb24 numpy frames into an x264 encoder."""

    def __init__(self, out_path: str, w: int, h: int, fps: int, *,
                 crf: int = 20, preset: str = "veryfast", audio: str | None = None,
                 extra_in: list[str] | None = None, extra_out: list[str] | None = None,
                 what: str = "encode"):
        self.path, self.w, self.h, self.fps = out_path, w, h, fps
        self.n = 0
        self.what = what
        cmd = [FFMPEG, "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
               "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{w}x{h}", "-r", str(fps), "-i", "pipe:0"]
        cmd += extra_in or []
        if audio:
            cmd += ["-i", audio]
        cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf),
                # Force a KNOWN RGB->YUV conversion. Without out_color_matrix
                # swscale defaults to BT.601 coefficients for this input even at
                # 720p, which silently breaks any luma-based ground truth
                # (measured: a "equal luma" red/teal pair came out 18.7 apart).
                "-vf", ("scale=out_color_matrix=bt709:out_range=tv:"
                        "flags=bicubic+accurate_rnd+full_chroma_int,"
                        "format=yuv420p"),
                "-colorspace", "bt709", "-color_primaries", "bt709",
                "-color_trc", "bt709", "-color_range", "tv",
                "-g", str(min(fps * 2, 120)),
                "-movflags", "+faststart"]
        if audio:
            cmd += ["-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
                    "-shortest"]
        cmd += extra_out or []
        cmd += [out_path]
        self.cmd = cmd
        self.t0 = time.time()
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                  stderr=subprocess.PIPE)

    def write(self, frame: np.ndarray) -> None:
        if frame.shape != (self.h, self.w, 3):
            raise ValueError(f"bad frame shape {frame.shape} != {(self.h, self.w, 3)}")
        assert self.p.stdin is not None
        try:
            self.p.stdin.write(np.ascontiguousarray(frame, dtype=np.uint8).tobytes())
        except BrokenPipeError:
            raise RuntimeError(f"{self.what}: ffmpeg died\n"
                               f"{self.p.stderr.read().decode('utf-8', 'replace')[-3000:]}")
        self.n += 1

    def write_repeat(self, frame: np.ndarray, k: int) -> None:
        buf = np.ascontiguousarray(frame, dtype=np.uint8).tobytes()
        for _ in range(k):
            self.p.stdin.write(buf)
            self.n += 1

    def close(self) -> None:
        self.p.stdin.close()
        err = self.p.stderr.read().decode("utf-8", "replace")
        rc = self.p.wait()
        if rc != 0:
            raise RuntimeError(f"{self.what} FAILED rc={rc}\n{' '.join(self.cmd)}\n{err[-4000:]}")
        print(f"  [{self.what}] {self.n} frames in {time.time()-self.t0:5.1f}s -> "
              f"{os.path.basename(self.path)}")


# NOTE: an earlier revision built static-card clips with the ffmpeg concat
# demuxer (`file ... / duration ...`). It was rejected: 3 cards x 1.0s at 24fps
# produced 95 frames instead of 72 (3.958s vs 3.000s), because image inputs get a
# default 25fps packet duration that the `duration` directive does not fully
# override. Everything now goes through VideoWriter + write_repeat(), which is
# frame-exact (verified by count_frames) and fast (900 frames of 1280x720 in
# ~1.6s in testing).


# ------------------------------------------------------------- rendering ----

WHITE = (255, 255, 255)
BLACK = (0, 0, 0)


def new_frame(w: int, h: int, rgb) -> np.ndarray:
    a = np.empty((h, w, 3), dtype=np.uint8)
    a[:, :] = np.array(rgb, dtype=np.uint8)
    return a


def luma709(rgb) -> float:
    r, g, b = [float(x) for x in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def frame_mean_luma(img: np.ndarray) -> float:
    a = img.astype(np.float64)
    return float((0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]).mean())


def fit_text(draw: ImageDraw.ImageDraw, text: str, fkey: str, max_w: int,
             start: int, min_size: int = 16, stroke: int = 0):
    """Largest font size whose rendered text fits max_w."""
    size = start
    while size > min_size:
        f = font(fkey, size)
        box = draw.textbbox((0, 0), text, font=f, stroke_width=stroke)
        if box[2] - box[0] <= max_w:
            return f, size
        size -= max(2, size // 20)
    return font(fkey, min_size), min_size


def draw_centered(draw, text, fkey, size, xy, fill, *, stroke=0,
                  stroke_fill=BLACK, max_w=None):
    f = font(fkey, size)
    if max_w:
        f, size = fit_text(draw, text, fkey, max_w, size, stroke=stroke)
    draw.text(xy, text, font=f, fill=fill, anchor="mm",
              stroke_width=stroke, stroke_fill=stroke_fill)
    return size


def card_solid(w: int, h: int, rgb, label: str, *, sub: str | None = None,
               label_rgb=(255, 255, 255), sub_rgb=(255, 255, 255),
               label_frac: float = 0.22, border: tuple | None = None) -> np.ndarray:
    """Solid colour card with a big centered label and optional subtitle."""
    img = Image.fromarray(new_frame(w, h, rgb), "RGB")
    d = ImageDraw.Draw(img)
    size = int(h * label_frac)
    used = draw_centered(d, label, "sansb", size, (w // 2, int(h * 0.47)),
                         label_rgb, stroke=max(2, size // 22), stroke_fill=(0, 0, 0),
                         max_w=int(w * 0.90))
    if sub:
        ssz = max(14, int(min(h * 0.075, used * 0.42)))
        draw_centered(d, sub, "mono", ssz, (w // 2, int(h * 0.47 + size * 0.95)),
                      sub_rgb, max_w=int(w * 0.88))
    if border:
        d.rectangle([2, 2, w - 3, h - 3], outline=border, width=max(3, h // 90))
    return np.asarray(img, dtype=np.uint8).copy()


def _vignette_label(img: Image.Image, text: str, w: int, h: int, *,
                    pos="tl", size=None, fill=(255, 255, 255)):
    d = ImageDraw.Draw(img)
    size = size or max(14, h // 18)
    pad = max(8, h // 40)
    box = d.textbbox((0, 0), text, font=font("monob", size))
    tw, th = box[2] - box[0], box[3] - box[1]
    x = pad if "l" in pos else w - tw - pad * 3
    y = pad if "t" in pos else h - th - pad * 3
    d.rectangle([x - pad, y - pad, x + tw + pad, y + th + pad], fill=(0, 0, 0))
    d.text((x, y), text, font=font("monob", size), fill=fill)


# --------------------------------------------------------------- audio -----

def write_wav(path: str, samples: np.ndarray, sr: int = 44100) -> str:
    """samples: float32 in [-1,1], shape (n,) mono or (n,2). Writes 16-bit PCM."""
    import wave
    s = np.clip(samples, -1.0, 1.0)
    if s.ndim == 1:
        s = np.stack([s, s], axis=1)
    pcm = (s * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(s.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


def read_wav(path: str) -> tuple[np.ndarray, int]:
    import wave
    with wave.open(path, "rb") as w:
        sr, ch, sw, n = (w.getframerate(), w.getnchannels(),
                         w.getsampwidth(), w.getnframes())
        raw = w.readframes(n)
    if sw != 2:
        raise ValueError(f"expected 16-bit pcm, got {sw*8}-bit")
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a, sr


def wav_duration(path: str) -> float:
    a, sr = read_wav(path)
    return len(a) / sr


def rms_db(x: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(x))) + 1e-12)
    return 20.0 * np.log10(r)


def peak_db(x: np.ndarray) -> float:
    return 20.0 * np.log10(float(np.max(np.abs(x))) + 1e-12)


def fade_edges(x: np.ndarray, ms: int = 8, sr: int = 44100) -> np.ndarray:
    n = min(int(sr * ms / 1000), len(x) // 2)
    if n <= 0:
        return x
    y = x.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[:n] *= ramp
    y[-n:] *= ramp[::-1]
    return y


# --------------------------------------------------------------- blur ------

def box_blur_x(a: np.ndarray, r: int) -> np.ndarray:
    """Horizontal box blur (float32 HxWxC) via cumsum. Edge-replicated."""
    if r <= 0:
        return a
    pad = np.pad(a, ((0, 0), (r + 1, r), (0, 0)), mode="edge")
    cs = np.cumsum(pad, axis=1, dtype=np.float64)
    k = 2 * r + 1
    out = (cs[:, k:, :] - cs[:, :-k, :]) / k
    return out.astype(np.float32)


def motion_blur_x(a: np.ndarray, radius: float) -> np.ndarray:
    """Approximate directional (horizontal) motion blur with 3 box passes."""
    if radius < 0.5:
        return a
    r = int(round(radius))
    radii = [max(1, r // 2), max(1, r // 3), max(1, r // 4)]
    out = a.astype(np.float32)
    for rr in radii:
        out = box_blur_x(out, rr)
    return out


def sharpness(img: np.ndarray) -> float:
    """Gradient-energy sharpness proxy (variance of Sobel-ish diffs)."""
    g = (img.astype(np.float32)
         @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))
    gx = np.diff(g, axis=1)
    gy = np.diff(g, axis=0)
    return float(np.var(gx) + np.var(gy))


# ------------------------------------------------------- sprite compositing ---

def text_rgba(text: str, fkey: str, size: int, fill=(255, 255, 255, 255),
              stroke: int = 0, stroke_fill=(0, 0, 0, 255)) -> np.ndarray:
    """Pre-render text to an RGBA sprite (cheap to blit onto many frames)."""
    f = font(fkey, size)
    tmp = Image.new("RGBA", (8, 8))
    box = ImageDraw.Draw(tmp).textbbox((0, 0), text, font=f, stroke_width=stroke)
    w = box[2] - box[0] + 2 * stroke + 8
    h = box[3] - box[1] + 2 * stroke + 8
    img = Image.new("RGBA", (max(w, 1), max(h, 1)), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((4 + stroke - box[0], 4 + stroke - box[1]), text,
                             font=f, fill=fill, stroke_width=stroke,
                             stroke_fill=stroke_fill)
    return np.asarray(img, dtype=np.uint8)


def blit_rgba(dst: np.ndarray, sprite: np.ndarray, x: int, y: int) -> None:
    """Alpha-blend an RGBA sprite onto an HxWx3 uint8 frame, clipped to bounds."""
    sh, sw = sprite.shape[:2]
    H, W = dst.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + sw), min(H, y + sh)
    if x0 >= x1 or y0 >= y1:
        return
    sx0, sy0 = x0 - x, y0 - y
    sub = sprite[sy0:sy0 + (y1 - y0), sx0:sx0 + (x1 - x0)]
    a = (sub[..., 3:4].astype(np.float32) / 255.0)
    reg = dst[y0:y1, x0:x1].astype(np.float32)
    dst[y0:y1, x0:x1] = (reg * (1.0 - a) + sub[..., :3].astype(np.float32) * a
                         ).astype(np.uint8)


def rect(frame: np.ndarray, x0: int, y0: int, x1: int, y1: int, rgb) -> None:
    H, W = frame.shape[:2]
    frame[max(0, y0):min(H, y1), max(0, x0):min(W, x1)] = np.array(rgb, np.uint8)


# ------------------------------------------------------------ measurement ---

def yavg_segment(path: str, start: float, dur: float) -> dict:
    """Mean YAVG over [start, start+dur) as stored in the encoded stream.

    Uses signalstats on decoded frames, so it reflects the real limited-range
    luma in the file (Y = 16..235), not the RGB we designed with.
    NOTE: must use the `trim` filter, not `-ss`/`-t`. With output-side -ss/-t the
    filter chain still sees every decoded frame and the metadata print covers the
    whole file (measured: 597 "frames" for a 3.7s window).
    """
    vf = (f"trim=start={start:.6f}:end={start + dur:.6f},signalstats,"
          f"metadata=print:key=lavfi.signalstats.YAVG:file=-")
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", path,
           "-vf", vf, "-fps_mode", "passthrough", "-an", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    vals = []
    for line in (p.stdout + p.stderr).splitlines():
        if "YAVG=" in line:
            try:
                vals.append(float(line.split("YAVG=")[1].split()[0]))
            except (IndexError, ValueError):
                pass
    if not vals:
        return {"n": 0, "mean": None}
    return {"n": len(vals), "mean": round(float(np.mean(vals)), 3),
            "min": round(float(np.min(vals)), 3),
            "max": round(float(np.max(vals)), 3)}


def volumedetect_segment(path: str, start: float, dur: float) -> dict:
    """Measured mean/max volume of an audio segment, in dBFS (trim, not -ss)."""
    af = f"atrim=start={start:.6f}:end={start + dur:.6f},volumedetect"
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "info", "-i", path,
           "-af", af, "-vn", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    out = {}
    for line in (p.stderr or "").splitlines():
        for k in ("mean_volume", "max_volume"):
            if k in line:
                try:
                    out[k] = round(float(line.split(k + ":")[1].split("dB")[0]), 2)
                except (IndexError, ValueError):
                    pass
    return out



# ---------------------------------------------------------------- misc -----

def poster_from_video(src: str, dst: str, t: float) -> None:
    ffmpeg(["-ss", f"{t:.3f}", "-i", src, "-frames:v", "1",
            "-vf", "scale='min(640,iw)':-2", dst], what="poster")


def write_json(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024.0
    return f"{n:.1f}GB"
