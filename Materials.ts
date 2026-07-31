import * as THREE from 'three';

type TextureWithEncoding = THREE.Texture & { colorSpace?: THREE.ColorSpace; encoding?: number };

type MaterialWithOptionalMaps = THREE.Material & {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
  bumpMap?: THREE.Texture;
  displacementMap?: THREE.Texture;
  alphaMap?: THREE.Texture;
  envMap?: THREE.Texture;
  normalScale?: THREE.Vector2;
};

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
  public static createPBRMaterial(
    options: {
      color?: number;
      map?: THREE.Texture;
      normalMap?: THREE.Texture;
      roughnessMap?: THREE.Texture;
      metalnessMap?: THREE.Texture;
      aoMap?: THREE.Texture;
      metalness?: number;
      roughness?: number;
      envMapIntensity?: number;
    } = {},
  ): THREE.MeshStandardMaterial {
    const params: THREE.MeshStandardMaterialParameters = {
      color: options.color ?? 0xffffff,
      metalness: typeof options.metalness === 'number' ? options.metalness : 0.0,
      roughness: typeof options.roughness === 'number' ? options.roughness : 0.55,
    };

    if (options.map) params.map = options.map;
    if (options.normalMap) params.normalMap = options.normalMap;
    if (options.roughnessMap) params.roughnessMap = options.roughnessMap;
    if (options.metalnessMap) params.metalnessMap = options.metalnessMap;
    if (options.aoMap) params.aoMap = options.aoMap;

    const material = new THREE.MeshStandardMaterial(params);
    material.envMapIntensity =
      typeof options.envMapIntensity === 'number' ? options.envMapIntensity : 1.0;
    return material;
  }

  public static createGradientMap(): THREE.DataTexture {
    // Create a slightly larger RGBA gradient texture (12 steps) to reduce banding artifacts
    // NEUTRAL ramp. MeshToonMaterial treats this as irradiance, so any tint
    // here multiplies into EVERY toonified prop's shading — the old
    // green-pastel ramp shifted red cottages and blue mailboxes toward olive
    // in their shadow bands. Grayscale (luminance-matched to the old ramp,
    // slightly cool dark end for the pastel feel) keeps hue on the material
    // colour where it belongs.
    const colors = [
      [40, 44, 52],
      [70, 74, 81],
      [101, 104, 110],
      [124, 126, 130],
      [149, 149, 151],
      [173, 173, 173],
      [189, 189, 189],
      [205, 205, 205],
      [218, 218, 218],
      [232, 232, 232],
      [243, 243, 243],
      [251, 251, 251],
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
    (gradientMap as TextureWithEncoding).colorSpace = THREE.SRGBColorSpace;
    gradientMap.needsUpdate = true;
    return gradientMap;
  }

  // Simple PBR-style standard material helper for objects where reflections matter
  public static createStandardMaterial(
    options: {
      color?: number;
      metalness?: number;
      roughness?: number;
      envMapIntensity?: number;
    } = {},
  ): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: options.color,
      metalness: typeof options.metalness === 'number' ? options.metalness : 0.06,
      roughness: typeof options.roughness === 'number' ? options.roughness : 0.6,
      envMapIntensity: typeof options.envMapIntensity === 'number' ? options.envMapIntensity : 0.9,
    });
  }

  // Small trim material used to break up hard edges (slightly glossy)
  public static createTrimMaterial(color: number): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color,
      metalness: 0.12,
      roughness: 0.35,
      envMapIntensity: 1.0,
    });
  }

  // Mailbox material with a bit more specular response so it reads at small sizes
  public static createMailboxStandard(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: 0x3a7bd5,
      metalness: 0.18,
      roughness: 0.36,
      envMapIntensity: 1.0,
    });
  }

  public static createPlanetMaterial(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color: 0x7fb37f, roughness: 0.9, metalness: 0.0 });
  }

  public static createCharacterBodyMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: 0xff6b6b,
      roughness: 0.55,
      metalness: 0.0,
      envMapIntensity: 0.8,
    });
  }

  public static createCharacterHeadMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: 0xffddaa,
      roughness: 0.78,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });
  }

  public static createHouseMaterial(color: number): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color,
      roughness: 0.65,
      metalness: 0.02,
      envMapIntensity: 0.8,
    });
  }

  public static createMailboxMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: 0x4488ff,
      roughness: 0.4,
      metalness: 0.18,
      envMapIntensity: 1.0,
    });
  }

  public static createTreeMaterial(): THREE.MeshStandardMaterial {
    return this.createPBRMaterial({
      color: 0x2f8b2f,
      roughness: 0.7,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });
  }

  public static createEmojiMaterial(textureUrl?: string): THREE.MeshStandardMaterial {
    const mat = this.createPBRMaterial({
      color: 0xffff00,
      roughness: 0.5,
      metalness: 0.0,
      envMapIntensity: 0.6,
    });
    if (textureUrl) {
      const textureLoader = new THREE.TextureLoader();
      mat.map = textureLoader.load(textureUrl);
      mat.transparent = true;
    }
    return mat;
  }

  // Ensure textures and material properties use correct encodings and flags after GLTF load or cloning.
  public static fixMaterialTextures(
    materialInput: THREE.Material | THREE.Material[] | null | undefined,
  ): void {
    if (!materialInput) {
      return;
    }

    const materials = Array.isArray(materialInput) ? materialInput : [materialInput];
    const linearColorSpace = THREE.LinearSRGBColorSpace;

    materials.forEach((material) => {
      if (!(material instanceof THREE.Material)) {
        return;
      }

      const mat = material as MaterialWithOptionalMaps;

      Materials.setTextureColorSpace(mat.map, THREE.SRGBColorSpace);
      Materials.setTextureColorSpace(mat.aoMap, linearColorSpace);
      Materials.setTextureColorSpace(mat.roughnessMap, linearColorSpace);
      Materials.setTextureColorSpace(mat.metalnessMap, linearColorSpace);
      Materials.setTextureColorSpace(mat.normalMap, linearColorSpace);

      if (mat.normalMap && !mat.normalScale) {
        mat.normalScale = new THREE.Vector2(1, 1);
      }

      if (typeof mat.opacity === 'number' && mat.opacity <= 0) {
        mat.opacity = 1;
        mat.transparent = false;
      }

      mat.needsUpdate = true;
    });
  }

  private static setTextureColorSpace(
    texture: THREE.Texture | undefined,
    targetColorSpace: THREE.ColorSpace,
  ): void {
    if (!texture) {
      return;
    }

    if ('colorSpace' in texture) {
      (texture as TextureWithEncoding).colorSpace = targetColorSpace;
    } else {
      // Fallback for older Three.js versions or custom textures without colorSpace property
      // For r152+, this branch should ideally not be hit for standard textures
      // (texture as TextureWithEncoding).encoding = encodingFallback;
    }
  }
}

