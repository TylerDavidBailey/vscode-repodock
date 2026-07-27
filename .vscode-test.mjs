import { defineConfig } from '@vscode/test-cli';

/**
 * The minimum VS Code this extension supports, matching `engines.vscode` in package.json.
 * A real version rather than 'stable': 'stable' is a floating channel that test-electron
 * re-resolves against the update API on every run, which would both make the CI download
 * cache useless and silently change what an old commit is tested against.
 */
const VSCODE_VERSION = '1.96.0';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: VSCODE_VERSION,
  // a globally installed extension must not be able to influence a run
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
