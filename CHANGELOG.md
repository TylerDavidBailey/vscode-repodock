# Changelog

## [1.3.1](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.3.0...v1.3.1) (2026-11-27)


### Bug Fixes

* offer a window reload when an in-place update cannot save the layout yet ([#79](https://github.com/TylerDavidBailey/vscode-repodock/issues/79)) ([9fb5d0e](https://github.com/TylerDavidBailey/vscode-repodock/commit/9fb5d0e1f48b861aa3f881f12a462a64e46d64ad))

## [1.3.0](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.2.0...v1.3.0) (2026-11-26)


### Features

* list pinned repos first and show each repo as a mark and a name ([#77](https://github.com/TylerDavidBailey/vscode-repodock/issues/77)) ([8c07110](https://github.com/TylerDavidBailey/vscode-repodock/commit/8c07110e9927699fca6db6718765d82f9508f5f9))

## [1.2.0](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.5...v1.2.0) (2026-11-25)


### Features

* redesign the extension icon as a folder with a commit ([#72](https://github.com/TylerDavidBailey/vscode-repodock/issues/72)) ([d731830](https://github.com/TylerDavidBailey/vscode-repodock/commit/d7318300b3f6128202ad02d9145e7805b95e4226))
* show Pinned, Recent, and All Repositories as sections of one tree ([#75](https://github.com/TylerDavidBailey/vscode-repodock/issues/75)) ([fd5b9e7](https://github.com/TylerDavidBailey/vscode-repodock/commit/fd5b9e798bcc8da01d24fd3ec1de17f8bea9cd01))


### Bug Fixes

* read git status without running programs a repository's config names ([#76](https://github.com/TylerDavidBailey/vscode-repodock/issues/76)) ([4062107](https://github.com/TylerDavidBailey/vscode-repodock/commit/40621075f403ac260f0cd6d9f4eec2406f85d79a))

## [1.1.5](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.4...v1.1.5) (2026-11-24)


### Bug Fixes

* **deps:** patch npm audit advisories in dev dependencies ([#70](https://github.com/TylerDavidBailey/vscode-repodock/issues/70)) ([3a2a4bb](https://github.com/TylerDavidBailey/vscode-repodock/commit/3a2a4bbc134743ff2147e443dee1c2a734640ad3))
* do not record or keep a repository that is no longer on disk ([#66](https://github.com/TylerDavidBailey/vscode-repodock/issues/66)) ([38a8b95](https://github.com/TylerDavidBailey/vscode-repodock/commit/38a8b9549e1ec8aeceb689a2144f75585ab07103))
* fall back to defaults for malformed sort and boolean settings ([#65](https://github.com/TylerDavidBailey/vscode-repodock/issues/65)) ([5c766c2](https://github.com/TylerDavidBailey/vscode-repodock/commit/5c766c214cd32c0ff1edca95580c233459738b2b))
* tell same-named repositories in different folders apart ([#67](https://github.com/TylerDavidBailey/vscode-repodock/issues/67)) ([0a7fd8b](https://github.com/TylerDavidBailey/vscode-repodock/commit/0a7fd8b57b5bfe6145382189a20d5b7be162682e))
* write view settings to the workspace scope in Restricted Mode ([#64](https://github.com/TylerDavidBailey/vscode-repodock/issues/64)) ([140a5a1](https://github.com/TylerDavidBailey/vscode-repodock/commit/140a5a1fec371e45a2efae134cf415537d04f6e1))

## [1.1.4](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.3...v1.1.4) (2026-11-01)


### Bug Fixes

* **deps:** patch npm audit advisories in dev dependencies ([#59](https://github.com/TylerDavidBailey/vscode-repodock/issues/59)) ([6c93c68](https://github.com/TylerDavidBailey/vscode-repodock/commit/6c93c68a31d409fcde87ed2121b6ec96b06c20ad))

## [1.1.3](https://github.com/TylerDavidBailey/vscode-repodock/compare/v1.1.2...v1.1.3) (2026-10-06)


### Bug Fixes

* ignore blank and relative entries in directories and hiddenRepos ([#34](https://github.com/TylerDavidBailey/vscode-repodock/issues/34)) ([f29d9bd](https://github.com/TylerDavidBailey/vscode-repodock/commit/f29d9bdda5a5bf3511c3eb08129b042c8a2b3d95))
* keep a superseded refresh waiting for the scan that replaced it ([#33](https://github.com/TylerDavidBailey/vscode-repodock/issues/33)) ([7429cd3](https://github.com/TylerDavidBailey/vscode-repodock/commit/7429cd32b172cf6e870427c4e5e95bc31b3b29cb))
* make Pin Repository a no-op on a repo that is already pinned ([#37](https://github.com/TylerDavidBailey/vscode-repodock/issues/37)) ([32b0be8](https://github.com/TylerDavidBailey/vscode-repodock/commit/32b0be8c692f8b5aa0a65b156a7a5727ac0f6023))
* run git status without optional locks and pin ovsx ([#32](https://github.com/TylerDavidBailey/vscode-repodock/issues/32)) ([f08c47b](https://github.com/TylerDavidBailey/vscode-repodock/commit/f08c47b110c9e1476c6b02410a3290b9c5c97597))
* survive malformed settings, re-sort after open, and keep overlapping settings writes ([#46](https://github.com/TylerDavidBailey/vscode-repodock/issues/46)) ([c3f7245](https://github.com/TylerDavidBailey/vscode-repodock/commit/c3f7245e070c03117c43757fc2cb009dd1051e16))
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
