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

/**
 * Per-district landmark building recipe. Each zone is now a recognisable
 * hero-version of its district's prop vocabulary (town hall / office HQ /
 * workshop / gallery-home / post office) rather than an abstract glowing beacon.
 * Kept small (5 buildings) and on shared-ish materials — cost is trivial.
 */
interface BuildingCfg {
  body: [number, number, number]; // w, h, d
  bodyColor: number;
  roof: 'pitch' | 'flat';
  roofColor: number;
  accent: 'columns' | 'antenna' | 'chimney' | 'awning' | 'none';
}

const BUILDINGS: Record<string, BuildingCfg> = {
  // Town hall / visitor pavilion — wide, columned, warm stone.
  welcome: {
    body: [4.0, 2.8, 3.2],
    bodyColor: 0xe8e0cf,
    roof: 'pitch',
    roofColor: 0x8a6d4f,
    accent: 'columns',
  },
  // Office HQ — tall, cool, glassy slab.
  professional: {
    body: [3.0, 4.6, 3.0],
    bodyColor: 0xb9c4d4,
    roof: 'flat',
    roofColor: 0x6b7686,
    accent: 'none',
  },
  // Workshop / lab — squat, ochre, rooftop antenna.
  projects: {
    body: [3.4, 3.0, 3.0],
    bodyColor: 0xcbb089,
    roof: 'flat',
    roofColor: 0x9a7d55,
    accent: 'antenna',
  },
  // Gallery / home — cottage grown up, blossom-tinted, chimney.
  personal: {
    body: [3.4, 2.7, 3.0],
    bodyColor: 0xe6c9d2,
    roof: 'pitch',
    roofColor: 0x9c5f74,
    accent: 'chimney',
  },
  // Post office / contact hall — lavender, awning over the door.
  contact: {
    body: [3.2, 2.9, 3.0],
    bodyColor: 0xd7c2e0,
    roof: 'pitch',
    roofColor: 0x7d5f92,
    accent: 'awning',
  },
};

/** Footprint collider radius pushed by GameScene — kept small so a player at
 *  the wall is still inside interactionRange (2.5) to open the panel. */
export const ZONE_BUILDING_COLLIDER_RADIUS = 1.7;

export class Zone {
  public id: string;
  public name: string;
  public description: string;
  public position: THREE.Vector3;
  public audioKey?: string;
  /** The landmark building group (was an abstract Mesh beacon). */
  public marker: THREE.Object3D;
  /** Rooftop emissive beacon, animated by update(); null-safe. */
  private beacon: THREE.Object3D | null = null;
  private beaconBaseY = 0;
  public label?: HTMLDivElement;

  constructor(data: ZoneData, island: Island) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.audioKey = data.audioKey;
    this.position = data.position.clone();

    this.marker = this.createBuilding(data.id, data.color, data.icon);
    this.beacon = this.marker.getObjectByName('zone-beacon') ?? null;
    if (this.beacon) this.beaconBaseY = this.beacon.position.y;

