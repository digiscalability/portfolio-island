import * as THREE from 'three';

import { a11y } from './Accessibility';
import { addGroupHulls } from './CelLook';
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
    // Outline Tier 1: ink the landmark masses; the beacon stays clean (its
    // emissive bob would drag a black shell through the glow). Floor 0.7 is
    // MEASURED, not guessed: window boxes cluster at world radius 0.52/0.63,
    // real masses start at 0.8 — 0.5 hulled every window and blew the +126
    // draw ledger (147 hulls across the five halls; 0.7 keeps ~35).
    addGroupHulls(this.marker, 0.7, (m) => m.name !== 'zone-beacon');

    // Seat the building on the displaced surface and orient it so its DOOR
    // (local +Z) faces the pole — i.e. addresses the avenue the player arrives
    // on. Built from a basis (right, up=normal, forward=toward-pole) so
    // alignment + door-facing happen in one quaternion.
    try {
      const dir = this.position.clone().normalize();
      // Offset 0.05 (was 0.4): the old seat floated every landmark building
      // 0.23-0.36u above the terrain with the door sill at knee height —
      // the only structures violating the island's bury-not-float convention.
      const sampled = island.sampleSurfaceByDirection(dir, 0.05);
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
    // Highest point of the roof: flat slab top (+0.3) vs gable apex (the 1.4-
    // tall cone seats ON the wall top). Rooftop attachments (beacon, icon)
    // must clear THIS, not just bh — gables rise 1.4 above the walls.
    const roofPeakY = base + bh + (cfg.roof === 'flat' ? 0.3 : 1.4);

    // Foundation slab — hides the flat footprint intersecting the displaced
    // sphere (the terrain note in CLAUDE.md), reused from the welcome-plaza
    // idiom. Sunk (-0.15) so the bottom is buried like every other prop.
    // The welcome hall's slab shrinks so it doesn't swallow the pole plaza
    // floor + decorative ring the hub composition is built from.
    const slabScale = id === 'welcome' ? [0.55, 0.62] : [0.82, 0.9];
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(bw * slabScale[0], bw * slabScale[1], 0.3, 24),
      new THREE.MeshStandardMaterial({ color: 0xbdb3a4, roughness: 0.95 }),
    );
    slab.position.y = -0.15;
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

    // Cornice band — a slim overhanging eave where the walls meet the roof, so
    // the roof reads as capping a finished building instead of sitting on a bare
    // box. Roof colour (always darker than the body in BUILDINGS) contrasts on
    // every district; it protrudes 0.1 all round and its top meets the wall top,
    // tucking just under the pitch cone / the flat roof's parapet slab.
    const cornice = new THREE.Mesh(
      new THREE.BoxGeometry(bw + 0.2, 0.18, bd + 0.2),
      new THREE.MeshStandardMaterial({ color: cfg.roofColor, roughness: 0.85 }),
    );
    cornice.position.y = base + bh - 0.1;
    cornice.castShadow = true;
    cornice.receiveShadow = true;
    g.add(cornice);

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
    // The tall office slab gets three storeys of glass so it reads inhabited
    // at night; the low landmarks keep their single row. Rear + side windows
    // dress the previously blank single-colour faces — same night-emissive
    // idiom, boxes embed 0.02 into the wall / protrude 0.06 like the fronts.
    // Dark reveal behind each glow pane so a window reads as framed glass, not a
    // glowing hole — the frame sits flush in the wall (protrudes 0.03), the pane
    // stays proud of it (0.06). Non-emissive on purpose: at night the warm glass
    // pops against the dark surround.
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x4a3f30, roughness: 0.85 });
    const winRows = id === 'professional' ? [0.32, 0.55, 0.78] : [0.62];
    for (const wy of winRows) {
      for (const wx of [-bw * 0.3, bw * 0.3]) {
        for (const wz of [bd / 2 + 0.02, -bd / 2 - 0.02]) {
          const sign = Math.sign(wz);
          const frame = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.96, 0.05), frameMat);
          frame.position.set(wx, base + bh * wy, sign * (bd / 2 + 0.005));
          g.add(frame);
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.8, 0.08), glowMat());
          win.position.set(wx, base + bh * wy, wz);
          win.userData.isNightEmissive = true;
          g.add(win);
        }
      }
      for (const sx of [-1, 1]) {
        for (const wz of [-bd * 0.24, bd * 0.24]) {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.96, 0.82), frameMat);
          frame.position.set(sx * (bw / 2 + 0.005), base + bh * wy, wz);
          g.add(frame);
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.66), glowMat());
          win.position.set(sx * (bw / 2 + 0.02), base + bh * wy, wz);
          win.userData.isNightEmissive = true;
          g.add(win);
        }
      }
    }

    // Rooftop beacon — the far-read navigation cue that replaces the tall beam.
    // Saturated emissive so it reads without bloom (mobile has no composer).
    const beacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.0 }),
    );
    beacon.name = 'zone-beacon';
    // 0.5 = octahedron half-height 0.26 + bob amplitude 0.12 + 0.12 margin.
    // The old (bh + 1.7) put the pitch-roof beacon only 0.3 over the apex —
    // its bottom vertex dipped to apex−0.08 at the bob's low point.
    beacon.position.y = roofPeakY + 0.5;
    beacon.userData.isNightEmissive = true;
    g.add(beacon);

    // Per-district accent prop
    this.addAccent(g, cfg, bw, bh, bd, base, color);

    // Civic entrance treatment — only the welcome hall (the island's pole-plaza
    // centrepiece) earns the portico; the district halls stay simpler.
    if (id === 'welcome') this.addPortico(g, bd, base);

    // District emoji, floated on the roof axis ABOVE the bobbing beacon
    // (carries per-district identity from any angle, no bloom, opts out of
    // raycasting). It used to hang at bh+0.35 on the door face, where gable
    // roofs (apex bh+1.4) sliced through it and camera-facing billboard swing
    // pushed its edges into the roof cone from side angles.
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
        // 1.6 above the peak: bottom of the 1.1-scale sprite sits at
        // roofPeakY+1.05, clearing the beacon's bob-top (roofPeakY+0.88) by
        // 0.17. Centred on the axis so billboard swing can never reach the
        // roof (the apex is the roof's highest point).
        sprite.position.set(0, roofPeakY + 1.6, 0);
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

  /**
   * Welcome-hall entrance: two pilasters framing the door, a shallow pediment
   * gable, and a two-tread stoop. Everything lives BELOW the pitch cone's base
   * (base+bh) — the cone's base radius overhangs the walls, so a taller/projecting
   * portico would poke through the eave. The pediment also clears the door lamp
   * (top ~base+2.26); the pilasters sit inboard of the accent columns (±bw*0.36).
   */
  private addPortico(g: THREE.Group, bd: number, base: number): void {
    const frontZ = bd / 2;
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xd8cdb8, roughness: 0.85 });

    // Pilasters flanking the doorway, rising to the pediment base.
    for (const px of [-0.62, 0.62]) {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.25, 0.12), trimMat);
      pil.position.set(px, base + 1.125, frontZ + 0.06);
      pil.castShadow = true;
      g.add(pil);
    }

    // Shallow pediment gable: a triangle in XY extruded along Z, seated on the
    // pilaster tops (base+2.25 → apex base+2.65, clearing the lamp top ~base+2.16
    // and staying under the cone base at base+bh).
    const tri = new THREE.Shape();
    tri.moveTo(-0.82, 0);
    tri.lineTo(0.82, 0);
    tri.lineTo(0, 0.4);
    tri.closePath();
    const pedGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.14, bevelEnabled: false });
    pedGeo.translate(0, 0, -0.07); // centre the extrusion on its front face
    const pediment = new THREE.Mesh(
      pedGeo,
      new THREE.MeshStandardMaterial({ color: 0x8a6d4f, roughness: 0.85 }),
    );
    pediment.position.set(0, base + 2.25, frontZ + 0.06);
    pediment.castShadow = true;
    g.add(pediment);

    // Two-tread stoop at the threshold; bottoms buried like every island prop.
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0xbdb3a4, roughness: 0.95 });
    for (let s = 0; s < 2; s++) {
      const tread = new THREE.Mesh(new THREE.BoxGeometry(1.8 + s * 0.5, 0.16, 0.4), stoneMat);
      tread.position.set(0, base - 0.02 - s * 0.12, frontZ + 0.25 + s * 0.32);
      tread.receiveShadow = true;
      g.add(tread);
    }
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.marker);
  }

  public update(time: number): void {
    // Animate ONLY the rooftop beacon — spinning/bobbing the whole building
    // (as the old marker did) would look absurd. Null-guarded.
    if (this.beacon) {
      if (a11y.reducedMotion) {
        // Held plumb-still: the beacon's colour and silhouette carry the
        // nav cue on their own.
        this.beacon.position.y = this.beaconBaseY;
      } else {
        this.beacon.position.y = this.beaconBaseY + Math.sin(time * 2) * 0.12; // absolute bob (no drift)
        // Absolute, time-derived spin — the old `+= 0.02` per frame doubled
        // the speed on 120 Hz displays. 1.2 rad/s matches 60 fps behaviour.
        this.beacon.rotation.y = time * 1.2;
      }
    }
  }

  public getPosition(): THREE.Vector3 {
    return this.position.clone();
  }

  public isNearby(playerPosition: THREE.Vector3, threshold: number = 3): boolean {
    return this.position.distanceTo(playerPosition) < threshold;
  }
}
