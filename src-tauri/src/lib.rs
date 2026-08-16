mod pty;

use pty::Shared;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    state: State<'_, Shared>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<u32, String> {
    state
        .spawn(app, rows, cols, cwd, shell)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_write(state: State<'_, Shared>, id: u32, data: String) -> Result<(), String> {
    state.write(id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(state: State<'_, Shared>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    state.resize(id, rows, cols).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(state: State<'_, Shared>, id: u32) {
    state.close(id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Shared::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close
        ])
        .run(tauri::generate_context!())
        .expect("marlin failed to start");
}
