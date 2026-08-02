import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface GLTFResult {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  loadedUrl: string;
}

export interface GLTFOptions {
  candidates?: string[];
  scale?: number;
  overrides?: {
    envMapIntensity?: number;
    roughnessScale?: number;
  };
}

/**
 * Load GLTF model with fallback URLs
 * Tries primary URL first, then candidates in order
 */
export async function loadGLTFWithFallbacks(
  primaryUrl: string,
  options: GLTFOptions = {},
): Promise<GLTFResult | null> {
  const urls = [primaryUrl, ...(options.candidates || [])];
  const loader = new GLTFLoader();

  for (const url of urls) {
    try {
      console.log(`🔄 Trying to load GLTF from: ${url}`);
      const gltf = await loader.loadAsync(url);

      // Apply scale if specified
      if (options.scale && options.scale !== 1) {
        gltf.scene.scale.setScalar(options.scale);
      }

      // Apply material overrides
      if (options.overrides) {
        gltf.scene.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material) {
            const material = child.material as THREE.MeshStandardMaterial;
            if (options.overrides!.envMapIntensity !== undefined) {
              material.envMapIntensity = options.overrides!.envMapIntensity;
            }
            if (options.overrides!.roughnessScale !== undefined) {
              material.roughness *= options.overrides!.roughnessScale;
            }
          }
        });
      }

      console.log(`✅ Successfully loaded GLTF from: ${url}`);
      return {
        scene: gltf.scene,
        animations: gltf.animations,
        loadedUrl: url,
      };
    } catch (error) {
      console.warn(`❌ Failed to load GLTF from ${url}:`, error);
      continue;
    }
  }

  console.error(`❌ All GLTF loading attempts failed for: ${primaryUrl}`);
  return null;
}

/**
 * Setup animation mixer for a GLTF model
 */
export function setupModelAnimation(
  scene: THREE.Group,
  animations: THREE.AnimationClip[],
  defaultAnimation: string = 'idle',
): THREE.AnimationMixer | null {
  if (animations.length === 0) {
    console.warn('⚠️ No animations found in GLTF model');
    return null;
  }

  const mixer = new THREE.AnimationMixer(scene);

  // Try to find the default animation
  let clip = animations.find((anim) =>
    anim.name.toLowerCase().includes(defaultAnimation.toLowerCase()),
  );

  // If not found, use the first animation
  if (!clip) {
    clip = animations[0];
    console.warn(`⚠️ Default animation "${defaultAnimation}" not found, using "${clip.name}"`);
  }

  if (clip) {
    const action = mixer.clipAction(clip);
    action.play();
    console.log(`🎬 Started animation: ${clip.name}`);
  }

  return mixer;
}
