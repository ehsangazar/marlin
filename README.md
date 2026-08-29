# marlin

**The terminal where you read what your agents did.** Native, open source, no account.

You do not run one command and watch it any more. You run several agents in several panes, and the
real work is reading what they changed. That part happens here, without leaving the terminal.

> **Status: v0.1, built 15 to 16 Aug 2026.** It works and it is used, but it is early. There
> are now [numbers](#measuring) for the part Rust owns, printed by one reproducible command,
> and **none at all for the part you actually feel**, which is keystroke to pixel. So this
> README still makes no speed claims.

## What it does today

- **Splits that nest.** `⌘D` vertical, `⌘⇧D` horizontal. A tab holds a tree, so any mix of the
  two is just what happens when you press the second key. Closing a pane collapses its parent
  and gives the space back to its sibling.
- **Tabs with a three-state bar.** `⌘⇧B` cycles top, side, hidden. `⌘T`, `⌘W`, `⌘[`, `⌘]`,
  `⌘1`–`⌘9`, and `⌃⇥` / `⌃⇧⇥` to cycle, which is what most people's fingers already do.
- **An explorer and real git status.** Branch, ahead count, merge conflicts, staged and changed,
  with stage, unstage and discard on each row. It shells out to **your** git.
- **Every repository in the tree wears its branch and its change count.** A directory of
  repositories is what a working directory usually is, so a folder that is one says which branch
  it is on and how many files are uncommitted, without you navigating into it. Click the branch
  to switch branch. Click the count and the sidebar grows a tab of its own next to Explorer,
  listing that repository's changed files: click one for its diff, stage or discard from the
  row, close the tab when you are done. Neither number runs on a timer: both are read once and
  then held until you press Refresh.
- **A branch switcher.** Filter as you type, arrows to walk the list, Return to switch. Local
  branches switch, remote ones check out as a local branch that tracks them, a name that matches
  nothing offers to create it, and deleting asks first and then asks again if git says the branch
  is not fully merged. Click any branch to see what it has that yours does not, and click a file
  there to read the diff. Merging, rebasing, pushing and pulling stay in the terminal below.
- **Reading takes over the tab.** Click a file or a diff and you get three columns: tree, file,
  terminal. `Esc` puts your exact layout back. Diffs render unified or side by side.
- **A command palette.** `⌘⇧P` commands, `⌘P` go to file, `⌘⇧F` search every file's text.
  One registry drives the palette and the key map, so an action cannot exist in one and be
  missing from the other.
- **Renaming that sticks.** `F2` pane, `⇧F2` tab. A manual rename pins the name so the shell
  stops touching it; without that, your first `cd` overwrites what you typed.
- **Status dots** from real shell marks, not guesswork. See below.
- **Syntax highlighting** across 30 languages, themed through the active palette.
- **Editing**, with a write refused if the file changed on disk since you opened it.
- **Find in scrollback**, zoom pane, directional pane focus, drag tabs to reorder them, and
  right-click menus everywhere including the tree.
- **Zoom the whole interface.** `⌘+` and `⌘-` in ten per cent steps, `⌘0` back to life size.
  Chrome and terminals scale together, and the level is a config key, so it survives a quit.
- **Named panes.** Every pane wears its name and its status dot on a title bar of its own.
  Double-click the bar to rename it, which pins the name so the shell stops changing it. Turn
  the row off in Settings if you want the height back.
- **One setup step, offered once.** The shell hooks ship inside the app, and if the line is not in
  your `~/.zshrc` or fish config the app says so on first launch and offers to write it, because a
  documented setup step is one almost everyone skips and almost nobody debugs. Say no and it never
  asks again.
- **`⌘/` lists every shortcut**, built from the same registry the palette and the key map read, so
  a key that exists and a key that is documented cannot drift apart. **`⌘⇧A`** takes you to the next
  pane that wants you, running, waiting or failed, wherever it is.
- **Commit what you accepted.** The Changes tab stages, unstages, discards, and commits what is
  staged, with a message and nothing else: no amend, no push. Reading what an agent changed and
  then accepting it is one thought, and leaving for another window to finish it is the seam this
  is meant to close. Everything past that is still a conversation for the pane below.
- **Closing asks, and says what it is closing.** `⌘W` names the pane it is about to close, or
  the tab when that pane was its last, or Marlin when that tab was your last, and each dialog
  lists what is still running in it. Closing a tab from its × or its menu asks the same way.
  Return answers whichever button has focus, which is Cancel.
- **Panes that move.** Drag a pane by its title bar onto the middle of another to swap them,
  onto an edge to move it there and split, or onto a tab to send it to that tab. Panes are
  moved, not rebuilt, so a pane keeps its scrollback and its shell wherever it lands. Dragging
  is done with mouse events rather than HTML5 drag and drop, which cannot work in this window:
  the webview is claimed as an OS drag destination so that files dragged in from Finder are
  delivered, and that swallows the page's own drags whole.
- **Your layout comes back.** Tabs, splits, working directories and pinned names are restored
  on launch from `~/.config/marlin/session.json`. Scrollback and running processes are not,
  and pretending otherwise would mean faking a screen with no process behind it.
- **A resizable explorer.** Drag its edge, double-click the edge to put it back. The width is
  a config key, so it is the same width in that repository tomorrow.
- **Desktop notifications**, only when the window is not focused and only for commands that
  ran long enough that you went and did something else.
- **Settings in `~/.config/marlin/marlin.toml`**, editable by hand and safe in dotfiles.
- **Local-only diagnostics** with crash detection and one-click issue reporting. No telemetry.
- **Six themes**, three dark and three light, with values taken from each upstream project.

## Shell integration

The status dots and the working-directory tracking need your shell to say what it is doing.
The hooks ship inside the app, so an installed copy already has them:

```sh
echo 'source "/Applications/Marlin.app/Contents/Resources/shell/marlin.zsh"' >> ~/.zshrc
echo 'source "/Applications/Marlin.app/Contents/Resources/shell/marlin.fish"' >> ~/.config/fish/config.fish
```

Building from source instead, run this **from the clone** so `$PWD` is the repository:

```sh
echo "source $PWD/shell/marlin.zsh" >> ~/.zshrc     # zsh
echo "source $PWD/shell/marlin.fish" >> ~/.config/fish/config.fish
```

These emit `OSC 133` semantic prompt marks and `OSC 7`. **Marlin never parses your command
line.** The shell says "a command started" and "it exited with 3"; the terminal draws a dot.
Without the hook you get a working terminal with no dots, which is degraded rather than broken.

## What it deliberately does not do

- **Interpret your command line.** Autosuggestions, completion, syntax highlighting and history
  are your shell's job, and fish and zsh are already excellent at them.
- **Be your editor.** Clicking a file opens it ready to type in, with highlighting, a gutter
  and `⌘S`, and a write is refused if the file changed on disk since you opened it. That is
  for the typo you spotted while reading. It is a textarea, not Neovim, and it is not trying
  to become Neovim.
- **Be a git client.** Staging, discarding and committing what you just read are in the sidebar,
  because they are the end of reading. Merging, rebasing, pushing and pulling are not: they are
  conversations with a remote that fail in ways needing a paragraph of output, and you are already
  in a terminal that prints it.
- **Phone home.** No telemetry of any kind.

## Not done yet

Listed because a README that only lists wins is a sales page. **Kept honest in both
directions**: eleven items that used to be on this list have been built and were removed,
because a stale gap list flatters you just as much as no gap list at all.

- **Nothing above the pty is measured.** [Measuring](#measuring) covers the pty, the reader
  and emitter threads and the UTF-8 chunking. It stops where the webview begins, so VT
  parsing, the grid and the renderer have no numbers, and **keystroke-to-pixel is still
  unmeasured**. That is the figure a user actually feels, and until it exists this project
  claims no speed.
- **Nothing is measured on a machine that is not this one.** The numbers below are one
  laptop. There is no tracking over time and nothing fails when they regress.
- **Builds carry an ad-hoc signature, not a certificate.** macOS shows the unidentified-developer
  warning and Windows shows SmartScreen, both once, on first launch. Until 22 Aug 2026 this was
  worse than that sentence admits: nothing configured a signing identity, so the bundle shipped with
  the linker's ad-hoc signature and no sealed resources, and macOS reads that as *damaged* rather
  than as untrusted. **The build is fixed and no download is**: `"signingIdentity": "-"` landed
  22 Aug and a release step fails the build if the resources stop being sealed, but no tag has been
  through the pipeline since, so the published 0.1.1 image still answers `spctl` with exit 1,
  re-checked 29 Aug 2026. See the warning under [Installing](#installing).
  **Notarisation is still missing and needs an Apple account this project does not have.** Building
  from source avoids the question.
- **No tag has been through the release pipeline.** Both workflows were written on 16 Aug 2026;
  `ci.yml` has run on every push since and `release.yml` has gone green as a dry run on macOS,
  Windows and Linux, but **0.1.2 will be the first actual release through it**. Nobody has *sat in
  front of* Marlin on Windows, and the Linux packages are built and have never been run by
  anybody.
- **The update installs without a signature to verify.** TLS to the feed and to the release
  host is the whole of what it trusts. See [`update.rs`](src-tauri/src/update.rs).
- **A restored session is a layout, not a session.** Tabs, splits, directories and pinned
  names come back. Scrollback and what was running do not, and cannot: see
  [`session.ts`](src/session.ts).
- **The editor is a textarea, not an editor.** Highlighting, a gutter and conflict-detecting
  saves, but no multiple cursors, no bracket matching, no undo beyond the browser's own, and
  no highlighting at all above 400KB.

## Measuring

```sh
cd src-tauri && cargo run --release --example measure
```

Every number is reproducible in that one command, and prints what it excludes beside it.
Measured 16 Aug 2026, M-series MacBook, release build, mains power. **Ranges, not single
figures**: these are the spread of p50 across six runs, because one run of anything that
touches a scheduler is a number you got, not a number that is true. A run competing with a
compile was ~65% slower than an idle one, which is the honest width of the claim.

| | p50 across 6 runs | best p95 |
|---|---|---|
| Pty round trip, tty echo, no process involved | 9.3–13.8µs | 11.6µs |
| Pty round trip including waking `cat` | 14.9–24.8µs | 19.8µs |

| | |
|---|---|
| UTF-8 chunk validation, 64KiB ASCII | 19–29 GiB/s |
| UTF-8 chunk validation, 64KiB mixed scripts | 1.1 GiB/s |
| Output throughput, process to coalesced chunks | 57–61 MiB/s, ~370–410 bytes per read |

**What these do and do not say.** The round trip is a *floor* for input latency: it excludes
VT parsing, the grid, the renderer and the compositor. Do not quote it as keystroke-to-pixel.
Throughput is bounded by the pty at ~57 MiB/s, not by anything Marlin does: validation is two
to three orders of magnitude faster than the pipe feeding it, which is the useful finding.
The mixed-script case is ~18× slower than ASCII because `str::from_utf8` has an ASCII fast
path, and it is still far above what a pty can deliver.

## Installing

From [Releases](https://github.com/ehsangazar/marlin/releases), or build it yourself. Everything
up to and including 0.1.1 was built by hand on one Apple silicon Mac, so the only artefact that
exists today is `Marlin_0.1.1_aarch64.dmg`. **The table below is what 0.1.2 will ship**, and the
Windows filenames in it are Tauri's naming convention rather than names anyone has yet seen come
out of a build.

| You are on | Take | Notes |
|---|---|---|
| macOS, Apple silicon or Intel | `Marlin_<version>_universal.dmg` | One universal binary, both architectures |
| Windows 10 or 11, x64 | `Marlin_<version>_x64-setup.exe` | Installs for the current user, no admin prompt |
| Windows, deploying it | `Marlin_<version>_x64_en-US.msi` | Same app, for people who need an MSI |
| Debian, Ubuntu and anything apt | `Marlin_<version>_amd64.deb` | Start here on Ubuntu, see the AppImage note below |
| Any other Linux, x64 | `Marlin_<version>_amd64.AppImage` | `chmod +x` and run it. No root, no package manager |

**Nothing is signed by a certificate authority.** There is no Apple Developer ID and no Windows
signing certificate, so macOS and Windows both stop you the first time. That warning is accurate:
nobody has paid anyone to vouch for this build. It is not a judgement about the contents, and it is
also not nothing, so here is exactly what you will see and what to do about it.

> [!WARNING]
> **The 0.1.1 disk image on the releases page is a different and worse case than the one described
> below, so read this first.** It was built by hand on 16 August, before the bug was found. It is
> not merely unsigned, it is **malformed**: the binary carries the linker's ad-hoc signature, which
> seals no bundle resources, and macOS reads a signature promising resources it cannot find as
> corruption. You therefore get **"Marlin is damaged and can't be opened. You should move it to the
> Trash"**, and **that dialog has no Open Anyway and no consent path at all.**
>
> **Two remedies that are widely recommended for that dialog do not work here.** Measured rather
> than assumed: `spctl -a -vvv -t exec` against the published 0.1.1 bundle, run 29 August 2026.
> Exit 1 is a malformed bundle; exit 3 is the ordinary unidentified developer you can click through.
>
> | State of the bundle | `spctl` |
> |---|---|
> | As downloaded | **exit 1**, *code has no resources but signature indicates they must be present* |
> | After `xattr -dr com.apple.quarantine` | **exit 1**, unchanged. The quarantine flag was never the problem |
> | After `codesign --force --deep --sign - /Applications/Marlin.app` | **exit 3**, *rejected*. The ordinary case, and Open Anyway appears |
>
> **To run 0.1.1 today:** drag it to Applications, run
> `codesign --force --deep --sign - /Applications/Marlin.app`, then follow the macOS steps below as
> normal. That re-seals the bundle on your own machine with the ad-hoc signature the build should
> have carried. It vouches for nothing and does not substitute for notarisation; it turns an
> unopenable file into one you can consciously decide to trust. If you would rather not run that on
> a stranger's binary, which is a reasonable position, build from source or wait for 0.1.2.
>
> **Fixed at source on 22 August**, in the build rather than in this advice: `"signingIdentity": "-"`
> in `tauri.conf.json` makes `tauri-bundler` actually run `codesign` instead of skipping the step,
> and a release job now fails the build if *Sealed Resources* goes missing again. **Neither has
> reached a download**, because no tag has been through the pipeline since. 0.1.2 is the first build
> that will carry it.

**It happens once.** Once you have allowed it, macOS saves the exception and Marlin opens by
double-clicking from then on. Updates install in place and never ask again, because the warning is
attached by whatever *downloads* a file and Marlin fetching its own disk image does not attach it.

On **macOS**, from 0.1.2 onwards, you get a dialog headed **"Marlin" Not Opened**, saying Apple could not verify Marlin
is free of malware. Its two buttons are **Done** and **Move to Trash**, and Move to Trash is the
highlighted one, so do not press it out of habit. Open **System Settings**, then
**Privacy & Security**, scroll to **Security**, and click **Open Anyway** next to Marlin. That
button is only there for about an hour after you tried to open it.

Right-clicking and choosing Open used to do the same job and **stopped working in macOS Sequoia**,
which removed that override. Plenty of projects still tell you to do it. If you would rather stay in
a terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Marlin.app
```

Downloading with `curl` rather than a browser skips the question entirely, for the same reason:
`curl` does not mark what it downloads.

On **Windows**, SmartScreen shows "Windows protected your PC". Choose **More info**, then
**Run anyway**.

On **Linux** there is none of this. Nothing asks for a signature, and neither package triggers a
warning of any kind.

**Take the `.deb` if apt is an option, and that is why it is listed first.** It declares its
dependencies, so apt resolves them for you. The AppImage carries the webview but not the whole
desktop, and CI has twice caught it wanting a library a bare system did not have,
`libfontconfig.so.1` and then `libfribidi.so.0`. Both are ordinary parts of a GTK desktop and you
almost certainly have them, but **nobody has yet run either package on a real Linux desktop**, so
that is a claim we are not making. If the AppImage exits complaining about a missing shared library,
the `.deb` is the answer.

**What the AppImage does not need is FUSE 2**, whatever the usual AppImage advice says. Its runtime
is `static-pie linked`, which `file` and `ldd` both confirm on every build, so it cannot be missing
`libfuse.so.2` and `sudo apt install libfuse2` is not a step you need. `--appimage-extract-and-run`
works if you would rather not mount anything at all.

> An earlier version of this section said the AppImage needs FUSE 2 and fails on a stock Ubuntu.
> **That was wrong.** It described classic AppImage behaviour that this AppImage does not have, and
> it was written before the smoke test existed to check it. Corrected 23 Aug 2026.

Building from source avoids the question everywhere, and is what we would do in your position.

> **Windows is built and started, not lived in, and read the tense here carefully.** Two
> workflows exist. [`ci.yml`](.github/workflows/ci.yml) compiles, clippies and tests on macOS,
> Linux and Windows on every push. [`release.yml`](.github/workflows/release.yml) builds the
> installers above on macOS and Windows for every tag, then installs the Windows one silently on
> a runner and checks the executable starts and is still alive twenty seconds later. Since
> 22 Aug 2026 it also builds Linux, on `ubuntu-22.04` so the artefacts do not demand a newer glibc
> than the distributions they are for.
>
> **Both have run, and no tag has been through either.** `ci.yml` runs on every push. `release.yml`
> has been dispatched as a dry run and gone green on all three platforms, so the installers above
> are files that have been built rather than filenames someone predicted. What has never happened
> is a *tag* going through it, which is what 0.1.2 will be. **The Linux artefacts are built and
> have never been run by anybody**, which is the same sentence this README uses about Windows, and
> Windows at least has the smoke job.
>
> That smoke test proves the installer works and the process starts. It proves
> nothing a person would notice: not that the window renders, not that a prompt appears, not that
> typing works. The day-to-day use behind "it works and it is used" is macOS. If Windows
> misbehaves, that is a bug worth
> [reporting](https://github.com/ehsangazar/marlin/issues/new/choose), not a known limitation to
> work around quietly.

Updates are checked once a day against a static file and shown in Settings. On macOS the button
that tells you a version exists installs it. On Windows it opens the release page instead, because
an installer cannot overwrite the executable it is running from.

## Building

```sh
pnpm install
pnpm tauri dev                                            # run it
CI=true pnpm tauri build --target universal-apple-darwin  # bundle it
```

Needs Node, pnpm and a stable Rust toolchain. macOS first; Linux compiles and tests but is
never packaged.

**`CI=true` is not decoration.** Without it the dmg step runs an AppleScript that asks Finder
to arrange the disk image window, and that fails on a machine where Finder will not cooperate,
taking the whole bundle with it. GitHub Actions sets `CI=true` for you, which is why
`release.yml` says nothing about it and a local build appears to be broken for no reason.
Building only the app rather than the disk image avoids it entirely:
`pnpm tauri build --bundles app`.

**Do not add a second `[[bin]]` to `src-tauri`.** Tauri's universal build runs `lipo` over every
bin target in the crate, so a second one both confuses which executable ends up as
`CFBundleExecutable` and puts an extra `lipo` on the critical path of every macOS release. The
measurement harness lives in `src-tauri/examples/` for exactly this reason, and
`mainBinaryName` in `tauri.conf.json` is the belt to that pair of braces.

## How it is put together

Rust owns everything the OS touches: the pty, the filesystem, git, project detection. It
interprets no escape sequences at all. The webview owns VT parsing and the grid via `xterm.js`
with the WebGL renderer, and all the chrome. The reasoning, including the measurements that
killed an earlier native renderer, is in `notes/Projects/Marlin/Decision 2026-08-16 Platform.md`.

## Contributing

[Open an issue](https://github.com/ehsangazar/marlin/issues/new/choose) with what you did and what
happened. Issues are triaged by agents, which reproduce what they can and open pull requests where
the fix is obvious. A human reviews everything before it ships.

Feature requests are welcome and are often answered with no. Marlin's feature list is short on
purpose, and every addition argues against the frame budget, so the request form asks for the
problem underneath the feature rather than the feature. That is the part that changes the answer.

For anything that is not a defect or a request, there are
[Discussions](https://github.com/ehsangazar/marlin/discussions).

## Sponsoring

Marlin is MIT, free, has no account, no telemetry and nothing to upsell, and it is maintained by
one person in the open. [GitHub Sponsors](https://github.com/sponsors/ehsangazar) is what pays for
the time. It is monthly and cancellable on purpose: this is an early project and you should be able
to stop if it stops earning it.

## Licence

MIT.

## How a release is built

`pnpm tauri build` produces whatever the platform you are on can produce: `Marlin.app` and a disk
image on macOS, an NSIS installer and an MSI on Windows.

Releases are not built by hand. Tagging `v*` runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which builds the macOS universal
disk image and the Windows installers on GitHub-hosted runners, attaches them to the tag, and only
then marks the release published. That workflow exists because the previous arrangement was one
`tauri build` on one Apple Silicon Mac, which quietly meant Marlin had never shipped a build an
Intel Mac or a Windows machine could run.

The one step that stays local is `scripts/publish.sh`, which points `site/version.json` (the update
feed every installed copy polls) at the finished release. It refuses to publish the feed until it
has checked every URL in it against the artefacts the release actually has, because a feed naming
a file that is not there tells every running copy to download a 404.