    // Seat the building on the displaced surface and orient it so its DOOR
    // (local +Z) faces the pole — i.e. addresses the avenue the player arrives
    // on. Built from a basis (right, up=normal, forward=toward-pole) so
    // alignment + door-facing happen in one quaternion.
    try {
      const dir = this.position.clone().normalize();
      const sampled = island.sampleSurfaceByDirection(dir, 0.4);
      this.marker.position.copy(sampled.position);
      this.position.copy(sampled.position); // proximity matches the visual

      const normal = sampled.normal.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0);
      // Tangent pointing toward the north pole; at the pole itself fall back to
      // a fixed longitude so the door still faces a sensible way.
      const toPole = up.clone().addScaledVector(normal, -up.dot(normal));
      if (toPole.lengthSq() < 1e-4) {
        toPole.set(1, 0, 0).addScaledVector(normal, -normal.x);
      }
      toPole.normalize();
      const right = new THREE.Vector3().crossVectors(normal, toPole).normalize();
      const forward = new THREE.Vector3().crossVectors(right, normal).normalize();
      this.marker.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, normal, forward),
      );
    } catch (_e) {
      this.marker.position.copy(this.position);
      this.marker.position.y = island.getRadius() + 0.5;
    }
  }

  private createBuilding(id: string, color: number, icon?: string): THREE.Group {
    const g = new THREE.Group();
    g.name = `zone_building_${id}`;
    const cfg = BUILDINGS[id] ?? BUILDINGS.welcome;
    const [bw, bh, bd] = cfg.body;
    const base = 0.1; // body sits just above the foundation slab

    // Foundation slab — hides the flat footprint intersecting the displaced
    // sphere (the terrain note in CLAUDE.md), reused from the welcome-plaza idiom.
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(bw * 0.82, bw * 0.9, 0.3, 24),
      new THREE.MeshStandardMaterial({ color: 0xbdb3a4, roughness: 0.95 }),
    );
    slab.position.y = -0.02;
    slab.receiveShadow = true;
    g.add(slab);

    // Body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(bw, bh, bd),
      new THREE.MeshStandardMaterial({ color: cfg.bodyColor, roughness: 0.8, metalness: 0.05 }),
    );
    body.position.y = base + bh / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // Roof
    const roofMat = new THREE.MeshStandardMaterial({ color: cfg.roofColor, roughness: 0.85 });
    if (cfg.roof === 'flat') {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.25, 0.3, bd + 0.25), roofMat);
      roof.position.y = base + bh + 0.15;
      roof.castShadow = true;
      g.add(roof);
    } else {
      const roof = new THREE.Mesh(new THREE.ConeGeometry(bw * 0.78, 1.4, 4), roofMat);
      roof.position.y = base + bh + 0.7;
      roof.rotation.y = Math.PI / 4; // align the 4-sided pyramid with the box
      roof.castShadow = true;
      g.add(roof);
    }

    // Door on the +Z (pole-facing) wall
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 1.9, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x5a3f28, roughness: 0.7 }),
    );
    door.position.set(0, base + 0.95, bd / 2 + 0.02);
    g.add(door);
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xd9b24a, metalness: 0.6, roughness: 0.3 }),
    );
    knob.position.set(0.34, base + 0.95, bd / 2 + 0.1);
    g.add(knob);

    // Warm door lamp + two windows — all night-emissive so EnvironmentCycle
    // lights them (buildings mustn't go dark where the old beam glowed).
    const glowMat = () =>
      new THREE.MeshStandardMaterial({
        color: 0xffe6a8,
        emissive: 0xffe6a8,
        emissiveIntensity: 0.4,
      });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), glowMat());
    lamp.position.set(0, base + 2.05, bd / 2 + 0.16);
    lamp.userData.isNightEmissive = true;
    g.add(lamp);
    for (const wx of [-bw * 0.3, bw * 0.3]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.8, 0.08), glowMat());
      win.position.set(wx, base + bh * 0.62, bd / 2 + 0.02);
      win.userData.isNightEmissive = true;
      g.add(win);
    }

    // Rooftop beacon — the far-read navigation cue that replaces the tall beam.
    // Saturated emissive so it reads without bloom (mobile has no composer).
    const beacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.0 }),
    );
    beacon.name = 'zone-beacon';
    beacon.position.y = base + bh + (cfg.roof === 'flat' ? 0.7 : 1.7);
    beacon.userData.isNightEmissive = true;
    g.add(beacon);

    // Per-district accent prop
    this.addAccent(g, cfg, bw, bh, bd, base, color);

    // Emoji shingle above the door (kept from the old marker — carries per-
    // district identity from any angle, no bloom, opts out of raycasting).
    if (icon) {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = '92px system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, 64, 70);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
        );
        sprite.name = 'zone-icon';
        sprite.position.set(0, base + bh + 0.35, bd / 2 + 0.05);
        sprite.scale.setScalar(1.1);
        sprite.raycast = () => {};
        g.add(sprite);
      }
    }

    return g;
  }

  private addAccent(
    g: THREE.Group,
    cfg: BuildingCfg,
    bw: number,
    bh: number,
    bd: number,
    base: number,
    color: number,
  ): void {
    if (cfg.accent === 'columns') {
      const colMat = new THREE.MeshStandardMaterial({ color: 0xe8e0cf, roughness: 0.85 });
      for (const cx of [-bw * 0.36, bw * 0.36]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, bh * 0.9, 10), colMat);
        col.position.set(cx, base + bh * 0.45, bd / 2 + 0.35);
        col.castShadow = true;
        g.add(col);
      }
    } else if (cfg.accent === 'antenna') {
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.05, 1.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.5, roughness: 0.5 }),
      );
      mast.position.set(bw * 0.28, base + bh + 0.9, -bd * 0.2);
      g.add(mast);
      const dish = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 10, 8, 0, Math.PI),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 }),
      );
      dish.position.set(bw * 0.28, base + bh + 1.6, -bd * 0.2);
      dish.rotation.x = Math.PI / 2.5;
      dish.userData.isNightEmissive = true;
      g.add(dish);
    } else if (cfg.accent === 'chimney') {
      const chim = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 1.0, 0.4),
        new THREE.MeshStandardMaterial({ color: 0x8a6d55, roughness: 0.9 }),
      );
      chim.position.set(bw * 0.28, base + bh + 0.9, bd * 0.2);
      chim.castShadow = true;
      g.add(chim);
    } else if (cfg.accent === 'awning') {
      const awn = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.12, 0.8),
        new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
      );
      awn.position.set(0, base + 2.0, bd / 2 + 0.4);
      awn.rotation.x = -0.28;
      g.add(awn);
    }
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.marker);
  }

  public update(time: number): void {
    // Animate ONLY the rooftop beacon — spinning/bobbing the whole building
    // (as the old marker did) would look absurd. Null-guarded.
    if (this.beacon) {
      this.beacon.position.y = this.beaconBaseY + Math.sin(time * 2) * 0.12; // absolute bob (no drift)
      this.beacon.rotation.y += 0.02;
    }
  }

  public getPosition(): THREE.Vector3 {
    return this.position.clone();
  }

  public isNearby(playerPosition: THREE.Vector3, threshold: number = 3): boolean {
    return this.position.distanceTo(playerPosition) < threshold;
  }
}
