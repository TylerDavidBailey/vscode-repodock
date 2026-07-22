# RepoDock

[![Marketplace](https://vsmarketplacebadges.dev/version/tylerdavidbailey.repodock.svg?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=tylerdavidbailey.repodock)
[![CI](https://github.com/TylerDavidBailey/vscode-repodock/actions/workflows/ci.yml/badge.svg)](https://github.com/TylerDavidBailey/vscode-repodock/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Discover every git repository inside the folders you add and switch between them without leaving VS Code.

RepoDock scans the folders you choose and lists every repo it finds in a sidebar, with live git status. Opening one takes a couple of keystrokes.

![RepoDock sidebar](docs/screenshot.png)

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Settings](#settings)
- [Contributing](#contributing)
- [Support](#support)
- [License](#license)

## Features

- Finds every git repo in the folders you add, including repos inside other repos (submodules, vendored checkouts).
- A real VS Code tree in the Activity Bar, one row per repo. Repos below a folder's top level show their parent directory in parentheses (`ginkgo (abc)`) so same-named repos stay distinct.
- Each row shows its branch and when you last opened it. The tooltip adds changed and untracked counts plus ahead/behind. When the window regains focus, status reloads and folders are rescanned, so a repo cloned from a terminal shows up on its own.
- Pin the repos you use daily to the top; hide the ones you never open.
- The repo open in the current window is highlighted and revealed when the view opens.
- Sort by most recently opened (compact `2h` timestamps) or alphabetically, from the title bar.
- Optionally group the list into one section per scanned folder. A repo under two overlapping folders appears once, in the more specific one.
- Focus the tree and type to filter.
- No network access, no telemetry, and no runtime dependencies. Paths and timestamps stay in VS Code's local storage.

## Getting started

Requires VS Code 1.96 or newer.

1. Install [RepoDock from the Marketplace](https://marketplace.visualstudio.com/items?itemName=tylerdavidbailey.repodock), or run `code --install-extension tylerdavidbailey.repodock`.
2. Open the RepoDock icon in the Activity Bar.
3. Click **Add Folder** and pick the directory (or directories) where your repos live.
4. Click any repo to open it, or focus the tree and type to filter.

## Commands

| Command                                                     | Description                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `RepoDock: Manage Folders`                                  | List scan folders, remove one, or add another (title-bar folder button) |
| `RepoDock: Add Folder` / `Remove Folder`                    | The same, as direct commands                                            |
| `RepoDock: Refresh`                                         | Rescan folders and reload git state                                     |
| `RepoDock: Sort by Recently Opened` / `Sort Alphabetically` | Toggle the sort order                                                   |
| `RepoDock: Group by Folder` / `Show Flat List`              | Toggle folder sections (shown when several folders are configured)      |
| `RepoDock: Unhide All Repositories`                         | Clear the hidden-repo list                                              |

Repo rows also offer **Pin/Unpin**, **Open in Current Window** / **Open in New Window** (inline icon), **Add to Workspace**, **Open in Integrated Terminal**, **Reveal in Finder / File Explorer**, **Copy Path**, and **Hide Repository** via the context menu.

## Settings

| Setting                    | Default                                          | Description                                           |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `repodock.directories`     | `[]`                                             | Folders to scan (`~` supported)                       |
| `repodock.maxDepth`        | `4`                                              | Directory levels to descend below each folder         |
| `repodock.exclude`         | `["node_modules", "bower_components", ".Trash"]` | Directory names skipped while scanning                |
| `repodock.hiddenRepos`     | `[]`                                             | Repos hidden via the context menu (`~` supported)     |
| `repodock.showNestedRepos` | `true`                                           | Show repos found inside another repo                  |
| `repodock.sortOrder`       | `"recent"`                                       | `recent` (last opened first) or `alphabetical`        |
| `repodock.groupByFolder`   | `false`                                          | One section per configured folder instead of one list |
| `repodock.openInNewWindow` | `false`                                          | Open repos in a new window when clicked               |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and the commit conventions releases are generated from.

## Support

[Open an issue](https://github.com/TylerDavidBailey/vscode-repodock/issues) for bugs and feature requests. For security problems, use the private process in [SECURITY.md](SECURITY.md) instead.

## License

[MIT](LICENSE)
