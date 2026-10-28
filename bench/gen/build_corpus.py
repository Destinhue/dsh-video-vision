#!/usr/bin/env python3
"""
build_corpus.py -- synthesize the v4video ground-truth video corpus.

Every clip is generated frame-exactly: numpy/Pillow frames are piped as rawvideo
into libx264, so shot boundaries land on integer frame indices and the ground
truth cut time is `frame / fps` with no rounding ambiguity.

Clips (see README.md for the numbers):
  A_hardcuts_720p        10 hard cuts, incl. an equal-luma / different-hue pair
  B_montage_360p         25 fast shots (0.6-1.5s), 24 cuts in 20s
  C_slowpan_720p         single 30s take, no cuts, moving text
  D_slideshow_720p       6 bilingual text cards
  E_blurtransition_720p  1s motion blur between two clean shots
  F_flicker_360p         single white flash frames on animated content
  G_speech_360p          SAPI speech at known times + silence gaps + RMS meter
  H_music_360p           music only, loud/quiet sections (no speech)
  I_portrait_interlaced  true interlaced 480x852 portrait, 4 shots

Usage:
  python build_corpus.py                 # all clips
  python build_corpus.py --only A,F      # subset
  python build_corpus.py --no-index      # skip index.json
"""
from __future__ import annotations

import argparse
import colorsys
import json
import math
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

import common as C

HERE = os.path.dirname(os.path.abspath(__file__))
PS1_TTS = os.path.join(HERE, "sapi_tts.ps1")
SR = 44100


# --------------------------------------------------------------- helpers ----

def cut_times(cum_frames: list[int], fps: int) -> list[float]:
    """Boundary times between consecutive shots, in seconds."""
    out, acc = [], 0
    for f in cum_frames[:-1]:
        acc += f
        out.append(round(acc / fps, 6))
    return out


def shot_list(cum_frames: list[int], fps: int, labels: list[str]) -> list[dict]:
    """Shots with exact start/end derived from frame counts."""
    shots, acc = [], 0
    for i, (f, lab) in enumerate(zip(cum_frames, labels)):
        shots.append({"index": i + 1,
                      "label": lab,
                      "start": round(acc / fps, 6),
                      "end": round((acc + f) / fps, 6),
                      "start_frame": acc,
                      "frames": f})
        acc += f
    return shots


def finalize(name: str, category: str, path: str, *, fps: int, w: int, h: int,
             frames: int, shots: list[dict], cuts: list[float],
             text_cards=None, speech=None, notes: str = "",
             extra: dict | None = None, poster_t: float = 1.0) -> dict:
    s = C.probe_summary(path)
    poster_rel = f"corpus/posters/{name}.png"
    C.poster_from_video(path, os.path.join(C.POSTERS, f"{name}.png"), poster_t)
    gt = {
        "name": name,
        "file": f"corpus/{name}.mp4",
        "category": category,
        "width": w, "height": h, "fps": fps, "frames": frames,
        "duration": round(frames / fps, 6),
        "container_duration": s["duration"],
        "shots": shots,
        "cuts": [round(c, 6) for c in cuts],
        "n_shots": len(shots),
        "n_cuts": len(cuts),
        "text_cards": text_cards or [],
        "speech": speech or [],
        "poster": poster_rel,
        "bytes": s["bytes"],
        "sha256": s["sha256"],
        "vcodec": s["vcodec"], "acodec": s["acodec"],
        "pix_fmt": s["pix_fmt"],
        "field_order": s["field_order"],
        "audio_sample_rate": s["sample_rate"],
        "notes": notes,
    }
    if extra:
        gt.update(extra)
    # sanity: encoded frame count must match the plan
    n_actual = C.count_frames(path)
    gt["frames_actual"] = n_actual
    if n_actual != frames:
        gt["WARNING"] = f"frame count mismatch: planned {frames}, encoded {n_actual}"
        print(f"  !! WARNING {name}: planned {frames} frames, got {n_actual}")
    print(f"  -> {name}: {frames}f {round(frames/fps,3)}s "
          f"{s['width']}x{s['height']} {C.human(s['bytes'])}")
    return gt


def pick_label_rgb(bg) -> tuple:
    return (15, 15, 18) if C.luma709(bg) > 140 else (255, 255, 255)


# =============================================================== A ==========

