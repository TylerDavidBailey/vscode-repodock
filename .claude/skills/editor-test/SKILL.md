---
name: editor-test
description: Test RepoDock in a real VS Code and a real VSCodium inside a Claude Code cloud session, with scripted normal-case and edge-case scenarios, screenshots, and a pass/fail report. Use before opening or updating any PR that changes src/, package.json, or media/, and whenever asked to test, verify, or screenshot the extension in an editor.
---

# Testing RepoDock in VS Code and VSCodium

Unit tests run against a stub of the `vscode` API, and `make test-integration` covers one
old VS Code build. Neither shows what a user sees. This skill loads the extension from the
working tree into the current VS Code and the current VSCodium, drives the real UI, and
checks it. Every PR that can change what the user sees runs the same pass and reports it
the same way.

## The pass

Run all four steps, in order, from the repository root.

1. **Gates.** These are what CI enforces, so a failure here ends the pass.

   ```bash
   npm ci
   make lint
   npm run typecheck
   make test-coverage
   xvfb-run -a make test-integration
   ```

2. **Editors and fixtures.** Both scripts skip work that is already done.

   ```bash
   bash .claude/skills/editor-test/scripts/install-editors.sh
   bash .claude/skills/editor-test/scripts/make-fixtures.sh
   ```

3. **Scenarios, in both editors.** The runner builds the extension first, starts its own
   virtual display, and exits non-zero when anything fails.

   ```bash
   node .claude/skills/editor-test/scripts/run-scenarios.mjs
   ```

   `--editor vscode` or `--editor vscodium` runs one editor, `--only id,id` runs chosen
   scenarios, and `--list` prints the catalog.

4. **Look at the screenshots.** Read the images in `/tmp/repodock-e2e/out/<editor>/` for
   every surface the PR touched, in both editors. Assertions read text out of the DOM, so
   they cannot see truncation, a wrong icon, a wrong color, or misalignment.

## Add scenarios for the change

The catalog lives in `scripts/scenarios.mjs`, and that is the file a PR edits. A PR that
changes what the user sees is not tested until the catalog says what the new behavior is.

- **Changed behavior:** update the expectations of the scenarios that cover it. Never
  delete or loosen an assertion to get a pass. If the old expectation is now wrong, replace
  it with the new one.
- **New behavior:** add one `normal` scenario for the path every user takes, and one `edge`
  scenario for each way its input or state can be unusual. Work down this list and add the
  cases that apply:
  - nothing to show: no folders, no repositories, an empty result
  - missing or stale: a folder or repository that no longer exists
  - duplicates: overlapping folders, repositories sharing a name
  - awkward text: spaces, non-ASCII, markdown characters, very long names and branches
  - git states: uncommitted changes, ahead, behind, detached HEAD, no commits, no upstream
  - structure: nested repositories, linked worktrees, symlinks, excluded folders, depth limit
  - scale: the 150 repositories under `~/many`
  - persistence: state that has to survive a window reload, such as pins and last-opened times
- **New fixture:** add it to `scripts/make-fixtures.sh` and rebuild with `--reset`. Put
  awkward repositories under `~/edge`, not `~/code` or `~/work`, because the normal-case
  scenarios assert the exact contents of those two.
- **A scenario that changes the window** (opens a folder, reloads) goes at the end of the
  catalog beside `open-repo`, because the others assume the window they were launched with.

Scenario style, so the catalog stays uniform:

- `id` is kebab-case and names the state, not the action taken to reach it.
- `title` is one sentence stating the expected behavior. It is what the report shows.
- Wrap every assertion about the UI in `ui.eventually`. Scans, git loads, and settings
  reloads all land asynchronously.
- Assert exact text with `assert.deepEqual` or `assert.equal` where the text is fixed, and
  a regular expression only where it legitimately varies (hashes, relative times).
- Put per-scenario configuration in `settings`. The runner resets to the base settings
  before each scenario, so no scenario cleans up settings after itself.
- A scenario that changes pins or files on disk restores them before it returns.
- End with `ui.shot('<id>')` when the state is worth a picture.

## Report it in the PR

Paste `/tmp/repodock-e2e/out/report.md` into the PR's **Testing** section, under a line for
the gates. The table already names both editor versions:

```markdown
Gates: lint, typecheck, coverage, and integration all pass.

| Scenario      | Kind   | VS Code 1.148.0 | VSCodium 1.143.17232 |
| ------------- | ------ | --------------- | -------------------- |
| `flat-recent` | normal | pass            | pass                 |
```

Then add one line on what the screenshots showed for the surfaces the PR changed. If a
scenario fails, or was skipped, say so in the PR with the error. Do not report a pass that
did not run.

## What the scenarios do not cover

State these as untested when a PR touches them, or test them by hand:

- macOS and Windows. Cloud sessions are Linux, so `Reveal in Finder`, drive-letter casing,
  and `\` separators are covered only by the unit tests.
- Restricted Mode. The editors launch with workspace trust disabled.
- A machine without git on its `PATH`.
- Commands that leave the editor: the folder dialog behind Add Folder, Reveal in File
  Explorer, Copy Path, and Open in New Window.

## Things that will trip you up

- **The work dir must have a short path.** The editor creates a unix socket inside its
  profile directory and socket paths are capped at 107 bytes. With a long path the editor
  exits right after launch and the only clue is a warning in its log. The default,
  `/tmp/repodock-e2e`, is fine. To keep the files elsewhere, symlink a short path to that
  place and set `REPODOCK_E2E_DIR` to the short path.
- **Never point the scripts at the real home directory.** The editors run with `HOME` set
  to `<work dir>/home`, which is what makes RepoDock show `~/code`, and it keeps real
  settings and repositories out of the run.
- **Network.** The scripts download from `update.code.visualstudio.com`,
  `vscode.download.prss.microsoft.com`, and `download.vscodium.com`. An environment with
  limited network access has to allow all three. VSCodium's GitHub releases are not
  reachable from a cloud session, which is why the script uses its apt repository.
- **Versions.** `install-editors.sh` takes the newest release of each editor the first
  time, then keeps it. VSCodium usually trails VS Code by a few releases, so a difference
  between the two columns can be a version difference. Pass `--force` to move to current
  releases, and pin with `VSCODE_VERSION` or `VSCODIUM_VERSION` to reproduce an old result.
- **Selectors are the editor's internals.** `run-scenarios.mjs` reads classes such as
  `.monaco-list-row` and `.label-description`. If every scenario fails after an editor
  upgrade, check those selectors in the `createUi` helpers before suspecting the extension.
- **Root and sandboxing.** Cloud sessions run as root, so the editors are launched with
  `--no-sandbox`. The "not recommended to run as root" notification in screenshots is
  expected.
