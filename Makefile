.DEFAULT_GOAL := help

.PHONY: help install build watch typecheck lint format test test-unit test-integration package install-local uninstall-local icon clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "%-18s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

build: ## Bundle the extension with esbuild
	npm run build

watch: ## Rebuild on change (pair with F5 for the Extension Development Host)
	npm run watch

typecheck: ## Type-check without emitting
	npm run typecheck

lint: ## eslint + prettier check
	npm run lint

format: ## Format everything with prettier
	npm run format

test-unit: ## Vitest unit tests for src/core
	npm run test:unit

test-integration: ## Integration tests in a real VS Code instance
	npm run test:integration

test: test-unit test-integration ## All tests

package: ## Produce a .vsix
	npm run package

install-local: package ## Package and install the .vsix into VS Code
	code --install-extension $$(ls -t repodock-*.vsix | head -1)

uninstall-local: ## Uninstall the extension from VS Code
	code --uninstall-extension tylerdavidbailey.repodock

icon: ## Regenerate media/icon.png
	npm run make-icon

clean: ## Remove build and test output
	rm -rf dist out .vscode-test *.vsix