def build_A() -> dict:
    """10 hard cuts, 4s each, 1280x720@30. One pair has equal luma, different hue."""
    w, h, fps = 1280, 720, 30
    shot_f = 120                      # 4.000 s
    name = "A_hardcuts_720p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")

    colors = [
        (210, 35, 45),    # 1 crimson
        (30, 95, 190),    # 2 blue
        (245, 195, 45),   # 3 yellow
        (28, 28, 34),     # 4 near black
        (255, 0, 0),      # 5 RED    } equal-luma
        (0, 64, 117),     # 6 TEAL   } pair
        (240, 240, 240),  # 7 white
        (20, 150, 90),    # 8 green
        (120, 60, 160),   # 9 purple
        (12, 12, 14),     # 10 near black
    ]
    labels = [f"SHOT{i:02d}" for i in range(1, 11)]

    def frame_for(i: int, rgb) -> np.ndarray:
        t = i * shot_f / fps
        return C.card_solid(w, h, rgb, labels[i],
                            sub=f"cut index {i+1:02d}  t={t:.2f}s",
                            label_rgb=pick_label_rgb(rgb),
                            label_frac=0.235, border=(255, 255, 255))

    # --- equal-luma compensation between shots 5 and 6 -----------------------
    # Mean frame luma is linear in a uniform RGB offset applied to the
    # background, so search small integer (dr,dg,db) offsets for a sub-0.02
    # residual. Range- and chroma-subsampling effects are measured afterwards on
    # the encoded stream (see luma_equal_pair.measured_yavg_limited_range).
    f5 = frame_for(4, colors[4])
    target = C.frame_mean_luma(f5)
    teal_base = frame_for(5, colors[5])
    need = target - C.frame_mean_luma(teal_base)

    best = (1e9, (0, 0, 0))
    cands = []
    for dr in range(-14, 15):
        for dg in range(-14, 15):
            for db in range(-14, 15):
                rgb = tuple(int(np.clip(v + d, 0, 255))
                            for v, d in zip(colors[5], (dr, dg, db)))
                if any(v + d < 0 or v + d > 255
                       for v, d in zip(colors[5], (dr, dg, db))):
                    continue          # clipping would break the linearity
                pred = 0.2126 * dr + 0.7152 * dg + 0.0722 * db
                cands.append((abs(pred - need), (dr, dg, db), rgb))
    cands.sort(key=lambda c: c[0])
    # Linear prediction ignores 4:2:0 chroma siting, so render the top few and
    # pick the one whose real frame mean is closest.
    for _, off, rgb in cands[:24]:
        d = abs(C.frame_mean_luma(frame_for(5, rgb)) - target)
        if d < best[0]:
            best = (d, off, rgb)
    resid, (dr, dg, db), teal_rgb = best
    colors[5] = teal_rgb
    f6 = frame_for(5, teal_rgb)
    lum_delta = abs(C.frame_mean_luma(f6) - target)
    print(f"A: equal-luma pair offset ({dr:+d},{dg:+d},{db:+d}) -> {teal_rgb} "
          f"(residual mean-luma delta {lum_delta:.5f}/255)")

    cum = [shot_f] * 10
    shots = shot_list(cum, fps, labels)
    cuts = cut_times(cum, fps)

    def encode_and_measure(teal) -> tuple:
        nonlocal colors
        colors[5] = teal
        vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", what=name)
        for i, rgb in enumerate(colors):
            vw.write_repeat(frame_for(i, rgb), shot_f)
        vw.close()
        ya = C.yavg_segment(path, 4 * 4.0 + 0.5, 3.0)
        yb = C.yavg_segment(path, 5 * 4.0 + 0.5, 3.0)
        return ya, yb

    ya, yb = encode_and_measure(teal_rgb)
    # x264's DC quantiser nudges the two frames apart by a fraction of one code
    # value. One or two empirical passes on the ENCODED stream close the gap far
    # below anything a scene detector could threshold on.
    passes = []
    for _ in range(3):
        if ya["mean"] is None or yb["mean"] is None:
            break
        delta = ya["mean"] - yb["mean"]
        passes.append(round(delta, 4))
        if abs(delta) <= 0.08:
            break
        incr = delta / 219.0 * 255.0          # limited-range Y -> full-range luma
        step, best_off = 1e9, (0, 0, 0)
        for pr in range(-3, 4):
            for pg in range(-3, 4):
                for pb in range(-3, 4):
                    rgb = (teal_rgb[0] + pr, teal_rgb[1] + pg, teal_rgb[2] + pb)
                    if any(v < 0 or v > 255 for v in rgb):
                        continue
                    d = abs(0.2126 * pr + 0.7152 * pg + 0.0722 * pb - incr)
                    if d < step:
                        step, best_off = d, (pr, pg, pb)
        if best_off == (0, 0, 0):
            break
        teal_rgb = tuple(int(v + d) for v, d in zip(teal_rgb, best_off))
        colors[5] = teal_rgb
        ya, yb = encode_and_measure(teal_rgb)
    if ya["mean"] is not None and yb["mean"] is not None:
        print(f"A: encoded-luma pair SHOT05={ya['mean']} SHOT06={yb['mean']} "
              f"delta={abs(ya['mean'] - yb['mean']):.4f}/219 "
              f"(pass deltas {passes}) teal={teal_rgb}")

    return finalize(
        name, "A_hard_cuts", path, fps=fps, w=w, h=h, frames=10 * shot_f,
        shots=shots, cuts=cuts, poster_t=1.0,
        notes=("Ten 4.000s solid-colour shots with a big English label and the cut "
               "time burned in. SHOT05 and SHOT06 have deliberately EQUAL mean "
               "luma but opposite hue, so a luma-difference scene detector should "
               "MISS that cut while an HSV/chroma detector should see it. All 9 "
               "cuts are hard: no fades, no motion, no audio."),
        extra={
            "luma_equal_pair": {
                "shots": [5, 6],
                "labels": ["SHOT05", "SHOT06"],
                "rgb": [[255, 0, 0], list(teal_rgb)],
                "teal_original_design_rgb": [0, 64, 117],
                "offset_from_design_rgb": [teal_rgb[0] - 0,
                                           teal_rgb[1] - 64,
                                           teal_rgb[2] - 117],
                "designed_mean_luma_rgb709": [
                    round(C.luma709((255, 0, 0)), 4),
                    round(C.luma709(teal_rgb), 4)],
                "measured_yavg_limited_range": {"SHOT05": ya["mean"],
                                                "SHOT06": yb["mean"]},
                "measured_delta_limited_range": (round(abs(ya["mean"] - yb["mean"]), 4)
                                                 if ya["mean"] is not None and yb["mean"] is not None
                                                 else None),
                "measured_delta_pct_of_range": (round(100 * abs(ya["mean"] - yb["mean"]) / 219.0, 4)
                                                if ya["mean"] is not None and yb["mean"] is not None
                                                else None),
                "threshold_guidance": (
                    "Any luma-difference scene detector with a threshold above "
                    "0.05% of the 219-code video range must NOT report a cut at "
                    "t=20.0s. An HSV/chroma detector must report 9 cuts."),
            },
            "shots_rgb": [list(c) for c in colors],
        })


# =============================================================== B ==========

