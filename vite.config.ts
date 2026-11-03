import { randomBytes } from 'crypto';
import fs from 'fs';
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

/**
 * Stamp a per-build id and this build's hashed file list into dist/sw.js.
 *
 * public/sw.js is copied into dist verbatim, so its bytes never changed between
 * deploys: the browser kept the first worker it installed and never ran
 * install/activate again, and the cache flush in activate never ran after the
 * first visit. A fresh BUILD_ID makes every build's worker byte-different (two
 * builds of the same commit still differ), and BUILD_ASSETS tells activate
 * which cached files belong to this build. Build-only; `vite dev` serves the
 * unstamped placeholders and never registers the worker.
 */
function serviceWorkerStamp(): Plugin {
  return {
    name: 'sw-build-stamp',
    apply: 'build',
    writeBundle(options, bundle) {
      // Runs after the bundle is written; the public dir (sw.js) was copied in
      // at renderStart.
      const file = path.join(options.dir ?? path.resolve(__dirname, 'dist'), 'sw.js');
      if (!fs.existsSync(file)) this.error(`sw-build-stamp: ${file} is missing`);
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      const buildId = `${stamp}-${randomBytes(4).toString('hex')}`;
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/'))
        .sort()
        .map((f) => `/${f}`);
      const idRe = /const BUILD_ID = '[^']*';/;
      const assetsRe = /const BUILD_ASSETS = \[[^\]]*\];/;
      const src = fs.readFileSync(file, 'utf8');
      if (!idRe.test(src) || !assetsRe.test(src)) {
        this.error('sw-build-stamp: BUILD_ID / BUILD_ASSETS placeholders not found in sw.js');
      }
      fs.writeFileSync(
        file,
        src
          .replace(idRe, () => `const BUILD_ID = '${buildId}';`)
          .replace(assetsRe, () => `const BUILD_ASSETS = ${JSON.stringify(assets)};`),
      );
    },
  };
}

// Vite config: expose assetKits and assets directories via aliases and allow serving them
export default defineConfig({
  plugins: [multiplayerRelay(), serviceWorkerStamp()],
  publicDir: 'public',
  build: {
    // Copy assets during build
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      output: {
        // Split heavy vendors into their own long-lived chunks: three (the
        // bulk of the bundle) and firebase parse/cache independently of app
        // code, so an app-only change doesn't re-ship megabytes and the
        // browser can cache the engine across deploys.
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules')) {
            if (id.includes('/three/') || id.includes('\\three\\')) {
              // Bloom/postprocessing is dynamically imported (SimpleRenderer)
              // and default-on but not needed until after world build, so give
              // it its own chunk that fetches in parallel instead of bloating
              // the eager `three` chunk that blocks first paint.
              if (id.includes('postprocessing')) return 'postprocessing';
              return 'three';
            }
            if (id.includes('firebase') || id.includes('@firebase')) return 'firebase';
          }
          return undefined;
        },
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
  // Drop dev-only console noise from the PRODUCTION bundle. `pure` marks these
  // calls as side-effect-free so the minifier removes them during `vite build`,
  // but leaves them intact in `vite dev` (esbuild only applies pure-elision when
  // minifying). console.warn / console.error are deliberately kept — the boot
  // watchdog and error telemetry in index.html rely on them.
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info', 'console.trace'],
    drop: ['debugger'],
  },
  // Development optimizations
  optimizeDeps: {
    include: ['three'], // Pre-bundle dependencies for faster dev server
    exclude: ['@vite/client', '@vite/env'],
  },
  resolve: {
    alias: {
      // Legacy aliases for backwards compatibility
      '/assetKits': path.resolve(__dirname, 'assetKits'),
      '/assets': path.resolve(__dirname, 'assets'),
    },
  },
  server: {
    // Pin the dev port and refuse to wander. Without strictPort, Vite silently
    // climbs to the next free port when 5173 is busy (e.g. a leaked server still
    // holding it), so each launch lands somewhere new and the preview tool — which
    // watches 5173 per .claude/launch.json — ends up pointing at the wrong port.
    // strictPort makes a busy port a hard error instead, surfacing the stale
    // server immediately rather than hiding it behind a fresh port number.
    port: 5173,
    strictPort: true,
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
