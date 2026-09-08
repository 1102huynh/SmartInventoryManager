// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Phase 25 (docs/phase-25-plan.md, issue #15): both promoted from `warn` to
      // `error`. `recommendedTypeChecked` ships them as `error`; Phase 16 §7 dialled
      // them down to `warn` because tightening was "a separate decision … [that] would
      // surface its own set of call sites to fix". Phase 25 measured that set — it is
      // empty (the tree already passes both, and the `void`-the-promise idiom is used
      // at every deliberate fire-and-forget site) — so the promotion costs no code
      // change and just stops a future violation landing as a passable warning.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // Test files routinely cross an untyped boundary on purpose — a mocked
    // repository (suppliers.service.spec.ts) or an HTTP response body read via
    // supertest (test/app.e2e-spec.ts) is `any` by nature, not a sign of a bug the
    // way the same pattern would be in application code. Relaxing the unsafe-* rules
    // only here keeps them meaningful everywhere else.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Phase 16 (docs/phase-16-plan.md Fork B): the fifth `unsafe-*` sibling, off
      // here for the same reason as the four above — `res.body.foo()` on a supertest
      // response is a call on `any` by the nature of the boundary, not a bug.
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
