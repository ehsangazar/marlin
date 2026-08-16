mod config;
mod fs;
mod log;
mod git;
mod pty;
mod update;

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
fn fs_read_doc(path: String) -> Result<fs::FileDoc, String> {
    fs::read_doc(&path, 4 * 1024 * 1024).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_write_doc(path: String, content: String, expect: String) -> Result<fs::FileDoc, String> {
    fs::write_doc(&path, &content, &expect).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_detect(path: String) -> fs::Project {
    fs::detect(&path)
}

#[tauri::command]
fn fs_walk(path: String) -> Vec<fs::Entry> {
    fs::walk(&path, 4000)
}

#[tauri::command]
fn fs_grep(path: String, query: String) -> Vec<fs::Hit> {
    fs::grep(&path, &query, 200)
}

#[tauri::command]
fn check_update() -> Result<update::UpdateInfo, String> {
    update::check().map_err(|e| e.to_string())
}

/// Install and relaunch in one call, because the two halves are not separately
/// useful: an app that has been replaced on disk but is still running the old
/// code is a state nobody wants to be left in.
#[tauri::command]
fn install_update(app: AppHandle, url: String) -> Result<(), String> {
    let installed = update::install(&url).map_err(|e| e.to_string())?;
    update::relaunch(&installed).map_err(|e| e.to_string())?;
    log::mark_clean_exit();
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    log::mark_clean_exit();
    app.exit(0);
}

#[tauri::command]
fn log_write(level: String, message: String) {
    log::write(&level, &message);
}

#[tauri::command]
fn log_diagnostics() -> Result<log::Diagnostics, String> {
    log::diagnostics(200).map_err(|e| e.to_string())
}

#[tauri::command]
fn log_clear_crash_flag() {
    log::mark_clean_exit();
}

#[tauri::command]
fn config_load() -> String {
    config::load()
}

#[tauri::command]
fn config_save(toml: String) -> Result<(), String> {
    config::save(&toml).map_err(|e| e.to_string())
}

#[tauri::command]
fn config_path() -> String {
    config::path().to_string_lossy().to_string()
}

#[tauri::command]
fn fs_reveal(path: String) -> Result<(), String> {
    fs::reveal(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_open_default(path: String) -> Result<(), String> {
    fs::open_path(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn fs_parent(path: String) -> String {
    fs::parent_dir(&path)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    fs::open_url(&url).map_err(|e| e.to_string())
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
fn git_workspace(root: String) -> Vec<git::RepoStatus> {
    git::workspace(&root)
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
    log::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
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
            fs_read_doc,
            fs_write_doc,
            fs_detect,
            fs_walk,
            fs_grep,
            check_update,
            install_update,
            quit_app,
            log_write,
            log_diagnostics,
            log_clear_crash_flag,
            config_load,
            config_save,
            config_path,
            fs_reveal,
            fs_open_default,
            fs_parent,
            open_external,
            fs_home,
            fs_display,
            git_status,
            git_workspace,
            git_diff,
            git_stage,
            git_unstage,
            git_discard
        ])
        .build(tauri::generate_context!())
        .expect("marlin failed to start")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                log::mark_clean_exit();
            }
        });
}
