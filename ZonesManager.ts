import * as THREE from 'three';

import { Island } from './Island';
import { Zone, type ZoneData } from './Zones';

export class ZonesManager {
  private zones: Zone[] = [];
  private island: Island;
  private scene: THREE.Scene;

  constructor(island: Island, scene: THREE.Scene) {
    this.island = island;
    this.scene = scene;
    this.initializeZones();
  }

  private initializeZones(): void {
    // Define the five zones distributed around the island
    const zoneData: ZoneData[] = [
      {
        id: 'welcome',
        name: 'Welcome Hub',
        description: 'Introduction to DigiScalability Life Island - your personal 3D portfolio space',
        position: new THREE.Vector3(0, this.island.getRadius(), 0), // North pole
        color: 0x4CAF50, // Green
        icon: '🏠',
      },
      {
        id: 'professional',
        name: 'Professional Experience',
        description: 'Career journey, skills, and professional achievements',
        position: new THREE.Vector3(
          Math.cos(0) * this.island.getRadius(),
          this.island.getRadius() * 0.5,
          Math.sin(0) * this.island.getRadius()
        ),
        color: 0x2196F3, // Blue
        icon: '💼',
      },
      {
        id: 'projects',
        name: 'Project Portfolio',
        description: 'Showcase of key projects, technologies, and innovations',
        position: new THREE.Vector3(
          Math.cos(Math.PI * 2/5) * this.island.getRadius(),
          this.island.getRadius() * 0.5,
          Math.sin(Math.PI * 2/5) * this.island.getRadius()
        ),
        color: 0xFF9800, // Orange
        icon: '🚀',
      },
      {
        id: 'personal',
        name: 'Personal Life',
        description: 'Hobbies, interests, and life outside of work',
        position: new THREE.Vector3(
          Math.cos(Math.PI * 4/5) * this.island.getRadius(),
          this.island.getRadius() * 0.5,
          Math.sin(Math.PI * 4/5) * this.island.getRadius()
        ),
        color: 0xE91E63, // Pink
        icon: '🎨',
      },
      {
        id: 'contact',
        name: 'Get In Touch',
        description: 'Contact information, social links, and collaboration opportunities',
        position: new THREE.Vector3(
          Math.cos(Math.PI * 6/5) * this.island.getRadius(),
          this.island.getRadius() * 0.5,
          Math.sin(Math.PI * 6/5) * this.island.getRadius()
        ),
        color: 0x9C27B0, // Purple
        icon: '📬',
      },
    ];

    // Create zones
    for (const data of zoneData) {
      const zone = new Zone(data, this.island);
      zone.addToScene(this.scene);
      this.zones.push(zone);
    }

    console.log(`🎯 Created ${this.zones.length} interactive zones`);
  }

  public getZonesGroup(): THREE.Group {
    // Return a group containing all zone markers for compatibility
    const group = new THREE.Group();
    group.name = 'Zones';
    for (const zone of this.zones) {
      group.add(zone.marker);
    }
    return group;
  }

  public getZones(): Zone[] {
    return this.zones;
  }

  public getZoneCount(): number {
    return this.zones.length;
  }

  public getNearbyZone(playerPosition: THREE.Vector3, threshold: number = 3):
    | { zone: Zone; distance: number }
    | null {
    let nearest: Zone | null = null;
    let nearestDistance = threshold;

    for (const zone of this.zones) {
      const distance = zone.getPosition().distanceTo(playerPosition);
      if (distance < nearestDistance) {
        nearest = zone;
        nearestDistance = distance;
      }
    }

    return nearest ? { zone: nearest, distance: nearestDistance } : null;
  }

  public update(time: number): void {
    for (const zone of this.zones) {
      zone.update(time);
    }
  }

  public getZoneById(id: string): Zone | undefined {
    return this.zones.find(zone => zone.id === id);
  }
}
