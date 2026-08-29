# Capturing keystroke-to-pixel latency with a phone

**This is the session protocol for Sat 26 Sep 2026.** It exists because the
capture happens once, on one afternoon, and a mistake in it is not discovered
until the analysis, by which point the three terminals are closed and the
machine is in a different state.

The gate it feeds, fixed on 22 Aug 2026 and not movable afterwards:

> Marlin's keystroke-to-pixel p50 must be no more than 30 ms above Ghostty's
> p50, measured in the same sitting, on this machine, on the same display at
> the same refresh rate, from the same 240 fps capture, with Alacritty in the
> same capture as a third point. Record the ratio as well as the delta.

The analysis is `scripts/keystroke-latency.py`. It is validated against
synthetic ground truth by `scripts/keystroke-latency-selftest.py`, which you
can run right now, before touching a phone, and which should print
`SELF TEST PASSED` in about a minute.

---

## The one thing to understand before the session

Two events are being timed per trial.

**t_press** comes off the **audio** track. A key going down is a sharp
broadband click, and 48 kHz audio resolves it to a fraction of a millisecond.
A 240 fps frame cannot resolve better than 4.17 ms, so taking the press off the
audio is worth roughly an order of magnitude on half the measurement, for free,
from a file you were recording anyway.

**t_pixel** comes off the **video** track: the first frame in which the text
region changes. That half is stuck with the frame period.

Audio and video do not share an origin inside the file. There is a constant
offset between them, it can be tens of milliseconds, and no number of trials
removes it. **Everything in the protocol below follows from one fact: that
offset is constant within one file, so it cancels in a difference and it does
not cancel in an absolute or a ratio.** That is why all three terminals must be
in ONE recording, and why there is a sync slate at the start.

---

## Before the day

- [ ] **Run the self test.** `python3 scripts/keystroke-latency-selftest.py`.
      It needs ffmpeg, ffprobe and python3 with numpy, and nothing else. If it
      does not say `SELF TEST PASSED`, fix that first, not on the day.
- [ ] **Check the phone really shoots 240.** In the camera app, slow motion at
      1080p240 or 720p240. Confirm it afterwards on the file itself:
      `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate -of csv file.mov`
      Both numbers should be about 240. **If the phone shot 30 or 60 and
      interpolated up to look slow, `avg_frame_rate` will say 30 or 60 and the
      session is worthless**, so check this on a ten second test clip before
      doing anything else.
- [ ] **Free up storage.** 240 fps eats about 400 MB per minute. The session is
      roughly six minutes of recording.
- [ ] **Set the three terminals to match.** Marlin already defaults to what is
      wanted, so the other two move to meet it.

  | | Marlin | Ghostty | Alacritty |
  |---|---|---|---|
  | Font | SF Mono 13 (default) | set `font-family = "SF Mono"`, `font-size = 13` | set `font.normal.family = "SF Mono"`, `font.size = 13` |
  | Cursor | block, blink off (default) | `cursor-style = block`, `cursor-style-blink = false` | `cursor.style.shape = "Block"`, `cursor.style.blinking = "Never"` |
  | Theme | dark, high contrast | same | same |

  **The blink setting is not cosmetic and it is not optional.** A blinking
  cursor inside the watched region repaints on its own schedule, and the
  analyser then pairs the key press with whichever repaint happened first. This
  is measured, not asserted: on the validation capture, adding a 1 Hz block
  cursor took the change count from 36 to 186 and moved the delta from +9.6 ms
  to **minus 85 ms**, while every individual figure still looked like a figure.
  The tool now refuses to stand behind a run that looks like that, but it is a
  waste of the session either way.

---

## Setting the room up

- **Tripod, or something the phone cannot move on.** Books work. The region
  coordinates are read off one frame and used for the whole file, so if the
  phone moves mid-session, the second half is lost.
- **Frame both the keyboard and the screen.** The keyboard needs to be in shot
  so the click is close to the microphone and so the slate is visible; the
  screen needs to be readable enough that a character appearing is obvious.
  Landscape, phone slightly above and to one side.
- **Light the keyboard, not the screen.** The screen provides its own light and
  will blow out if you point a lamp at it. Overhead room light on the keys is
  enough.
