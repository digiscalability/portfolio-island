import * as THREE from 'three';

import { Materials } from './Materials';

/**
 * SimplePlanet
 *
 * A simplified, modular island/planet implementation following the Messenger game pattern.
 * This replaces the 1700-line Island.ts with a focused, efficient class that:
 * - Creates spherical terrain with displacement mapping
 * - Provides raycasting for ground detection
 * - Manages object placement via batching
 *
 * Design goals:
 * - Self-contained (no external manager dependencies)
 * - Simple Three.js patterns (direct mesh manipulation)
 * - Fast ground queries (ready state promise)
 */
export class SimplePlanet extends THREE.Group {
  private radius: number;
  private terrainMesh!: THREE.Mesh;
  private terrainGeometry!: THREE.BufferGeometry;
  private terrainMaterial!: THREE.MeshToonMaterial;
  private center: THREE.Vector3 = new THREE.Vector3();

  // Raycasting support
  private raycaster: THREE.Raycaster = new THREE.Raycaster();
  private rayOrigin: THREE.Vector3 = new THREE.Vector3();
  private rayDirection: THREE.Vector3 = new THREE.Vector3(0, -1, 0);

  // Ready state (like Messenger's scene.ready promise)
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;

  constructor(radius: number = 18) {
    super();
    this.name = 'SimplePlanet';
    this.radius = radius;

    // Create ready promise
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.createTerrain();
  }

  /**
   * Get the ready state promise
   * Usage: await planet.ready();
   */
  async ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Simple procedural noise function (Perlin-like)
   */
  private noise(x: number, y: number, z: number): number {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 45.164) * 43758.5453;
    return n - Math.floor(n);
  }

  /**
   * Create the spherical terrain with procedural displacement
   */
  private createTerrain(): void {
    // Use icosahedron for better terrain distribution
    const geometry = new THREE.IcosahedronGeometry(this.radius, 5);

    // Procedural displacement using simple noise
    const posAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    const posArray = posAttribute.array as Float32Array;

    for (let i = 0; i < posArray.length; i += 3) {
      const x = posArray[i];
      const y = posArray[i + 1];
      const z = posArray[i + 2];

      // Normalize to unit sphere
      const v = new THREE.Vector3(x, y, z).normalize();

      // Multi-octave noise for natural terrain
      let noise = 0;
      let amplitude = 1;
      let frequency = 1;
      let maxAmplitude = 0;

      for (let octave = 0; octave < 4; octave++) {
        noise += this.noise(v.x * frequency, v.y * frequency, v.z * frequency) * amplitude;
        maxAmplitude += amplitude;
        amplitude *= 0.5;
        frequency *= 2;
      }

      noise /= maxAmplitude;

      // Apply displacement
      const displacement = this.radius * (0.15 + noise * 0.1);
      posArray[i] = v.x * displacement;
      posArray[i + 1] = v.y * displacement;
      posArray[i + 2] = v.z * displacement;
    }

    posAttribute.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // Use toon material for cel-shaded look like messenger.abeto.co
    this.terrainMaterial = Materials.createToonMaterial(0x4a9b5c); // Vibrant green

    this.terrainMesh = new THREE.Mesh(geometry, this.terrainMaterial);
    this.terrainGeometry = geometry;

    this.add(this.terrainMesh);

    // Add receiveShadow for shadow mapping
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;

    // Mark as ready
    setTimeout(() => this.readyResolve(), 10);
  }

  /**
   * Raycast from a point downward to find terrain surface
   * Returns the hit point or null
   */
  public rayCastToSurface(point: THREE.Vector3, _maxDistance: number = 100): THREE.Vector3 | null {
    this.rayOrigin.copy(point);
    this.rayDirection.set(0, -1, 0);

    this.raycaster.set(this.rayOrigin, this.rayDirection);
    const hits = this.raycaster.intersectObject(this.terrainMesh);

    if (hits.length > 0) {
      return hits[0].point;
    }

    return null;
  }

  /**
   * Get the surface normal at a point on the terrain
   */
  public getSurfaceNormal(point: THREE.Vector3): THREE.Vector3 {
    this.rayOrigin.copy(point);
    this.rayDirection.set(0, -1, 0);

    this.raycaster.set(this.rayOrigin, this.rayDirection);
    const hits = this.raycaster.intersectObject(this.terrainMesh);

    if (hits.length > 0 && hits[0].face) {
      const normal = hits[0].face.normal.clone();
      return this.terrainMesh.getWorldDirection(normal);
    }

    // Default: point towards center
    return point.clone().normalize();
  }

  /**
   * Find a point on the surface given a world position
   * Useful for grounding objects to terrain
   */
  public getGroundPoint(
    worldPosition: THREE.Vector3,
    searchDistance: number = this.radius * 3,
  ): THREE.Vector3 {
    // Cast from above
    const searchPoint = worldPosition
      .clone()
      .normalize()
      .multiplyScalar(this.radius * 2);
    const hit = this.rayCastToSurface(searchPoint, searchDistance);
    return hit || worldPosition;
  }

  /**
   * Check if a world position is "on" the terrain surface
   */
  public isOnSurface(worldPosition: THREE.Vector3, tolerance: number = 1.0): boolean {
    const surfacePoint = this.getGroundPoint(worldPosition);
    const distance = worldPosition.distanceTo(surfacePoint);
    return distance <= tolerance;
  }

  /**
   * Raycast from world position in a direction
   */
  public rayCast(origin: THREE.Vector3, direction: THREE.Vector3): any {
    this.raycaster.set(origin, direction.normalize());
    const hits = this.raycaster.intersectObject(this.terrainMesh);
    return hits.length > 0 ? hits[0] : null;
  }

  /**
   * Sample the surface by shooting a ray along a direction.
   * Returns the surface position and normal, falling back to an analytical sphere if no hit.
   */
  public sampleSurfaceByDirection(
    direction: THREE.Vector3,
    rayLength: number = this.radius * 2,
  ): { position: THREE.Vector3; normal: THREE.Vector3 } {
    const dir = direction.clone();
    if (dir.lengthSq() === 0) {
      dir.set(0, 1, 0);
    }
    dir.normalize();

    const origin = dir.clone().multiplyScalar(this.radius + rayLength);
    const ray = dir.clone().multiplyScalar(-1);

    const hit = this.rayCast(origin, ray);

    if (hit && hit.point) {
      const position = hit.point.clone();
      let normal = dir.clone();

      if (hit.face) {
        this.terrainMesh.updateMatrixWorld(true);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(this.terrainMesh.matrixWorld);
        normal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
      }

      return { position, normal };
    }

    return {
      position: dir.clone().multiplyScalar(this.radius),
      normal: dir.clone(),
    };
  }

  /**
   * Get the radius of the planet
   */
  public getRadius(): number {
    return this.radius;
  }

  /**
   * Get the center of the planet (origin in this simplified implementation)
   */
  public getCenter(): THREE.Vector3 {
    return this.center;
  }

  /**
   * Get the terrain mesh (for rendering configuration, shadow maps, etc.)
   */
  public getTerrainMesh(): THREE.Mesh {
    return this.terrainMesh;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.terrainGeometry.dispose();
    this.terrainMaterial.dispose();
  }
}
