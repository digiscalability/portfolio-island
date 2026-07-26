import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // _legacy/ now holds only git-ignored source assets kept locally; its dead
    // code was removed. Exclude kept so the folder is never scanned for tests.
    exclude: ['**/node_modules/**', '_legacy/**', 'dist/**'],
  },
});
