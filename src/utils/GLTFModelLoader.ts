import * as THREE from 'three';
import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type GLTFLoaderConstructor = new () => GLTFLoader;

let _pendingLoads = 0;

export function getPendingGLTFLoads() {
  return _pendingLoads;
}

export async function loadGLTFModel(url: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  _pendingLoads++;
  try {
    const loaderModule = await import('three/addons/loaders/GLTFLoader.js');
    const { GLTFLoader: GLTFLoaderClass } = loaderModule as { GLTFLoader: GLTFLoaderConstructor };
    const loader = new GLTFLoaderClass();
    return await new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf: GLTF) => {
          const scene = (gltf.scene ?? gltf.scenes?.[0]) ?? new THREE.Group();
          resolve({ scene, animations: gltf.animations ?? [] });
        },
        undefined,
        reject
      );
    });
  } finally {
    _pendingLoads = Math.max(0, _pendingLoads - 1);
  }
}
