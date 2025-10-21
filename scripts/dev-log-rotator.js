const fs = require('fs');
const path = require('path');
const child = require('child_process');

const LOG = path.resolve(process.cwd(), 'dev.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const CHECK_MS = 2000;

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG)) return;
    const stats = fs.statSync(LOG);
    if (stats.size > MAX_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.resolve(process.cwd(), `dev-${ts}.log`);
      fs.renameSync(LOG, dest);
      console.log(`Rotated log to ${dest}`);
    }
  } catch (e) {
    console.error('rotate error', e);
  }
}

// start periodic rotation
setInterval(rotateIfNeeded, CHECK_MS);
rotateIfNeeded();

// spawn vite with DEBUG env; prefer cross-spawn if present
const env = Object.assign({}, process.env, { DEBUG: process.env.DEBUG || 'vite:*' });
let spawnFn = null;
try {
  // optional dependency: cross-spawn (if project adds it)
  spawnFn = require('cross-spawn');
} catch (e) {
  spawnFn = null;
}

const isWin = process.platform === 'win32';
const cmd = isWin ? 'npm' : 'npx';
const args = isWin ? ['run', 'dev'] : ['vite'];

function startVite() {
  try {
    let viteProc;
    if (spawnFn) {
      viteProc = spawnFn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } else {
      // fallback: use child_process.spawn with shell:true for better compatibility on Windows
      viteProc = child.spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    }

    const writeStream = fs.createWriteStream(LOG, { flags: 'a' });
    const pipeStream = (s) => { if (!s) return; s.on('data', (c) => writeStream.write(c)); };
    pipeStream(viteProc.stdout);
    pipeStream(viteProc.stderr);

    viteProc.on('error', (err) => {
      console.error('Failed to spawn vite process:', err);
      writeStream.end();
      process.exit(1);
    });

    viteProc.on('close', (code) => {
      console.log(`vite exited with ${code}`);
      writeStream.end();
      process.exit(code);
    });

    process.on('SIGINT', () => {
      try { viteProc.kill('SIGINT'); } catch (e) {}
      process.exit();
    });
  } catch (e) {
    console.error('startVite error', e);
    process.exit(1);
  }
}

startVite();
