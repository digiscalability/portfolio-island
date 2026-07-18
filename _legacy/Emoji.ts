import * as THREE from 'three';

import { Materials } from './Materials';
import { loadGLTFModel } from './src/utils/GLTFModelLoader';

export class Emoji {
  public mesh: THREE.Group;
  private baseY: number;

  constructor(type: string = '😊', position: THREE.Vector3) {
    this.baseY = position.y;
    // Start with placeholder, then replace with GLTF model
    this.mesh = this.createPlaceholder();
    this.mesh.position.copy(position);

    // Asynchronously load appropriate 3D model from assetKits
    this.loadModelForType(type);
  }

  private createPlaceholder(): THREE.Group {
    const group = new THREE.Group();
    // Simple placeholder geometry
    const geometry = new THREE.SphereGeometry(0.3, 8, 8);
    const material = Materials.createStandardMaterial({ color: 0x88cc88, roughness: 0.8 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    group.add(mesh);
    return group;
  }

  private async loadModelForType(type: string): Promise<void> {
    // Map emoji types to appropriate 3D models from Stylized Nature MegaKit
    const modelMap: Record<string, string[]> = {
      '😊': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Flower_3_Single.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Flower_4_Single.gltf',
      ],
      '🌟': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Pebble_Round_1.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Pebble_Round_3.gltf',
      ],
      '🎨': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Mushroom_Common.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Mushroom_Laetiporus.gltf',
      ],
      '🎵': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Plant_1.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Plant_7.gltf',
      ],
      '💡': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Pebble_Square_1.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Pebble_Square_3.gltf',
      ],
      '🚀': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Rock_Medium_2.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Rock_Medium_3.gltf',
      ],
      '🏆': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Flower_3_Group.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Flower_4_Group.gltf',
      ],
      '📚': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Bush_Common.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Bush_Common_Flowers.gltf',
      ],
      '☕': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Mushroom_Laetiporus.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Mushroom_Common.gltf',
      ],
      '🌈': [
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Fern_1.gltf',
        '/assetKits/Stylized Nature MegaKit[Standard]/glTF/Plant_7_Big.gltf',
      ],
    };

    const candidates = modelMap[type] || modelMap['😊'];
    try {
      let res: Awaited<ReturnType<typeof loadGLTFModel>> | null = null;
      // Try each candidate path
      for (const path of candidates) {
        try {
          res = await loadGLTFModel(path);
          if (res) break;
        } catch {
          // Try next candidate
        }
      }

      if (!res || !res.scene) {
        console.warn(`Emoji: Could not load model for type ${type}, keeping placeholder`);
        return;
      }

      const model = res.scene;

      // Scale the model appropriately
      const bbox = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const targetSize = 0.5; // Target size in world units
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 0.001) {
        const scale = targetSize / maxDim;
        model.scale.setScalar(scale);
      }

      // Fix materials
      model.traverse((obj: THREE.Object3D) => {
        if (!(obj instanceof THREE.Mesh) || !obj.material) {
          return;
        }
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((material) => Materials.fixMaterialTextures(material));
        obj.castShadow = true;
        obj.receiveShadow = true;
      });

      // Replace placeholder with loaded model
      const parent = this.mesh.parent;
      const pos = this.mesh.position.clone();
      const quat = this.mesh.quaternion.clone();

      if (parent) {
        parent.remove(this.mesh);
        parent.add(model);
      }

      model.position.copy(pos);
      model.quaternion.copy(quat);
      this.mesh = model;
    } catch (error) {
      console.warn(`Emoji: Failed to load 3D model for ${type}, using placeholder`, error);
    }
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  public update(time: number): void {
    // Floating animation
    this.mesh.position.y = this.baseY + Math.sin(time * 2) * 0.3;

    // Gentle rotation
    this.mesh.rotation.y += 0.01;
  }

  public setPosition(position: THREE.Vector3): void {
    this.mesh.position.copy(position);
    this.baseY = position.y;
  }

  public setRotation(quaternion: THREE.Quaternion): void {
    this.mesh.quaternion.copy(quaternion);
  }
}
