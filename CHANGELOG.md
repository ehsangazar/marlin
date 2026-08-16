# Changelog

Notable changes to Marlin. Format follows [Keep a Changelog](https://keepachangelog.com),
versioning follows [semver](https://semver.org).

While the major version is 0, the minor version carries breaking changes and the patch
version carries everything else.

## [Unreleased]

### Added
- Every pane wears a title bar showing its name and status dot. Double-click it to rename the
  pane, which pins the name so the shell stops changing it. The bar is also the drag handle,
  replacing the grip that only appeared on hover. `pane_titles = false` under `[layout]`, or
  the Settings toggle, gives the row back to the terminal.

### Fixed
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
  menu's Quit all reach one confirmation. The dialog names what is live — panes, tabs, what is
  still running, what is waiting, what has unsaved changes — because quitting is only a real
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
