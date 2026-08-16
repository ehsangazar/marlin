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

        // Read big and coalesce. Emitting per byte, or per read of a few
        // hundred bytes, is how a terminal loses to `cat` on a large file: the
        // cost is per-message, not per-byte.
        std::thread::spawn(move || {
            let mut buf = [0u8; 64 * 1024];
            let mut pending = Vec::<u8>::with_capacity(64 * 1024);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Drain whatever else is already waiting before we pay
                        // for an IPC hop.
                        while pending.len() < 512 * 1024 {
                            match reader.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n2) => pending.extend_from_slice(&buf[..n2]),
                                Err(_) => break,
                            }
                            break;
                        }
                        let text = String::from_utf8_lossy(&pending).to_string();
                        pending.clear();
                        let _ = app.emit(
                            "pty:data",
                            Output {
                                id,
                                data: text,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
            let _ = child.wait();
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
