import * as THREE from 'three';

import { House } from './House';
import { Mailbox } from './Mailbox';

export interface LampObject extends THREE.Group {
  group: THREE.Group;
  isOn: boolean;
  light: THREE.Light;
}

export interface TownPlanOptions {
  size: number;
  roadSpacing: number;
  roadWidth: number;
  blockInset: number;
  treesPerBlock: [number, number];
}

export interface TownPlanResult {
  colliders: Array<{
    position: THREE.Vector3;
    radius: number;
  }>;
  houses: House[];
  mailboxes: Mailbox[];
  lamps: LampObject[];
}

/**
 * TownPlanner - Generates town layout with houses, mailboxes, lamps
 */
export class TownPlanner {
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Generate town layout
   */
  async generate(options: TownPlanOptions): Promise<TownPlanResult> {
    const result: TownPlanResult = {
      colliders: [],
      houses: [],
      mailboxes: [],
      lamps: [],
    };

    const { size, roadSpacing, roadWidth, blockInset } = options;

    // Generate grid of blocks
    const halfSize = size / 2;
    const blockSize = roadSpacing - roadWidth;

    for (let x = -halfSize + roadSpacing / 2; x < halfSize; x += roadSpacing) {
      for (let z = -halfSize + roadSpacing / 2; z < halfSize; z += roadSpacing) {
        await this.generateBlock(x, z, blockSize - blockInset * 2, result);
      }
    }

    console.log(
      `🏘️ Generated town with ${result.mailboxes.length} mailboxes, ${result.lamps.length} lamps`,
    );
    return result;
  }

  /**
   * Generate a single city block
   */
  private async generateBlock(
    centerX: number,
    centerZ: number,
    blockSize: number,
    result: TownPlanResult,
  ): Promise<void> {
    const halfBlock = blockSize / 2;

    // Add houses around the perimeter
    const housePositions = [
      { x: centerX - halfBlock, z: centerZ - halfBlock },
      { x: centerX + halfBlock, z: centerZ - halfBlock },
      { x: centerX - halfBlock, z: centerZ + halfBlock },
      { x: centerX + halfBlock, z: centerZ + halfBlock },
    ];

    for (const pos of housePositions) {
      try {
        const house = new House(0x8b4513); // Brown houses
        house.mesh.position.set(pos.x, 0, pos.z);
        this.scene.add(house.mesh);
        result.houses.push(house);

        // Collider position is provisional; GameScene re-projects it onto the
        // sphere surface together with the house itself.
        result.colliders.push({
          position: new THREE.Vector3(pos.x, 0, pos.z),
          radius: 3, // Approximate radius for house
        });
      } catch (error) {
        console.warn('Failed to create house:', error);
      }
    }

    // Add a mailbox per block (deterministic — the delivery loop needs them)
    try {
      const mailbox = new Mailbox();
      mailbox.mesh.position.set(centerX - halfBlock + 2, 0, centerZ - halfBlock + 2);
      this.scene.add(mailbox.mesh);
      result.mailboxes.push(mailbox);

      // Add collider
      result.colliders.push({
        position: new THREE.Vector3(centerX - halfBlock + 2, 0, centerZ - halfBlock + 2),
        radius: 1, // Approximate radius for mailbox
      });
    } catch (error) {
      console.warn('Failed to create mailbox:', error);
    }

    // Add lamp posts
    const lampPositions = [
      { x: centerX, z: centerZ - halfBlock },
      { x: centerX, z: centerZ + halfBlock },
      { x: centerX - halfBlock, z: centerZ },
      { x: centerX + halfBlock, z: centerZ },
    ];

    for (const pos of lampPositions) {
      const lamp = this.createLamp();
      lamp.position.set(pos.x, 0, pos.z);
      this.scene.add(lamp);
      result.lamps.push(lamp);
    }
  }

  /**
   * Create a simple lamp post
   */
  private createLamp(): LampObject {
    const lamp = new THREE.Group() as unknown as LampObject;

    const poleMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    // Main pole
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4, 8), poleMat);
    pole.position.y = 2;
    pole.castShadow = true;
    lamp.add(pole);
    // Curved arm
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), poleMat);
    arm.position.set(0.35, 3.9, 0);
    arm.rotation.z = -Math.PI / 4;
    lamp.add(arm);
    // Lamp shade
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.25, 8),
      new THREE.MeshLambertMaterial({ color: 0x2a2a2a }),
    );
    shade.position.set(0.6, 3.9, 0);
    shade.rotation.z = Math.PI;
    shade.castShadow = true;
    lamp.add(shade);
    // Glowing bulb — isNightEmissive so EnvironmentCycle dims it by day
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xfff4cc,
        emissive: 0xffe8a0,
        emissiveIntensity: 0.8,
      }),
    );
    bulb.position.set(0.6, 3.78, 0);
    bulb.userData.isNightEmissive = true;
    lamp.add(bulb);
    // Point light — isLampLight so EnvironmentCycle's night pass drives it
    // (picked up by the cycle's late rescan; these lamps are placed after
    // its construction). Range 7, not 20: on an r≈22 planet a range-20
    // light reached half the village and every lit fragment paid for it.
    const light = new THREE.PointLight(0xffeeaa, 0.5, 7, 2);
    light.position.set(0.6, 3.78, 0);
    light.userData = { isLampLight: true };
    lamp.add(light);

    // Add properties expected by GameScene
    lamp.group = lamp;
    lamp.isOn = true;
    lamp.light = light;

    lamp.userData = { type: 'lamp' };
    return lamp;
  }
}
