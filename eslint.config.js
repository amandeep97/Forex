// eslint.config.js
//
// This exists because of two bugs that reached the phone in two days.
//
// The first called a bar-fetching helper named `bars` that was never defined
// and never imported. It threw inside an async effect, the error escaped as an
// unhandled rejection, and the Desk's record rendered six verdicts with no
// scores and no sign anything was wrong. The second dropped an object into a
// template string, so a panel printed "[object Object]" on screen.
//
// Neither the build nor the fifty-nine tests could see either one. Vite bundles
// without resolving free variables, and the tests exercise pure functions —
// the wiring in a component is the part nothing was checking.
//
// So the rule set here is deliberately narrow. It is not a style guide and it
// does not care about quotes or semicolons; adding a hundred formatting
// warnings to a working codebase would just teach everyone to ignore the
// output. What it catches is the class of mistake that is invisible until
// runtime:
//
//   no-undef                  the `bars` bug, exactly
//   no-unused-vars            an import that was renamed and left behind
//   react-hooks/rules-of-hooks a hook called conditionally
//   no-cond-assign, etc.      the recommended set's genuine bug rules
//
// The "[object Object]" class needs types, not a linter, so it is honestly out
// of reach here. That one is still on tests and on reading the screen.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'vps-bot/node_modules/**', 'bot/**'],
  },

  // ── The app: browser, JSX, React hooks ────────────────────────────────────
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      // Dependency arrays are advisory here rather than an error. Several
      // effects in this app deliberately run on a subset of what they read,
      // and turning those into errors would mean rewriting working code to
      // satisfy a rule rather than to fix a bug.
      'react-hooks/exhaustive-deps': 'warn',
      // An unused CATCH binding is the house style for "the failure is the
      // answer" and is everywhere; an unused import is a real leftover.
      // WARN, not error, and deliberately. There are three hundred of these
      // across a working codebase — old imports, a renamed variable, a helper
      // kept for later. Not one of them can crash anything. Failing the build
      // on them would mean three hundred edits to unrelated files before a
      // single real finding could be enforced, and a rule nobody can satisfy is
      // a rule everybody switches off. Worth cleaning up; not worth blocking on.
      'no-unused-vars': ['warn', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
      'no-useless-escape': 'warn',
      // The bot's log lines and the studies print deliberately.
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── Shared modules: no DOM, no Node. That is the whole contract. ──────────
  {
    files: ['shared/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Deliberately NEITHER browser nor node globals. shared/ is imported by
      // the app AND loaded by the bot, so anything that only exists in one of
      // them is a bug there rather than a missing global here — a `localStorage`
      // in shared/ would break the VPS at runtime and this is what says so.
      globals: {},
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-useless-escape': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── The bot and the tests: Node ───────────────────────────────────────────
  {
    files: ['vps-bot/**/*.js', 'tests/**/*.{mjs,cjs,js}', '*.config.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-useless-escape': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['vps-bot/**/*.js', 'tests/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
