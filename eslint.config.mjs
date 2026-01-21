// @ts-check

import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TYPECHECKED_FILES = ['src/**/*.ts', 'src/**/*.d.ts']

// Flat config. Order matters: later entries override earlier ones.
export default defineConfig(
  // Global ignores
  {
    ignores: [
      'doc/**',
      '.worktrees/**',
      'extra/lectic-run.js', // eslint has a hard time understanding #!/usr/bin/env -S lectic script
      'extra/lectic.vscode/out/**',
    ],
  },

  // Base JS recommendations (applies to JS/MJS/CJS etc).
  js.configs.recommended,

  // TypeScript: base recommended rules (non-type-aware).
  ...tseslint.configs.recommended,

  // TypeScript: enable type-aware linting for the main src tree.
  //
  // Note: we are *not* enabling typescript-eslint's full
  // recommendedTypeChecked preset, because it turns on a lot of strict
  // rules (no-unsafe-*, restrict-template-expressions, require-await, ...)
  // that this repo currently doesn't satisfy.
  {
    files: TYPECHECKED_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },

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

      // Prefer `import { type Foo } from '...'` for type-only imports.
      //
      // With TS's `verbatimModuleSyntax`, this avoids accidental runtime
      // imports and helps keep tree-shaking predictable.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],

      // Prefer strict equality except for "nullish" checks.
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
    },
  },

  // Type-aware rules (only valid when type information is available)
  {
    files: TYPECHECKED_FILES,
    rules: {
      // Catch unnecessary casts like `x as T` when x is already T.
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',

      // A few high-value type-aware rules from recommendedTypeChecked.
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreIIFE: true,
          ignoreVoid: true,
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: true,
            attributes: false,
          },
        },
      ],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
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
