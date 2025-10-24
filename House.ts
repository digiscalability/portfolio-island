import * as THREE from 'three';

import { Materials } from './Materials';
import { loadGLTFWithFallbacks } from './utils/GLTFModelLoader';

export class House {
  public mesh: THREE.Group;

  constructor(color: number = 0xffaa66) {
    this.mesh = new THREE.Group();
    this.createHouse(color);
  }

  private async createHouse(color: number): Promise<void> {
    try {
      // Try to load a GLTF house/structure model first, with fallbacks
      const gltfResult = await loadGLTFWithFallbacks('/assets/models/house.gltf', {
        candidates: [
          '/assets/models/cabin.gltf',
          '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf',
          '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Cart_Empty.gltf',
          '/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/Workbench.gltf',
          '/public/assetKits/Fantasy Props MegaKit[Standard]/Exports/glTF/Stall_Empty.gltf',
        ],
        scale: 3.0, // Larger scale for structures to be visible
        overrides: {
          envMapIntensity: 0.7, // Nice lighting for houses
        },
      });

      if (gltfResult) {
        // Position the GLTF model properly
        gltfResult.scene.position.y = 0; // Place on ground
        this.mesh.add(gltfResult.scene);
        console.log('✅ House: Loaded GLTF model');
        return;
      }
    } catch (error) {
      console.warn('⚠️ House: Could not load GLTF model, using fallback geometry:', error);
    }

    // Fallback: Create simple house geometry if GLTF fails
    const fallbackHouse = this.createSimpleHouse(color);
    this.mesh.add(fallbackHouse);
  }

  private createSimpleHouse(color: number): THREE.Group {
    const group = new THREE.Group();

    // Main building (box)
    const buildingGeometry = new THREE.BoxGeometry(2, 2, 2);
    const buildingMaterial = Materials.createHouseMaterial(color);
    const building = new THREE.Mesh(buildingGeometry, buildingMaterial);
    building.position.y = 1;
    building.castShadow = true;
    building.receiveShadow = true;
    group.add(building);

    // Roof (pyramid)
    const roofGeometry = new THREE.ConeGeometry(1.6, 1, 4);
    const roofMaterial = Materials.createPBRMaterial({ color: 0x8b4513, roughness: 0.7 }); // Brown
    const roof = new THREE.Mesh(roofGeometry, roofMaterial);
    roof.position.y = 2.5;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    // Door (small box)
    const doorGeometry = new THREE.BoxGeometry(0.6, 1, 0.1);
    const doorMaterial = Materials.createStandardMaterial({
      color: 0x654321,
      metalness: 0.02,
      roughness: 0.7,
      envMapIntensity: 0.2,
    });
    const door = new THREE.Mesh(doorGeometry, doorMaterial);
    door.position.set(0, 0.5, 1.05);
    group.add(door);

    // Window (small box)
    const windowGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.1);
    const windowMaterial = Materials.createStandardMaterial({
      color: 0x87ceeb,
      metalness: 0,
      roughness: 0.2,
      envMapIntensity: 0.9,
    });
    const window1 = new THREE.Mesh(windowGeometry, windowMaterial);
    window1.position.set(-0.6, 1.5, 1.05);
    group.add(window1);

    const window2 = window1.clone();
    window2.position.set(0.6, 1.5, 1.05);
    group.add(window2);

    // small trim around door for readability
    const trimGeom = new THREE.BoxGeometry(0.75, 1.1, 0.05);
    const trimMat = Materials.createStandardMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.6,
    });
    const trim = new THREE.Mesh(trimGeom, trimMat);
    trim.position.set(0, 0.55, 1.08);
    group.add(trim);

    return group;
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  public setPosition(position: THREE.Vector3): void {
    this.mesh.position.copy(position);
  }

  public setRotation(quaternion: THREE.Quaternion): void {
    this.mesh.quaternion.copy(quaternion);
  }
}
