// generate-thumbs.js
// Scans assets/ for images referenced in asset-manifest.json and generates thumbnails into assets/thumbs/
// Usage: node scripts/generate-thumbs.js

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const manifestPath = path.join(__dirname, '..', 'assets', 'asset-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('asset-manifest.json not found at', manifestPath);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const assetsDir = path.join(__dirname, '..', 'assets');
  const thumbsDir = path.join(assetsDir, 'thumbs');
  await ensureDir(thumbsDir);

  // gather candidate images from manifest textures and from assets folder (png/jpg/svg)
  const textures = (manifest.textures || []).filter((t) => !/^https?:\/\//i.test(t));
  const candidates = new Set();
  textures.forEach((t) => {
    const ext = t.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif', 'svg'].includes(ext)) {
      candidates.add(t);
    }
  });

  // also scan assets/ for common image names
  const files = fs.readdirSync(assetsDir);
  files.forEach((f) => {
    const ext = f.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext)) candidates.add(f);
  });

  console.log('Found', candidates.size, 'candidates for thumbnails');

  for (const fname of candidates) {
    const src = path.join(assetsDir, fname);
    const out = path.join(thumbsDir, fname.replace(/\.[^/.]+$/, '') + '.webp');
    if (!fs.existsSync(src)) {
      console.warn('source missing', src);
      continue;
    }
    if (fs.existsSync(out)) {
      console.log('thumb exists', out);
      continue;
    }
    try {
      // use sharp to generate 180x120 webp thumbnail with modest quality
      await sharp(src).resize(180, 120, { fit: 'cover' }).webp({ quality: 72 }).toFile(out);
      console.log('wrote', out);
    } catch (e) {
      console.warn('failed to thumb', src, e.message || e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
