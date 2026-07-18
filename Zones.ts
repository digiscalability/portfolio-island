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
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.4, 0.22), pillarMat);
      pillar.position.set(Math.cos(a) * 2.6, 0.7, Math.sin(a) * 2.6);
      pillar.castShadow = true;
      mesh.add(pillar);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), capMat);
      cap.position.set(Math.cos(a) * 2.6, 1.5, Math.sin(a) * 2.6);
      mesh.add(cap);
    }

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

export class ZonesManager {
  public zones: Zone[] = [];
  private island: Island;

  constructor(island: Island) {
    this.island = island;
    this.createZones();
  }

  private createZones(): void {
    const zoneDefinitions: Omit<ZoneData, 'position'>[] = [
      {
        id: 'business-hub',
        name: 'Syed\'s Studio',
        description: 'A showcase of professional projects, apps, and consultancy work by Syed Abbas Ali.',
        color: 0x2b6cb0,
        audioKey: 'ambient-business'
      },
      {
        id: 'hobby-cove',
        name: 'Hobby Cove',
        description: 'Music, art, and creative experiments. See demos, sketches, and favorite playlists.',
        color: 0xff6b9d,
        audioKey: 'ambient-hobby'
      },
      {
        id: 'achievement-hall',
        name: 'Achievement Hall',
        description: 'Milestones, awards, and selected highlights from a career in engineering and design.',
        color: 0xffd700,
        audioKey: 'ambient-hall'
      },
      {
        id: 'memory-garden',
        name: 'Memory Garden',
        description: 'Personal stories, photos, and reflections — a calm place to read about Syed\'s journey.',
        color: 0x88dd88,
        audioKey: 'ambient-garden'
      },
      {
        id: 'contact-dock',
        name: 'Contact Dock',
        description: 'Get in touch with Syed — chat, leave feedback, or schedule an appointment.',
        color: 0xff8844,
        audioKey: 'ambient-dock'
      },
    ];

    // Distribute zones evenly around the island
    const positions: THREE.Vector3[] = [];
    zoneDefinitions.forEach((_, index) => {
      const angle = (index / zoneDefinitions.length) * Math.PI * 2;
      const x = Math.cos(angle) * (this.island.getRadius() * 1.5);
      const z = Math.sin(angle) * (this.island.getRadius() * 1.5);
      positions.push(new THREE.Vector3(x, 0, z));
    });

    zoneDefinitions.forEach((def, index) => {
      const zoneData: ZoneData = {
        ...def,
        position: positions[index],
      };
      const zone = new Zone(zoneData, this.island);
      this.zones.push(zone);
    });
  }

  public addToScene(scene: THREE.Scene): void {
    this.zones.forEach((zone) => zone.addToScene(scene));
  }

  public update(time: number): void {
    this.zones.forEach((zone) => zone.update(time));
  }

  public findNearbyZone(playerPosition: THREE.Vector3, threshold: number = 3): Zone | null {
    for (const zone of this.zones) {
      if (zone.isNearby(playerPosition, threshold)) {
        return zone;
      }
    }
    return null;
  }

  public getZoneById(id: string): Zone | undefined {
    return this.zones.find((zone) => zone.id === id);
  }
}