def build_B() -> dict:
    """25 fast shots (0.6-1.5s) in exactly 20s, 640x360@30."""
    w, h, fps = 640, 360, 30
    n, total_f = 25, 600             # 20.000 s
    name = "B_montage_360p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")

    rng = np.random.default_rng(7)
    raw = rng.integers(18, 46, size=n).astype(float)   # 0.6 .. 1.5 s
    raw = raw / raw.sum() * total_f
    durs = np.floor(raw).astype(int)
    while durs.sum() != total_f:                       # deterministic fix-up
        if durs.sum() < total_f:
            durs[int(np.argmin(durs))] += 1
        else:
            durs[int(np.argmax(durs))] -= 1
    assert durs.min() >= 18 - 6 and durs.max() <= 45 + 6, (durs.min(), durs.max())

    labels = [f"M{i:02d}" for i in range(1, n + 1)]
    vw = C.VideoWriter(path, w, h, fps, crf=21, preset="veryfast", what=name)
    for i, df in enumerate(durs):
        hue = (i * 0.37) % 1.0
        s_ = 0.85 if i % 3 else 0.55
        v_ = 0.95 if i % 2 else 0.70
        rgb = tuple(int(round(x * 255)) for x in colorsys.hsv_to_rgb(hue, s_, v_))
        base = C.card_solid(w, h, rgb, labels[i], label_rgb=pick_label_rgb(rgb),
                            sub=f"{df/fps:.3f}s", label_frac=0.30)
        for j in range(int(df)):                       # progress bar = motion
            fr = base.copy()
            x1 = int((w - 24) * (j + 1) / df)
            C.rect(fr, 12, h - 34, 12 + x1, h - 16, (255, 255, 255))
            vw.write(fr)
    vw.close()

    cum = [int(d) for d in durs]
    shots = shot_list(cum, fps, labels)
    cuts = cut_times(cum, fps)

    return finalize(
        name, "B_fast_montage", path, fps=fps, w=w, h=h, frames=total_f,
        shots=shots, cuts=cuts, poster_t=0.3,
        notes=("25 shots of 0.600-1.500s, 24 cuts in exactly 20.000s. Each shot is "
               "a big index label on a distinct hue plus a white progress bar that "
               "resets at every cut, so a sampler that misses a cut also visibly "
               "splices two different progress bars. Shot durations are generated "
               "from numpy rng(seed=7) and fixed up to sum to exactly 600 frames."),
        extra={"shot_durations_s": [round(f / fps, 4) for f in cum],
               "seed": 7})


# =============================================================== C ==========

def build_C() -> dict:
    """30s single take: slow pan across a 2560px panorama + independently moving text."""
    w, h, fps = 1280, 720, 25
    total_f = 750                     # 30.000 s
    pano_w = 2560
    name = "C_slowpan_720p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")

    # ---- panorama -----------------------------------------------------------
    yy = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    xx = np.linspace(0, 1, pano_w, dtype=np.float32)[None, :]
    sky = np.stack([
        30 + 150 * (1 - yy) + 12 * np.sin(6 * xx),
        60 + 110 * (1 - yy) + 10 * np.cos(5 * xx),
        120 + 90 * (1 - yy) + 0.0 * xx,
    ], axis=-1)
    pano = np.clip(sky, 0, 255).astype(np.uint8)
    pano = np.ascontiguousarray(np.broadcast_to(pano, (h, pano_w, 3)).copy())

    img = Image.fromarray(pano, "RGB")
    d = ImageDraw.Draw(img)
    # ground plane + grid
    d.rectangle([0, int(h * 0.72), pano_w, h], fill=(34, 38, 44))
    for gx in range(0, pano_w, 80):
        d.line([(gx, int(h * 0.72)), (gx + 40, h)], fill=(58, 64, 72), width=2)
    for gy in range(int(h * 0.72), h, 36):
        d.line([(0, gy), (pano_w, gy)], fill=(58, 64, 72), width=2)
    # landmarks with bilingual labels
    marks = [(260, "起点 START", (232, 84, 64)),
             (900, "中段 MIDDLE", (64, 176, 208)),
             (1500, "左侧 LEFT", (232, 196, 72)),
             (2180, "终点 END", (120, 208, 120))]
    for i, (mx, text, col) in enumerate(marks):
        bw, bh = 150, 240
        d.rectangle([mx, int(h * 0.72) - bh, mx + bw, int(h * 0.72)], fill=col)
        d.rectangle([mx, int(h * 0.72) - bh, mx + bw, int(h * 0.72)],
                    outline=(255, 255, 255), width=3)
        t = C.text_rgba(text, "cjkb", 44, (255, 255, 255, 255), 3)
        img.paste(Image.fromarray(t, "RGBA"),
                  (mx + bw // 2 - t.shape[1] // 2,
                   int(h * 0.72) - bh // 2 - t.shape[0] // 2), Image.fromarray(t, "RGBA"))
    d.text((30, 26), "SLOW PAN / SINGLE TAKE / NO CUTS / 30.000s",
           font=C.font("monob", 34), fill=(255, 255, 255),
           stroke_width=3, stroke_fill=(0, 0, 0))
    d.text((30, 74), "panorama 2560px -> 1280px viewport", font=C.font("mono", 26),
           fill=(230, 230, 230), stroke_width=2, stroke_fill=(0, 0, 0))
    pano = np.asarray(img, dtype=np.uint8).copy()

    sprite = C.text_rgba("MOVING LABEL", "sansb", 56, (255, 255, 255, 255), 4)

    vw = C.VideoWriter(path, w, h, fps, crf=21, preset="veryfast", what=name)
    for i in range(total_f):
        t = i / fps
        off = int(round((pano_w - w) * i / (total_f - 1)))       # 0 .. 1280
        fr = pano[:, off:off + w].copy()
        mx = int(60 + (w - 520) * i / (total_f - 1))
        my = int(h * 0.30 + 70 * math.sin(2 * math.pi * t / 6.0))
        C.blit_rgba(fr, sprite, mx, my)
        ts = C.text_rgba(f"t={t:05.2f}s", "monob", 34, (255, 240, 120, 255), 3)
        C.blit_rgba(fr, ts, w - ts.shape[1] - 24, h - ts.shape[0] - 24)
        vw.write(fr)
    vw.close()

    return finalize(
        name, "C_slow_pan", path, fps=fps, w=w, h=h, frames=total_f,
        shots=[{"index": 1, "label": "SINGLE_TAKE", "start": 0.0,
                "end": round(total_f / fps, 6), "start_frame": 0, "frames": total_f}],
        cuts=[], poster_t=2.0,
        notes=("One continuous 30.000s take: a 1280px viewport pans across a "
               "2560px panorama (0 -> 1280 px, ~42.7 px/s) while a 'MOVING LABEL' "
               "sprite drifts horizontally AND vertically (sin, period 6s) and a "
               "burned-in timer ticks. Ground truth has exactly 0 cuts, so any cut "
               "reported here is a false positive. Motion is smooth: neighbouring "
               "frames differ, which stresses scene detectors that threshold too "
               "low."),
        extra={"pan": {"from_x": 0, "to_x": 1280, "speed_px_per_s": 42.667},
               "moving_text": {"period_s": 6.0, "x_range_px": [60, 820],
                               "y_center_px": 216, "y_amplitude_px": 70}})


# =============================================================== D ==========

def _card_bilingual(w: int, h: int, idx: int, total: int, title_cn: str,
                    title_en: str, lines: list[str], accent) -> np.ndarray:
    img = Image.new("RGB", (w, h), (16, 18, 22))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 10], fill=accent)
    d.rectangle([0, h - 8, w, h], fill=accent)
    d.rectangle([56, 96, 64, 96 + 250], fill=accent)
    d.text((96, 104), title_cn, font=C.font("cjkb", 96), fill=(255, 255, 255))
    d.text((100, 226), title_en, font=C.font("sansb", 52), fill=accent)
    d.line([(96, 300), (w - 96, 300)], fill=(70, 76, 86), width=3)
    y = 348
    for ln in lines:
        d.ellipse([100, y + 18, 118, y + 36], fill=accent)
        d.text((140, y), ln, font=C.font("cjk", 46), fill=(226, 230, 236))
        y += 82
    d.text((96, h - 96), f"CARD {idx:02d} / {total:02d}", font=C.font("monob", 34),
           fill=(140, 148, 160))
    d.text((w - 340, h - 96), "1280x720 · 24fps", font=C.font("mono", 30),
           fill=(140, 148, 160))
    return np.asarray(img, dtype=np.uint8).copy()


