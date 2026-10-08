// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Browser extension: plain scripts sharing globalThis.HS (apps/extension/common.js).
    files: ['apps/extension/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        HS: 'readonly',
        chrome: 'readonly',
        browser: 'readonly',
        importScripts: 'readonly',
        document: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
);
