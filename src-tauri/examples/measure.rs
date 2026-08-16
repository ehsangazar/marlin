//! What Marlin can and cannot say about its own speed.
//!
//!     cargo run --release --example measure
//!
//! **An example, not a binary, and that is load-bearing.** Tauri's
//! `universal-apple-darwin` build runs `lipo` over every *bin* target in the
//! crate, not just the app. As a second bin this file broke the macOS release
//! twice over: the bundler picked the wrong executable, so `Marlin.app` shipped
//! with `CFBundleExecutable` set to `measure` and launching the terminal
//! printed a table of throughput figures instead of opening a window; and the
//! extra `lipo` step sat on the critical path of every release, where it could
//! and did fail. Cargo does not lipo examples. Do not move this back under
//! `src/bin/`.
//!
//! Every number here is measured on the machine you run it on, printed with
//! what it excludes, and reproducible in one command. That last part is the
//! point: a performance claim you cannot re-run is a performance claim.
//!
//! **What this measures.** The path Rust owns: the pty, the reader and emitter
//! threads, and the UTF-8 chunking between them.
//!
//! **What this does not measure, and therefore what Marlin must not claim.**
//! Keystroke-to-pixel. The webview owns VT parsing, the grid and the WebGL
//! renderer, and none of that is reachable from here. A round trip through the
//! pty is a floor for input latency, not the figure a user feels, and it is
//! labelled as such below.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use marlin_lib::pty::valid_prefix;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

fn main() {
    println!("Marlin measurement, {} build", if cfg!(debug_assertions) { "debug" } else { "release" });
    if cfg!(debug_assertions) {
        println!("!! debug build: these numbers are not the ones to publish.");
    }
    println!();

    chunking();
    println!();
    roundtrip();
    println!();
    throughput();
}

/// The one piece of per-chunk work on the hot path, in isolation.
///
/// Two shapes, because they are different jobs: an all-ASCII buffer is the
/// common case and validation can vectorise, and a buffer ending mid-character
/// is the case the code exists for.
fn chunking() {
    println!("UTF-8 chunk validation (pure CPU, no I/O)");

    for (name, buf) in [
        ("64 KiB ASCII", vec![b'x'; 64 * 1024]),
        ("64 KiB mixed", "café ✓ ⣾ ".repeat(4096).into_bytes()),
        ("64 KiB split tail", {
            let mut v = "café ✓ ⣾ ".repeat(4096).into_bytes();
            v.push(0xE2); // a lone lead byte: the tail must be held back
            v
        }),
    ] {
        // Enough iterations that the timer's own resolution is noise.
        let iters = 2000;
        let start = Instant::now();
        let mut sink = 0usize;
        for _ in 0..iters {
            sink = sink.wrapping_add(valid_prefix(&buf));
        }
        let each = start.elapsed() / iters;
        let per_sec = buf.len() as f64 / each.as_secs_f64() / (1024.0 * 1024.0 * 1024.0);
        println!(
            "  {name:<18} {:>9.2?} per chunk   {per_sec:>7.1} GiB/s   (checksum {sink})",
            each
        );
    }
}

