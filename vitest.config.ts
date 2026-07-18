import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // _legacy holds archived, unshipped code (including an old jest-style
    // test) — never part of the live suite.
    exclude: ['**/node_modules/**', '_legacy/**', 'dist/**'],
  },
});
