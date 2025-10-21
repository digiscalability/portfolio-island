import * as THREE from 'three';
import { Emoji } from './Emoji';
import { House } from './House';
import { Island } from './Island';
import { Mailbox } from './Mailbox';
import { Materials } from './Materials';
import { MathUtils } from './MathUtils';

export class ObjectPlacement {
  private island: Island;
  private scene: THREE.Scene;
  public houses: House[] = [];
  public mailboxes: Mailbox[] = [];
  public emojis: Emoji[] = [];
  // When true the legacy low-poly placeholders are generated. Default false to prefer Island's higher quality assets.
  private useLowPolyPlaceholders: boolean = false;

  constructor(island: Island, scene: THREE.Scene) {
    this.island = island;
    this.scene = scene;
    // Reference legacy placement helpers so they don't generate TypeScript 'declared but never used' warnings.
    // They are not executed by default (useLowPolyPlaceholders controls invocation) but keeping
    // references allows code to remain in the repository for debug/low-fi mode.
    (this as any)._placeholderRefs = {
      placeHouses: this.placeHouses,
      placeMailboxes: this.placeMailboxes,
      placeTrees: this.placeTrees,
      placeBenches: this.placeBenches,
      placeLamps: this.placeLamps,
      placeFlowers: this.placeFlowers,
      placeSigns: this.placeSigns,
      placeCars: this.placeCars,
      createSimpleTree: this.createSimpleTree,
    };
  }

  public placeObjects(): void {
    // Prefer high-quality assets created by Island by default. If the project wants the old low-poly
    // placeholders (for debugging or low-fi mode) it can enable `useLowPolyPlaceholders`.
    if (this.useLowPolyPlaceholders) {
      this.placeHouses(12);
      this.placeMailboxes();
      this.placeTrees(20);
      this.placeBenches(6);
      this.placeLamps(8);
      this.placeFlowers(80);
      this.placeSigns(8);
      this.placeCars(6);
    }
    this.placeEmojis(10);
    // Remove any boundary/plane objects from the scene
    this.removeBoundaries();
  }

  private removeBoundaries(): void {
    // Remove any objects named 'boundary', 'wall', 'plane', 'stripe', 'decal', or similar from the scene
    const names = ['boundary', 'wall', 'plane', 'stripe', 'decal', 'roadPlane'];
    this.scene.traverse((obj: any) => {
      if (obj && obj.name && names.some(n => obj.name.toLowerCase().includes(n))) {
        if (obj.parent) obj.parent.remove(obj);
      }
    });
  }

  private placeHouses(count: number): void {
    // Island already places houses with correct displaced sampling and higher detail.
    // Avoid duplicating boxy placeholders created elsewhere. Instead, ensure mailboxes/benches near houses are placed.
    return;
  }

  private placeMailboxes(): void {
    // Place a mailbox near each house
    this.houses.forEach((house) => {
      const mailbox = new Mailbox();

      // Offset mailbox slightly from house
      const housePos = house.mesh.position.clone();
      const offset = new THREE.Vector3(2, 0, 0).applyQuaternion(house.mesh.quaternion);
      const mailboxPos = housePos.clone().add(offset);

      mailbox.setPosition(mailboxPos);
      MathUtils.alignToSphere(mailbox.mesh, this.island.getCenter(), this.island.getRadius());

      // sample bubble text - small variety so NPCs feel different
      const greetings = [
        'Hello there!',
        'Have you seen my parcel?',
        'Lovely day for a delivery.',
        'I like your hat!',
        'Drop by the business hub!'
      ];
      const idx = Math.floor(Math.random() * greetings.length);
      mailbox.setBubbleText(greetings[idx]);

      mailbox.addToScene(this.scene);
      this.mailboxes.push(mailbox);
    });
  }

  private placeEmojis(count: number): void {
    const emojiTypes = ['😊', '🌟', '🎨', '🎵', '💡', '🚀', '🏆', '📚', '☕', '🌈'];
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() + 0.5);

