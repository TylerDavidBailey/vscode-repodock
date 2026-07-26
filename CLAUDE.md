# CLAUDE.md

RepoDock is a VS Code extension: it scans configured folders for git repositories and
switches between them via a tree view in the Activity Bar. README.md has the
user-facing docs; this file covers what isn't obvious from it.

## Commands

- `make watch` / `make build` — esbuild bundle to `dist/`
- `npm run typecheck` — `tsc --noEmit` over both projects (see the tsconfig note below)
- `make lint` — eslint + `prettier --check` (CI enforces both; fix formatting with `npm run format`)
- `make test-unit` — vitest over `test/unit` (fast, no VS Code)
- `make test-coverage` — the same run with v8 coverage and enforced thresholds
- `make test-integration` — `@vscode/test-cli` in a real downloaded VS Code (slow; builds first)

## Architecture

- `src/core/` must never import `vscode`: scanning (`scanner.ts`), `git status` parsing
  (`git.ts`), labels/sorting/dedupe/hidden-filtering (`sorting.ts`), path keys (`paths.ts`),
  shared types (`types.ts`), and a concurrency limiter (`limit.ts`). Put new logic here
  whenever possible so it stays unit-testable.
- `src/ext/` wires core into the VS Code API: activation (`extension.ts`), tree
  (`treeProvider.ts`), commands (`commands.ts`), the Manage Folders picker
  (`folderPicker.ts`), settings (`settings.ts`), and Memento-backed stores
  (`recency.ts`, `pins.ts`).
- Unit tests share fixtures from `test/unit/helpers/`: `createVscodeStub()` for the `vscode`
  module, `fakeMemento()` and `fakeExtensionContext()` for the Memento-backed stores and
  `activate`, `makeRepo`/`makeGitState`/`withGitRepos` for fixtures, and `required()` to
  narrow away the `undefined` that `noUncheckedIndexedAccess` adds (the lint config forbids
  `!`). Because `vi.mock` factories are hoisted above imports, wire the stub up through a
  dynamic import and read recorded calls from the `stubState` singleton —
  `test/unit/treeProvider.test.ts` shows the pattern.

## Testing

- The stub records every API call into a `StubState`: `commands` (id to handler, so a test
  can invoke a command the way VS Code would), `contextKeys`, `quickPick`, `treeView`,
  `terminals`, and `fire*` helpers that play the configuration, window-state and
  workspace-folder events. Extend it rather than hand-rolling a second stub.
- `test/unit/contributes.test.ts` guards the `package.json` seam: contributed commands
  against registered ones, the `view/item/context` regexes against the `contextValue`
  strings a rendered row really carries, settings defaults against `getConfig`'s fallbacks,
  and `when`-clause context keys against those `activate` sets. Touching `package.json`
  or `repoItem`'s `contextValue` without touching this file is a mistake.
- Coverage is enforced per directory in `vitest.config.mts`, set a few points under what
  the suite reaches. It measures the vitest run only — integration tests exercise the
  bundled `dist/` build and are not instrumented, so read `extension.ts`'s number as
  "covered by unit tests", not "covered".
- Integration tests are for what only the real API proves (the settings-write to
  config-listener to rescan loop, `contextValue` on a real tree). Command bodies belong in
  `test/unit/commands.test.ts`. Anything the suite writes to global settings must be
  cleared in `after` — the user-data dir is shared between runs.
- `path.sep` is fixed when `node:path` loads, so overriding `process.platform` does not
  reach it. Windows separator behavior needs `node:path` mocked with its `win32` variant
  (`test/unit/sorting-windows.test.ts`); `canonicalPathKey`'s case folding reads
  `process.platform` and can be faked directly.

## Comments and naming

Follows the TSDoc spec and the Microsoft TypeScript/VS Code coding guidelines.

- `/** */` documents exported symbols; `//` explains _why_ inside a body. Never put a
  `/** */` block on a statement.
- Document an export only where the signature doesn't already say it — semantics, units,
  side effects, what `undefined` means. A summary line with no tags is the normal case.
- Never write types in `@param`/`@returns`; the compiler enforces them. A tag that restates
  the parameter name is noise — drop the tag.
- Keep a comment only if it says what the code cannot: invariants, platform quirks, rejected
  alternatives, security reasoning, issue links. Delete anything that narrates the code.
- Don't re-document a `vscode` interface you implement (`getTreeItem`, `getChildren`). Do
  document what the type system can't see: which `contextValue` strings drive `package.json`
  menus, which settings a function writes, what a write triggers downstream.
- Names: verb-phrase functions, `is`/`has`/`should` booleans, PascalCase types with no `I`
  prefix, no `Async` suffix, camelCase filenames. Whole words over abbreviations — single
  letters only in comparators.

## Conventions and gotchas

- Conventional Commits are load-bearing: release-please derives versions and the
  changelog from them, and PR titles must follow them (PRs are squash-merged).
- The same repo can be found under two overlapping scan roots — always dedupe by
  `repo.path` (`dedupeRepos` in `sorting.ts`).
- Compare configured/user paths with `canonicalPathKey` after `expandPath`; display
  paths with `tildify`.
- TypeScript 6 requires an explicit `"types"` list in tsconfig — automatic `@types`
  inclusion doesn't apply. There are two projects: the root `tsconfig.json` (`["node"]`,
  covering `src` and `test/unit`) and `test/integration/tsconfig.json`, which adds
  `"mocha"`. Keeping mocha's globals out of the root is deliberate — otherwise a vitest
  file that forgot `import { describe } from 'vitest'` would still typecheck.
  `tsconfig.test.json` is the build config that emits integration tests to `out/`.
- Releases publish through the reusable `.github/workflows/publish.yml`, called by
  release-please after its `verify` job. Tags it creates use the workflow token and cannot
  trigger a `push`-triggered workflow, which is why publishing is called rather than
  triggered; `workflow_dispatch` on the same file is the manual recovery path.
