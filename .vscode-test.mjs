import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  // pinned rather than left to float, so the .vscode-test download cache in CI has a
  // stable key and a VS Code release cannot change what a rerun of an old commit tests
  version: 'stable',
  // a globally installed extension must not be able to influence a run
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'bdd',
    timeout: 60000,
  },
});
