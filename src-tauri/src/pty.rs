//! Pty ownership.
//!
//! Rust keeps everything the OS touches. The webview owns VT parsing and the
//! grid, so nothing here interprets a single escape sequence: bytes in, bytes
//! out, and the shell is none of our business.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter};

/// One pane's pty. `writer` is kept so keystrokes can go straight down without
/// touching the reader thread.
struct Pane {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct Ptys {
    panes: Mutex<HashMap<u32, Pane>>,
    next: Mutex<u32>,
}

#[derive(serde::Serialize, Clone)]
pub struct Output {
    pub id: u32,
    pub data: String,
}

impl Ptys {
    pub fn spawn(
        &self,
        app: AppHandle,
        rows: u16,
        cols: u16,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Result<u32> {
        let sys = NativePtySystem::default();
        let pair = sys.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = shell
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/zsh".into());

        let mut cmd = CommandBuilder::new(shell);
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        // Tell the shell what it is talking to. Without this, anything using
        // terminfo assumes the worst and half the colours disappear.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "marlin");

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let id = {
            let mut n = self.next.lock().unwrap();
            *n += 1;
            *n
        };

        self.panes.lock().unwrap().insert(
            id,
            Pane {
                writer,
                master: pair.master,
            },
        );

        // Coalescing has to be free when there is nothing to coalesce, and that
        // is why this is two threads and a channel rather than one loop.
        //
        // A single loop can only ask "is there more?" by reading again, and a
        // read on a pty master blocks. Coalescing that way holds the echo of
        // every keystroke hostage until the *next* one arrives, which is felt
        // as the whole terminal typing a character behind. Handing the bytes to
        // a channel makes the same question non-blocking: `try_recv` answers
        // "nothing yet" instantly, so a lone keystroke is emitted the moment it
        // is read, and a flood still collapses into one IPC hop.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

        // Reader: blocking reads straight into the channel, never waiting on
        // the webview. A slow frame must not back-pressure the shell.
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
            let _ = child.wait();
            // Dropping tx here is what tells the emitter the shell is gone.
        });

        // Emitter: one blocking wait, then take everything already queued.
        std::thread::spawn(move || {
            let mut carry = Vec::<u8>::new();
            while let Ok(first) = rx.recv() {
                let mut pending = std::mem::take(&mut carry);
                pending.extend_from_slice(&first);
                while pending.len() < 512 * 1024 {
                    match rx.try_recv() {
                        Ok(more) => pending.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
                // A chunk boundary can land inside a multi-byte character, and
                // lossy conversion would turn it into a replacement character
                // that never recovers. Hold the incomplete tail (at most three
                // bytes) for the next round instead.
                let good = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => pending.len(),
                };
                carry.extend_from_slice(&pending[good..]);
                if good == 0 {
                    continue;
                }
                let text = String::from_utf8_lossy(&pending[..good]).into_owned();
                let _ = app.emit("pty:data", Output { id, data: text });
            }
            let _ = app.emit("pty:exit", id);
        });

        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        let mut panes = self.panes.lock().unwrap();
        let pane = panes.get_mut(&id).ok_or_else(|| anyhow!("no pane {id}"))?;
        pane.writer.write_all(data.as_bytes())?;
        pane.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<()> {
        let panes = self.panes.lock().unwrap();
        let pane = panes.get(&id).ok_or_else(|| anyhow!("no pane {id}"))?;
        pane.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&self, id: u32) {
        self.panes.lock().unwrap().remove(&id);
    }
}

pub type Shared = Arc<Ptys>;
