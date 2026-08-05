import tseslint from 'typescript-eslint'

// Deliberately narrow. Prettier owns formatting and `tsc --strict` owns types, including
// unused locals and parameters. What neither can see is a promise nobody awaited — and in
// a package whose next layers are almost entirely awaited Playwright calls, a missed await
// does not throw. The step simply has not finished when the screenshot is taken, and a
// wrong image is written and installed without a word.
export default tseslint.config(
  { ignores: ['dist/**', 'scripts/**', 'tests/fixture/**'] },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
)
