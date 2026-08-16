# Changelog

Notable changes to Marlin. Format follows [Keep a Changelog](https://keepachangelog.com),
versioning follows [semver](https://semver.org).

While the major version is 0, the minor version carries breaking changes and the patch
version carries everything else.

## [Unreleased]

### Added
- Quitting asks first, from every route: `⌘W` on the last pane, `⌘Q`, the red button and the
  menu's Quit all reach one confirmation. The dialog names what is live — panes, tabs, what is
  still running, what is waiting, what has unsaved changes — because quitting is only a real
  decision if you can see what you are throwing away.

### Fixed
- `⌘W` on the last pane used to do nothing at all. It now reads as an attempt to quit, which is
  what it is.

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
