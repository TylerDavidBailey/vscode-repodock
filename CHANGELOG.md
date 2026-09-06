# Changelog

## [1.1.3](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.2...v1.1.3) (2026-09-06)


### Bug Fixes

* ignore blank and relative entries in directories and hiddenRepos ([#34](https://github.com/TylerDavidBailey/vscode-repodock/issues/34)) ([f29d9bd](https://github.com/TylerDavidBailey/vscode-repodock/commit/f29d9bdda5a5bf3511c3eb08129b042c8a2b3d95))
* keep a superseded refresh waiting for the scan that replaced it ([#33](https://github.com/TylerDavidBailey/vscode-repodock/issues/33)) ([7429cd3](https://github.com/TylerDavidBailey/vscode-repodock/commit/7429cd32b172cf6e870427c4e5e95bc31b3b29cb))
* make Pin Repository a no-op on a repo that is already pinned ([#37](https://github.com/TylerDavidBailey/vscode-repodock/issues/37)) ([32b0be8](https://github.com/TylerDavidBailey/vscode-repodock/commit/32b0be8c692f8b5aa0a65b156a7a5727ac0f6023))
* run git status without optional locks and pin ovsx ([#32](https://github.com/TylerDavidBailey/vscode-repodock/issues/32)) ([f08c47b](https://github.com/TylerDavidBailey/vscode-repodock/commit/f08c47b110c9e1476c6b02410a3290b9c5c97597))
* tell the user when Add to Workspace changes nothing ([#38](https://github.com/TylerDavidBailey/vscode-repodock/issues/38)) ([a1759a3](https://github.com/TylerDavidBailey/vscode-repodock/commit/a1759a3a64debb5ee5842c17afb3c090021dc554))
* write settings to the scope whose value is in effect ([#36](https://github.com/TylerDavidBailey/vscode-repodock/issues/36)) ([34ead6e](https://github.com/TylerDavidBailey/vscode-repodock/commit/34ead6e4063ea3c841d9e324fac6eb8f088c4b25))

## [1.1.2](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.1...v1.1.2) (2026-09-02)


### Bug Fixes

* correct path-case handling, settings refresh, and repo counts ([#28](https://github.com/TylerDavidBailey/vscode-repodock/issues/28)) ([c2e40a7](https://github.com/TylerDavidBailey/vscode-repodock/commit/c2e40a71240d7a9d344d7db316e3f4b5056e4f8e))

## [1.1.1](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.0...v1.1.1) (2026-07-27)


### Bug Fixes

* unpin no longer re-pins an unpinned repository ([#13](https://github.com/TylerDavidBailey/vscode-repodock/issues/13)) ([8cebb24](https://github.com/TylerDavidBailey/vscode-repodock/commit/8cebb24476243be09c6e5035b9a712e2e06341d3))

## [1.1.0](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.0.1...v1.1.0) (2026-07-23)


### Features

* rescan folders on window focus so new clones appear automatically ([#7](https://github.com/TylerDavidBailey/vscode-repodock/issues/7)) ([80d2d27](https://github.com/TylerDavidBailey/vscode-repodock/commit/80d2d278efd365198458de396d434ceebeb00fcc))

## [1.0.1](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.0.0...v1.0.1) (2026-07-18)


### Bug Fixes

* git status wipes, hidden-repo leaks, and Windows path-casing bugs ([#5](https://github.com/TylerDavidBailey/vscode-repodock/issues/5)) ([8f4b84b](https://github.com/TylerDavidBailey/vscode-repodock/commit/8f4b84b1fa7df7ffdfdd87a367ef15a8a8aeb527))

## 1.0.0 (2026-07-16)

Initial public release.
