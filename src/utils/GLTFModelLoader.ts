import * as THREE from 'three';

let _pendingLoads = 0;

export function getPendingGLTFLoads() {
  return _pendingLoads;
}

export async function loadGLTFModel(url: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  _pendingLoads++;
  try {
    const mod = await import('three/addons/loaders/GLTFLoader.js');
    const { GLTFLoader } = mod as any;
    const loader = new GLTFLoader();
    return await new Promise((resolve, reject) => {
      loader.load(url, (gltf: any) => {
        resolve({ scene: gltf.scene || gltf.scenes?.[0], animations: gltf.animations || [] });
      }, undefined, reject);
    });
  } finally {
    _pendingLoads = Math.max(0, _pendingLoads - 1);
  }
}
