import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // The vscode stub records into a module-level singleton, which is only per-suite
    // because each file gets its own module registry. Turning isolation off as a speed
    // hack would silently make every suite share one stub.
    isolate: true,
    coverage: {
      provider: 'v8',
      // every source file, not just the ones a test happened to import
      include: ['src/**/*.ts'],
      // types only: no runtime code to cover
      exclude: ['src/core/types.ts'],
      // 'text' lists only the files short of 100%, which is the useful part locally
      reporter: ['text', 'text-summary', 'lcov'],
      // Set a few points below what the suite currently reaches, so an ordinary refactor
      // does not fail CI but a genuinely untested new branch does. Raise them when the
      // real numbers move up; never lower them to make a build pass.
      thresholds: {
        // pure logic, no vscode import, so it should stay near-fully covered
        'src/core/**': { statements: 97, branches: 92, functions: 98, lines: 98 },
        // wired to the VS Code API, where a few defensive paths stay out of reach
        'src/ext/**': { statements: 96, branches: 90, functions: 95, lines: 97 },
      },
    },
  },
});
