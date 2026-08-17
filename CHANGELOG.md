# Changelog

Notable changes to Marlin. Format follows [Keep a Changelog](https://keepachangelog.com),
versioning follows [semver](https://semver.org).

While the major version is 0, the minor version carries breaking changes and the patch
version carries everything else.

## [Unreleased]

### Added
- Every folder in the explorer that is a git repository shows the branch it is on and how many
  files are uncommitted. The branch opens a **branch switcher**: filter as you type, arrows to
  walk the list, Return to switch, a name matching nothing offers to create it, and deleting
  asks first and then asks again with git's own words if the branch is not fully merged. Remote
  branches are listed separately and check out as a local branch that tracks them, with a Fetch
  button so that list is not stale. Clicking any branch shows what it has that yours does not,
  three-dot, and clicking a file there opens its diff in the tab. The change count gives the
  sidebar a tab of its own next to Explorer, listing that repository's changed files with the
  usual stage, unstage and discard on each row; the strip appears only once something other
  than the explorer is open. Reviewing a few files means moving between them and coming back to
  the list, which a modal cannot do. Branches come from `.git/HEAD`, read as a file, so a folder
  of repositories costs no subprocesses to label; counts are a real `git status` each, run in
  parallel and then cached until an explicit refresh.
- A **Refresh** button on the explorer header. Nothing in the sidebar polls, deliberately, so a
  change made by an agent in another window used to sit there looking current.
- **Zoom.** `⌘+` and `⌘-` in ten per cent steps between 70% and 200%, `⌘0` back to 100%. Chrome
  scales through the root font size and terminals through their own, so they move together.
  Saved as `zoom` under `[appearance]`.
- Dialogs have buttons as well as keys, and each button carries the key that presses it. The
  rename box gained Save and Cancel; the keys had only ever been written in a hint line.
- An application menu, replacing the default one Tauri installs when an app declares none.
- `⌃⇥` and `⌃⇧⇥` cycle tabs, alongside the existing `⌘]` and `⌘[`. Two bindings for one action
  on purpose: the rest of this key map is iTerm2's, but Ctrl+Tab is what browsers, editors and
  Windows Terminal use, and it costs the shell nothing because a tty has no encoding for it.
  Next Tab and Previous Tab are now in the command palette too, where tab navigation had never
  appeared at all.
- Every pane wears a title bar showing its name and status dot. Double-click it to rename the
  pane, which pins the name so the shell stops changing it. The bar is also the drag handle,
  replacing the grip that only appeared on hover. `pane_titles = false` under `[layout]`, or
  the Settings toggle, gives the row back to the terminal.

- **The one setup step is now offered rather than documented.** If the shell integration line is
  missing from your `~/.zshrc` or fish config, a bar appears once with the exact line and a button
  that appends it. Status dots are a headline feature that silently did nothing until a step
  everyone skips was taken, which made it the app's largest gap between what it does and what a
  new user sees it do.
- **`⌘/` shows every shortcut**, generated from the registry the palette and key map already
  share. **`⌘⇧A`** focuses the next pane that is running, waiting or failed, across tabs: four
  agents in four panes was the case that made a dot without a way to reach it a hunt.
- **Commit from the Changes tab**: a message, the staged files, and nothing else. No amend, no
  push. Reading what an agent changed and accepting it is one thought, and the app previously
  ended that thought one verb early.

### Changed
- Source control is now the second tab of the sidebar rather than a section under the explorer,
  so changed files are listed in one place instead of two.
- Closing a pane only asks when something is running, waiting or unsaved in it. A confirmation on
  every idle pane is how a dialog becomes a key you press without reading, which is the state the
  tab and quit dialogs must never be in.
- A new tab or split starts in the working directory of the pane you were in, rather than at home.

### Removed
- The **Repositories** panel above the explorer. Every repository folder in the tree now carries
  its own branch and change count, so the panel was a second answer to a question the tree was
  already answering, and it cost a `git status` per sibling repository on every `cd`.

### Fixed
- **`⌘W` closed the window instead of the pane, and `⌘Q` quit without asking.** Setting no menu
  is not the same as having no menu: Tauri installs a default one that owns both accelerators,
  and AppKit matches a menu's key equivalent before the keystroke reaches the webview, so the
  key map never ran for either. `⌘Q` also bypassed the clean-exit marker, which the next launch
  read as a crash.
- **Closing anything now asks, and names what it is closing**: the pane, or the tab when that
  pane was its last, or Marlin when that tab was your last, each listing what is still running.
  The × on a tab and the tab menu ask the same way; Close Other Tabs asks once for the batch.
- **Return in a confirmation always answered yes**, even though Cancel held the focus and the
  code claimed that focus was the safety. It now answers the focused button.
- **Double-clicking a pane title or a tab never renamed anything.** WebKit does not deliver
  `dblclick` on a draggable element, and both are drag handles.
- **Dragging tabs to reorder them, dragging panes to move or swap them, and dropping a pane on
  a tab had never worked.** All three were built on HTML5 drag and drop, which cannot function
  in this window: Tauri claims the webview as an OS drag destination so Finder drops are
  delivered, and reports every drag as handled, so WebKit dispatches no `dragover` or `drop` to
  the page at all. `dragstart` still fires, which is why the code looked right. All three are
  now mouse events.
- Dragging a file in from Finder landed it in whichever pane sat nearest the top-left corner
  instead of the one under the cursor. The drop position is logical pixels on macOS, and it
  was being scaled again as though it were physical.
- Closing a zoomed pane with ⌘W offered to quit Marlin, and with a second tab open closed that
  whole tab instead. A zoomed pane is the only one in the visible tree, and that was being read
  as the tab being down to its last pane.
- Closing a pane while a file or diff viewer was open left the closed pane in the layout the
  viewer had stashed, so pressing Escape brought back a pane whose shell was already gone.

## [0.1.1] - 2026-08-16

### Added
- Dragging files in from Finder types their paths into the pane you dropped them on, quoted for
  the shell and followed by a space, so a drop finishes a half-written command instead of
  running one. The pane under the cursor lights up while the drag is over it.
- Check for updates in Settings, and the button that tells you a version exists is the button
  that installs it: it downloads the disk image, replaces the app in place and relaunches.
  Nothing is sent but one GET to a static file.
- A workspace panel in the sidebar. Open a folder holding several repositories and each one
  lists its branch, how far ahead or behind it is and how many files have changed, expandable to
  the files themselves. The scan runs in parallel in Rust, so nine repositories cost one call.
- Quitting asks first, from every route: `⌘W` on the last pane, `⌘Q`, the red button and the
  menu's Quit all reach one confirmation. The dialog names what is live: panes, tabs, what is
  still running, what is waiting, what has unsaved changes, because quitting is only a real
  decision if you can see what you are throwing away.

### Fixed
- Typing was a character behind. The pty reader coalesced output by issuing a second read before
  emitting, and a read on a pty master blocks, so the echo of every keystroke sat in a buffer
  until the next keystroke arrived to release it. Reading and emitting are now separate threads
  either side of a channel: asking "is there more?" is a `try_recv` that answers instantly, so a
  lone keystroke goes straight through and a flood still collapses into one message.
- Output split across a read boundary in the middle of a multi-byte character no longer turns it
  into a replacement character. The incomplete tail is held for the next chunk.
- `⌘W` on the last pane used to do nothing at all. It now reads as an attempt to quit, which is
  what it is.
- The workspace scan test pointed at whatever happened to sit above the repository, so it passed
  or failed on how the person running it arranges their projects folder. It builds its own
  repositories in a temporary directory now.

## [0.1.0] - 2026-08-16

First working version. Built 15 to 16 Aug 2026.

### Added
- Nesting splits: a tab holds a tree, so any mix of vertical and horizontal falls out of
  pressing the second key. Closing a pane collapses its parent.
- Tabs with a three-state bar: top, side, hidden, cycled with one key.
- Explorer sidebar with file-type icons, plus workspace detection so a directory holding
  several repositories shows as repositories rather than pretending to be one project.
- Source control: branch, ahead count, merge conflicts, staged and changed, with stage,
  unstage and discard. Shells out to the user's own `git` rather than linking libgit2.
- File and diff viewer that takes over the tab in three columns (tree, file, terminal) and
  restores the previous layout on close. Diffs render unified or side by side.
- Editing with conflict detection: a write is refused if the file changed on disk since it
  was opened, and writes go via a temporary file and a rename.
- Syntax highlighting across 30 languages, themed through the active palette.
- Command palette, go to file, and search across every file's text.
- Renaming with the pinning rule: a manual rename stops the shell overwriting the name.
- Find in scrollback, zoom pane, directional pane focus by geometry, tab reordering by drag,
  and right-click menus everywhere including the tree.
- Status dots driven by `OSC 133` shell marks, with integration scripts for zsh and fish.
- Six themes, three dark and three light, all meeting WCAG AA for both text roles.
- Settings written to `~/.config/marlin/marlin.toml`, editable by hand.
- Local-only diagnostics with crash detection and one-click pre-filled issue reporting.
  **No telemetry, and terminal output is never logged.**

### Known gaps
- Nothing is measured: no latency, throughput or memory figures exist.
- No desktop notifications yet, and no updater.
- Builds are unsigned, so other machines need Gatekeeper talked around.
