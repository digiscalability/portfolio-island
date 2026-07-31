import * as THREE from 'three';

import { DISTRICTS, dirFor } from './Districts';
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
    // Positions/colors/names come from the shared DISTRICTS source of truth
    // (Districts.ts) so the glowing plaza markers always sit exactly on the
    // Island's district plazas + minimap dots. Descriptions/icons are zone
    // content and stay here.
    const META: Record<string, { description: string; icon: string }> = {
      welcome: {
        description: 'Introduction to DigiScalability Life Island - your personal 3D portfolio space',
        icon: '🏠',
      },
      professional: { description: 'Career journey, skills, and professional achievements', icon: '💼' },
      projects: { description: 'Showcase of key projects, technologies, and innovations', icon: '🚀' },
      personal: { description: 'Hobbies, interests, and life outside of work', icon: '🎨' },
      contact: {
        description: 'Contact information, social links, and collaboration opportunities',
        icon: '📬',
      },
    };
    const R = this.island.getRadius();
    const zoneData: ZoneData[] = DISTRICTS.map((d) => ({
      id: d.id,
      name: d.name,
      description: META[d.id].description,
      position: dirFor(d.lon, d.lat).multiplyScalar(R),
      color: d.color,
      icon: META[d.id].icon,
    }));

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
