import * as THREE from 'three';

export class Materials {
  public static createToonMaterial(color: number): THREE.MeshToonMaterial {
    const gradientMap = this.createGradientMap();
      return new THREE.MeshToonMaterial({
        color,
        gradientMap,
        // keep emissive very low to avoid driving bloom; highlights rely on envMap/specular
        emissive: 0x000000,
        emissiveIntensity: 0.02,
      });
    }

    // Create a PBR-style material that accepts optional texture maps for albedo/normal/roughness/metalness
    public static createPBRMaterial(options: {
      color?: number;
      map?: THREE.Texture;
      normalMap?: THREE.Texture;
      roughnessMap?: THREE.Texture;
      metalnessMap?: THREE.Texture;
      aoMap?: THREE.Texture;
      metalness?: number;
      roughness?: number;
      envMapIntensity?: number;
    } = {}): THREE.MeshStandardMaterial {
      const params: any = {
        color: options.color || 0xffffff,
        metalness: typeof options.metalness === 'number' ? options.metalness : 0.0,
        roughness: typeof options.roughness === 'number' ? options.roughness : 0.55,
      };
      if (options.map) params.map = options.map;
      if (options.normalMap) params.normalMap = options.normalMap;
      if (options.roughnessMap) params.roughnessMap = options.roughnessMap;
      if (options.metalnessMap) params.metalnessMap = options.metalnessMap;
      if (options.aoMap) params.aoMap = options.aoMap;
      const mat = new THREE.MeshStandardMaterial(params);
      try { (mat as any).envMapIntensity = typeof options.envMapIntensity === 'number' ? options.envMapIntensity : 1.0; } catch (e) {}
      return mat;
    }

  public static createGradientMap(): THREE.DataTexture {
    // Create a slightly larger RGBA gradient texture (12 steps) to reduce banding artifacts
    // Palette tuned to soft pastels for friendly visuals
    const colors = [
      [24, 50, 40], [44, 84, 64], [68, 116, 88], [84, 140, 108], [108, 164, 128], [132, 188, 146],
      [156, 202, 162], [178, 216, 182], [198, 226, 196], [214, 240, 210], [232, 248, 226], [240, 255, 240]
    ];
    const width = colors.length;
    const data = new Uint8Array(width * 4);
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      data[i * 4 + 0] = c[0];
      data[i * 4 + 1] = c[1];
      data[i * 4 + 2] = c[2];
      data[i * 4 + 3] = 255;
    }
    const gradientMap = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
    gradientMap.minFilter = THREE.NearestFilter;
    gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.generateMipmaps = false;
    // Set color space for Three.js r152+
    try {
      if ('colorSpace' in gradientMap) {
        (gradientMap as any).colorSpace = THREE.SRGBColorSpace;
      } else {
        (gradientMap as any).encoding = 3001; // THREE.sRGBEncoding fallback
      }
    } catch (e) { /* ignore */ }
    gradientMap.needsUpdate = true;
    return gradientMap;
  }

  // Simple PBR-style standard material helper for objects where reflections matter
  public static createStandardMaterial(options: { color?: number; metalness?: number; roughness?: number; envMapIntensity?: number } = {}): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: options.color, metalness: typeof options.metalness === 'number' ? options.metalness : 0.06, roughness: typeof options.roughness === 'number' ? options.roughness : 0.6, envMapIntensity: typeof options.envMapIntensity === 'number' ? options.envMapIntensity : 0.9 });
  }

  // Small trim material used to break up hard edges (slightly glossy)
  public static createTrimMaterial(color: number): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color, metalness: 0.12, roughness: 0.35, envMapIntensity: 1.0 });
  }

  // Mailbox material with a bit more specular response so it reads at small sizes
  public static createMailboxStandard(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: 0x3a7bd5, metalness: 0.18, roughness: 0.36, envMapIntensity: 1.0 });
  }

  public static createPlanetMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: 0x7fb37f, roughness: 0.9, metalness: 0.0 });
  }

  public static createCharacterBodyMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: 0xff6b6b, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.8 });
  }

  public static createCharacterHeadMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: 0xffddaa, roughness: 0.78, metalness: 0.0, envMapIntensity: 0.5 });
  }

  public static createHouseMaterial(color: number): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color, roughness: 0.65, metalness: 0.02, envMapIntensity: 0.8 });
  }

  public static createMailboxMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: 0x4488ff, roughness: 0.4, metalness: 0.18, envMapIntensity: 1.0 });
  }

  public static createTreeMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({ color: 0x2f8b2f, roughness: 0.7, metalness: 0.0, envMapIntensity: 0.5 });
  }

  public static createEmojiMaterial(textureUrl?: string): THREE.MeshStandardMaterial {
    const mat = this.createPBRMaterial({ color: 0xffff00, roughness: 0.5, metalness: 0.0, envMapIntensity: 0.6 });
    if (textureUrl) {
      const textureLoader = new THREE.TextureLoader();
      mat.map = textureLoader.load(textureUrl);
      mat.transparent = true;
    }
    return mat;
  }

  // Ensure textures and material properties use correct encodings and flags after GLTF load or cloning.
  public static fixMaterialTextures(m: any): void {
    try {
      if (!m) return;
      // Modern Three.js uses colorSpace instead of encoding
      const sRGB = THREE.SRGBColorSpace;
      const linear = 'LinearSRGBColorSpace' in THREE ? (THREE as any).LinearSRGBColorSpace : 3000; // fallback
      // If an array of materials
      const mats = Array.isArray(m) ? m : [m];
      mats.forEach((mat: any) => {
        if (!mat) return;
        try {
          // Base color / albedo maps should be sRGB
          if (mat.map) {
            try {
              if ('colorSpace' in mat.map) {
                (mat.map as any).colorSpace = sRGB;
              } else {
                (mat.map as any).encoding = 3001; // sRGBEncoding
              }
            } catch (e) { /* ignore */ }
          }
          // AO/Roughness/Metalness/ORM should be linear
          if (mat.aoMap) {
            try {
              if ('colorSpace' in mat.aoMap) {
                (mat.aoMap as any).colorSpace = linear;
              } else {
                (mat.aoMap as any).encoding = 3000; // LinearEncoding
              }
            } catch (e) { /* ignore */ }
          }
          if (mat.roughnessMap) {
            try {
              if ('colorSpace' in mat.roughnessMap) {
                (mat.roughnessMap as any).colorSpace = linear;
              } else {
                (mat.roughnessMap as any).encoding = 3000;
              }
            } catch (e) { /* ignore */ }
          }
          if (mat.metalnessMap) {
            try {
              if ('colorSpace' in mat.metalnessMap) {
                (mat.metalnessMap as any).colorSpace = linear;
              } else {
                (mat.metalnessMap as any).encoding = 3000;
              }
            } catch (e) { /* ignore */ }
          }
          if (mat.normalMap) {
            try {
              if ('colorSpace' in mat.normalMap) {
                (mat.normalMap as any).colorSpace = linear;
              } else {
                (mat.normalMap as any).encoding = 3000;
              }
              if (!mat.normalScale) mat.normalScale = new THREE.Vector2(1,1);
            } catch (e) { /* ignore */ }
          }
          // If opacity was inadvertently zero, restore to fully opaque
          if ('opacity' in mat && typeof mat.opacity === 'number' && mat.opacity <= 0) { try { mat.opacity = 1; mat.transparent = false; } catch (e) {} }
          try { mat.needsUpdate = true; } catch (e) {}
        } catch (e) {}
      });
    } catch (e) {}
  }
}