def build_D() -> dict:
    """6 bilingual slides, 6s each, 1280x720@24. Tests OCR at tile size."""
    w, h, fps = 1280, 720, 24
    card_f = int(6.0 * fps)            # 144 frames = 6.000 s
    name = "D_slideshow_720p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")

    cards = [
        ("基准测试总览", "BENCHMARK OVERVIEW",
         ["帧采样 · frame sampling", "镜头切分 · shot detection",
          "语音转写 · speech to text"], (232, 84, 64)),
        ("镜头切分", "SHOT DETECTION",
         ["硬切 · hard cut", "淡入淡出 · fade", "闪帧 · flash frame"],
         (64, 176, 208)),
        ("文字识别", "OCR READABILITY",
         ["中英混排 · mixed script", "最小字号 46 像素", "对比度 13:1"],
         (232, 196, 72)),
        ("语音转写", "SPEECH TRANSCRIPTION",
         ["已知台词 · known script", "静音间隔 1.8 秒", "采样率 44100 Hz"],
         (120, 208, 120)),
        ("帧采样策略", "FRAME SAMPLING",
         ["均匀采样 · uniform", "关键帧 · keyframe", "质心采样 · centroid"],
         (168, 128, 232)),
        ("结论", "SUMMARY",
         ["九段素材 · nine clips", "全部机器可读 · machine readable",
          "真值精确到帧 · frame-exact"], (240, 240, 240)),
    ]

    frames = []
    for i, (cn, en, lines, acc) in enumerate(cards):
        frames.append(_card_bilingual(w, h, i + 1, len(cards), cn, en, lines, acc))

    vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", what=name)
    for fr in frames:
        vw.write_repeat(fr, card_f)
    vw.close()

    text_cards = []
    for i, (cn, en, lines, _) in enumerate(cards):
        text_cards.append({
            "start": round(i * card_f / fps, 6),
            "end": round((i + 1) * card_f / fps, 6),
            "index": i + 1,
            "title_cn": cn, "title_en": en,
            "lines": lines,
            "text": "\n".join([cn, en] + lines),
        })
    cum = [card_f] * len(cards)
    shots = shot_list(cum, fps, [f"CARD{i:02d}" for i in range(1, 7)])

    return finalize(
        name, "D_slideshow_ocr", path, fps=fps, w=w, h=h, frames=card_f * len(cards),
        shots=shots, cuts=cut_times(cum, fps), text_cards=text_cards, poster_t=1.0,
        notes=("Six static slides of exactly 6.000s each. Titles are Chinese at "
               "96px (Microsoft YaHei Bold), English subtitles at 52px, body lines "
               "at 46px, all >=46px tall at 720p so they stay ~11px tall in a "
               "1280/5-wide tile. Every card carries both scripts on the same "
               "line-group, which is the hard case for OCR tile sizing: at 46px the "
               "CJK glyphs are 46x46 px, still legible after a 4x downscale, "
               "illegible after 8x."),
        extra={"card_texts": [tc["text"] for tc in text_cards]})


# =============================================================== E ==========

def build_E() -> dict:
    """1s horizontal motion blur joining two clean shots. Tests sharpest-frame pick."""
    w, h, fps = 1280, 720, 30
    f_clean, f_trans = 150, 30         # 5.000 s + 1.000 s + 5.000 s = 11.000 s
    name = "E_blurtransition_720p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")

    a = C.card_solid(w, h, (36, 110, 168), "BEFORE",
                     sub="clean shot A · sharp", label_frac=0.24,
                     border=(255, 255, 255)).astype(np.float32)
    b = C.card_solid(w, h, (196, 96, 48), "AFTER",
                     sub="clean shot B · sharp", label_frac=0.24,
                     border=(255, 255, 255)).astype(np.float32)

    vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", what=name)
    vw.write_repeat(a.astype(np.uint8), f_clean)

    sharp = []
    for i in range(f_trans):
        alpha = i / (f_trans - 1)
        blend = (1.0 - alpha) * a + alpha * b
        radius = 34.0 * math.sin(math.pi * alpha)      # 0 at both ends, 34px mid
        fr = C.motion_blur_x(blend, radius)
        out = np.clip(fr, 0, 255).astype(np.uint8)
        sharp.append(round(C.sharpness(out), 2))
        vw.write(out)
    vw.write_repeat(b.astype(np.uint8), f_clean)
    vw.close()

    shots = [
        {"index": 1, "label": "SHOT_A", "start": 0.0,
         "end": round(f_clean / fps, 6), "start_frame": 0, "frames": f_clean},
        {"index": 2, "label": "TRANSITION", "start": round(f_clean / fps, 6),
         "end": round((f_clean + f_trans) / fps, 6),
         "start_frame": f_clean, "frames": f_trans},
        {"index": 3, "label": "SHOT_B",
         "start": round((f_clean + f_trans) / fps, 6),
         "end": round((2 * f_clean + f_trans) / fps, 6),
         "start_frame": f_clean + f_trans, "frames": f_clean},
    ]
    clean_sharp = C.sharpness(a.astype(np.uint8))
    min_i = int(np.argmin(sharp))

    return finalize(
        name, "E_blur_transition", path, fps=fps, w=w, h=h,
        frames=2 * f_clean + f_trans, shots=shots, cuts=[], poster_t=1.0,
        notes=("Shot A (5.000s, sharp) -> 30 transition frames (1.000s) -> shot B "
               "(5.000s, sharp). Transition frame i is a crossfade blended with a "
               "horizontal motion blur whose radius follows 34*sin(pi*alpha), so it "
               "is ~0px at both ends and ~34px in the middle: the sharpest frame in "
               "the transition window IS the first or last one. There are NO hard "
               "cuts; a correct sampler should pick a sharp frame from the window "
               "rather than the blurriest one, so ground truth records the measured "
               "sharpness curve and the blurriest frame index."),
        extra={"transitions": [{"start": round(f_clean / fps, 6),
                                "end": round((f_clean + f_trans) / fps, 6),
                                "type": "motion_blur_x",
                                "frames": [f_clean, f_clean + f_trans - 1]}],
               "sharpness": {
                   "metric": "var(dx)+var(dy) of luma",
                   "clean_shot_value": round(clean_sharp, 2),
                   "transition_curve": sharp,
                   "blurriest_frame": f_clean + min_i,
                   "blurriest_time": round((f_clean + min_i) / fps, 6),
                   "blurriest_value": sharp[min_i],
                   "clean_frame_ranges": [[0, f_clean - 1],
                                          [f_clean + f_trans,
                                           2 * f_clean + f_trans - 1]]}})