    for (let i = 0; i < count; i++) {
      const emoji = new Emoji(emojiTypes[i % emojiTypes.length], positions[i]);
      MathUtils.alignToSphere(emoji.mesh, this.island.getCenter(), this.island.getRadius() + 0.5);

      emoji.addToScene(this.scene);
      this.emojis.push(emoji);
    }
  }

  private placeTrees(count: number): void {
    // Use Island's higher-quality tree assets (instanced or GLTF replacements). Don't add simple boxy trees here to avoid duplicates.
    return;
  }

  private placeBenches(count: number): void {
    // Use Fibonacci sphere distribution for natural placement across the island
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() * 0.7);

    for (let i = 0; i < count; i++) {
      const bench = this.createSimpleBench();

      // Sample the actual terrain surface at this position
      const direction = positions[i].clone().normalize();
      const sampled = this.island.sampleSurfaceByDirection(direction, 0.45);

      bench.position.copy(sampled.position);

      // Align bench to surface normal for natural appearance
      bench.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);

      bench.scale.setScalar(1.5);
      this.scene.add(bench);
    }
  }

  private createSimpleBench(): THREE.Group {
    const group = new THREE.Group();

    const benchGeom = new THREE.BoxGeometry(2, 0.3, 0.6);
    const benchMat = Materials.createTrimMaterial(0x8b4513);
    const bench = new THREE.Mesh(benchGeom, benchMat);
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);

    return group;
  }

  private placeLamps(count: number): void {
    // Use Fibonacci sphere distribution for natural placement
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() * 0.75);

    for (let i = 0; i < count; i++) {
      const lamp = this.createSimpleLamp();

      // Sample the actual terrain surface at this position
      const direction = positions[i].clone().normalize();
      const sampled = this.island.sampleSurfaceByDirection(direction, 0.5);

      lamp.position.copy(sampled.position);

      // Align lamp to surface normal
      lamp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);

      lamp.scale.setScalar(0.8);
      this.scene.add(lamp);
    }
  }

  private createSimpleLamp(): THREE.Group {
    const group = new THREE.Group();

    const postGeom = new THREE.CylinderGeometry(0.05, 0.05, 2, 8);
    const postMat = Materials.createTrimMaterial(0x333333);
    const post = new THREE.Mesh(postGeom, postMat);
    post.position.y = 1;
    post.castShadow = true;
    group.add(post);

    const headGeom = new THREE.SphereGeometry(0.2, 8, 8);
    const headMat = Materials.createTrimMaterial(0x444444);
    const head = new THREE.Mesh(headGeom, headMat);
    head.position.y = 2;
    head.castShadow = true;
    group.add(head);

    // Add light
    const light = new THREE.PointLight(0xffeeaa, 0.8, 4, 2);
    light.position.y = 2;
    group.add(light);

    return group;
  }

  private placeFlowers(count: number): void {
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() + 0.2);

    for (let i = 0; i < count; i++) {
      const flower = this.createSimpleFlower();
      flower.position.copy(positions[i]);
      MathUtils.alignToSphere(flower, this.island.getCenter(), this.island.getRadius() + 0.2);

      this.scene.add(flower);
    }
  }

  private createSimpleFlower(): THREE.Group {
    const group = new THREE.Group();

    const stemGeom = new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6);
    const stemMat = Materials.createStandardMaterial({ color: 0x228B22 });
    const stem = new THREE.Mesh(stemGeom, stemMat);
    stem.position.y = 0.2;
    group.add(stem);

    const petalGeom = new THREE.ConeGeometry(0.1, 0.2, 6);
    const petalMat = Materials.createStandardMaterial({ color: 0xff69b4 });
    const petals = new THREE.Mesh(petalGeom, petalMat);
    petals.position.y = 0.4;
    group.add(petals);

    return group;
  }

  private placeSigns(count: number): void {
    // Use Fibonacci sphere distribution for natural placement
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() * 0.65);

    for (let i = 0; i < count; i++) {
      const sign = this.createSimpleSign();

      // Sample the actual terrain surface at this position
      const direction = positions[i].clone().normalize();
      const sampled = this.island.sampleSurfaceByDirection(direction, 1.5);

      sign.position.copy(sampled.position);

      // Align sign to surface normal
      sign.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);

      sign.scale.setScalar(1.5);
      this.scene.add(sign);
    }
  }

  private createSimpleSign(): THREE.Group {
    const group = new THREE.Group();

    const postGeom = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
    const postMat = Materials.createTrimMaterial(0x8b4513);
    const post = new THREE.Mesh(postGeom, postMat);
    post.position.y = 0.5;
    post.castShadow = true;
    group.add(post);

    const boardGeom = new THREE.PlaneGeometry(1, 0.6);
    const boardMat = Materials.createTrimMaterial(0xffffff);
    const board = new THREE.Mesh(boardGeom, boardMat);
    board.position.y = 1;
    board.position.z = 0.01;
    group.add(board);

    return group;
  }

  private placeCars(count: number): void {
    // Use Fibonacci sphere distribution for natural placement
    const positions = MathUtils.fibonacciSphere(count, this.island.getRadius() * 0.8);

    for (let i = 0; i < count; i++) {
      const car = this.createSimpleCar();

      // Sample the actual terrain surface at this position
      const direction = positions[i].clone().normalize();
      const sampled = this.island.sampleSurfaceByDirection(direction, 0.4);

      car.position.copy(sampled.position);

      // Align car to surface normal
      car.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sampled.normal);

      car.scale.setScalar(1.5);
      this.scene.add(car);
    }
  }

  private createSimpleCar(): THREE.Group {
    const group = new THREE.Group();

    const bodyGeom = new THREE.BoxGeometry(2, 0.8, 4);
    const bodyMat = Materials.createTrimMaterial(0xff0000);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    return group;
  }

  private createSimpleTree(): THREE.Group {
    const group = new THREE.Group();

    // Trunk
  const trunkGeometry = new THREE.CylinderGeometry(0.4, 0.5, 4, 8);
  const trunkMaterial = Materials.createPBRMaterial({ color: 0x8b4513, roughness: 0.7 });
  const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.position.y = 2;
    trunk.castShadow = true;
    group.add(trunk);

    // Foliage (cone)
    const foliageGeometry = new THREE.ConeGeometry(2, 4, 8);
  const foliageMaterial = Materials.createTreeMaterial();
  const foliage = new THREE.Mesh(foliageGeometry, foliageMaterial);
    foliage.position.y = 5;
    foliage.castShadow = true;
    group.add(foliage);

    return group;
  }

  public update(time: number): void {
    this.mailboxes.forEach((mailbox) => mailbox.update(time));
    this.emojis.forEach((emoji) => emoji.update(time));
  }
}

