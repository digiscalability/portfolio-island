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
    this.marker = this.createMarker(data.color, data.icon);

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

  private createMarker(color: number, icon?: string): THREE.Mesh {
    // Landmark plaza: stone-toned disc + emissive ring + light beam, so each
    // zone reads as a destination without looking radioactive up close.
    const geometry = new THREE.CylinderGeometry(1.6, 1.7, 0.18, 24);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.12,
      metalness: 0.2,
      roughness: 0.4,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Floating indicator orb (animated by update()). Held above the beam tip
    // (~3.5): at y=2 it sat exactly at player-head height under the mobile
    // follow-camera pitch and read as a balloon glued to the player.
    const indicatorGeometry = new THREE.SphereGeometry(0.24, 16, 16);
    const indicatorMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.0,
    });
    const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
    indicator.position.y = 3.6;
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

    // (The old 6-pillar "henge" with glowing ball caps is gone — from the
    // ground the poles read as bizarre antennae ringing every plaza. The
    // disc + ring + beam + floating orb carry the landmark job fine.)

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

    // Emoji identity badge floating above the orb — the five markers were
    // identical geometry in five colours, indistinguishable at a glance. The
    // icon (🏠💼🚀🎨📬) was defined in ZoneData all along and never rendered. A
    // camera-facing sprite reads as identity from any angle without adding a
    // real light or a fragile floating plane.
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
        sprite.position.y = 4.6;
        sprite.scale.setScalar(1.5);
        // Purely decorative — opt out of raycasting so the interaction/camera
        // rays skip it (and don't spam the "Raycaster.camera not set" warning).
        sprite.raycast = () => {};
        mesh.add(sprite);
      }
    }

    return mesh;
  }

  public addToScene(scene: THREE.Scene): void {
    scene.add(this.marker);
  }

  public update(time: number): void {
    // Animate the floating indicator (bobs just above the beam tip)
    if (this.marker.children.length > 0) {
      const indicator = this.marker.children[0];
      indicator.position.y = 3.6 + Math.sin(time * 2) * 0.25;
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