- **Kill the noise.** Windows shut, fans off, nothing playing. The click
  detector wants a quiet floor; it is robust to hum and to low frequency thumps
  because it high passes first, but it is not robust to someone talking.
- **Quiet the machine.** Close everything that is not the three terminals. No
  browser, no Slack, no backup running, no build going. Plug the laptop in and
  turn Low Power Mode off.
- **Pin the refresh rate.** System Settings, Displays, Refresh Rate: pick a
  fixed number such as 60 Hertz. **Do not leave it on ProMotion or Adaptive.**
  A variable refresh rate can settle at a different rate in different apps, and
  that is not measurement noise, it is a genuine difference between the
  terminals that has nothing to do with their code and would go straight into
  the delta.

---

## What must not change between the three terminals

Everything in this list is either in the gate's wording or is a confound that
would land directly in the delta.

- The **display**, its **resolution and scaling**, and its **refresh rate**.
- The **window size and position**. Put each window at the same rectangle. Use
  the same number of columns and rows.
- The **font family, size and line height**, as far as each terminal allows.
- The **theme**, so that a character has the same contrast against the
  background in all three.
- The **power state**: plugged in, Low Power Mode off, throughout.
- The **background load**: the same nothing, in all three.
- The **phone**: not moved, not refocused, not stopped and restarted. **One
  continuous recording for the whole session.** If the recording stops, the
  offset changes, and blocks either side of the break can no longer be compared.

---

## What to type, and why

**Type `m`, repeatedly, into `cat > /dev/null`.**

Set each terminal up by typing, before the trials start:

```
clear && cat > /dev/null
```

- **`cat > /dev/null` rather than a shell prompt.** The character is echoed by
  the kernel's line discipline and drawn by the terminal, which is exactly the
  path being measured, and nothing else happens. A shell prompt brings
  autosuggestions, syntax highlighting and prompt redraws, all of which repaint
  the line on their own schedule and all of which look to the analyser like the
  character arriving.
- **`clear` first** so the typed line lands on the same row every time, in all
  three terminals.
- **`m` rather than any other key.** It takes no modifier, so there is exactly
  one press transient per trial rather than two; and it is about the densest
  lowercase glyph, so the pixel change is large.
- **Tap, do not hold.** Key repeat would fire a stream of characters off one
  press. A quick tap also keeps the release click well clear of the next press.
- **Each character lands in the next column**, so a block of trials writes a
  row of `m`s across one line and nothing needs clearing mid block. Thirty
  trials is thirty columns, comfortably inside one line.

---

## How many trials, and why that number

The spread on keystroke-to-pixel is dominated by **where the press happens to
fall inside the display's refresh period**. At 60 Hz that is a uniform 16.7 ms
wide, which alone is 4.8 ms of standard deviation. Add the stack's own jitter
and the measurement's 1.2 ms of frame quantisation and the honest working
assumption before the capture is a standard deviation of about **8 ms**. The
tool prints the real one, so this can be checked afterwards.

The standard error of a median is about `1.25 x sd / sqrt(n)`, and the delta is
a difference of two medians, so its standard error is about `sqrt(2)` times
that.

| n per terminal | se of one p50 | se of the delta | 95% interval on the delta |
|---|---|---|---|
| 10 | 3.2 ms | 4.5 ms | about +/- 8.8 ms |
| **20 (minimum)** | 2.2 ms | 3.2 ms | about +/- 6.2 ms |
| **30 (target)** | 1.8 ms | 2.6 ms | about +/- 5.1 ms |
| 60 | 1.3 ms | 1.8 ms | about +/- 3.6 ms |

**The minimum is 20 per terminal. Below that a p50 is not a p50, it is an
anecdote.** The target is **30**, which puts the 95% interval on the delta at
about 5 ms against a threshold of 30 ms, so the gate only becomes ambiguous if
the delta lands between roughly 25 and 35 ms.

**The pre-committed rule, settled Sat 29 Aug 2026, four weeks before the
capture: the gate turns on the UPPER end of the 95% interval, not on the point
estimate.** PASS means the whole interval sits at or below 30 ms. FAIL means
the whole interval sits above it. Anything else is **NOT RESOLVED**, which is
an outcome and not an invitation to quote the median as though it had passed.

