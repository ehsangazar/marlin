#!/usr/bin/env python3
"""Measure keystroke-to-pixel latency from a 240 fps phone capture.

WHY THIS EXISTS
---------------
Marlin has never had a keystroke-to-pixel number. The only honest way to get
one on a webview terminal is to point a high speed camera at the keyboard and
the screen at the same time, because every software probe stops at a boundary
that is not the photon: the pty round trip in `cargo run --release --example
measure` is 14 microseconds and says nothing about what a human sees.

The naive version of that method is "film it and count frames by eye", twice
per trial, across three terminals. Sixty trials is a hundred and twenty manual
counts, which is a plan for not getting a number. This script removes the
counting.

THE TWO EVENTS, AND WHY THEY COME FROM DIFFERENT TRACKS
-------------------------------------------------------
t_press comes from the AUDIO track, not the video. A phone records 48 kHz
audio alongside 240 fps video. A key going down is a sharp broadband
transient, so onset detection resolves it to well under a millisecond, while a
240 fps frame cannot resolve better than 4.17 ms. Taking the press off the
audio track therefore buys about an order of magnitude on half of the
measurement, for free, from a file you were recording anyway.

t_pixel comes from the VIDEO track: the first frame in which a defined region
of the screen changes by more than a threshold. That half is stuck with the
frame period.

THE OFFSET, SAID OUT LOUD RATHER THAN HIDDEN
--------------------------------------------
Audio and video in one container do not share an origin. The sensor pipeline,
the audio pipeline and the AAC encoder's priming samples each contribute a
delay, and the container's per-stream start_time only accounts for some of it.
So every absolute latency this script prints carries an unknown constant
offset, and that offset can be tens of milliseconds. It is not noise and no
number of trials removes it.

What saves the measurement is that the offset is CONSTANT WITHIN ONE FILE, and
the gate is a difference between two terminals captured in that one file. The
offset cancels in the difference exactly. So:

  the delta is trustworthy, and the gate turns on it
  the absolute is offset-bearing, and is quoted as such or not at all
  the RATIO is worse than the absolute, and this surprised me

The ratio deserves its own line because the gate decision asks for one. A
constant offset cancels in a subtraction and does not cancel in a division, so
a ratio of two offset-bearing medians is not the ratio of the two latencies.
On the validation capture, where the true ratio was 1.286, the uncorrected
ratio came out at 0.582: wrong in the second significant figure and on the
wrong side of 1, while the delta on the same file was right to 0.02 ms.

So the ratio needs the offset measured, and --slate-frame is how: one sharp
noise made in shot before the trials start, whose contact frame a human reads
off the video once. One number per session, not one per trial.

This script labels all of that in its own output, every run, because the
absolute number is the one a reader will want to quote and it is the one that
is not clean.

WHAT IT DOES NOT DO
-------------------
It does not make a claim about any terminal. It reports what it measured, the
n behind it, and the two floors under the resolution: 4.17 ms of frame
quantisation, and the display's own refresh period, which is real latency
rather than measurement error and lands on all three terminals alike.

USAGE
  scripts/keystroke-latency.py --protocol
  scripts/keystroke-latency.py capture.mov --grid-frame 12.0 -o /tmp/f.png
  scripts/keystroke-latency.py capture.mov --roi 300,180,700,60 \
      --order marlin,ghostty,alacritty,ghostty,alacritty,marlin \
      --slate-frame 412 --slate-before 6 \
      --baseline ghostty --subject marlin --csv trials.csv

Requires ffmpeg, ffprobe and python3 with numpy. Nothing else, on purpose:
this has to run on the machine that held the phone, five weeks from now,
without a package manager step in the way.
"""

import argparse
import json
import math
import os
import subprocess
import sys
from textwrap import wrap

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is required: this script needs python3 with numpy on the path")

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

# Where --protocol reads from. Kept as a file rather than a string constant so
# the capture protocol is reviewable as a document in its own right.
PROTOCOL = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "docs",
    "keystroke-to-pixel-capture.md",
)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


# ---------------------------------------------------------------- probing

def probe(path):
    """Read the stream facts we are not allowed to assume."""
    out = run([FFPROBE, "-v", "error", "-show_streams", "-show_format",
               "-of", "json", path]).stdout
    doc = json.loads(out)
    v = a = None
    for s in doc.get("streams", []):
        if s.get("codec_type") == "video" and v is None:
            v = s
        if s.get("codec_type") == "audio" and a is None:
            a = s
    if v is None:
        sys.exit("no video stream in %s" % path)

    def rate(txt):
        if not txt or "/" not in txt:
            return float(txt) if txt else 0.0
        n, d = txt.split("/")
        return float(n) / float(d) if float(d) else 0.0

    info = {
        "width": int(v["width"]),
        "height": int(v["height"]),
        "fps": rate(v.get("avg_frame_rate") or v.get("r_frame_rate")),
        "nominal_fps": rate(v.get("r_frame_rate")),
        "v_start": float(v.get("start_time") or 0.0),
        "duration": float(doc.get("format", {}).get("duration") or 0.0),
        "has_audio": a is not None,
        "sample_rate": int(a["sample_rate"]) if a else 0,
        "a_start": float(a.get("start_time") or 0.0) if a else 0.0,
        "v_codec": v.get("codec_name", "?"),
        "a_codec": a.get("codec_name", "?") if a else None,
    }
    return info


