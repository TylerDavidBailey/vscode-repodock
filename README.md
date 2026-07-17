# RepoDock

[![CI](https://github.com/TylerDavidBailey/vscode-repodock/actions/workflows/ci.yml/badge.svg)](https://github.com/TylerDavidBailey/vscode-repodock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Add folders, discover every git repository inside them, and switch between repos without leaving VS Code.

RepoDock scans the directories you choose (recursively, nested repos included), lists everything in a native sidebar with live git status, and gets you into any repo in a couple of keystrokes.

![RepoDock sidebar](docs/screenshot.png)

## Features

- **Recursive discovery** — point RepoDock at `~/Developer/repos` (or several folders) and it finds every git repository inside, including repos nested in subfolders and repos inside other repos (submodules, vendored checkouts).
- **Native sidebar** — a real VS Code tree in the Activity Bar, one row per repo. Repos in subfolders (or inside another repo) show their folder in parentheses (`ginkgo (abc)`), so nothing hides behind extra folder levels and same-named repos stay distinguishable.
- **Git state at a glance** — every repo row shows its branch and when you last opened it; the tooltip has the full picture (changes, untracked, ahead/behind). Status reloads automatically whenever the window regains focus.
- **Pin and hide** — pin your daily drivers to the top of the list (they get a pin icon), and hide repos you never open.
- **You are here** — the repo open in the current window is highlighted, tinted, and auto-revealed when the view opens, so you always know where you are.
- **Sort your way** — one flat list, ordered by most recently opened (with compact `2h`-style timestamps) or alphabetically. Toggle from the view title bar.
- **Group by folder** — scanning more than one folder? Toggle the title-bar group button to give each folder its own collapsible section (a repo found under two overlapping folders appears once, in the more specific one).
- **Type-to-find** — focus the tree and just type; VS Code's built-in tree filtering works out of the box.
- **Private by design** — no network requests, no telemetry, zero runtime dependencies. Folder paths and last-opened timestamps never leave VS Code's local storage.

## Getting started

1. Open the RepoDock icon in the Activity Bar.
2. Click **Add Folder** and pick the directory (or directories) where your repos live.
3. Click any repo to open it — or focus the tree and type to filter.

## Commands

| Command                                                     | Description                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `RepoDock: Manage Folders`                                  | List scan folders, remove one, or add another (title-bar folder button) |
| `RepoDock: Add Folder` / `Remove Folder`                    | The same, as direct commands                                            |
| `RepoDock: Refresh`                                         | Rescan folders and reload git state                                     |
| `RepoDock: Sort by Recently Opened` / `Sort Alphabetically` | Toggle the sort order                                                   |
| `RepoDock: Group by Folder` / `Show Flat List`              | Toggle folder sections (shown when several folders are configured)      |
| `RepoDock: Unhide All Repositories`                         | Clear the hidden-repo list                                              |

Repo rows also offer **Pin/Unpin**, **Open in New Window** (inline icon), **Add to Workspace**, **Open in Integrated Terminal**, **Reveal in Finder / File Explorer**, **Copy Path**, and **Hide Repository** via the context menu.

## Settings

| Setting                    | Default                                          | Description                                           |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `repodock.directories`     | `[]`                                             | Folders to scan (`~` supported)                       |
| `repodock.maxDepth`        | `4`                                              | Directory levels to descend below each folder         |
| `repodock.exclude`         | `["node_modules", "bower_components", ".Trash"]` | Directory names skipped while scanning                |
| `repodock.hiddenRepos`     | `[]`                                             | Repos hidden via the context menu (absolute paths)    |
| `repodock.showNestedRepos` | `true`                                           | Show repos found inside another repo, nested under it |
| `repodock.sortOrder`       | `"recent"`                                       | `recent` (last opened first) or `alphabetical`        |
| `repodock.groupByFolder`   | `false`                                          | One section per configured folder instead of one list |
| `repodock.openInNewWindow` | `false`                                          | Open repos in a new window when clicked               |

## Install locally

Until RepoDock is on the Marketplace, install it from a packaged `.vsix`:

```sh
make install-local   # packages and runs `code --install-extension repodock-<version>.vsix`
```

Or manually: `npm run package`, then in VS Code run **Extensions: Install from VSIX…** and pick the file. `make uninstall-local` removes it again. To try changes without installing, open this repo in VS Code and press `F5` — it launches an Extension Development Host with RepoDock loaded.

## Development

A Makefile wraps the npm scripts (`make help` lists everything):

```sh
make install         # npm install
make watch           # esbuild in watch mode; press F5 to launch the Extension Development Host
make test-unit       # vitest unit tests for the core (scanner, git parsing, grouping)
make test-integration  # @vscode/test-cli suite in a real VS Code instance
make lint            # eslint + prettier
make package         # produce a .vsix
```

The `src/core` layer has no dependency on the `vscode` module, so scanning, git parsing, and grouping logic are all unit-testable; `src/ext` wires that core into the VS Code API.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow (conventional commits are required — releases are generated from them) and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[MIT](LICENSE)