**Pass `--threshold 30` and the tool prints that verdict itself.** A rule
applied by hand after the numbers are on screen is not a pre-committed rule.

**Why the upper bound and not the median.** The two errors do not cost the same.
A false PASS puts a speed claim on a public surface that the measurement does
not support, which is the exact thing the positioning was rebuilt on 16 Aug to
stop doing. A false FAIL costs one sentence in the write-up, and the write-up
ships either way. So the rule makes Marlin prove it is inside 30 ms rather than
merely fail to prove it is outside.

**This replaces the earlier proposal to pool to n=60 whenever the delta landed
between 25 and 35 ms.** That proposal was right about the problem and wrong
about the remedy: n=60 only narrows the interval to about plus or minus 3.6 ms,
so a delta near 30 is still unresolved and the rule never terminates.
**One pooled recapture to n=60 is still allowed on a NOT RESOLVED, declared
before the second session is looked at, and its result is final whichever way
it falls. There is no third session.** Full reasoning in
`Decision 2026-08-29 Pre-Capture Rules` in the vault.

---

## The order: interleave, in rotating rounds

**Do not do all thirty Marlin trials, then all thirty Ghostty.** The machine
warms up, the background settles, and the way you hit a key at the start of a
session is not the way you hit it twenty minutes in. Any of those drifting
would be attributed to whichever terminal happened to be last.

**Three rounds of ten trials each, rotating the order**, which is nine blocks
and thirty trials per terminal:

| Round | Order |
|---|---|
| 1 | Marlin, Ghostty, Alacritty |
| 2 | Ghostty, Alacritty, Marlin |
| 3 | Alacritty, Marlin, Ghostty |

Every terminal is first once, second once and third once. Write this down on
paper and tick blocks off as you go, because losing track of which block was
which is the one mistake the analysis cannot recover from.

---

## Marking the trial boundaries

**A gap of silence is the marker, and it is the only marker.** No clap track,
no slate between blocks, nothing on screen. A pause is the only marker a person
reliably produces under pressure.

- **Within a block: about 1.5 seconds between taps.** Count "one thousand and
  one, one thousand and two". Do not rush; anything above about 0.4 s is
  detected correctly, but a steady rhythm makes the recording easy to read by
  eye if anything goes wrong.
- **Between blocks: at least 8 seconds of silence.** Switch terminals at the
  START of that gap, then wait, then start tapping. The window repaint when a
  terminal comes to the front is a large pixel change, and it must be far away
  from any key press.
- The analyser splits blocks on any gap over 4 seconds by default (`--gap`).
  8 seconds of silence against 1.5 seconds between taps is a wide margin.

---

## The sync slate, which buys the absolute number and the ratio

**Do this once, at the very start of the recording, before any trials.**

Strike two hard objects together sharply, once, in shot, somewhere near the
keyboard: two coins, a pen against a mug, the back of a knife against a table.
It needs to be **loud** and to have a **visible moment of contact**.

Then leave four seconds of silence before the first block.

**What it buys.** The analyser finds the click in the audio by itself. You find
the frame of contact by eye, once, by scrubbing the video. Those two are
simultaneous in the real world, so the difference between them IS the
audio-to-video offset, and with it the absolute latencies become real numbers
and the ratio the gate asks for becomes computable.

**Why the ratio needs it and the delta does not.** A constant offset cancels in
a subtraction and does not cancel in a division. On the validation capture the
true ratio was 1.286 and the uncorrected ratio came out at 0.582: not slightly
wrong, wrong in the second significant figure and on the wrong side of 1. The
delta on that same file was right to 0.02 ms with no correction at all.

**Its accuracy.** Identifying the contact frame by eye is good to a frame or
two, so the corrected absolute and the ratio carry about 4 to 8 ms of error
that the delta does not. Say so when quoting them.

---

## The dry run, which is not optional

**Before the real session, do a two minute rehearsal and analyse it.** Three
trials per terminal, one block each, same setup, same everything. Then run the
analyser on it.

This is the step that catches: the region being in the wrong place, the phone
having shot 60 fps, a cursor still blinking, the wrong window being focused, a
terminal whose text lands on a different row, and the microphone being too far
from the keyboard. **Every one of those is fatal to the real session and free
to fix during a rehearsal.**

The dry run has passed when the analyser reports the right number of presses,
the right number of blocks, and raises no alarms.