# =============================================================== F ==========

def build_F() -> dict:
    """Single white flash frames dropped into continuously moving content."""
    w, h, fps = 640, 360, 30
    total_f = 720                       # 24.000 s
    name = "F_flicker_360p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")
    flash_at = [48, 105, 168, 213, 288, 333, 405, 462, 519, 576, 639, 690]

    # pre-render the animated base for 1/30s steps
    lab = C.text_rgba("FLICKER + FLASH FRAMES", "sansb", 44, (255, 255, 255, 255), 4)
    vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", what=name)
    flash_set = set(flash_at)
    grad = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :, None]
    for i in range(total_f):
        if i in flash_set:
            vw.write(C.new_frame(w, h, (255, 255, 255)))     # single white frame
            continue
        t = i / fps
        # hue rotates continuously; luma stays mid-grey so flashes are unambiguous
        c1 = np.array([90 + 60 * math.sin(2 * math.pi * t / 9),
                       110 + 55 * math.sin(2 * math.pi * t / 7 + 1.1),
                       130 + 50 * math.sin(2 * math.pi * t / 11 + 2.2)],
                      dtype=np.float32)
        c2 = np.array([40 + 45 * math.sin(2 * math.pi * t / 5 + 0.7),
                       50 + 40 * math.sin(2 * math.pi * t / 6 + 2.0),
                       70 + 45 * math.sin(2 * math.pi * t / 4 + 3.0)],
                      dtype=np.float32)
        fr = np.clip(c1[None, None, :] * (1 - grad) + c2[None, None, :] * grad,
                     0, 255).astype(np.uint8)
        fr = np.broadcast_to(fr, (h, w, 3)).copy()
        # moving bar + bouncing block give real inter-frame motion
        bx = int((w - 70) * (0.5 + 0.5 * math.sin(2 * math.pi * t / 8)))
        C.rect(fr, bx, int(h * 0.62), bx + 70, h, (245, 240, 120))
        by = int((h - 60) * (0.5 + 0.5 * math.sin(2 * math.pi * t / 3.3)))
        C.rect(fr, int(w * 0.06), by, int(w * 0.06) + 60, by + 60, (250, 250, 250))
        C.blit_rgba(fr, lab, int(w / 2 - lab.shape[1] / 2), 30)
        ts = C.text_rgba(f"t={t:05.2f}", "monob", 28, (255, 255, 255, 255), 3)
        C.blit_rgba(fr, ts, w - ts.shape[1] - 18, h - ts.shape[0] - 18)
        vw.write(fr)
    vw.close()

    flash = [{"frame": f, "time": round(f / fps, 6)} for f in flash_at]
    return finalize(
        name, "F_flicker_flash", path, fps=fps, w=w, h=h, frames=total_f,
        shots=[{"index": 1, "label": "CONTINUOUS", "start": 0.0,
                "end": round(total_f / fps, 6), "start_frame": 0, "frames": total_f}],
        cuts=[], poster_t=1.0,
        notes=("24.000s of continuously varying colour + two moving elements, with "
               "12 SINGLE-FRAME pure-white flashes at the frame indices listed in "
               "flash_frames[]. Each flash lasts 1/30s = 33.3ms. A tile grid that "
               "spends a cell on a flash wastes that cell's whole time span, and a "
               "scene detector that thresholds naively will report 24 cuts where "
               "there are none. Content is designed so the luma of neighbouring "
               "normal frames differs by < 2/255, making a white frame pop."),
        extra={"flash_frames": flash,
               "expected_visual_changes": [
                   {"frame": f, "time": round(f / fps, 6),
                    "reason": "single-frame white flash (not a shot cut)"}
                   for f in flash_at],
               "flash_count": len(flash),
               "flash_duration_ms": round(1000.0 / fps, 3),
               "expected_clean_frame_count": total_f - len(flash_at)})


# =============================================================== G ==========

SENTENCES = [
    ("The quick brown fox jumps over the lazy dog.", "Microsoft Zira Desktop"),
    ("Schema migration failed in the nightly build at three in the morning.",
     "Microsoft Zira Desktop"),
    ("Please rotate the API key before Friday.", "Microsoft Zira Desktop"),
    ("One hundred and forty two items remain in the queue.",
     "Microsoft Zira Desktop"),
]


def _sapi(text: str, out_wav: str, voice: str) -> float:
    cmd = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
           "-File", PS1_TTS, "-Text", text, "-Out", out_wav, "-Voice", voice]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    if p.returncode != 0 or not os.path.exists(out_wav):
        raise RuntimeError(f"SAPI failed for {text!r}\n{p.stdout}\n{p.stderr}")
    return C.wav_duration(out_wav)


