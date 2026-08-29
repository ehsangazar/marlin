#!/usr/bin/env python3
"""Prove keystroke-latency.py recovers a latency it was never told.

WHY A SELF TEST AND NOT JUST A CAREFUL READ
-------------------------------------------
The whole value of the 26 Sep capture is that the number is believable. A
script that reports latencies is trivially easy to write and impossible to
trust: nothing in its output tells you whether it is measuring the thing it
says it is, or an off by one frame, or a cursor blink. So this synthesises a
video whose answer is known exactly, runs the real analyser over it as a black
box, and reports the error between what went in and what came out.

WHAT THE SYNTHETIC FILE CONTAINS, AND WHY EACH PART IS THERE
------------------------------------------------------------
  three blocks separated by long silences      tests block segmentation
  a key click and a quieter release click      tests the refractory window
  broadband hiss, mains hum and a low thump    tests the high pass
  100 Hz brightness flicker on every frame     tests the flicker rejection
  sensor noise and real h264 compression       stops it being a clean signal
  a moving bright blob over the keyboard       tests that the roi is honoured
  a constant undeclared audio-to-video offset  THE point of the exercise

That last one is the reason this file exists in the form it does. The offset
is applied by shifting the click track in the generated audio, so nothing in
the container declares it and the analyser cannot subtract it. If the argument
in keystroke-latency.py is right, the absolute latencies come back wrong by
exactly that offset, and the DELTA between two terminals comes back right
anyway. That is a falsifiable claim and this is the thing that falsifies it.

THE LABELS ARE ALPHA, BRAVO AND CHARLIE ON PURPOSE
--------------------------------------------------
Not marlin, ghostty and alacritty. The latencies here are invented numbers in
a generated file, and output that reads like a measurement of a real terminal
is output that will eventually be quoted as one.

  scripts/keystroke-latency-selftest.py
  scripts/keystroke-latency-selftest.py --quick --keep /tmp/ktp
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ANALYSER = os.path.join(HERE, "keystroke-latency.py")

FPS = 240.0
SR = 48000
W, H = 384, 216
ROI = (48, 120, 304, 28)          # x, y, w, h: the prompt line strip
GLYPH_W, GLYPH_H, GLYPH_PITCH = 6, 14, 9

# Invented per terminal latencies, in milliseconds. Only the differences
# between them matter to the test.
BASE_MS = {"alpha": 22.0, "bravo": 12.0, "charlie": 8.0}
REFRESH_MS = 1000.0 / 60.0        # the display quantisation the capture will see

# The undeclared constant the whole method has to survive.
AV_OFFSET_S = 0.037

# The sync slate: two hard objects struck together in shot, once, before the
# trials start. Its audio is found automatically; its contact FRAME is the one
# number a human reads off the video, and it is what turns the offset-bearing
# absolutes into real ones. Placed on an exact frame boundary so the test
# checks the arithmetic rather than the rounding.
SLATE_T = 1.5
SLATE_FRAME = int(SLATE_T * FPS)
TRIALS_START = 4.0


def synth_audio(presses, duration_s, offset_s, rng, slate_t=None):
    """A click track that sounds enough like a keyboard to be a fair test."""
    n = int(duration_s * SR)
    x = rng.normal(0.0, 0.0015, n)                       # room hiss
    t = np.arange(n) / SR
    x += 0.010 * np.sin(2 * np.pi * 50.0 * t)            # mains hum
    x += 0.004 * np.sin(2 * np.pi * 120.0 * t + 1.0)

    # A low frequency thump that is loud but is not a key. If the high pass in
    # the analyser is doing its job this never becomes a detected press.
    for tt in (duration_s * 0.31, duration_s * 0.67):
        i = int(tt * SR)
        m = min(n - i, int(0.25 * SR))
        if m > 0:
            env = np.exp(-np.arange(m) / (0.05 * SR))
            x[i:i + m] += 0.25 * env * np.sin(2 * np.pi * 45.0 * np.arange(m) / SR)

    def burst(at, amp, tau):
        i = int(round((at + offset_s) * SR))
        m = min(n - i, int(0.03 * SR))
        if i < 0 or m <= 0:
            return
        env = np.exp(-np.arange(m) / (tau * SR))
        env[0] = 0.0                                    # attack in one sample
        x[i:i + m] += amp * env * rng.normal(0.0, 1.0, m)

    if slate_t is not None:
        burst(slate_t, 0.75, 0.0030)          # the slate, louder than any key

    for p in presses:
        burst(p, rng.uniform(0.22, 0.40), 0.0022)
        # The release, 60 to 110 ms later and much quieter. This is what the
        # refractory window in the analyser exists to reject.
        burst(p + rng.uniform(0.060, 0.110), rng.uniform(0.06, 0.13), 0.0018)

    return np.clip(x, -0.99, 0.99)


def write_wav(path, x):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32000.0).astype("<i2").tobytes())


def synth_video(path, events, n_frames, blink, rng, ffmpeg):
    """Render the screen, then push it through a real h264 encoder.

    Encoding rather than handing the analyser raw frames is deliberate: the
    26 Sep capture will be compressed video off a phone, and a detector that
    only works on lossless input is a detector that does not work.
    """
    rx, ry, rw, rh = ROI
    base = np.full((H, W), 18.0, dtype=np.float32)
    base[ry - 14:ry + rh + 14, rx - 14:rx + rw + 14] = 30.0   # the window chrome
    canvas = base.copy()

    appear = {}
    clear = set()
    for e in events:
        appear.setdefault(e["frame"], []).append(e)
        clear.add(e["switch_frame"])

    noise = rng.normal(0.0, 2.6, (48, H, W)).astype(np.float32)

    cmd = [ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
           "-s", "%dx%d" % (W, H), "-r", "%.6f" % FPS, "-i", "-",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    chunk = []
    for i in range(n_frames):
        if i in clear:
            canvas = base.copy()
        for e in appear.get(i, []):
            gx = rx + 8 + e["col"] * GLYPH_PITCH
            canvas[ry + 7:ry + 7 + GLYPH_H, gx:gx + GLYPH_W] = 212.0

        t = i / FPS
        # Mains lighting beating against the sensor. Global, so the analyser's
        # mean subtraction should make it disappear entirely.
        f = canvas * (1.0 + 0.035 * np.sin(2 * np.pi * 100.0 * t))
        f = f + noise[i % len(noise)]

        # A hand over the keys, well outside the roi. If the roi were ignored
        # this alone would produce a change on almost every frame.
        hx = int(60 + 90 * (0.5 + 0.5 * np.sin(2 * np.pi * 0.8 * t)))
        f[H - 40:H - 12, hx:hx + 70] = 150.0

        # The slate, visible from its contact frame for half a second. The
        # analyser never looks for this: a human reads the frame number off
        # the video once. It is drawn so that the number is readable.
        if SLATE_FRAME <= i < SLATE_FRAME + 120:
            f[H - 74:H - 48, 150:230] = 242.0

        if blink:
            # Deliberately wrong: a 1 Hz block cursor inside the roi, to show
            # what the protocol's "turn blink off" line is protecting.
            if int(t * 2) % 2 == 0:
                cx = rx + 8 + 26 * GLYPH_PITCH
                f[ry + 7:ry + 7 + GLYPH_H, cx:cx + GLYPH_W] = 200.0

        chunk.append(np.clip(f, 0, 255).astype(np.uint8).tobytes())
        if len(chunk) >= 240:
            p.stdin.write(b"".join(chunk))
            chunk = []
    if chunk:
        p.stdin.write(b"".join(chunk))
    p.stdin.close()
    err = p.stderr.read().decode()
    if p.wait() != 0:
        sys.exit("ffmpeg failed encoding the synthetic video:\n" + err)


def build(workdir, trials_per_block, blink, seed, ffmpeg):
    """Lay out the trials, render both tracks, mux, and return the truth."""
    rng = np.random.default_rng(seed)
    order = ["alpha", "bravo", "charlie", "bravo", "charlie", "alpha"]

    if trials_per_block > 30:
        sys.exit("this synthetic screen only has room for 30 glyphs on a line")

    events = []
    t = TRIALS_START
    for bi, label in enumerate(order):
        # The whole window repaints when the next terminal comes to the front.
        # It sits three seconds before the first press of the block, in the
        # middle of the gap, because a repaint next to a press is a pixel
        # change the pairing would happily mistake for the glyph. That is not
        # an artefact of the simulation: it is the reason the protocol tells
        # Gaz to switch terminals at the START of the gap and then wait.
        switch_frame = max(0, int((t - 3.0) * FPS))
        for j in range(trials_per_block):
            press = t
            lat_ms = (BASE_MS[label]
                      + rng.uniform(0.0, REFRESH_MS)     # display quantisation
                      + rng.normal(0.0, 1.8))           # jitter in the stack
            lat_ms = max(lat_ms, 1.0)
            pixel = press + lat_ms / 1000.0
            events.append({
                "block": bi, "label": label, "col": j,
                "press": press, "pixel": pixel, "latency_ms": lat_ms,
                # The camera can only show the change from the first frame
                # sampled at or after it happened.
                "frame": int(np.ceil(pixel * FPS)),
                "switch_frame": switch_frame,
            })
            t += rng.uniform(0.95, 1.25)
        t += 8.0                                        # the block gap marker

    duration = t + 1.5
    n_frames = int(duration * FPS)

    vpath = os.path.join(workdir, "v.mp4")
    apath = os.path.join(workdir, "a.wav")
    out = os.path.join(workdir, "capture.mp4")

    synth_video(vpath, events, n_frames, blink, rng, ffmpeg)
    write_wav(apath, synth_audio([e["press"] for e in events], duration,
                                 AV_OFFSET_S, rng, slate_t=SLATE_T))
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", vpath, "-i", apath,
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "128k", out], check=True)
    return out, events, order


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--trials", type=int, default=20,
                    help="trials per block in the synthetic capture")
    ap.add_argument("--quick", action="store_true",
                    help="fewer trials, for iterating on the analyser")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--keep", metavar="DIR",
                    help="keep the generated files here instead of a temp dir")
    ap.add_argument("--blink-demo", action="store_true",
                    help="also run with a blinking cursor in the roi, to show "
                         "what the protocol's blink rule is protecting")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()
    # Line buffer, so that this script's own output and the output of
    # anything it shells out to stay in the order they happened when the
    # whole lot is piped into a file or a pager.
    sys.stdout.reconfigure(line_buffering=True)

    trials = 6 if args.quick else args.trials
    work = args.keep or tempfile.mkdtemp(prefix="ktp-selftest-")
    os.makedirs(work, exist_ok=True)

    print("synthesising %d trials per block, 6 blocks, seed %d" % (trials, args.seed))
    print("injected audio-to-video offset: %+.1f ms (undeclared in the container)"
          % (AV_OFFSET_S * 1000.0))
    cap, events, order = build(work, trials, False, args.seed, args.ffmpeg)
    print("wrote %s (%.1f MB)" % (cap, os.path.getsize(cap) / 1e6))
    print("")

    csv = os.path.join(work, "trials.csv")
    js = os.path.join(work, "result.json")
    cmd = [sys.executable, ANALYSER, cap,
           "--roi", "%d,%d,%d,%d" % ROI,
           "--order", ",".join(order),
           "--subject", "alpha", "--baseline", "bravo",
           "--slate-frame", str(SLATE_FRAME),
           "--slate-before", "%.1f" % (TRIALS_START - 0.5),
           "--csv", csv, "--json", js]
    print("$ " + " ".join(cmd[1:]))
    print("")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit("analyser exited %d" % r.returncode)

    ok = compare(events, csv, js, order, trials)

    if args.blink_demo:
        print("")
        print("=" * 72)
        print("BLINK DEMO: same capture with a 1 Hz block cursor inside the roi")
        print("=" * 72)
        w2 = os.path.join(work, "blink")
        os.makedirs(w2, exist_ok=True)
        cap2, _, _ = build(w2, trials, True, args.seed, args.ffmpeg)
        subprocess.run([sys.executable, ANALYSER, cap2,
                        "--roi", "%d,%d,%d,%d" % ROI,
                        "--order", ",".join(order),
                        "--slate-before", "%.1f" % (TRIALS_START - 0.5),
                        "--subject", "alpha", "--baseline", "bravo"])

    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    return 0 if ok else 1


def compare(events, csv, js, order, trials):
    rows = []
    with open(csv) as f:
        head = f.readline().strip().split(",")
        for line in f:
            rows.append(dict(zip(head, line.rstrip("\n").split(","))))
    with open(js) as f:
        res = json.load(f)

    print("")
    print("=" * 72)
    print("GROUND TRUTH versus RECOVERED")
    print("=" * 72)

    expected = len(events)
    got = len([r for r in rows if r["latency_ms"]])
    print("")
    print("trials  expected %d, recovered %d" % (expected, got))
    if got != expected:
        print("  FAIL: the analyser did not find every trial")

    # Match on order. The synthetic presses are far enough apart that the nth
    # detected press is the nth real one, and if that is not true the count
    # check above has already failed.
    press_err, lat_err = [], []
    by_label_true = {}
    for e, r in zip(events, rows):
        if not r["latency_ms"]:
            continue
        press_err.append((float(r["t_press_s"]) - (e["press"] + AV_OFFSET_S)) * 1000.0)
        # What the analyser SHOULD report: the true latency less the offset it
        # cannot see.
        want = e["latency_ms"] - AV_OFFSET_S * 1000.0
        lat_err.append(float(r["latency_ms"]) - want)
        by_label_true.setdefault(e["label"], []).append(e["latency_ms"])

    if not press_err:
        print("")
        print("SELF TEST FAILED: no trials were recovered at all, so there is")
        print("nothing to compare. The analyser output above says where it lost")
        print("them: check the press count and the pixel change count.")
        return False

    pe, le = np.abs(press_err), np.abs(lat_err)
    print("")
    print("t_press recovery, against the true press time plus the injected offset")
    print("  median error %.3f ms, p95 %.3f ms, worst %.3f ms"
          % (np.median(pe), np.percentile(pe, 95), pe.max()))
    half_frame = 1000.0 / FPS / 2.0
    press_ok = np.median(pe) < 0.30 and np.percentile(pe, 95) < half_frame
    print("  %s tolerance: median under 0.30 ms and p95 under %.2f ms, which is"
          % ("PASS" if press_ok else "FAIL", half_frame))
    print("       half a frame. Clearing that means the press is not what limits")
    print("       this measurement, which is the entire reason it comes off the")
    print("       audio track rather than the video. The worst case tail is AAC")
    print("       pre-echo and it is documented in refine_onset.")

    print("")
    print("per trial latency, against true latency less the injected offset")
    print("  median error %+.3f ms, p95 |error| %.3f ms, worst %.3f ms"
          % (np.median(lat_err), np.percentile(le, 95), le.max()))
    quant = 1000.0 / FPS / 2.0
    lat_ok = np.percentile(le, 95) < quant + 1.0
    print("  %s tolerance: p95 under %.2f ms, being half a frame (%.2f ms) of"
          % ("PASS" if lat_ok else "FAIL", quant + 1.0, quant))
    print("       unavoidable quantisation plus 1 ms for the press. The worst")
    print("       case is larger and is the AAC tail, which is why the gate is")
    print("       on a p50 rather than on any single trial.")

    print("")
    print("p50 per terminal, true versus recovered")
    print("  %-9s %8s %10s %10s %9s" % ("label", "true p50", "want p50", "got p50", "error"))
    p50_ok = True
    for lab in ("alpha", "bravo", "charlie"):
        true_p50 = float(np.percentile(by_label_true[lab], 50))
        want = true_p50 - AV_OFFSET_S * 1000.0
        got_p50 = res["terminals"][lab]["p50"]
        err = got_p50 - want
        if abs(err) > 1.5:
            p50_ok = False
        print("  %-9s %8.2f %10.2f %10.2f %+9.2f" % (lab, true_p50, want, got_p50, err))
    print("  %s every recovered p50 within 1.50 ms of the offset-shifted truth"
          % ("PASS" if p50_ok else "FAIL"))

    print("")
    print("THE CLAIM UNDER TEST: the offset poisons the absolute and cancels in")
    print("the delta.")
    true_delta = (float(np.percentile(by_label_true["alpha"], 50))
                  - float(np.percentile(by_label_true["bravo"], 50)))
    got_delta = res["delta_ms"]
    got_ratio = res["ratio"]
    true_ratio = (float(np.percentile(by_label_true["alpha"], 50))
                  / float(np.percentile(by_label_true["bravo"], 50)))
    print("")
    print("  absolute alpha p50: true %.2f ms, reported %.2f ms, error %+.2f ms"
          % (float(np.percentile(by_label_true["alpha"], 50)),
             res["terminals"]["alpha"]["p50"],
             res["terminals"]["alpha"]["p50"] - float(np.percentile(by_label_true["alpha"], 50))))
    print("    that error is the injected offset, %+.1f ms, and no amount of n removes it"
          % (-AV_OFFSET_S * 1000.0))
    print("")
    print("  DELTA alpha minus bravo: true %+.2f ms, reported %+.2f ms, error %+.2f ms"
          % (true_delta, got_delta, got_delta - true_delta))
    delta_ok = abs(got_delta - true_delta) < 1.5
    print("  %s tolerance 1.50 ms on the figure the gate turns on"
          % ("PASS" if delta_ok else "FAIL"))
    print("")
    print("THE OFFSET ITSELF, recovered from one slate frame")
    off = res.get("offset_ms")
    off_ok = off is not None and abs(off - (-AV_OFFSET_S * 1000.0)) < 2.0
    print("  injected %+.2f ms, recovered %s, error %s"
          % (-AV_OFFSET_S * 1000.0,
             "%+.2f ms" % off if off is not None else "none",
             "%+.2f ms" % (off + AV_OFFSET_S * 1000.0) if off is not None else "n/a"))
    print("  %s tolerance 2.00 ms, about half a frame of slack on the frame a"
          % ("PASS" if off_ok else "FAIL"))
    print("       human would pick off the video.")

    print("")
    print("  absolute alpha p50, corrected: true %.2f ms, reported %.2f ms"
          % (float(np.percentile(by_label_true["alpha"], 50)),
             res["terminals"]["alpha"].get("p50_corrected", float("nan"))))
    corr_ok = abs(res["terminals"]["alpha"].get("p50_corrected", 1e9)
                  - float(np.percentile(by_label_true["alpha"], 50))) < 2.5
    print("  %s the offset correction puts the absolute back where it belongs"
          % ("PASS" if corr_ok else "FAIL"))

    print("")
    print("  ratio: true %.3f, reported %.3f (basis: %s)"
          % (true_ratio, got_ratio, res.get("ratio_basis")))
    ratio_ok = abs(got_ratio - true_ratio) < 0.15
    print("  %s a ratio does NOT survive an additive offset, so this is only a"
          % ("PASS" if ratio_ok else "FAIL"))
    print("       number at all because the slate measured the offset out. The")
    print("       gate decision asks for the ratio, and one frame number read off")
    print("       the video by hand is what makes it exist.")

    # The believability guards must stay silent on a good capture. Without
    # this the guards could drift into firing on everything, which is the same
    # as not having them.
    alarms = res.get("alarms") or []
    quiet_ok = not alarms
    print("")
    print("believability guards on a clean capture")
    print("  %s %d alarm(s) raised, expected 0. Run --blink-demo to see them fire."
          % ("PASS" if quiet_ok else "FAIL", len(alarms)))
    for a in alarms:
        print("    " + a)

    all_ok = (press_ok and lat_ok and p50_ok and delta_ok and off_ok
              and corr_ok and ratio_ok and quiet_ok and got == expected)
    print("")
    print("=" * 72)
    print("SELF TEST %s" % ("PASSED" if all_ok else "FAILED"))
    print("=" * 72)
    return all_ok


if __name__ == "__main__":
    sys.exit(main())
