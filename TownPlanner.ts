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

    console.log(`🏘️ Generated town with ${result.mailboxes.length} mailboxes, ${result.lamps.length} lamps`);
    return result;
  }

  /**
   * Generate a single city block
   */
  private async generateBlock(
    centerX: number,
    centerZ: number,
    blockSize: number,
    result: TownPlanResult
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
        const house = new House(0x8B4513); // Brown houses
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

    // Pole
    const poleGeometry = new THREE.CylinderGeometry(0.1, 0.1, 4);
    const poleMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.y = 2;
    pole.castShadow = true;
    lamp.add(pole);

    // Light fixture
    const fixtureGeometry = new THREE.SphereGeometry(0.3);
    const fixtureMaterial = new THREE.MeshBasicMaterial({ color: 0xffff88 });
    const fixture = new THREE.Mesh(fixtureGeometry, fixtureMaterial);
    fixture.position.y = 4;
    lamp.add(fixture);

    // Add point light
    const light = new THREE.PointLight(0xffff88, 0.5, 20);
    light.position.y = 4;
    lamp.add(light);

    // Add properties expected by GameScene
    lamp.group = lamp;
    lamp.isOn = true;
    lamp.light = light;

    lamp.userData = { type: 'lamp' };
    return lamp;
  }
}
