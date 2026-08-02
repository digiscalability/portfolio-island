// Simple placeholder generator that writes a few SVGs and a tiny JSON glTF placeholder (cube)
// Run with: node ./scripts/gen-placeholders.js

const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'assets', 'placeholders');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function writeSVG(name, color, w = 512, h = 512) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n  <rect width="100%" height="100%" fill="${color}"/>\n  <text x="50%" y="50%" font-size="48" fill="#fff" text-anchor="middle" dominant-baseline="middle">${name}</text>\n</svg>`;
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
}

function writeGltfCube(name) {
  // Minimal glTF JSON referencing a tiny binary buffer with a single cube (we'll inline simple positions)
  // For simplicity we create a JSON glTF with accessor data embedded as base64 image (not recommended for production but fine for placeholders)
  const positions = new Float32Array([
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4, 0, 4, 7, 7, 3, 0, 1, 5, 6, 6, 2, 1, 3, 2, 6, 6, 7, 3, 0, 1,
    5, 5, 4, 0,
  ]);

  // Create binary buffer: positions followed by indices
  const posBytes = Buffer.from(positions.buffer);
  const idxBytes = Buffer.from(indices.buffer);
  const totalLen = posBytes.length + idxBytes.length;
  const bin = Buffer.concat([posBytes, idxBytes], totalLen);
  const binPath = path.join(outDir, `${name}.bin`);
  fs.writeFileSync(binPath, bin);

  // Build glTF JSON
  const gltf = {
    asset: { version: '2.0', generator: 'gen-placeholders.js' },
    buffers: [{ uri: `${name}.bin`, byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: posBytes.length, byteLength: idxBytes.length, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };

  fs.writeFileSync(path.join(outDir, `${name}.gltf`), JSON.stringify(gltf, null, 2));
}

// Generate a few SVG placeholders
writeSVG('placeholder-building', '#7db6ff');
writeSVG('placeholder-road', '#555555');
writeSVG('placeholder-tree', '#4caf50');

// Generate a cube glTF placeholder
writeGltfCube('placeholder-cube');

console.log('Placeholders generated at', outDir);
