const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const OUT = path.join(ASSETS_DIR, 'asset-manifest.json');

function walk(dir) {
  const results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      const sub = walk(filePath).map((p) => path.relative(ASSETS_DIR, p).replace(/\\/g, '/'));
      results.push(...sub);
    } else {
      results.push(path.relative(ASSETS_DIR, filePath).replace(/\\/g, '/'));
    }
  });
  return results;
}

function categorize(files) {
  const textures = [];
  const audio = [];
  const models = [];
  files.forEach((f) => {
    const ext = path.extname(f).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.avif', '.svg'].includes(ext)) textures.push(f);
    else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) audio.push(f);
    else if (['.gltf', '.glb', '.fbx', '.obj'].includes(ext)) models.push(f);
  });
  return { textures, audio, models };
}

function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    console.error('Assets directory not found:', ASSETS_DIR);
    process.exit(1);
  }
  const files = walk(ASSETS_DIR);
  const manifest = categorize(files);
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Wrote manifest to', OUT);
}

main();