/// Byte in, byte back out, twice over, because there are two different numbers
/// here and conflating them would flatter the terminal.
///
/// With echo left on, the bytes that come back are the *line discipline's*: the
/// kernel echoes the keystroke and no process is involved at all. That is the
/// floor of the floor, and it is worth printing precisely so nobody mistakes it
/// for the other one.
///
/// With `stty -echo`, the only way a byte comes back is out of `cat`, so the
/// measurement includes the scheduler waking a process. That is the honest
/// answer to "how long before the shell's reply reaches us".
///
/// `cat` rather than a shell either way: a shell would add prompt drawing, job
/// control and its own startup to a number meant to be the floor underneath them.
fn roundtrip() {
    println!("Pty round trip");
    println!("  (this is a FLOOR for input latency. It excludes VT parsing, the");
    println!("   grid, the renderer and the compositor, so it is NOT");
    println!("   keystroke-to-pixel and must never be quoted as though it were.)");

    // One pty, echo left on, and both numbers come out of the same exchange.
    //
    // Writing "x" to a tty running `cat` produces the byte back twice: once
    // from the line discipline, immediately, with no process involved, and once
    // from `cat` after the kernel has scheduled it. Timing the first and the
    // second arrival separately is the difference between what the tty costs
    // and what a process costs, measured under identical conditions.
    //
    // Reads happen on their own thread behind a channel with a timeout, because
    // a pty master does not reliably report EOF when its child dies: portable
    // pty keeps a slave descriptor, so a blocking read on a dead pane waits
    // forever. That is a hang in a measuring tool, which is the one place a
    // hang is indistinguishable from a slow result.
    let sys = NativePtySystem::default();
    let pair = sys
        .openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");
    let mut child = pair.slave.spawn_command(CommandBuilder::new("cat")).expect("spawn cat");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader");
    let mut writer = pair.master.take_writer().expect("writer");

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    // `cat` starting up is not what is being measured.
    std::thread::sleep(Duration::from_millis(150));
    while rx.try_recv().is_ok() {}
    for _ in 0..3 {
        writer.write_all(b"w\n").unwrap();
        writer.flush().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        while rx.try_recv().is_ok() {}
    }

    let n = 200;
    let mut tty = Vec::with_capacity(n);
    let mut proc = Vec::with_capacity(n);
    let mut coalesced = 0usize;
    let mut lost = 0usize;

    for _ in 0..n {
        let start = Instant::now();
        writer.write_all(b"x\n").unwrap();
        writer.flush().unwrap();

        // Two copies of "x" come back. Count them rather than counting reads:
        // if the two arrive inside one read the timings are genuinely equal,
        // and that is a result, not a measurement error.
        let mut seen = 0usize;
        let mut first: Option<Duration> = None;
        let mut all: Option<Duration> = None;
        while seen < 2 {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(bytes) => {
                    let at = start.elapsed();
                    first.get_or_insert(at);
                    seen += bytes.iter().filter(|b| **b == b'x').count();
                    if seen >= 2 {
                        all = Some(at);
                    }
                }
                Err(_) => break,
            }
        }
        match (first, all) {
            (Some(f), Some(a)) => {
                if f == a {
                    coalesced += 1;
                }
                tty.push(f);
                proc.push(a);
            }
            _ => lost += 1,
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    if tty.is_empty() {
        println!("  no round trips completed, so there is no number to report");
        return;
    }
    tty.sort();
    proc.sort();
    let q = |v: &Vec<Duration>, p: f64| v[((v.len() - 1) as f64 * p) as usize];
    println!(
        "  tty echo, no process   n={:<4} p50 {:>9.2?}  p95 {:>9.2?}  p99 {:>9.2?}",
        tty.len(),
        q(&tty, 0.50),
        q(&tty, 0.95),
        q(&tty, 0.99)
    );
    println!(
        "  echo + `cat` replied   n={:<4} p50 {:>9.2?}  p95 {:>9.2?}  p99 {:>9.2?}",
        proc.len(),
        q(&proc, 0.50),
        q(&proc, 0.95),
        q(&proc, 0.99)
    );
    println!(
        "  ({coalesced} of {} arrived in a single read, so for those two the tty and",
        tty.len()
    );
    println!("   the process figures are the same instant by definition. {lost} timed out.)");
}

/// How fast output moves from a process to the point where the webview would be
/// handed it, coalescing exactly the way the emitter thread does.
fn throughput() {
    println!("Output throughput: process -> coalesced UTF-8 chunks");
    println!("  (stops where the IPC hop to the webview begins, which is the");
    println!("   next cost and is not measured here.)");

    let sys = NativePtySystem::default();
    let pair = sys
        .openpty(PtySize { rows: 40, cols: 120, pixel_width: 0, pixel_height: 0 })
        .expect("openpty");

    // 64 MiB of output with no shell in the way. `yes` is a tight write loop,
    // which is the worst case a pane realistically sees: a build log at full tilt.
    let mut cmd = CommandBuilder::new("sh");
    cmd.args(["-c", "yes 'marlin measurement line, long enough to look like real output' | head -c 67108864"]);
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let start = Instant::now();
    std::thread::spawn(move || {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // The emitter thread's loop, verbatim in shape.
    let mut total = 0usize;
    let mut chunks = 0usize;
    let mut carry = Vec::<u8>::new();
    while let Ok(first) = rx.recv_timeout(Duration::from_secs(30)) {
        let mut pending = std::mem::take(&mut carry);
        pending.extend_from_slice(&first);
        while pending.len() < 512 * 1024 {
            match rx.try_recv() {
                Ok(more) => pending.extend_from_slice(&more),
                Err(_) => break,
            }
        }
        let good = valid_prefix(&pending);
        carry.extend_from_slice(&pending[good..]);
        if good == 0 {
            continue;
        }
        let _text = String::from_utf8_lossy(&pending[..good]).into_owned();
        total += good;
        chunks += 1;
    }
    let took = start.elapsed();

    let per = total as f64 / chunks.max(1) as f64;
    println!(
        "  {:.1} MiB in {:.2?}   {:.0} MiB/s   {chunks} chunks   {per:.0} bytes per chunk",
        total as f64 / (1024.0 * 1024.0),
        took,
        total as f64 / took.as_secs_f64() / (1024.0 * 1024.0),
    );
    println!("  Chunk count is the IPC hop count. Coalescing is a back-pressure");
    println!("  mechanism, so a small figure here means the consumer kept up and");
    println!("  there was never a queue to collapse, not that it failed to work.");

    let _ = child.wait();
}
