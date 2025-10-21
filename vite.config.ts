import path from 'path';
import { defineConfig } from 'vite';

// Vite config: expose assetKits and assets directories via aliases and allow serving them
export default defineConfig({
  publicDir: 'public',
  build: {
    // Copy assets during build
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html')
      }
    },
    // Ensure assets are copied to output
    copyPublicDir: true
  },
  resolve: {
    alias: {
      // allow imports/requests like '/assetKits/...' to resolve to workspace folder
      '/assetKits': path.resolve(__dirname, 'assetKits'),
      '/assets': path.resolve(__dirname, 'assets'),
    },
  },
  server: {
    fs: {
      // allow serving files from these directories (useful for local assetKits)
      // include project root so index.html and other top-level files are accessible
      allow: [path.resolve(__dirname), path.resolve(__dirname, 'assetKits'), path.resolve(__dirname, 'assets')],
    },
  },
});
