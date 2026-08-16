mod fs;
mod git;
mod pty;

use pty::Shared;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn fs_list(path: String) -> Result<Vec<fs::Entry>, String> {
    fs::list_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_read(path: String) -> Result<String, String> {
    fs::read_text(&path, 512 * 1024).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_detect(path: String) -> fs::Project {
    fs::detect(&path)
}

#[tauri::command]
fn fs_home() -> String {
    fs::home()
}

#[tauri::command]
fn fs_display(path: String) -> String {
    fs::display_path(&path)
}

#[tauri::command]
fn git_status(cwd: String) -> Result<git::GitStatus, String> {
    git::status(&cwd).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_diff(cwd: String, path: String, staged: bool) -> Result<String, String> {
    git::diff(&cwd, &path, staged).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_stage(cwd: String, path: String) -> Result<(), String> {
    git::stage(&cwd, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_unstage(cwd: String, path: String) -> Result<(), String> {
    git::unstage(&cwd, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_discard(cwd: String, path: String) -> Result<(), String> {
    git::discard(&cwd, &path).map_err(|e| e.to_string())
}

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
            pty_close,
            fs_list,
            fs_read,
            fs_detect,
            fs_home,
            fs_display,
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_discard
        ])
        .run(tauri::generate_context!())
        .expect("marlin failed to start");
}
