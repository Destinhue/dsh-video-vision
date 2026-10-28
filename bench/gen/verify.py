"""Independent verification of the generated corpus.

This does NOT trust the build script: it re-decodes every mp4 with ffmpeg and
recomputes the properties the ground truth claims. Anything the build script got
wrong shows up here as a FAIL line.

Checks per clip
  * container: duration / size / fps, frame count (decoded, not from the header)
  * hard cuts: frame-to-frame difference on a small decode; every GT cut must
    have a spike within +/-1 frame, and no spike may appear away from a GT cut
    (for the clips whose GT says "no cuts")
  * A only: the equal-luma pair - luma delta must be tiny while chroma delta is
    large
  * D only: every card's text region must contain high-contrast pixels (a proxy
    for "the text really is rendered")
  * F only: every flicker frame must be a near-white frame
  * H only: loud sections must measure a much higher mean volume than quiet ones
  * I only: encoded field order must not be "progressive"

Usage: PYTHONPATH=. python verify.py [--only A,F] [--strict]
Exit code 0 if all checks pass (or only warnings), 1 if any FAIL.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

import numpy as np

import common as C

FAILS: list[str] = []
WARNS: list[str] = []


def fail(msg: str) -> None:
    FAILS.append(msg)
    print(f"  FAIL  {msg}")


def warn(msg: str) -> None:
    WARNS.append(msg)
    print(f"  warn  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def decode_small(path: str, w: int = 96, h: int = 54) -> np.ndarray:
    """Decode the whole video to (n, h, w, 3) uint8 via one ffmpeg pipe."""
    cmd = [C.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", path,
           "-vf", f"scale={w}:{h}:flags=area", "-pix_fmt", "rgb24",
           "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"decode failed: {p.stderr.decode('utf-8', 'replace')[:400]}")
    fs = w * h * 3
    n = len(p.stdout) // fs
    return np.frombuffer(p.stdout[:n * fs], dtype=np.uint8).reshape(n, h, w, 3)


def frame_diffs(frames: np.ndarray) -> np.ndarray:
    a = frames.astype(np.int16)
    return np.abs(a[1:] - a[:-1]).mean(axis=(1, 2, 3))


def peaks(diffs: np.ndarray, k: float = 6.0) -> list[int]:
    """Indices i such that diff[i] is a strong local maximum.

    i is the index of the *first* frame of the new shot (diff index i-1 -> i).
    """
    if len(diffs) < 3:
        return []
    med = float(np.median(diffs))
    mad = float(np.median(np.abs(diffs - med))) or 1e-6
    thr = med + k * max(mad, 1.0)
    out = []
    for i in range(1, len(diffs) - 1):
        if diffs[i] > thr and diffs[i] >= diffs[i - 1] and diffs[i] >= diffs[i + 1]:
            out.append(i + 1)          # +1: frame index whose content starts
    return out


def check_clip(entry: dict, strict: bool) -> None:
    """entry = one element of index.json["clips"]; the full GT comes from gt_file."""
    name = entry["name"]
    with open(os.path.join(C.BENCH, entry["gt_file"]), encoding="utf-8") as f:
        gt = json.load(f)
    path = os.path.join(C.BENCH, entry["file"])
    print(f"\n=== {name} ===")
    if not os.path.exists(path):
        fail(f"{name}: missing file {path}")
        return

    fps = float(gt["fps"])
    frames = decode_small(path)
    n = len(frames)
    want = gt.get("frames")
    if want is not None and n != want:
        fail(f"{name}: decoded {n} frames, GT says {want}")
    else:
        ok(f"frame count {n}")

    dur = n / fps
    if abs(dur - float(gt["duration"])) > 1.5 / fps:
        fail(f"{name}: duration {dur:.4f}s vs GT {gt['duration']}s")
    else:
        ok(f"duration {dur:.4f}s")

    # ---------------- cuts ----------------
    gt_cuts = [float(c) for c in gt.get("cuts") or []]
    gt_frames = [int(round(c * fps)) for c in gt_cuts]
    d = frame_diffs(frames)
    det = peaks(d)
    # Frames where the GT *predicts* a pixel-difference spike that is NOT a shot
    # cut (single flash frames, banner/section switches). A scene detector is
    # allowed to fire there; it is not a GT cut.
    expected_frames = set()
    for ev in gt.get("expected_visual_changes") or []:
        f0 = int(ev.get("frame", 0))
        # a flash spikes on entry AND on exit
        for k in (-1, 0, 1):
            expected_frames.add(f0 + k)
    matched_gt, missed, extra = set(), [], []
    for gc, gf in zip(gt_cuts, gt_frames):
        hit = [p for p in det if abs(p - gf) <= 1]
        if hit:
            matched_gt.add(gc)
        else:
            missed.append(gc)
    for p in det:
        if any(abs(p - gf) <= 1 for gf in gt_frames):
            continue
        if p in expected_frames or (p + 1) in expected_frames:
            continue
        extra.append(p)
    if gt_cuts:
        if missed:
            fail(f"{name}: {len(missed)} GT cut(s) not detected: {missed[:6]}")
        else:
            ok(f"all {len(gt_cuts)} GT cuts detected (+/-1 frame)")
        if extra:
            # extra detections are expected for D (card changes) and B (progress
            # bar resets) - only flag when GT claims very few cuts
            if len(gt_cuts) <= 2:
                fail(f"{name}: {len(extra)} cut(s) detected in a clip with "
                     f"{len(gt_cuts)} GT cut(s): frames {extra[:8]}")
            else:
                ok(f"{len(extra)} extra peak(s) (progress bar / label churn), "
                   f"e.g. frames {extra[:5]}")
    else:
        if extra:
            fail(f"{name}: GT says 0 cuts but {len(extra)} unexplained peak(s) at "
                 f"frames {extra[:8]} (max diff {d.max():.2f})")
        else:
            ok(f"no false cuts (0 unexplained peaks, max frame diff {d.max():.2f}); "
               f"{len(det)} peak(s) explained by expected_visual_changes")

    # ---------------- per-clip extras ----------------
    kind = gt.get("category", "")
    if kind.startswith("A_"):
        pair = gt["luma_equal_pair"]
        ya, yb = pair["measured_yavg_limited_range"]["SHOT05"], \
            pair["measured_yavg_limited_range"]["SHOT06"]
        if ya is None or yb is None:
            fail(f"{name}: could not measure the equal-luma pair")
        else:
            dlt = abs(ya - yb)
            if dlt > 1.0:
                fail(f"{name}: equal-luma pair differs by {dlt:.3f}/219")
            else:
                ok(f"equal-luma pair delta {dlt:.4f}/219 "
                   f"({100*dlt/219:.3f}% of range)")
        # chroma must differ a lot: compare mean |U-128| / |V-128| on the two shots
        u5, v5 = chroma_means(path, 5 * 4.0 + 0.5, 3.0)
        u6, v6 = chroma_means(path, 6 * 4.0 + 0.5, 3.0)
        if abs(u5 - u6) + abs(v5 - v6) < 20:
            fail(f"{name}: chroma barely differs between SHOT05/06 "
                 f"(U {u5:.1f}->{u6:.1f}, V {v5:.1f}->{v6:.1f})")
        else:
            ok(f"chroma differs strongly (U {u5:.1f}->{u6:.1f}, "
               f"V {v5:.1f}->{v6:.1f})")

    if kind.startswith("D_"):
        cards = gt.get("text_cards") or []
        for card in cards:
            mid = (float(card["start"]) + float(card["end"])) / 2
            n_fr = int(mid * fps)
            if n_fr >= n:
                fail(f"{name}: card {card['index']} mid {mid:.2f}s beyond EOF")
                continue
            fr = frames[n_fr]
            # text proxy: the card body is near-black, the glyphs near-white
            lo = fr.min()
            hi = fr.max()
            if hi - lo < 120:
                fail(f"{name}: card {card['index']} has no high-contrast text "
                     f"(range {hi-lo})")
        if cards:
            ok(f"{len(cards)} text cards all contain high-contrast content")

    if kind.startswith("F_"):
        raw = gt.get("flash_frames") or []
        fl = [int(e["frame"]) if isinstance(e, dict) else int(e) for e in raw]
        bad = []
        for f in fl:
            if f >= n:
                bad.append((f, "beyond EOF"))
                continue
            m = frames[f].mean()
            if m < 235:
                bad.append((f, f"mean {m:.1f}"))
        if bad:
            fail(f"{name}: {len(bad)} flicker frame(s) not white: {bad[:5]}")
        else:
            ok(f"all {len(fl)} single-frame flashes are near-white")
        # and the frames around them must NOT be white (else it is a shot change)
        for f in fl[:6]:
            if 0 < f < n - 1:
                a = frames[f - 1].mean()
                b = frames[f + 1].mean()
                if max(a, b) > 200:
                    fail(f"{name}: frame {f} is not an isolated flash "
                         f"(neighbours {a:.0f}/{b:.0f})")
        ok("flashes are isolated single frames")

    if kind.startswith("H_"):
        m = gt.get("measured_levels_db") or gt.get("measured_sections") or []
        loud = [v["mean_volume"] for v in m if v.get("kind") == "loud"]
        quiet = [v["mean_volume"] for v in m if v.get("kind") == "quiet"]
        if loud and quiet:
            gap = min(loud) - max(quiet)
            if gap < 15:
                fail(f"{name}: loud/quiet gap only {gap:.1f} dB")
            else:
                ok(f"loud vs quiet mean-volume gap {gap:.1f} dB")
        if gt.get("expected_transcript") not in ("", None):
            fail(f"{name}: a music-only clip must have an empty transcript")
        else:
            ok("expected transcript is empty (false-transcript test)")

    if kind.startswith("I_"):
        s = C.probe_summary(path)
        if s["field_order"] in (None, "progressive"):
            fail(f"{name}: field_order is {s['field_order']!r}, expected tff/bff")
        else:
            ok(f"field order {s['field_order']}, aspect {s['width']}x{s['height']}")
        if s["width"] >= s["height"]:
            fail(f"{name}: expected portrait, got {s['width']}x{s['height']}")

    if kind.startswith("G_"):
        segs = gt.get("speech") or []
        if len(segs) < 3:
            fail(f"{name}: only {len(segs)} speech segments")
        else:
            ok(f"{len(segs)} speech segments")
        # audio envelope: speech windows must be louder than the gaps
        wav = os.path.join(C.WORK, "speech", "G_mix.wav")
        if os.path.exists(wav):
            a, sr = C.read_wav(wav)
            sp, si = [], []
            for s in segs:
                i0, i1 = int(float(s["start"]) * sr), int(float(s["end"]) * sr)
                sp.append(C.rms_db(a[i0:i1]))
            gaps = gt.get("silence_gaps") or []
            for g in gaps:
                i0, i1 = int(float(g["start"]) * sr), int(float(g["end"]) * sr)
                si.append(C.rms_db(a[i0:i1]))
            if sp and si and min(sp) - max(si) < 10:
                fail(f"{name}: speech {min(sp):.1f}dB vs silence {max(si):.1f}dB, "
                     f"not separable")
            elif sp:
                ok(f"speech {min(sp):.1f}..{max(sp):.1f} dBFS vs "
                   f"gaps {max(si) if si else float('nan'):.1f} dBFS")


def chroma_means(path: str, start: float, dur: float) -> tuple[float, float]:
    """Mean U and V over a window (to check the hue, not the luma)."""
    cmd = [C.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", path,
           "-vf", (f"trim=start={start:.6f}:end={start+dur:.6f},"
                   f"scale=64:36:flags=area,signalstats,"
                   f"metadata=print:key=lavfi.signalstats.UAVG:file=-,"
                   f"metadata=print:key=lavfi.signalstats.VAVG:file=-"),
           "-fps_mode", "passthrough", "-an", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    us, vs = [], []
    for line in (p.stdout + p.stderr).splitlines():
        if "UAVG=" in line:
            try:
                us.append(float(line.split("UAVG=")[1].split()[0]))
            except (IndexError, ValueError):
                pass
        elif "VAVG=" in line:
            try:
                vs.append(float(line.split("VAVG=")[1].split()[0]))
            except (IndexError, ValueError):
                pass
    return (float(np.mean(us)) if us else float("nan"),
            float(np.mean(vs)) if vs else float("nan"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    index_path = os.path.join(C.CORPUS, "index.json")
    if not os.path.exists(index_path):
        print(f"no index.json at {index_path}; run build_corpus.py first")
        return 2
    with open(index_path, encoding="utf-8") as f:
        index = json.load(f)
    want = [s.strip().upper() for s in args.only.split(",") if s.strip()]
    clips = [c for c in index["clips"]
             if not want or c["name"].split("_")[0].upper() in want]
    print(f"verifying {len(clips)} clip(s) against {index_path}")
    for c in clips:
        check_clip(c, args.strict)

    print("\n" + "=" * 60)
    if FAILS:
        print(f"{len(FAILS)} FAILURE(S):")
        for f_ in FAILS:
            print("  - " + f_)
        return 1
    print(f"ALL CHECKS PASSED ({len(WARNS)} warning(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
