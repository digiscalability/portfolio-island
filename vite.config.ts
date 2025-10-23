import path from 'path';
import { defineConfig } from 'vite';

// Vite config: expose assetKits and assets directories via aliases and allow serving them
export default defineConfig({
  publicDir: 'public',
  build: {
    // Copy assets during build
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
    // Ensure assets are copied to output
    copyPublicDir: true,
    // Optimize build performance
    sourcemap: false, // Disable in production for smaller builds
    minify: 'esbuild', // Faster than terser
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
  },
  // Development optimizations
  optimizeDeps: {
    include: ['three'], // Pre-bundle dependencies for faster dev server
    exclude: ['@vite/client', '@vite/env'],
  },
  resolve: {
    alias: {
      // Path aliases matching tsconfig.json
      '@': path.resolve(__dirname),
      '@core': path.resolve(__dirname),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@assets': path.resolve(__dirname, 'assets'),
      '@assetKits': path.resolve(__dirname, 'assetKits'),
      // Legacy aliases for backwards compatibility
      '/assetKits': path.resolve(__dirname, 'assetKits'),
      '/assets': path.resolve(__dirname, 'assets'),
    },
  },
  server: {
    hmr: {
      overlay: true, // Show HMR errors as overlay
    },
    watch: {
      // Improve file watching performance
      usePolling: false,
      interval: 100,
    },
    fs: {
      // allow serving files from these directories (useful for local assetKits)
      // include project root so index.html and other top-level files are accessible
      allow: [
        path.resolve(__dirname),
        path.resolve(__dirname, 'assetKits'),
        path.resolve(__dirname, 'assets'),
      ],
    },
  },
});