def build_G() -> dict:
    """Known speech at known times with silence gaps + audio-reactive level bar."""
    w, h, fps = 640, 360, 30
    name = "G_speech_360p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")
    wavdir = os.path.join(C.WORK, "speech")
    os.makedirs(wavdir, exist_ok=True)

    # ---- synthesize each sentence, then lay them out with known silence -------
    clips = []
    for i, (text, voice) in enumerate(SENTENCES):
        p = os.path.join(wavdir, f"seg{i+1}.wav")
        dur = _sapi(text, p, voice)
        a, sr = C.read_wav(p)
        clips.append({"text": text, "dur": dur, "audio": a, "sr": sr})
        print(f"  SAPI seg{i+1}: {dur:.3f}s  {text!r}")

    gaps = [1.7, 1.8, 1.4]
    starts = [1.0]
    for i in range(1, len(clips)):
        starts.append(round(starts[i - 1] + clips[i - 1]["dur"] + gaps[i - 1], 4))

    last_end = starts[-1] + clips[-1]["dur"]
    # Video must cover the WHOLE audio track (incl. the 0.4s tail pad), otherwise
    # the muxer truncates the last silence and the GT speech ends past EOF.
    total_f = int(math.ceil((last_end + 2.0) * fps))
    total_s = total_f / fps

    # ---- build the audio track ----------------------------------------------
    pad = 0.4
    n_samp = int((total_s + pad) * SR)
    mix = np.zeros(n_samp, dtype=np.float32)
    speech = []
    for i, c in enumerate(clips):
        a = c["audio"]
        if c["sr"] != SR:
            idx = np.linspace(0, len(a) - 1, int(len(a) * SR / c["sr"]))
            a = np.interp(idx, np.arange(len(a)), a).astype(np.float32)
        a = C.fade_edges(a, 10, SR) * 0.85
        off = int(round(starts[i] * SR))
        mix[off:off + len(a)] = a
        speech.append({"index": i + 1, "start": starts[i],
                       "end": round(starts[i] + len(a) / SR, 4),
                       "text": c["text"], "voice": SENTENCES[i][1]})
    wav = os.path.join(wavdir, "G_mix.wav")
    C.write_wav(wav, mix, SR)
    print(f"  audio: {len(mix)/SR:.3f}s, speech {speech[0]['start']}..{speech[-1]['end']}")

    # ---- per-frame RMS envelope (drives the burned-in meter) ----------------
    env = np.array([C.rms_db(mix[int(i / fps * SR):int((i + 1) / fps * SR)])
                    for i in range(total_f)])

    # ---- cards that switch exactly at each speech start / end --------------
    states = []          # (start, end, kind, sub, rgb, speech_index|None)
    prev = 0.0
    for si, s in enumerate(speech):
        if s["start"] - prev > 1e-6:
            states.append((prev, s["start"], "SILENCE",
                           f"gap {s['start'] - prev:.2f}s", (28, 32, 40), None))
        states.append((s["start"], s["end"], "SPEECH", s["text"], (58, 46, 32), si))
        prev = s["end"]
    if total_s - prev > 1e-6:
        states.append((prev, total_s, "SILENCE",
                       f"tail {total_s - prev:.2f}s", (28, 32, 40), None))

    base_cache: dict[int, np.ndarray] = {}

    def base_for(seg: int) -> np.ndarray:
        if seg not in base_cache:
            _, _, kind, sub, rgb, si = states[seg]
            if kind == "SPEECH":
                title = f"SPEECH {si + 1}/{len(speech)}"
                body = sub
            else:
                title, body = "SILENCE", sub
            base_cache[seg] = C.card_solid(w, h, rgb, title, sub=body[:56],
                                           label_frac=0.16)
        return base_cache[seg]

    vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", audio=wav,
                       what=name)
    seg_i = 0
    for i in range(total_f):
        t = i / fps
        while seg_i + 1 < len(states) and t >= states[seg_i + 1][0]:
            seg_i += 1
        fr = base_for(seg_i).copy()
        # level bar: -60..0 dBFS -> 0..100% width
        lvl = float(np.clip((env[i] + 60.0) / 60.0, 0, 1))
        C.rect(fr, 0, h - 18, w, h, (20, 20, 24))
        C.rect(fr, 0, h - 18, int(w * lvl), h, (90, 210, 120))
        vw.write(fr)
    vw.close()

    text_cards = [{"start": round(a, 6), "end": round(b, 6), "text": kind,
                   "detail": sub} for a, b, kind, sub, _rgb, _si in states]

    env_path = os.path.join(C.CORPUS, f"{name}.envelope.json")
    C.write_json(env_path, {
        "name": name, "fps": fps, "frames": total_f,
        "metric": "RMS dBFS per frame window",
        "db": [round(float(x), 2) for x in env],
    })

    silences = []
    prev_end = 0.0
    for s in speech:
        if s["start"] - prev_end > 0.01:
            silences.append({"start": round(prev_end, 4), "end": s["start"],
                             "duration": round(s["start"] - prev_end, 4)})
        prev_end = s["end"]
    if total_s - prev_end > 0.01:
        silences.append({"start": round(prev_end, 4), "end": round(total_s, 4),
                         "duration": round(total_s - prev_end, 4)})

    return finalize(
        name, "G_speech_asr", path, fps=fps, w=w, h=h, frames=total_f,
        shots=[{"index": 1, "label": "SPEECH_CLIP", "start": 0.0,
                "end": round(total_s, 6), "start_frame": 0, "frames": total_f}],
        cuts=[], speech=speech, text_cards=text_cards, poster_t=1.6,
        notes=("Windows SAPI (Microsoft Zira Desktop) renders four sentences to "
               "44.1kHz mono WAV; they are laid out at the offsets below with "
               "1.4-1.8s silence between them. Each sentence's exact end time is "
               "its WAV duration, not an estimate. The video card switches between "
               "'SILENCE' (dark blue) and 'SPEECH' (dark amber) exactly at each "
               "speech start, and a green bar at the bottom tracks the per-frame "
               "RMS in dBFS (-60..0), so audio/video offset is measurable to one "
               "frame (33.3ms). Per-frame envelope: G_speech_360p.envelope.json."),
        extra={"silence_gaps": silences,
               # The banner switches SILENCE<->SPEECH at the exact speech start
               # and end times. Those are text-overlay changes inside ONE
               # continuous take: a pixel-difference detector will spike there but
               # a correct scene/shot detector must NOT report a shot cut.
               "expected_visual_changes": [
                   {"frame": int(round(b * fps)),
                    "time": round(b, 6),
                    "reason": f"banner switches to {states[i + 1][2] if i + 1 < len(states) else 'SILENCE'} (not a shot cut)"}
                   for i, (a, b, *_rest) in enumerate(states[:-1])],
               "envelope_file": f"corpus/{name}.envelope.json",
               "audio_encoding": {"sample_rate": SR, "codec": "aac",
                                  "bitrate": "160k", "channels": 2},
               "tts": {"engine": "Windows SAPI System.Speech",
                       "voices": sorted({v for _, v in SENTENCES})}})


