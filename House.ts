import * as THREE from 'three';

import { Materials } from './Materials';

export class House {
  public mesh: THREE.Group;

  constructor(color: number = 0xffaa66) {
    this.mesh = new THREE.Group();
    this.createHouse(color);
  }

  private async createHouse(color: number): Promise<void> {
    // Skip GLTF loading for performance - use simple geometry
    const fallbackHouse = this.createSimpleHouse(color);
    this.mesh.add(fallbackHouse);
  }

  private createSimpleHouse(color: number): THREE.Group {
    const group = new THREE.Group();

    // Foundation plinth: extends below ground so slope gaps under the house
    // read as intentional stonework instead of a floating box edge.
    const foundationGeometry = new THREE.BoxGeometry(2.3, 1.0, 2.3);
    const foundationMaterial = Materials.createPBRMaterial({ color: 0x9a917f, roughness: 0.95 });
    const foundation = new THREE.Mesh(foundationGeometry, foundationMaterial);
    foundation.position.y = -0.45;
    foundation.receiveShadow = true;
    group.add(foundation);

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
