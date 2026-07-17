# CLAUDE.md

RepoDock is a VS Code extension: it scans configured folders for git repositories and
switches between them via a tree view in the Activity Bar. README.md has the
user-facing docs; this file covers what isn't obvious from it.

## Commands

- `make watch` / `make build` — esbuild bundle to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `make lint` — eslint + `prettier --check` (CI enforces both; fix formatting with `npm run format`)
- `make test-unit` — vitest over `test/unit` (fast, no VS Code)
- `make test-integration` — `@vscode/test-cli` in a real downloaded VS Code (slow; builds first)

## Architecture

- `src/core/` must never import `vscode`: scanning (`scanner.ts`), `git status` parsing
  (`git.ts`), labels/sorting/dedupe/hidden-filtering (`sorting.ts`), path keys (`paths.ts`).
  Put new logic here whenever possible so it stays unit-testable.
- `src/ext/` wires core into the VS Code API: activation (`extension.ts`), tree
  (`treeProvider.ts`), commands (`commands.ts`), the Manage Folders picker
  (`folderPicker.ts`), settings (`settings.ts`), and Memento-backed stores
  (`recency.ts`, `pins.ts`).
- Unit tests stub the `vscode` module with `vi.mock`; `test/unit/treeProvider-provider.test.ts`
  shows the pattern.

## Conventions and gotchas

- Conventional Commits are load-bearing: release-please derives versions and the
  changelog from them, and PR titles must follow them (PRs are squash-merged).
- The same repo can be found under two overlapping scan roots — always dedupe by
  `repo.path` (`dedupeRepos` in `sorting.ts`).
- Compare configured/user paths with `canonicalPathKey` after `expandPath`; display
  paths with `tildify`.
- TypeScript 6 requires an explicit `"types"` list in tsconfig (`["node", "mocha"]`
  here) — automatic `@types` inclusion doesn't apply.
