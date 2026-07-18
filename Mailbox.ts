import * as THREE from 'three';

import { Materials } from './Materials';

export class Mailbox {
  public mesh: THREE.Group;
  public hasDelivery: boolean = false;
  private glowMaterial?: THREE.MeshStandardMaterial;
  // optional short text to show in speech bubble when player approaches
  public bubbleText?: string;

  constructor() {
    this.mesh = new THREE.Group();
    this.createMailbox();
  }

  private async createMailbox(): Promise<void> {
    // Skip GLTF loading for performance - use simple geometry
    const fallbackMailbox = this.createSimpleMailbox();
    this.mesh.add(fallbackMailbox);
  }

  private createSimpleMailbox(): THREE.Group {
    const group = new THREE.Group();

    // Post (cylinder)
    const postGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1.5, 8);
    const post = new THREE.Mesh(
      postGeometry,
      Materials.createPBRMaterial({ color: 0x654321, roughness: 0.7 }),
    );
    post.position.y = 0.75;
    post.castShadow = true;
    group.add(post);

    // Box (main mailbox)
    const boxGeometry = new THREE.BoxGeometry(0.8, 0.5, 0.4);
    const boxMaterial = Materials.createMailboxStandard();
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    box.position.y = 1.7;
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);

    // small white decal plate on front for legibility (slightly inset)
    const plateGeo = new THREE.PlaneGeometry(0.42, 0.18);
    const plateMat = Materials.createStandardMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.9,
      envMapIntensity: 0,
    });
    const plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.set(0, 1.7, 0.21);
    group.add(plate);

    // Flag (small box)
    const flagGeometry = new THREE.BoxGeometry(0.3, 0.1, 0.05);
    const flag = new THREE.Mesh(
      flagGeometry,
      Materials.createPBRMaterial({ color: 0xff0000, roughness: 0.4 }),
    );
    flag.position.set(0.5, 1.8, 0);
    group.add(flag);

    // Glow indicator (hidden by default)
    const glowGeometry = new THREE.SphereGeometry(0.3, 16, 16);
    this.glowMaterial = new THREE.MeshStandardMaterial({
      color: 0xffff00,
      emissive: 0xffff00,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0,
    });
    const glow = new THREE.Mesh(glowGeometry, this.glowMaterial);
    glow.position.y = 2.2;
    group.add(glow);

    return group;
  }

  public setBubbleText(text: string | undefined) {
    this.bubbleText = text;
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

  public setHasDelivery(hasDelivery: boolean): void {
    this.hasDelivery = hasDelivery;
    if (this.glowMaterial) {
      this.glowMaterial.opacity = hasDelivery ? 0.6 : 0;
    }
  }

  public update(time: number): void {
    if (this.hasDelivery && this.glowMaterial) {
      // Pulse effect
      this.glowMaterial.opacity = 0.3 + Math.sin(time * 3) * 0.3;
    }
  }

  public isNearby(position: THREE.Vector3, threshold: number = 2): boolean {
    return this.mesh.position.distanceTo(position) < threshold;
  }
}

