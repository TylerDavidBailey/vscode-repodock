import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'out/', '.vscode-test/', 'coverage/', '*.vsix'] },
  eslint.configs.recommended,
  // type-aware rules: catches un-awaited promises, unsafe any usage, and more
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      // numbers interpolate deterministically; forbidding them is churn without safety
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // test doubles legitimately use empty stubs
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
);
