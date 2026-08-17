//! The application menu.
//!
//! Setting no menu is not the same as having no menu: Tauri installs a default
//! one, and that default owns `⌘W` (File and Window both carry "Close Window")
//! and `⌘Q` ("Quit"). AppKit matches a menu item's key equivalent before the
//! keystroke reaches the responder chain, so the webview's key map never saw
//! either of them. `⌘W` closed the window over a tab that still had panes in it,
//! and `⌘Q` terminated the process without the confirmation the app promises and
//! without marking a clean exit, which the next launch read as a crash.
//!
//! So the menu has to be declared rather than inherited. Everything that is a
//! genuine system action stays predefined; the two items that overlap with
//! Marlin's own shortcuts forward to the frontend and act nowhere else, because
//! only the frontend knows what a pane is or what quitting would throw away.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};

/// Carries the id of the chosen item to the webview.
pub const EVENT: &str = "menu";

/// Close the focused pane, and only fall through to closing the app when that
/// pane is the last one. Handled by `closeFocused` in `main.ts`.
pub const CLOSE_PANE: &str = "close-pane";

/// Quit, via the same confirmation every other route reaches.
pub const QUIT: &str = "quit";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                QUIT,
                format!("Quit {}", pkg.name),
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[&MenuItem::with_id(
            app,
            CLOSE_PANE,
            "Close Pane",
            true,
            Some("CmdOrCtrl+W"),
        )?],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    // No "Close Window" here either. It is the same `⌘W` under another name, and
    // the red button already does it, through `onCloseRequested` and the same
    // confirmation.
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
    )
}
