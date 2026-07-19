import * as THREE from 'three';

import { Island } from './Island';

export interface ZoneData {
  id: string;
  name: string;
  description: string;
  position: THREE.Vector3;
  color: number;
  audioKey?: string;
  icon?: string;
}

export class Zone {
  public id: string;
  public name: string;
  public description: string;
  public position: THREE.Vector3;
  public audioKey?: string;
  public marker: THREE.Mesh;
  public label?: HTMLDivElement;

  constructor(data: ZoneData, island: Island) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.audioKey = data.audioKey;
    this.position = data.position.clone();

    // Create visual marker (portal/platform)
    this.marker = this.createMarker(data.color);

    // Align marker to island displaced surface properly
    try {
      const dir = this.position.clone().normalize();
      const sampled = island.sampleSurfaceByDirection(dir, 0.3); // clear of terrain bumps so ring+pillars never half-bury
      this.marker.position.copy(sampled.position);
      // orient marker up along sampled normal
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), sampled.normal);
      this.marker.quaternion.copy(q);
      // keep stored logical position as the sampled surface position (so proximity checks match visual)
      this.position.copy(sampled.position);
    } catch (_e) {
      this.marker.position.copy(this.position);
      this.marker.position.y = island.getRadius() + 0.5;
    }
  }

  private createMarker(color: number): THREE.Mesh {
    // Landmark plaza: glowing disc + emissive ring + pillar circle, so each
    // zone reads as a destination from across the planet.
    const geometry = new THREE.CylinderGeometry(1.6, 1.7, 0.18, 24);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.45,
      metalness: 0.2,
      roughness: 0.4,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Floating indicator orb (animated by update())
    const indicatorGeometry = new THREE.SphereGeometry(0.3, 16, 16);
    const indicatorMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.0,
    });
    const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    indicator.position.y = 2;
    mesh.add(indicator);

    // Emissive ground ring around the disc
    const ringGeom = new THREE.TorusGeometry(2.1, 0.07, 8, 32);
    const ringMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.9,
      roughness: 0.4,
    });
    const ring = new THREE.Mesh(ringGeom, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    mesh.add(ring);

    // Pillar circle with glowing caps
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.7 });
    const capMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.2,
    });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.8, 8), pillarMat);
      pillar.position.set(Math.cos(a) * 2.4, 0.9, Math.sin(a) * 2.4);
      pillar.castShadow = true;
      mesh.add(pillar);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 10), capMat);
      cap.position.set(Math.cos(a) * 2.4, 1.9, Math.sin(a) * 2.4);
      mesh.add(cap);
    }

    // Central light column
    const beamMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.25,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.3, 3.5, 8), beamMat);
    beam.position.y = 1.75;
    mesh.add(beam);

    return mesh;
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.marker);
  }

  public update(time: number): void {
    // Animate the floating indicator
    if (this.marker.children.length > 0) {
      const indicator = this.marker.children[0];
      indicator.position.y = 2 + Math.sin(time * 2) * 0.3;
    }

    // Rotate the marker slowly
    this.marker.rotateY(0.01);
  }

  public getPosition(): THREE.Vector3 {
    return this.position.clone();
  }

  public isNearby(playerPosition: THREE.Vector3, threshold: number = 3): boolean {
    return this.position.distanceTo(playerPosition) < threshold;
  }
}

