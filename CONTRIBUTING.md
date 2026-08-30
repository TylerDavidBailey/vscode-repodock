# Contributing to RepoDock

Thanks for helping out.

## Setup

```sh
make install     # npm install
make watch       # esbuild in watch mode
```

To launch an Extension Development Host with the extension loaded, press `F5` in VS Code.

To test a packaged build instead, run `make install-local`. It builds a `.vsix` and installs
it into VS Code, and `make uninstall-local` removes it. `make help` lists every target.

## Before you open a PR

```sh
make lint test            # eslint + prettier, unit tests, and integration tests
make test-coverage        # unit tests again, with the coverage thresholds CI enforces
```

CI runs the same checks on Linux, macOS, and Windows. All of them must pass.

- Unit tests (`test/unit`, vitest) cover both `src/core` and `src/ext`. `src/core` must stay
  free of `vscode` imports so it remains testable outside the editor, and `src/ext` reaches
  the API through a shared stub in `test/unit/helpers/vscodeStub.ts`. Prefer extending that
  stub over adding an integration test.
- Integration tests (`test/integration`, `@vscode/test-cli`) run in a real VS Code instance.
  Keep them for what only the real API can prove. They are slow, and every global setting
  they write has to be cleared afterwards.
- `test/unit/contributes.test.ts` checks the code against `package.json`. Adding a command,
  a menu entry, a setting, or a `contextValue` means updating both, and the test reports the
  one you missed.
- Coverage thresholds are enforced per directory. Raise them when the numbers rise. Never
  lower one to make a build pass.
- New behavior needs a test. A bug fix needs a regression test.

## Write commit messages as Conventional Commits

release-please generates every release from
[Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` → minor version bump
- `fix: ...` → patch version bump
- `feat!: ...` or a `BREAKING CHANGE:` footer → major version bump
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

Your PR title and your commits must follow this format. release-please derives the version
number and the changelog from them.

Once release-please cuts a tag, `.github/workflows/publish.yml` verifies it and then ships
the same build three ways: a `.vsix` attached to the GitHub release, a `vsce publish` to the
Visual Studio Marketplace, and an `ovsx publish` to Open VSX. Each registry step is skipped
when its token secret (`VSCE_PAT` or `OVSX_PAT`) is unset, so a missing token holds back one
registry without failing the release.

## Architecture

`src/core` holds the scanner, the git porcelain parsing, and the labelling, grouping, and
sorting. It is plain Node with no VS Code dependency. `src/ext` wires that core into the
VS Code API: `treeProvider.ts` renders the sidebar, `folderPicker.ts` the Manage Folders
picker, and `commands.ts` registers the commands. `extension.ts` composes all of it in
`activate()`.
