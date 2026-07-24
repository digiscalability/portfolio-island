import path from 'path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Dev multiplayer relay: a WebSocket echo hub on the SAME port as Vite
 * (path /mp), so it works on localhost and across the LAN (phones) with
 * zero extra processes. Every message a client sends is forwarded to all
 * other clients — the game protocol lives entirely client-side
 * (Multiplayer.ts). Production can swap in Firebase RTDB via the same
 * transport seam.
 */
function multiplayerRelay(): Plugin {
  return {
    name: 'multiplayer-relay',
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(data.toString());
            }
          }
        });
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url === '/mp') {
          wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        }
      });
    },
  };
}

// Vite config: expose assetKits and assets directories via aliases and allow serving them
export default defineConfig({
  plugins: [multiplayerRelay()],
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
      // Reduce chokidar pressure by ignoring heavy, static assets and build output
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/assetKits/**',
        '**/assets/**/*.gltf',
        '**/assets/**/*.glb',
        '**/assets/**/*.bin',
        '**/assets/**/*.fbx',
      ],
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