---

## On the day, in order

1. Set the room, the machine and the three terminals up per the sections above.
2. **Start recording.** One continuous take from here to the end.
3. **Slate:** strike the two objects together once. Wait four seconds.
4. **Round 1:** Marlin ten taps, gap, Ghostty ten taps, gap, Alacritty ten taps.
5. **Round 2:** Ghostty, Alacritty, Marlin.
6. **Round 3:** Alacritty, Marlin, Ghostty.
7. **Stop recording.** Copy the file off the phone without letting anything
   re-encode it. AirDrop the original; do not let Photos convert it.

---

## Analysing it

**Find the region.** Pull a frame from partway into the first block and read
the coordinates off the grid:

```
scripts/keystroke-latency.py capture.mov --grid-frame 30 -o roi.png
```

The red grid is 100 pixels, the yellow 20. The region wants to **contain the
line of `m`s in all three terminals and as little else as possible**. It does
not need to be tight: a bigger region raises the noise floor only slightly,
whereas a region that misses the text in one of the three terminals loses that
terminal entirely.

Two things to watch. Marlin uses a line height of 1.35, so its rows sit at
different heights from Ghostty's and Alacritty's at the same font size: check
the region against a frame from **each** terminal's block, not just the first.
And **keep tab bars, status bars, clocks and the file tree out of the region**
if you can, because anything in there that redraws on its own becomes a false
pixel change.

**Find the slate frame.** Scrub to the moment of contact and note the frame
number. In QuickTime, hold the right arrow to step frame by frame; frame number
is time in seconds times 240.

**Read it three times, independently, and take the median.** This is the one
number in the whole protocol still read off a video by a person, so it has the
failure mode the rest of the method was built to remove, concentrated at n=1.
**If the three reads disagree by more than one frame the slate is unusable:
make another one and recapture.** One frame out at 240 fps moves the offset by
4.17 ms, which is about 14% on the ratio.

**A wrong slate cannot flip the gate**, because the offset cancels in the delta
whatever the slate said. It corrupts the corrected absolutes and the ratio and
nothing else. The tool also refuses a corrected p50 below 1 ms or above 150 ms,
which is not a fast or slow terminal but a misread slate.

**Run it.**

```
scripts/keystroke-latency.py capture.mov \
  --roi 300,180,700,60 \
  --order marlin,ghostty,alacritty,ghostty,alacritty,marlin,alacritty,marlin,ghostty \
  --slate-frame 412 --slate-before 6 \
  --subject marlin --baseline ghostty \
  --threshold 30 \
  --csv trials.csv --json result.json
```

Read the output in this order:

1. **The detection lines.** Presses should equal the trials you actually did.
   Blocks should be nine, with roughly ten trials each. Both threshold plateaus
   should be tens of steps wide; a narrow plateau means the run is on the edge
   of a different answer.
2. **Any alarm banner.** If `DO NOT QUOTE THIS RUN` appears, stop and fix what
   it names. It is looking for presses with more than one pixel change nearby,
   and for a spread wider than the physics allows.
3. **The delta.** That is the gate.
4. **The absolutes and the ratio**, which are only real if the slate frame was
   supplied, and which carry the slate's own error.

**If the audio turns out to be unusable**, there is a fallback: put the press
times in a text file, one per line in seconds, and pass `--press-times`. The
tool then only does the video half. It is worse, because the video half is the
half with the 4.17 ms floor, and it means finding sixty press frames by hand.
It is there so that a bad audio track costs an evening rather than the session.

---

## What the number means, and what it does not

- **The delta is the figure the gate turns on**, and it is clean: the offset
  cancels, and the display refresh period lands on all three terminals alike,
  adding variance to it but not bias.
- **The absolutes carry the offset** unless the slate was used, and they carry
  the slate's own frame or two of error even then.
- **The frame quantisation floor is 4.17 ms**, and the tool reports each
  t_pixel as the midpoint between the last unchanged frame and the first
  changed one, so the error is half a frame either way rather than a whole
  frame late.
- **None of this is a claim about Marlin.** It is a measurement with an error
  bar. A miss is a performance bug and a better write-up, per the 22 Aug gate
  decision, and there is no speed claim anywhere on any public surface to
  withdraw.