# ---------------------------------------------------------------- audio

def read_audio(path, sample_rate):
    """Mono float32 PCM at the file's own sample rate.

    Resampling would move the transient, so the rate is whatever the phone
    recorded at and the caller works in that.
    """
    p = subprocess.run(
        [FFMPEG, "-v", "error", "-i", path, "-vn", "-ac", "1",
         "-ar", str(sample_rate), "-f", "f32le", "-"],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float64)


def click_envelope(x, sr, hop_s=0.0005, win_s=0.002):
    """A high frequency energy envelope, which is what a key click looks like.

    The first difference is a crude one pole high pass. It costs one line and
    it throws away room rumble, mains hum, voice and the low frequency thump of
    the desk, all of which are loud and none of which are the key going down.
    The envelope is then a moving RMS, computed by cumulative sum so that a
    five minute capture does not need a five minute array of windows.
    """
    d = np.diff(x, prepend=x[:1])
    hop = max(1, int(round(sr * hop_s)))
    win = max(hop, int(round(sr * win_s)))
    c = np.concatenate(([0.0], np.cumsum(d * d)))
    n = (len(d) - win) // hop + 1
    if n <= 0:
        return np.zeros(0), np.zeros(0)
    starts = hop * np.arange(n)
    env = np.sqrt(np.maximum(c[starts + win] - c[starts], 0.0) / win)
    t = (starts + win / 2.0) / sr
    return t, env


def rising_edges(t, env, thr, refractory_s):
    """Indices where the envelope first crosses thr, ignoring re-crossings.

    The refractory window is doing real work: a key press and its release are
    both transients, roughly 60 to 120 ms apart, and the release is quieter but
    well above the floor. Without a refractory the release is counted as a
    trial and every second latency is nonsense.
    """
    above = env > thr
    idx = np.flatnonzero(above[1:] & ~above[:-1]) + 1
    if len(idx) == 0:
        return idx
    keep = [idx[0]]
    for i in idx[1:]:
        if t[i] - t[keep[-1]] >= refractory_s:
            keep.append(i)
    return np.array(keep)


def plateau_threshold(t, env, refractory_s, ks, expect=None, min_count=3):
    """Pick the detection threshold by finding where the count stops moving.

    Any threshold picked by hand is a number the person holding the phone can
    tune until they like the answer. This sweeps k over a wide range, counts
    events at each, and takes the middle of the LONGEST run of k values that
    all give the same count. A real set of key presses produces a wide plateau,
    because there is a large gap between the quietest click and the loudest
    thing that is not a click. A narrow plateau, or none, means the audio is
    not clean and the run should be rejected rather than reported.

    Returns (k, thr, count, plateau_width, sweep).
    """
    med = float(np.median(env))
    mad = float(np.median(np.abs(env - med))) * 1.4826
    if mad <= 0:
        mad = float(np.std(env)) or 1e-12

    sweep = []
    for k in ks:
        thr = med + k * mad
        c = len(rising_edges(t, env, thr, refractory_s))
        sweep.append((float(k), thr, c))

    best = None
    i = 0
    while i < len(sweep):
        j = i
        while j + 1 < len(sweep) and sweep[j + 1][2] == sweep[i][2]:
            j += 1
        count = sweep[i][2]
        width = j - i + 1
        ok = count >= min_count if expect is None else count == expect
        if ok and (best is None or width > best[0]):
            best = (width, (i + j) // 2)
        i = j + 1

    if best is None:
        return None, None, 0, 0, sweep
    width, mid = best
    k, thr, count = sweep[mid]
    return k, thr, count, width, sweep


def refine_onset(x, sr, t_coarse, back_s=0.004, fwd_s=0.006,
                 smooth_s=0.000125, frac=0.15):
    """Walk back from the transient's peak to where it actually began.

    The envelope crossing is late by construction: it fires only once enough
    energy has piled up in a 2 ms window. The physical onset is earlier, so
    find the peak nearby and walk back to where the signal drops below a small
    fraction of it.

    Walking back on RAW samples does not work, and the difference is not
    marginal. A key click is broadband, so its waveform crosses zero constantly
    and any single sample near the start can be close to nothing. Walking back
    sample by sample therefore stops at the first accidental zero crossing,
    which is a random distance from the true onset. Measured against four
    hundred synthetic clicks that cost 0.31 ms of standard deviation and a
    1.35 ms worst case.

    Walking back on a 0.125 ms moving RMS instead removes the zero crossings
    and leaves 0.011 ms of standard deviation, a hundredfold improvement, with
    the remaining error being a near constant bias. Most of that bias is the
    window's own width and is corrected below; whatever survives is constant
    across every trial in the file and therefore cancels in the delta exactly
    as the audio-to-video offset does.

    THE THRESHOLD IS 0.15 BECAUSE PHONES RECORD AAC
    A phone does not hand you the microphone signal. It hands you AAC, and AAC
    spreads a transient backwards across its analysis window whenever it fails
    to switch to short blocks. That pre-echo is real energy sitting BEFORE the
    click, at a few percent of its peak, so a walkback that stops at 5 percent
    of the peak walks straight into it and reports the press up to three
    milliseconds early. Measured on the same four hundred clicks: lossless
    audio gives a 0.045 ms worst case, the same audio through AAC at 128k
    gives 3.4 ms, and the median is untouched in both, which is the signature
    of a tail rather than a shift.

    Stopping at 15 percent instead steps over the pre-echo. It reports the
    onset slightly late, and that does not matter: a late-but-consistent
    estimator beats an unbiased-but-occasionally-wrong one here, because a
    constant bias cancels in the delta and variance does not. Across three
    seeds and both codecs, 0.15 gave 0.14 to 0.16 ms of standard deviation
    against 0.46 ms at 0.05.
    """
    i0 = max(0, int((t_coarse - back_s) * sr))
    i1 = min(len(x), int((t_coarse + fwd_s) * sr))
    win = max(2, int(round(smooth_s * sr)))
    if i1 - i0 < win + 4:
        return t_coarse
    d = np.abs(np.diff(x[i0:i1], prepend=x[i0:i0 + 1]))
    c = np.concatenate(([0.0], np.cumsum(d * d)))
    env = np.sqrt(np.maximum(c[win:] - c[:-win], 0.0) / win)
    pk = int(np.argmax(env))
    thr = env[pk] * frac
    j = pk
    while j > 0 and env[j - 1] > thr:
        j -= 1
    # A trailing window reports the onset up to one window early, because the
    # energy enters at the window's right hand edge. Half a window is the
    # unbiased correction.
    return (i0 + j + win / 2.0) / sr


# ---------------------------------------------------------------- video

def frame_times(path, info, assume_cfr=False):
    """Real presentation timestamps, because phones do not always shoot CFR.

    A capture labelled 240 fps can be 239.76, or can drop frames when the phone
    gets warm. Assuming a constant rate then puts a slowly growing error on
    every t_pixel in the second half of the file. So read the timestamps unless
    told not to.
    """
    if assume_cfr:
        return None
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "frame=pts_time", "-of", "csv=p=0", path]).stdout
    vals = []
    for line in out.decode().splitlines():
        line = line.strip().rstrip(",")
        if not line or line == "N/A":
            continue
        try:
            vals.append(float(line))
        except ValueError:
            pass
    return np.array(vals) if vals else None