# =============================================================== H ==========

def _music_section(n: int, sr: int, freqs: list[float], gain: float,
                   t0: float) -> np.ndarray:
    t = (np.arange(n, dtype=np.float32) / sr) + t0
    sig = np.zeros(n, dtype=np.float32)
    for k, f in enumerate(freqs):
        amp = 0.55 / (k + 1)
        sig += amp * np.sin(2 * np.pi * f * t).astype(np.float32)
        sig += 0.22 * amp * np.sin(2 * np.pi * 2 * f * t).astype(np.float32)
    # slow tremolo + an arpeggio so it reads as music, not a test tone
    trem = (0.82 + 0.18 * np.sin(2 * np.pi * 0.9 * t)).astype(np.float32)
    arp_f = np.array([freqs[0] * 2, freqs[1] * 2, freqs[2] * 2, freqs[1] * 2],
                     dtype=np.float32)
    step = int(sr * 0.5)
    arp = np.zeros(n, dtype=np.float32)
    for b, bf in enumerate(np.tile(arp_f, int(np.ceil(n / step / len(arp_f))))[:n // step + 1]):
        s0 = b * step
        s1 = min(n, s0 + step)
        if s0 >= n:
            break
        tt = np.arange(s1 - s0, dtype=np.float32) / sr
        envv = np.exp(-3.2 * tt).astype(np.float32)
        arp[s0:s1] = 0.30 * np.sin(2 * np.pi * bf * tt).astype(np.float32) * envv
    sig = (sig / (np.max(np.abs(sig)) + 1e-9)) * 0.9 + arp
    return (sig * trem * gain).astype(np.float32)


def build_H() -> dict:
    """Music only, loud/quiet sections. Any transcript is a false positive."""
    w, h, fps = 640, 360, 24
    name = "H_music_360p"
    path = os.path.join(C.CORPUS, f"{name}.mp4")
    sections = [  # (start, end, level, gain)
        (0.0, 8.0, "loud", 1.00),
        (8.0, 16.0, "quiet", 0.035),
        (16.0, 24.0, "loud", 0.85),
        (24.0, 30.0, "quiet", 0.050),
    ]
    total_f = int(30.0 * fps)
    total_s = total_f / fps

    prog = [[220.00, 261.63, 329.63],      # Am
            [174.61, 220.00, 261.63],      # F
            [196.00, 246.94, 293.66],      # G
            [220.00, 261.63, 329.63]]      # Am
    n_samp = int((total_s + 0.5) * SR)
    mix = np.zeros(n_samp, dtype=np.float32)
    for si, (ss, se, lvl, g) in enumerate(sections):
        a = int(ss * SR)
        b = int(se * SR)
        seg = _music_section(b - a, SR, prog[si % len(prog)], g, ss)
        if si == 0:
            seg = C.fade_edges(seg, 60, SR)
        mix[a:b] = seg
    wav = os.path.join(C.WORK, "H_music.wav")
    C.write_wav(wav, mix, SR)

    env = np.array([C.rms_db(mix[int(i / fps * SR):int((i + 1) / fps * SR)])
                    for i in range(total_f)])

    letters = ["LOUD", "QUIET", "LOUD", "QUIET"]
    cols = [(140, 60, 60), (40, 52, 64), (140, 60, 60), (40, 52, 64)]
    vw = C.VideoWriter(path, w, h, fps, crf=20, preset="veryfast", audio=wav,
                       what=name)
    cur_si, base = -1, None
    for i in range(total_f):
        t = i / fps
        si = 0
        for k, s in enumerate(sections):
            if s[0] <= t:
                si = k
        if si != cur_si:
            base = C.card_solid(w, h, cols[si], "MUSIC ONLY",
                                sub=f"section {si+1}/4 · {letters[si]} · no speech",
                                label_frac=0.17)
            cur_si = si
        fr = base.copy()
        lvl = float(np.clip((env[i] + 60.0) / 60.0, 0, 1))
        C.rect(fr, 0, h - 22, w, h, (18, 18, 22))
        C.rect(fr, 0, h - 22, int(w * lvl), h, (230, 180, 60))
        C.blit_rgba(fr, C.text_rgba(f"-{abs(env[i]):05.1f} dBFS", "monob", 26,
                                    (255, 255, 255, 255), 3),
                    w - 250, 14)
        vw.write(fr)
    vw.close()

    meas = []
    for (ss, se, lvl, g) in sections:
        v = C.volumedetect_segment(path, ss + 0.25, max(0.5, se - ss - 0.5))
        meas.append({"start": ss, "end": se, "level": lvl, "gain": g,
                     "measured_mean_db": v.get("mean_volume"),
                     "measured_max_db": v.get("max_volume")})
        print(f"  H section {ss}-{se}s {lvl}: {v}")

    loud = [m["measured_mean_db"] for m in meas if m["level"] == "loud"]
    quiet = [m["measured_mean_db"] for m in meas if m["level"] == "quiet"]
    contrast = round(float(np.mean(loud) - np.mean(quiet)), 2)

    return finalize(
        name, "H_music_only", path, fps=fps, w=w, h=h, frames=total_f,
        shots=[{"index": 1, "label": "MUSIC", "start": 0.0,
                "end": round(total_s, 6), "start_frame": 0, "frames": total_f}],
        cuts=[], speech=[], poster_t=2.0,
        notes=("30.000s of synthesized instrumental music (Am-F-G-Am pad + "
               "arpeggio, no voices) split into four sections: LOUD / QUIET / LOUD "
               "/ QUIET with a measured loud-quiet contrast of "
               f"{contrast} dB. There is NO speech in this clip, so a correct ASR "
               "pass returns an empty transcript; anything else is a false "
               "positive. The video shows the per-frame dBFS and a level bar so the "
               "envelope can be matched frame by frame."),
        extra={"audio_sections": meas,
               "expected_visual_changes": [
                   {"frame": int(round(ss * fps)), "time": ss,
                    "reason": f"section background/label switches to {lvl} "
                              f"(not a shot cut)"}
                   for (ss, se, lvl, g) in sections[1:]],
               "loud_quiet_contrast_db": contrast,
               "spectrum": {"chords": ["A2-C4-E4", "F2-A3-C4", "G2-B3-D4",
                                       "A2-C4-E4"],
                            "instrument": "additive sine pad + decaying arpeggio"},
               "expected_transcript": ""})


# =============================================================== I ==========

def build_I() -> dict:
    """True interlaced 480x852 portrait clip with 4 shots."""
    w, h, fps = 480, 852, 25
    name = "I_portrait_interlaced"
    path = os.path.join(C.CORPUS, f"{name}.mp4")
    shot_frames = [150, 150, 125, 125]     # 6s, 6s, 5s, 5s -> 22.000 s
    labels = ["PORTRAIT 01", "PORTRAIT 02", "PORTRAIT 03", "PORTRAIT 04"]
    colors = [(186, 42, 96), (34, 118, 96), (206, 152, 40), (72, 68, 160)]

    prog = []                                   # progressive frames at 2x rate
    for si, sf in enumerate(shot_frames):
        rgb = colors[si]
        base = C.card_solid(w, h, rgb, labels[si], sub=f"480x852 interlaced · {sf/fps:.2f}s",
                            label_frac=0.075)
        for j in range(sf * 2):
            fr = base.copy()
            yy = int((h - 90) * j / (sf * 2 - 1))
            C.rect(fr, 30, yy, w - 30, yy + 60, (250, 250, 250))       # moving band
            xx = int((w - 50) * (j % (sf)) / max(1, sf - 1))
            C.rect(fr, xx, int(h * 0.80), xx + 40, int(h * 0.80) + 40, (20, 20, 24))
            prog.append(fr)

    vw = C.VideoWriter(path, w, h, fps, crf=21, preset="veryfast", what=name,
                       extra_out=["-flags", "+ildct+ilme", "-x264-params", "tff=1"])
    for i in range(len(prog) // 2):
        f0, f1 = prog[2 * i], prog[2 * i + 1]      # two moments -> one frame
        fr = f0.copy()
        fr[1::2, :, :] = f1[1::2, :, :]            # bottom field from the later moment
        vw.write(fr)
    vw.close()

    cum = shot_frames
    shots = shot_list(cum, fps, labels)
    s = C.probe_summary(path)

    return finalize(
        name, "I_portrait_interlaced", path, fps=fps, w=w, h=h,
        frames=sum(shot_frames), shots=shots, cuts=cut_times(cum, fps),
        poster_t=1.0,
        notes=("Portrait 480x852 (0.563:1) encoded as TRUE interlaced H.264 top-field-"
               "first: each output frame takes its top field from moment n and its "
               "bottom field from moment n+1, so combing is real and a deinterlacer "
               "must be used or the moving elements will look feathered. Tests "
               "(a) non-16:9 aspect handling, (b) field-order metadata and (c) "
               "vertically tall tiles. 22.000s, 4 shots. NOTE: 480x854 is NOT a "
               "legal size for interlaced H.264 4:2:0 - libx264 rejects it with "
               "'height not divisible by 4 (480x854)'. 852 (213 macroblocks) is "
               "the nearest legal height, hence 480x852."),
        extra={"aspect_ratio": round(w / h, 4),
               "orientation": "portrait",
               "labels": labels,
               "interlaced": True,
               "encoded_field_order": s["field_order"],
               "requires_deinterlace": s["field_order"] not in (None, "progressive"),
               "frame_notes": "top and bottom fields come from consecutive moments"})


# ================================================================= main =====

BUILDERS = {
    "A": build_A, "B": build_B, "C": build_C, "D": build_D,
    "E": build_E, "F": build_F, "G": build_G, "H": build_H, "I": build_I,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma separated keys, e.g. A,C,F")
    ap.add_argument("--no-index", action="store_true")
    args = ap.parse_args()

    C.ensure_dirs()
    keys = ([k.strip().upper() for k in args.only.split(",") if k.strip()]
            or list(BUILDERS))
    gts, t_all = [], time.time()
    for k in keys:
        if k not in BUILDERS:
            print(f"!! unknown clip {k}")
            continue
        print(f"\n=== {k} ===")
        t0 = time.time()
        gt = BUILDERS[k]()
        gt["build_seconds"] = round(time.time() - t0, 1)
        C.write_json(os.path.join(C.CORPUS, "gt", f"{gt['name']}.gt.json"), gt)
        gts.append(gt)

    print(f"\ntotal build {time.time()-t_all:.1f}s for {len(gts)} clips")

    if not args.no_index and len(keys) == len(BUILDERS):
        idx_path = os.path.join(C.CORPUS, "index.json")
        prior = {}
        if os.path.exists(idx_path):
            prior = {c["name"]: c for c in json.load(open(idx_path, encoding="utf-8"))["clips"]}
        clips = []
        for g in gts:
            clips.append({
                "name": g["name"],
                "file": g["file"],
                "category": g["category"],
                "duration_s": g["duration"],
                "fps": g["fps"],
                "width": g["width"], "height": g["height"],
                "frames": g["frames"],
                "n_shots": g["n_shots"],
                "n_cuts": g["n_cuts"],
                "n_text_cards": len(g["text_cards"]),
                "n_speech": len(g["speech"]),
                "has_audio": bool(g["acodec"]),
                "bytes": g["bytes"],
                "poster": g["poster"],
                "gt_file": f"corpus/gt/{g['name']}.gt.json",
                "sha256": g["sha256"],
                "cuts": g["cuts"],
                "notes_head": g["notes"][:160],
                "gt": g,
            })
        total_bytes = sum(c["bytes"] for c in clips)
        index = {
            "schema": "v4video.bench.corpus/1",
            "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "generator": {
                "script": "bench/gen/build_corpus.py",
                "ffmpeg": C.FFMPEG, "ffprobe": C.FFPROBE,
                "ffmpeg_version": "8.0.1-essentials_build-www.gyan.dev",
            },
            "clip_count": len(clips),
            "total_seconds": round(sum(c["duration_s"] for c in clips), 3),
            "total_bytes": total_bytes,
            "total_human": C.human(total_bytes),
            "clips": clips,
        }
        C.write_json(idx_path, index)
        print(f"\nindex.json: {len(clips)} clips, "
              f"{index['total_seconds']}s, {index['total_human']}")

    print("\nGT written to", os.path.join(C.CORPUS, "gt"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
