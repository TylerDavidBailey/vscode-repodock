# CLAUDE.md

RepoDock is a VS Code extension. It scans configured folders for git repositories and
switches between them through a tree view in the Activity Bar. README.md holds the
user-facing docs. This file covers what those docs leave out.

## Commands

- `make watch` and `make build`: esbuild bundle to `dist/`
- `npm run typecheck`: `tsc --noEmit` over both projects (see the tsconfig note below)
- `make lint`: eslint plus `prettier --check`. CI enforces both. Fix formatting with
  `npm run format`
- `make test-unit`: vitest over `test/unit`, fast and with no VS Code
- `make test-coverage`: the same run with v8 coverage and enforced thresholds
- `make test-integration`: `@vscode/test-cli` in a real downloaded VS Code. Slow, and it
  builds first

## Architecture

- `src/core/` must never import `vscode`: scanning (`scanner.ts`), `git status` parsing
  (`git.ts`), labels, sorting, dedupe, and hidden-filtering (`sorting.ts`), path keys
  (`paths.ts`), shared types (`types.ts`), and a concurrency limiter (`limit.ts`). Put new
  logic here whenever possible so it stays unit-testable.
- `src/ext/` wires core into the VS Code API: activation (`extension.ts`), tree
  (`treeProvider.ts`), commands (`commands.ts`), the Manage Folders picker
  (`folderPicker.ts`), settings (`settings.ts`), and Memento-backed stores
  (`recency.ts`, `pins.ts`).
- Unit tests share fixtures from `test/unit/helpers/`: `createVscodeStub()` for the `vscode`
  module, `fakeMemento()` and `fakeExtensionContext()` for the Memento-backed stores and
  `activate`, `makeRepo`, `makeGitState`, and `withGitRepos` for repo fixtures, and
  `required()` to narrow away the `undefined` that `noUncheckedIndexedAccess` adds. The lint
  config forbids `!`. Because `vi.mock` factories are hoisted above imports, wire the stub up
  through a dynamic import and read recorded calls from the `stubState` singleton.
  `test/unit/treeProvider.test.ts` shows the pattern.

## Testing

- The stub records every API call into a `StubState`: `commands` (id to handler, so a test
  can invoke a command the way VS Code would), `contextKeys`, `quickPick`, `treeView`,
  `terminals`, and `fire*` helpers that play the configuration, window-state, and
  workspace-folder events. Extend the stub rather than writing a second one.
- `test/unit/contributes.test.ts` guards the `package.json` seam: contributed commands
  against registered ones, the `view/item/context` regexes against the `contextValue`
  strings a rendered row really carries, settings defaults against `getConfig`'s fallbacks,
  and `when`-clause context keys against the keys `activate` sets. Touching `package.json`
  or `repoItem`'s `contextValue` without touching this file is a mistake.
- Coverage is enforced per directory in `vitest.config.mts`, set a few points under what
  the suite reaches. Coverage measures the vitest run only. Integration tests exercise the
  bundled `dist/` build, which no instrumentation covers, so read `extension.ts`'s number as
  "covered by unit tests", not "covered".
- Integration tests are for what only the real API proves: the loop from a settings write to
  the config listener to a rescan, and `contextValue` on a real tree. Command bodies belong
  in `test/unit/commands.test.ts`. Clear anything the suite writes to global settings in
  `after`, because runs share the user-data dir.
- `path.sep` is fixed when `node:path` loads, so overriding `process.platform` does not
  reach it. Windows separator behavior needs `node:path` mocked with its `win32` variant
  (`test/unit/sorting-windows.test.ts`). `canonicalPathKey`'s case folding reads
  `process.platform`, so you can fake that directly.

## Comments and naming

Follows the TSDoc spec and the Microsoft TypeScript and VS Code coding guidelines.

- `/** */` documents exported symbols. `//` explains _why_ inside a body. Never put a
  `/** */` block on a statement.
- Document an export only where the signature doesn't already say it: semantics, units,
  side effects, and what `undefined` means. A summary line with no tags is the normal case.
- Never write types in `@param` or `@returns`, because the compiler enforces them. A tag
  that restates the parameter name is noise, so drop the tag.
- Keep a comment only if it says what the code cannot: invariants, platform quirks, rejected
  alternatives, security reasoning, issue links. Delete anything that narrates the code.
- Don't re-document a `vscode` interface you implement (`getTreeItem`, `getChildren`). Do
  document what the type system can't see: which `contextValue` strings drive `package.json`
  menus, which settings a function writes, what a write triggers downstream.
- Names: verb-phrase functions, booleans prefixed with `is`, `has`, or `should`, PascalCase
  types with no `I` prefix, no `Async` suffix, and camelCase filenames. Prefer whole words
  over abbreviations, and use single letters only in comparators.

## Conventions and gotchas

- Conventional Commits are load-bearing: release-please derives versions and the
  changelog from them, and PR titles must follow them, because PRs are squash-merged.
- Two overlapping scan roots can both turn up the same repo, so always dedupe by
  `repo.path` (`dedupeRepos` in `sorting.ts`).
- Compare configured paths and user paths with `canonicalPathKey` after `expandPath`.
  Display paths with `tildify`.
- TypeScript 6 requires an explicit `"types"` list in tsconfig, because automatic `@types`
  inclusion doesn't apply. There are two projects: the root `tsconfig.json` (`["node"]`,
  covering `src` and `test/unit`) and `test/integration/tsconfig.json`, which adds
  `"mocha"`. Keeping mocha's globals out of the root is deliberate. Otherwise a vitest
  file that forgot `import { describe } from 'vitest'` would still typecheck.
  `tsconfig.test.json` is the build config that emits integration tests to `out/`.
- Releases publish through the reusable `.github/workflows/publish.yml`, called by
  release-please after its `verify` job. A tag release-please creates uses the workflow
  token and cannot trigger a `push`-triggered workflow, which is the reason publishing is
  called rather than triggered. `workflow_dispatch` on the same file is the manual
  recovery path.
- One build goes to three places: the `.vsix` on the GitHub release, `vsce publish` to the
  Visual Studio Marketplace, and `ovsx publish` to Open VSX, which VSCodium and other
  non-Microsoft builds read. Each registry step exits early when its secret (`VSCE_PAT` or
  `OVSX_PAT`) is unset, so one missing token does not fail the run. Every step is
  idempotent: `gh release upload --clobber` replaces the asset, and both publishers refuse
  a version that already exists. A doc that names one registry has to name the other.
