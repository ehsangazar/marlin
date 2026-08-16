# marlin

**A terminal built for running coding agents.** Fast, customisable, opinionated.

> **Status: v0.1, built 15 to 16 Aug 2026.** It works and it is used, but it is early, and
> **no performance number has been measured yet**, so this README makes no speed claims. When
> there are numbers they will appear here with the method beside them.

## What it does today

- **Splits that nest.** `⌘D` vertical, `⌘⇧D` horizontal. A tab holds a tree, so any mix of the
  two is just what happens when you press the second key. Closing a pane collapses its parent
  and gives the space back to its sibling.
- **Tabs with a three-state bar.** `⌘⇧B` cycles top, side, hidden. `⌘T`, `⌘W`, `⌘[`, `⌘]`,
  `⌘1`–`⌘9`.
- **An explorer and real git status.** Branch, ahead count, merge conflicts, staged and changed,
  with stage, unstage and discard on each row. It shells out to **your** git.
- **Workspaces.** A directory holding several repositories shows as repositories rather than
  pretending to be one project, which is what a working directory usually is.
- **Reading takes over the tab.** Click a file or a diff and you get three columns: tree, file,
  terminal. `Esc` puts your exact layout back. Diffs render unified or side by side.
- **A command palette.** `⌘⇧P` commands, `⌘P` go to file, `⌘⇧F` search every file's text.
  One registry drives the palette and the key map, so an action cannot exist in one and be
  missing from the other.
- **Renaming that sticks.** `F2` pane, `⇧F2` tab. A manual rename pins the name so the shell
  stops touching it; without that, your first `cd` overwrites what you typed.
- **Status dots** from real shell marks, not guesswork. See below.
- **Six themes**, three dark and three light, with values taken from each upstream project.

## Shell integration

The status dots and the working-directory tracking need your shell to say what it is doing:

```sh
echo 'source ~/Projects/merge/marlin/shell/marlin.zsh' >> ~/.zshrc     # zsh
echo 'source ~/Projects/merge/marlin/shell/marlin.fish' >> ~/.config/fish/config.fish
```

These emit `OSC 133` semantic prompt marks and `OSC 7`. **Marlin never parses your command
line.** The shell says "a command started" and "it exited with 3"; the terminal draws a dot.
Without the hook you get a working terminal with no dots, which is degraded rather than broken.

## What it deliberately does not do

- **Interpret your command line.** Autosuggestions, completion, syntax highlighting and history
  are your shell's job, and fish and zsh are already excellent at them.
- **Edit files.** The viewer is read-only.
- **Commit.** Stage, unstage and discard are in the sidebar. You are already in a terminal.
- **Phone home.** No telemetry of any kind.

## Not done yet

Listed because a README that only lists wins is a sales page.

- **No syntax highlighting** in the file viewer, only line numbers.
- **Config lives in `localStorage`**, not in a hand-editable `~/.config/marlin/marlin.toml`.
- **No notifications, no updater, no drag and drop, no right-click menus, no zoom pane, no
  scrollback search, no pane focus by direction.**
- **No signed build**, so a downloaded binary would be blocked by Gatekeeper. Build it yourself.
- **Nothing is measured.** No latency, throughput or memory figures exist.

## Building

```sh
pnpm install
pnpm tauri dev      # run it
pnpm tauri build    # bundle it
```

Needs Node, pnpm and a stable Rust toolchain. macOS first; Linux untested.

## How it is put together

Rust owns everything the OS touches: the pty, the filesystem, git, project detection. It
interprets no escape sequences at all. The webview owns VT parsing and the grid via `xterm.js`
with the WebGL renderer, and all the chrome. The reasoning, including the measurements that
killed an earlier native renderer, is in `notes/Projects/Marlin/Decision 2026-08-16 Platform.md`.

## Contributing

Open an issue with what you did and what happened. Issues are triaged by agents, which reproduce
what they can and open pull requests where the fix is obvious. A human reviews everything before
it ships.

## Licence

MIT.

## Note on bundling

`pnpm tauri build` produces `Marlin.app` (5.9 MB). The DMG target is disabled: Tauri's
`bundle_dmg.sh` drives Finder through AppleScript to lay out the disk image window, which needs
an interactive GUI session and fails from a plain shell. Re-enable it in `tauri.conf.json` when
building by hand for a release.
