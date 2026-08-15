# marlin

**The terminal for the age of AI.** Fast, customisable, opinionated.

Built for running several coding agents at once and knowing which one is waiting for you.

> **Status: spike.** This repository was started on 15 Aug 2026 and does not yet do anything you
> would want to use. Nothing in the feature list below is finished, and **no performance number has
> been measured.** The design is at [marlin.gazar.dev](https://marlin.gazar.dev).

## What it is meant to be

A terminal with splits that nest, a tab bar that can go vertical, and a sidebar that understands a
directory full of repositories. It uses iTerm2's keys for terminal actions and VSCode's for file
actions, so there is nothing to relearn. It notices when a pane is running a coding agent and tells
you when that agent is blocked waiting for you.

It competes on one thing: **speed**. Every feature has to argue against the frame budget, and the
settings panel says what each one costs.

## What it deliberately does not do

- **Interpret your command line.** Autosuggestions, completion, syntax highlighting and history are
  your shell's job, and fish and zsh are already excellent at them. Marlin reads semantic prompt
  marks instead, which is the half a shell cannot do.
- **Edit files.** The sidebar previews them read-only and hands them to `$EDITOR`.
- **Commit.** Stage, unstage, discard and revert are in the sidebar. You are already in a terminal.
- **Phone home.** No telemetry. One update check a day, no identifiers, and a switch to stop it.

## Building

```sh
cargo run
```

Requires a stable Rust toolchain. macOS first; Linux best-effort.

## Contributing

Open an issue with what you did and what happened. Issues are triaged by agents, which reproduce
what they can and open pull requests where the fix is obvious. A human reviews everything before it
ships.

## Licence

MIT.