def read_exact(stream, n):
    """Pipes give short reads. A frame boundary is not a suggestion."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
    return bytes(buf)


def box_max(d, b):
    """The largest box-averaged value anywhere in each difference image.

    This is the metric, and choosing it was the one place the first version of
    this script was wrong, so the reasoning is written down rather than left in
    the commit.

    The obvious metric is the mean absolute difference over the region. It does
    not work. One character in a region wide enough to hold forty of them is
    about two percent of the pixels, so its contribution to the mean is roughly
    the size of the sensor noise, and on a real synthetic capture the glyph
    events came out at 1.3 against a noise floor of 0.26: no separation at all,
    and the threshold search settled on a value that found five events out of
    forty two.

    What separates the glyph from the noise is that the glyph is CONTIGUOUS and
    the noise is not. Averaging over a small box divides independent per pixel
    noise by the box side while leaving a solid glyph almost untouched, and
    taking the maximum over the region then asks "did anything anywhere in here
    change in a spatially coherent way" rather than "did the average change".
    On the same file that gave no separation at all, this gives glyph events at
    167 to 191 against a floor of 2.7 and a worst non-event of 19.

    A box filter also happens to be the right shape for the residual the mean
    subtraction leaves behind. Room lighting flicker scales with pixel value,
    so it is largest exactly where the bright glyphs already are, and it is a
    low amplitude wobble rather than a solid edge.
    """
    n, h, w = d.shape
    b = max(1, min(b, h, w))
    if b == 1:
        return d.reshape(n, -1).max(axis=1)
    c = np.pad(d.cumsum(1).cumsum(2), ((0, 0), (1, 0), (1, 0)))
    s = c[:, b:, b:] - c[:, :-b, b:] - c[:, b:, :-b] + c[:, :-b, :-b]
    return s.reshape(n, -1).max(axis=1) / float(b * b)


def roi_change(path, roi, box=5, chunk=256):
    """Stream the region past ffmpeg and return one change value per frame.

    Streaming rather than loading the stack is not tidiness. A five minute
    240 fps capture is seventy two thousand frames, and holding a 400 by 40
    region for all of them as float32 is four and a half gigabytes. The
    analysis then dies on the one file it was written for.

    Each frame has its own mean subtracted before differencing. Any change
    that is uniform across the region disappears, which is exactly what mains
    lighting flicker and camera auto exposure are, and what is left is change
    that is not uniform, which is exactly what a character appearing is.
    """
    x, y, w, h = roi
    p = subprocess.Popen(
        [FFMPEG, "-v", "error", "-i", path,
         "-vf", "crop=%d:%d:%d:%d,format=gray" % (w, h, x, y),
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    fsz = w * h
    out = [0.0]
    prev = None
    total = 0
    while True:
        raw = read_exact(p.stdout, fsz * chunk)
        nf = len(raw) // fsz
        if nf == 0:
            break
        f = np.frombuffer(raw[: nf * fsz], dtype=np.uint8).reshape(nf, h, w).astype(np.float32)
        f -= f.mean(axis=(1, 2), keepdims=True)
        stack = f if prev is None else np.concatenate((prev[None, :, :], f), axis=0)
        out.extend(box_max(np.abs(np.diff(stack, axis=0)), box).tolist())
        prev = f[-1]
        total += nf
        if nf < chunk:
            break
    p.stdout.close()
    err = p.stderr.read().decode()
    if p.wait() != 0:
        sys.exit("ffmpeg failed reading the roi:\n" + err)
    # The first frame has no predecessor, so its change is defined as zero and
    # the array stays the same length as the frame list.
    return np.array(out[:total])


# ---------------------------------------------------------------- pairing

def segment(times, gap_s):
    """Split the press times into blocks wherever there is a long silence.

    The trial boundary marker is a gap and nothing else. No clap track, no
    slate, no on screen marker: those are all things that can be forgotten
    during the one session there is time for. A pause is the only marker a
    person reliably produces under pressure, and it is unambiguous as long as
    it is several times longer than the gap between trials.
    """
    blocks = []
    cur = [0]
    for i in range(1, len(times)):
        if times[i] - times[i - 1] > gap_s:
            blocks.append(cur)
            cur = []
        cur.append(i)
    blocks.append(cur)
    return blocks


def percentile(vals, q):
    return float(np.percentile(np.asarray(vals, dtype=float), q)) if len(vals) else float("nan")


def summarise(vals):
    a = np.asarray(sorted(vals), dtype=float)
    return {
        "n": int(len(a)),
        "p50": percentile(a, 50),
        "p95": percentile(a, 95),
        "mean": float(a.mean()) if len(a) else float("nan"),
        "sd": float(a.std(ddof=1)) if len(a) > 1 else float("nan"),
        "min": float(a.min()) if len(a) else float("nan"),
        "max": float(a.max()) if len(a) else float("nan"),
    }


def median_se(sd, n):
    """Standard error of a median, roughly, for a roughly normal sample.

    1.253 sigma over root n is the normal case. Quoted so the reader can see
    whether n was large enough for the delta to mean anything, rather than
    being handed a p50 with no error bar at all.
    """
    if not n or n < 2 or not math.isfinite(sd):
        return float("nan")
    return 1.2533 * sd / math.sqrt(n)


# ---------------------------------------------------------------- helpers

def parse_roi(txt):
    parts = [p.strip() for p in txt.replace("x", ",").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("roi must be x,y,w,h")
    x, y, w, h = (int(p) for p in parts)
    # ffmpeg's crop wants even dimensions for most pixel formats, and an odd
    # width silently becomes a different crop rather than an error.
    return (x - x % 2, y - y % 2, w - w % 2, h - h % 2)


def grid_frame(path, t, out):
    """Write one frame with a labelled grid on it, so the ROI can be read off.

    Choosing x,y,w,h by opening the video in a player and guessing is the step
    most likely to waste the session, because a wrong ROI is only discovered
    when the analysis returns nothing. This makes it a five second job.
    """
    run([FFMPEG, "-v", "error", "-y", "-ss", str(t), "-i", path, "-frames:v", "1",
         "-vf", "drawgrid=w=100:h=100:t=1:c=red@0.7,"
                "drawgrid=w=20:h=20:t=1:c=yellow@0.25", out])
    return out


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(
        description="Keystroke-to-pixel latency from a 240 fps phone capture.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run --protocol for the capture instructions.")
    ap.add_argument("video", nargs="?", help="the capture file")
    ap.add_argument("--protocol", action="store_true",
                    help="print the capture protocol and exit")
    ap.add_argument("--grid-frame", type=float, metavar="SECONDS",
                    help="write one frame with a coordinate grid, to choose --roi")
    ap.add_argument("-o", "--out", default="roi-grid.png",
                    help="where --grid-frame writes")
    ap.add_argument("--roi", type=parse_roi,
                    help="screen region to watch, as x,y,w,h in source pixels")
    ap.add_argument("--order", default="",
                    help="comma separated terminal label per block, in capture order")
    ap.add_argument("--baseline", default="ghostty",
                    help="the terminal the delta is measured against")
    ap.add_argument("--subject", default="marlin",
                    help="the terminal under test")
    ap.add_argument("--gap", type=float, default=4.0,
                    help="silence longer than this starts a new block, seconds")
    ap.add_argument("--refractory", type=float, default=0.25,
                    help="minimum seconds between two accepted presses")
    ap.add_argument("--window", default="-0.25,0.60", metavar="LO,HI",
                    help="where to look for the pixel change relative to the press")
    ap.add_argument("--press-times", metavar="FILE",
                    help="fallback: read press times in seconds from a file, "
                         "one per line, instead of detecting them from audio")
    ap.add_argument("--audio-k", type=float,
                    help="override the audio threshold, in MADs above the floor")
    ap.add_argument("--video-k", type=float,
                    help="override the video threshold, in MADs above the floor")
    ap.add_argument("--box", type=int, default=5, metavar="PX",
                    help="side of the box filter applied to each frame difference")
    ap.add_argument("--expect-presses", type=int,
                    help="total trials expected, used to pick the audio threshold")
    ap.add_argument("--slate-frame", type=int, metavar="N",
                    help="video frame in which the sync slate makes contact. "
                         "Given this, the audio-to-video offset is measured and "
                         "the absolute latencies and the ratio become meaningful. "
                         "See --protocol.")
    ap.add_argument("--slate-before", type=float, default=0.0, metavar="SECONDS",
                    help="presses before this time are slate and setup, not trials")
    ap.add_argument("--offset-ms", type=float,
                    help="supply a known audio-to-video offset directly, instead "
                         "of measuring one with --slate-frame")
    ap.add_argument("--threshold", type=float, metavar="MS",
                    help="gate threshold on the delta, in ms. Given this, the "
                         "run prints an explicit PASS, FAIL or NOT RESOLVED "
                         "against the UPPER end of the 95%% interval, which is "
                         "the rule fixed on 29 Aug 2026 before any capture. "
                         "The point estimate does not decide it.")
    ap.add_argument("--cfr", action="store_true",
                    help="trust the nominal frame rate instead of reading timestamps")
    ap.add_argument("--csv", help="write the per-trial table here")
    ap.add_argument("--json", help="write the full result as json here")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    # Line buffer, so that this script's own output and the output of
    # anything it shells out to stay in the order they happened when the
    # whole lot is piped into a file or a pager.
    sys.stdout.reconfigure(line_buffering=True)

    if args.protocol:
        if os.path.exists(PROTOCOL):
            with open(PROTOCOL) as f:
                sys.stdout.write(f.read())
        else:
            sys.stdout.write(__doc__)
        return 0

    if not args.video:
        ap.error("a capture file is required")
    if args.grid_frame is not None:
        print(grid_frame(args.video, args.grid_frame, args.out))
        return 0
    if not args.roi:
        ap.error("--roi is required: run --grid-frame to choose one")

    info = probe(args.video)
    fps = info["fps"] or info["nominal_fps"]
    quant_ms = 1000.0 / fps if fps else float("nan")

    say = (lambda *a: None) if args.quiet else (lambda *a: print(*a))

    say("capture   %s" % os.path.basename(args.video))
    say("video     %dx%d  %s  %.3f fps nominal, frame period %.2f ms"
        % (info["width"], info["height"], info["v_codec"], fps, quant_ms))
    if info["has_audio"]:
        say("audio     %s  %d Hz" % (info["a_codec"], info["sample_rate"]))
    say("roi       x=%d y=%d w=%d h=%d" % args.roi)
    say("")

    # ---- t_press
    notes = []
    alarms = []          # things that make the whole run untrustworthy
    if args.press_times:
        with open(args.press_times) as f:
            presses = np.array([float(l) for l in f if l.strip()])
        press_source = "manual (%s)" % args.press_times
        say("presses   %d read from %s" % (len(presses), args.press_times))
        notes.append("press times were supplied rather than detected. If they "
                     "were read off the VIDEO then there is no audio-to-video "
                     "offset in these results at all and the absolutes are "
                     "already clean; if they came from the audio timeline the "
                     "offset is present as usual. The tool cannot tell which, "
                     "so it says both.")
    else:
        if not info["has_audio"]:
            sys.exit("no audio track: rerun with --press-times, see --protocol")
        sr = info["sample_rate"]
        x = read_audio(args.video, sr)
        t_env, env = click_envelope(x, sr)
        ks = np.arange(3.0, 80.0, 0.5)
        if args.audio_k is not None:
            med = float(np.median(env))
            mad = float(np.median(np.abs(env - med))) * 1.4826 or 1e-12
            thr = med + args.audio_k * mad
            coarse = rising_edges(t_env, env, thr, args.refractory)
            k, width = args.audio_k, 0
        else:
            k, thr, cnt, width, sweep = plateau_threshold(
                t_env, env, args.refractory, ks, expect=args.expect_presses)
            if k is None:
                sys.exit("no stable audio threshold found: the click track is not "
                         "clean enough to trust. Rerun with --press-times.")
            coarse = rising_edges(t_env, env, thr, args.refractory)
        presses = np.array([refine_onset(x, sr, t_env[i]) for i in coarse])
        # The container's own per stream start time is a KNOWN part of the
        # offset, so remove it. What is left is the unknown part.
        presses = presses + info["a_start"]
        press_source = "audio onsets"
        say("presses   %d detected, threshold k=%.1f, plateau %d steps wide"
            % (len(presses), k, width))
        if width and width < 6:
            notes.append("the audio threshold plateau is only %d steps wide, so the "
                         "press count is sensitive to the threshold. Treat this run "
                         "as suspect." % width)

    all_presses = np.array(presses)
    if args.slate_before > 0:
        before = int(np.sum(all_presses < args.slate_before))
        presses = all_presses[all_presses >= args.slate_before]
        say("          %d press(es) before %.2f s treated as slate and setup, "
            "not trials" % (before, args.slate_before))

    if len(presses) < 2:
        sys.exit("fewer than two presses found: nothing to measure")

    # ---- t_pixel
    change = roi_change(args.video, args.roi, box=args.box)
    pts = frame_times(args.video, info, assume_cfr=args.cfr)
    if pts is None or len(pts) != len(change):
        if pts is not None:
            notes.append("frame timestamp count (%d) did not match decoded frames "
                         "(%d), so a constant %.3f fps was assumed."
                         % (len(pts), len(change), fps))
        pts = np.arange(len(change)) / fps + info["v_start"]

    vks = np.arange(3.0, 400.0, 0.5)
    if args.video_k is not None:
        med = float(np.median(change))
        mad = float(np.median(np.abs(change - med))) * 1.4826 or 1e-12
        vthr = med + args.video_k * mad
        vk, vwidth = args.video_k, 0
    else:
        # Every press that produced a character produced a pixel change, so a
        # threshold that finds fewer changes than there were presses is wrong
        # by construction. Requiring at least that many is what stops the
        # search settling on a threshold that only catches the largest events,
        # such as switching between terminals.
        vk, vthr, vcnt, vwidth, _ = plateau_threshold(
            pts, change, args.refractory, vks, min_count=len(presses))
        if vk is None:
            sys.exit("no threshold found that produces at least as many pixel "
                     "changes as there were key presses. Either --roi is not on "
                     "the text, or the glyphs are too faint. Check with "
                     "--grid-frame.")
    edges = rising_edges(pts, change, vthr, args.refractory)
    say("pixels    %d changes in the roi, threshold k=%.1f, plateau %d steps wide"
        % (len(edges), vk, vwidth))
    if vwidth and vwidth < 6:
        notes.append("the video threshold plateau is only %d steps wide. The region "
                     "may be picking up something other than the glyph, a blinking "
                     "cursor being the usual culprit." % vwidth)

    # ---- pair them
    # ---- the offset, if it was made measurable
    offset_ms = args.offset_ms
    offset_source = "supplied on the command line" if offset_ms is not None else None
    if args.slate_frame is not None:
        if args.slate_frame >= len(pts):
            sys.exit("--slate-frame %d is past the end of the video (%d frames)"
                     % (args.slate_frame, len(pts)))
        t_slate_v = pts[args.slate_frame]
        near = np.argmin(np.abs(all_presses - t_slate_v))
        gap = all_presses[near] - t_slate_v
        if abs(gap) > 0.5:
            sys.exit("no click found within 500 ms of --slate-frame %d (t=%.3f s). "
                     "Check the frame number." % (args.slate_frame, t_slate_v))
        offset_ms = (t_slate_v - all_presses[near]) * 1000.0
        offset_source = ("from the slate at frame %d, t=%.4f s"
                         % (args.slate_frame, t_slate_v))
        say("offset    %+.2f ms, %s" % (offset_ms, offset_source))

    lo, hi = (float(v) for v in args.window.split(","))
    trials = []
    cand_counts = []
    for i, tp in enumerate(presses):
        cand = [e for e in edges if lo <= pts[e] - tp <= hi]
        cand_counts.append(len(cand))
        if not cand:
            trials.append({"press": tp, "pixel": None, "latency_ms": None,
                           "reason": "no pixel change in the window"})
            continue
        e = cand[0]
        # The change happened somewhere between the last unchanged frame and
        # this one, so the midpoint is the unbiased estimate and the error is
        # half a frame either way rather than a whole frame late.
        t_prev = pts[e - 1] if e > 0 else pts[e] - 1.0 / fps
        t_pix = 0.5 * (t_prev + pts[e])
        trials.append({"press": tp, "pixel": t_pix, "frame": int(e),
                       "latency_ms": (t_pix - tp) * 1000.0, "reason": None})

    # ---- is this run believable at all
    #
    # A press that produced one character should produce ONE pixel change in
    # the region before the next press. When it produces several, the region is
    # watching something that is not the glyph, and the pairing then locks onto
    # whichever of them came first. The usual culprit is a blinking cursor, and
    # the failure is not subtle: on the validation capture, adding a 1 Hz block
    # cursor inside the region took the change count from 36 to 186 and moved
    # the delta from +9.6 ms to -85 ms. It did so while every individual number
    # still looked like a number, which is exactly why this check exists.
    multi = sum(1 for c in cand_counts if c > 1)
    if multi > 0.15 * max(1, len(cand_counts)):
        alarms.append(
            "%d of %d presses had more than one pixel change in the search "
            "window. The region is reacting to something other than the "
            "character appearing. In order of likelihood: a blinking cursor "
            "inside the roi, a shell autosuggestion or syntax highlighter "
            "redrawing the line, or a roi wide enough to include the clock."
            % (multi, len(cand_counts)))

    # ---- blocks and labels
    labels = [s.strip() for s in args.order.split(",") if s.strip()]
    blocks = segment(presses, args.gap)
    say("blocks    %d found with a %.1f s gap: %s"
        % (len(blocks), args.gap, ", ".join(str(len(b)) for b in blocks)))
    if labels and len(labels) != len(blocks):
        say("")
        say("MISMATCH: --order names %d blocks but %d were found. Either the gap "
            "between terminals was too short, or a trial gap was too long."
            % (len(labels), len(blocks)))
        say("Block start times: %s"
            % ", ".join("%.2f" % presses[b[0]] for b in blocks))
        say("Adjust --gap and rerun. Nothing below this line is reliable.")
        labels = []

    for bi, b in enumerate(blocks):
        lab = labels[bi] if bi < len(labels) else "block%d" % (bi + 1)
        for i in b:
            trials[i]["label"] = lab
            trials[i]["block"] = bi

    # ---- report
    by = {}
    for t in trials:
        if t.get("latency_ms") is None:
            continue
        by.setdefault(t.get("label", "?"), []).append(t["latency_ms"])

    dropped = sum(1 for t in trials if t.get("latency_ms") is None)
    corrected = offset_ms is not None
    say("")
    if corrected:
        say("PER TERMINAL. The absolute column carries the audio-to-video offset;")
        say("the corrected column has had the measured %+.2f ms taken out of it."
            % offset_ms)
    else:
        say("PER TERMINAL, absolute figures. Every one of these carries the same")
        say("unknown constant audio-to-video offset. Do not quote them alone.")
    say("")
    head = "  %-12s %4s %9s %9s %9s %9s" % ("terminal", "n", "p50 ms", "p95 ms", "sd ms", "se(p50)")
    say(head + ("%11s" % "p50 corr" if corrected else ""))
    stats = {}
    for lab in sorted(by):
        st = summarise(by[lab])
        st["se_p50"] = median_se(st["sd"], st["n"])
        if corrected:
            st["p50_corrected"] = st["p50"] - offset_ms
            st["p95_corrected"] = st["p95"] - offset_ms
        stats[lab] = st
        line = ("  %-12s %4d %9.2f %9.2f %9.2f %9.2f"
                % (lab, st["n"], st["p50"], st["p95"], st["sd"], st["se_p50"]))
        say(line + ("%11.2f" % st["p50_corrected"] if corrected else ""))
    if dropped:
        say("")
        say("  %d press(es) had no pixel change in the window and were dropped."
            % dropped)

    # The physical spread of keystroke-to-pixel is dominated by where the press
    # falls inside the display refresh period, which at 60 Hz is a uniform
    # 16.7 ms wide and about 4.8 ms of standard deviation. Several times that
    # is not a slow terminal, it is a broken measurement.
    # A slate frame identified wrongly moves every corrected absolute by the
    # same amount and is invisible in the delta, which cancels it. The only
    # thing that catches it is knowing roughly what keystroke-to-pixel is:
    # tens of milliseconds, never negative, and never a fifth of a second on a
    # terminal anybody would use. So the corrected column, and only the
    # corrected column, gets a plausibility check. The uncorrected absolutes
    # carry the unknown offset by definition and are not checkable this way,
    # which is why they may not be quoted at all.
    if corrected:
        for lab, st in stats.items():
            c = st.get("p50_corrected")
            if c is None or not math.isfinite(c):
                continue
            if c < 1.0 or c > 150.0:
                alarms.append(
                    "%s has an offset-corrected p50 of %.1f ms, which is not a "
                    "latency any terminal has. Keystroke to pixel is tens of "
                    "milliseconds and cannot be negative. The offset of %+.2f ms "
                    "is wrong, which means the slate frame is wrong, and every "
                    "corrected absolute and the ratio are wrong with it. The "
                    "delta is unaffected: it cancels the offset whatever the "
                    "slate said. Re-read the slate frame three times, take the "
                    "median, and if they disagree by more than one frame make a "
                    "new slate and recapture."
                    % (lab, c, offset_ms))

    for lab, st in stats.items():
        if math.isfinite(st["sd"]) and st["sd"] > 20.0:
            alarms.append(
                "%s has a standard deviation of %.1f ms across %d trials. One "
                "refresh period at 60 Hz accounts for about 4.8 ms, so this is "
                "four times more spread than the physics allows and the trials "
                "are probably not all measuring the same thing."
                % (lab, st["sd"], st["n"]))

    result = {"file": args.video, "fps": fps, "roi": list(args.roi),
              "press_source": press_source, "quant_ms": quant_ms,
              "terminals": stats, "dropped": dropped, "notes": notes,
              "offset_ms": offset_ms, "offset_source": offset_source}

    sub, base = args.subject, args.baseline
    if sub in stats and base in stats:
        d = stats[sub]["p50"] - stats[base]["p50"]
        se = math.sqrt(median_se(stats[sub]["sd"], stats[sub]["n"]) ** 2
                       + median_se(stats[base]["sd"], stats[base]["n"]) ** 2)
        lo, hi = d - 1.96 * se, d + 1.96 * se
        result["delta_ms"] = d
        result["delta_se_ms"] = se
        result["delta_ci95_ms"] = [lo, hi]
        say("")
        say("THE FIGURE THE GATE TURNS ON")
        say("")
        say("  %s p50 minus %s p50 = %+.2f ms   (se about %.2f ms)" % (sub, base, d, se))
        say("  95%% interval on that delta: %+.2f to %+.2f ms" % (lo, hi))
        say("")
        say("  The offset is the same in both terms, so it cancels in that")
        say("  subtraction exactly. The delta is clean whether or not the offset")
        say("  was ever measured, which is why the gate was written on a delta.")
        say("")
        if corrected:
            rc = stats[sub]["p50_corrected"] / stats[base]["p50_corrected"]
            result["ratio"] = rc
            result["ratio_basis"] = "offset-corrected"
            say("  ratio %s to %s = %.3f, on the corrected p50s." % (sub, base, rc))
            say("  It is only as good as the slate: a slate frame identified one")
            say("  frame out moves the offset by %.2f ms and the ratio with it."
                % quant_ms)
        else:
            raw = stats[sub]["p50"] / stats[base]["p50"] if stats[base]["p50"] else float("nan")
            result["ratio"] = raw
            result["ratio_basis"] = "uncorrected, not meaningful"
            say("  RATIO: NOT AVAILABLE, and the arithmetic reason matters.")
            say("  A constant offset cancels in a subtraction and does NOT cancel")
            say("  in a division, so a ratio of two offset-bearing p50s is not the")
            say("  ratio of the two latencies. On the validation file, where the")
            say("  true ratio was 1.286, the uncorrected ratio came out at 0.582.")
            say("  The raw quotient here is %.3f and should not be quoted." % raw)
            say("  To get a real one, measure the offset: see --slate-frame in")
            say("  --protocol. It costs one number, read off the video once.")

        # The verdict is computed here, by the tool, against a threshold given
        # on the command line, because a rule that is applied by hand after the
        # numbers are visible is not a pre-committed rule. It turns on the
        # UPPER end of the interval and not on the point estimate: fixed
        # 29 Aug 2026, five weeks before the capture, in
        # "Decision 2026-08-29 Pre-Capture Rules". The asymmetry is the whole
        # argument. A false pass puts a speed claim on a public surface that
        # the measurement does not support. A false fail costs a sentence.
        if args.threshold is not None:
            t = args.threshold
            verdict = ("PASS" if hi <= t else
                       "FAIL" if lo > t else
                       "NOT RESOLVED")
            result["threshold_ms"] = t
            result["verdict"] = verdict
            say("")
            say("  VERDICT against a %.1f ms threshold: %s" % (t, verdict))
            if verdict == "PASS":
                say("  The whole interval sits at or below the threshold, so the")
                say("  delta is within it and not merely consistent with being")
                say("  within it.")
            elif verdict == "FAIL":
                say("  The whole interval sits above the threshold. This is a")
                say("  real result, not a failed measurement, and it is the one")
                say("  the write-up should report.")
            else:
                say("  The interval spans the threshold, so this session cannot")
                say("  decide it either way. Under the 29 Aug rule ONE pooled")
                say("  recapture to n=60 is allowed, declared before the second")
                say("  session is looked at, and its result is final whichever")
                say("  way it falls. There is no third session.")
                say("  NOT RESOLVED is an outcome. It is not a reason to quote")
                say("  the point estimate as though it had passed.")
    else:
        say("")
        say("No delta: --subject %s and --baseline %s were not both found in the "
            "labels. Pass --order." % (sub, base))

    say("")
    say("WHAT LIMITS THIS NUMBER")
    say("  frame quantisation   +/- %.2f ms per t_pixel, half of one %.0f fps frame"
        % (quant_ms / 2.0, fps))
    say("  press resolution     median under 0.1 ms and p95 under 0.6 ms against")
    say("                       synthetic ground truth, so the press is not the")
    say("                       limit. That is the whole reason it is taken off")
    say("                       the audio track and not the video")
    say("  display refresh      up to one refresh period is real latency, not")
    say("                       measurement error, and it lands on all terminals")
    say("                       alike, so it inflates the absolutes and adds")
    say("                       variance to the delta without biasing it")
    if corrected:
        say("  a/v offset           measured as %+.2f ms, %s." % (offset_ms, offset_source))
        say("                       Its own error is about one frame, %.2f ms, from"
            % quant_ms)
        say("                       identifying the slate frame by eye. That error")
        say("                       is in the corrected absolutes and the ratio,")
        say("                       and NOT in the delta")
    else:
        say("  a/v offset           unknown, constant within this file, cancels in")
        say("                       the delta, present in full in every absolute,")
        say("                       and fatal to the ratio. Pass --slate-frame")
    for n in notes:
        say("")
        say("  NOTE: %s" % n)

    if alarms:
        say("")
        say("!" * 72)
        say("DO NOT QUOTE THIS RUN. %d check(s) failed." % len(alarms))
        say("!" * 72)
        for a in alarms:
            say("")
            for line in wrap(a, 70):
                say("  " + line)
        say("")
        say("  The numbers above were still printed, because a run that prints")
        say("  nothing teaches nobody anything about what went wrong. They are")
        say("  not a measurement. Fix the capture or the roi and run it again.")
    result["alarms"] = alarms

    if args.csv:
        with open(args.csv, "w") as f:
            f.write("block,label,trial,t_press_s,t_pixel_s,frame,latency_ms,dropped_reason\n")
            counters = {}
            for t in trials:
                lab = t.get("label", "")
                counters[lab] = counters.get(lab, 0) + 1
                f.write("%s,%s,%d,%.6f,%s,%s,%s,%s\n" % (
                    t.get("block", ""), lab, counters[lab], t["press"],
                    "%.6f" % t["pixel"] if t.get("pixel") else "",
                    t.get("frame", ""),
                    "%.3f" % t["latency_ms"] if t.get("latency_ms") is not None else "",
                    t.get("reason") or ""))
        say("")
        say("per-trial table written to %s" % args.csv)

    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=2)

    return 0


if __name__ == "__main__":
    sys.exit(main())
