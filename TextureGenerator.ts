import * as THREE from 'three';

// Small utility to procedurally generate simple PBR-style canvas textures at runtime.
// These are intended as placeholders until authored textures / GLTF models are provided.
export class TextureGenerator {
  // Create a simple tiled asphalt road albedo, normal and roughness textures
  public static createRoadTextures(tileWidth = 512, tileHeight = 64) {
    const albedoCanvas = document.createElement('canvas');
    albedoCanvas.width = tileWidth;
    albedoCanvas.height = tileHeight;
    const actx = albedoCanvas.getContext('2d')!;
    // base asphalt
    actx.fillStyle = '#3e3e3e';
    actx.fillRect(0, 0, tileWidth, tileHeight);
    // add darker patches and subtle streaks
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * tileWidth;
      const y = Math.random() * tileHeight;
      const w = 1 + Math.random() * 6;
      const h = 1 + Math.random() * 6;
      actx.fillStyle = `rgba(0,0,0,${(Math.random() * 0.18).toFixed(2)})`;
      actx.fillRect(x, y, w, h);
    }
    // center line subtle
    actx.fillStyle = '#dddddd';
    actx.fillRect(tileWidth / 2 - 3, tileHeight * 0.25, 6, tileHeight * 0.5);

    const albedo = new THREE.CanvasTexture(albedoCanvas);
    albedo.wrapS = THREE.RepeatWrapping;
    albedo.wrapT = THREE.RepeatWrapping;

    // roughness map: darker = smoother; we'll use grayscale noise
    const roughCanvas = document.createElement('canvas');
    roughCanvas.width = tileWidth;
    roughCanvas.height = tileHeight;
    const rctx = roughCanvas.getContext('2d')!;
    const rimg = rctx.createImageData(tileWidth, tileHeight);
    for (let i = 0; i < rimg.data.length; i += 4) {
      const v = 160 + Math.floor(Math.random() * 56);
      rimg.data[i] = v;
      rimg.data[i + 1] = v;
      rimg.data[i + 2] = v;
      rimg.data[i + 3] = 255;
    }
    rctx.putImageData(rimg, 0, 0);
    const roughness = new THREE.CanvasTexture(roughCanvas);
    roughness.wrapS = THREE.RepeatWrapping;
    roughness.wrapT = THREE.RepeatWrapping;

    // normal map derived from albedo by a small Sobel filter
    const normal = this.createNormalMapFromCanvas(albedoCanvas);

    return { albedo, normal, roughness };
  }

  // Create simple building facade textures (brick-ish) and matching normal/ao/roughness
  public static createBuildingTextures(w = 512, h = 512) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    // base plaster/paint
    ctx.fillStyle = '#d9c6b3';
    ctx.fillRect(0, 0, w, h);
    // add bricks/tiles rows
    ctx.fillStyle = '#bfa28f';
    const rowH = 28;
    for (let y = 0; y < h; y += rowH) {
      for (let x = 0; x < w; x += 48) {
        const jitter = Math.floor((Math.random() - 0.5) * 6);
        ctx.fillRect(x + jitter, y + 6, 44, rowH - 10);
        ctx.fillStyle = `rgba(0,0,0,${(Math.random() * 0.06).toFixed(2)})`;
        ctx.fillRect(x + jitter + 1, y + rowH - 6, 42, 2);
        ctx.fillStyle = '#bfa28f';
      }
    }

    const albedo = new THREE.CanvasTexture(c);
    albedo.wrapS = THREE.RepeatWrapping;
    albedo.wrapT = THREE.RepeatWrapping;

    const normal = this.createNormalMapFromCanvas(c);

    // AO as subtle darkening near edges
    const aoC = document.createElement('canvas'); aoC.width = w; aoC.height = h;
    const aoc = aoC.getContext('2d')!;
    aoc.fillStyle = 'rgba(0,0,0,0)'; aoc.fillRect(0,0,w,h);
    // vignette AO
    const grad = aoc.createRadialGradient(w/2,h/2,w*0.2,w/2,h/2,w*0.7);
    grad.addColorStop(0,'rgba(0,0,0,0)');
    grad.addColorStop(1,'rgba(0,0,0,0.18)');
    aoc.fillStyle = grad; aoc.fillRect(0,0,w,h);
    const ao = new THREE.CanvasTexture(aoC);
    ao.wrapS = THREE.RepeatWrapping; ao.wrapT = THREE.RepeatWrapping;

    const roughC = document.createElement('canvas'); roughC.width = w; roughC.height = h;
    const rctx = roughC.getContext('2d')!;
    rctx.fillStyle = '#b0b0b0'; rctx.fillRect(0,0,w,h);
    const rough = new THREE.CanvasTexture(roughC);
    rough.wrapS = THREE.RepeatWrapping; rough.wrapT = THREE.RepeatWrapping;

    return { albedo, normal, roughness: rough, ao };
  }

  // Create a normal map from a source canvas using a simple sobel-like operator.
  public static createNormalMapFromCanvas(source: HTMLCanvasElement): THREE.CanvasTexture {
    const w = source.width; const h = source.height;
    const sctx = source.getContext('2d')!;
    const src = sctx.getImageData(0, 0, w, h).data;

    const nCanvas = document.createElement('canvas');
    nCanvas.width = w; nCanvas.height = h;
    const nctx = nCanvas.getContext('2d')!;
    const nImage = nctx.createImageData(w, h);

    const lum = (idx: number) => {
      const r = src[idx]; const g = src[idx+1]; const b = src[idx+2];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const left = x > 0 ? lum(((y * w + (x - 1)) * 4)) : lum(idx);
        const right = x < w - 1 ? lum(((y * w + (x + 1)) * 4)) : lum(idx);
        const up = y > 0 ? lum((((y - 1) * w + x) * 4)) : lum(idx);
        const down = y < h - 1 ? lum((((y + 1) * w + x) * 4)) : lum(idx);

        const gx = (right - left) / 255;
        const gy = (down - up) / 255;
        const nz = 1.0;
        const nx = -gx; const ny = -gy;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const nnx = (nx / len) * 0.5 + 0.5;
        const nny = (ny / len) * 0.5 + 0.5;
        const nnz = (nz / len) * 0.5 + 0.5;
        nImage.data[idx] = Math.round(nnx * 255);
        nImage.data[idx + 1] = Math.round(nny * 255);
        nImage.data[idx + 2] = Math.round(nnz * 255);
        nImage.data[idx + 3] = 255;
      }
    }
    nctx.putImageData(nImage, 0, 0);
    const tex = new THREE.CanvasTexture(nCanvas);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }
}

export default TextureGenerator;
