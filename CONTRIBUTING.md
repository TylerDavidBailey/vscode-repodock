# Contributing to RepoDock

Thanks for helping out! The short version:

## Setup

```sh
make install     # npm install
make watch       # esbuild in watch mode
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

To test a packaged build instead, `make install-local` produces a `.vsix` and installs it
into VS Code (`make uninstall-local` removes it). `make help` lists all targets.

## Before you open a PR

```sh
make lint test            # eslint + prettier, unit tests, and integration tests
make test-coverage        # unit tests again, with the coverage thresholds CI enforces
```

CI runs the same checks on Linux, macOS, and Windows; all must pass.

- Unit tests (`test/unit`, vitest) cover both `src/core` — which must stay free of
  `vscode` imports so it remains testable outside the editor — and `src/ext`, through a
  shared stub of the VS Code API in `test/unit/helpers/vscodeStub.ts`. Prefer extending
  that stub over reaching for the integration suite.
- Integration tests (`test/integration`, `@vscode/test-cli`) run in a real VS Code
  instance. Keep them for what only the real API can prove; they are slow, and every
  global setting they write has to be cleared afterwards.
- `test/unit/contributes.test.ts` checks the code against `package.json`. Adding a command,
  a menu entry, a setting, or a `contextValue` means updating both, and it will tell you
  if you missed one.
- Coverage thresholds are enforced per directory. Raise them when the numbers rise; don't
  lower them to make a build pass.
- New behavior needs a test; bug fixes need a regression test.

## Commit messages (required)

Releases are fully automated by release-please, which reads
[Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` → minor version bump
- `fix: ...` → patch version bump
- `feat!: ...` or a `BREAKING CHANGE:` footer → major version bump
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

Your PR title and commits must follow this format; the version number and changelog are
generated from them.

## Architecture in one paragraph

`src/core` (scanner, git porcelain parsing, labels, grouping and sorting) is pure Node with no VS Code
dependency. `src/ext` wires that core into the VS Code API: `treeProvider.ts` renders the
sidebar, `folderPicker.ts` the Manage Folders picker, `commands.ts` registers commands, and
`extension.ts` composes everything in `activate()`.
