// @ts-check

import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Flat config. Order matters: later entries override earlier ones.
export default defineConfig(
  // Global ignores
  {
    ignores: [
      'doc/**',
      'extra/lectic.vscode/out/**',
    ],
  },

  // TypeScript + base recommended rules
  ...tseslint.configs.recommended,

  // Global tweaks
  {
    rules: {
      // Allow intentional unused bindings by prefixing with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files: allow explicit any, common in test scaffolding
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-escape': 'off',
    },
  },

  // VS Code extension sources: relax any around VS Code API shims
  {
  files: ['extra/lectic.vscode/src/**/*.ts'],
  rules: {
  '@typescript-eslint/no-explicit-any': 'off',
  },
  },

  // ANSI/terminal control sequences parsing relies on control chars
  {
    files: ['src/tools/exec.ts'],
    rules: {
      'no-control-regex': 'off',
    },
  },

)
