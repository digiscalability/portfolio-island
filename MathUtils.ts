import * as THREE from 'three';

export class MathUtils {
  /**
   * Convert spherical coordinates to Cartesian coordinates
   */
  public static sphericalToCartesian(
    radius: number,
    theta: number,
    phi: number
  ): THREE.Vector3 {
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    return new THREE.Vector3(x, y, z);
  }

  /**
   * Get the surface normal at a position on a sphere
   */
  public static getSurfaceNormal(
    position: THREE.Vector3,
    center: THREE.Vector3
  ): THREE.Vector3 {
    return position.clone().sub(center).normalize();
  }

  /**
   * Align an object to the surface of a sphere
   */
  public static alignToSphere(
    object: THREE.Object3D,
    sphereCenter: THREE.Vector3,
    sphereRadius: number
  ): void {
    const surfaceNormal = this.getSurfaceNormal(object.position, sphereCenter);
    
    // Set position at correct radius
    object.position.copy(
      sphereCenter.clone().add(surfaceNormal.clone().multiplyScalar(sphereRadius))
    );

    // Align rotation to surface
    const targetQuaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      surfaceNormal
    );
    object.quaternion.copy(targetQuaternion);
  }

  /**
   * Generate evenly distributed points on a sphere using Fibonacci sphere algorithm
   */
  public static fibonacciSphere(samples: number, radius: number): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle

    for (let i = 0; i < samples; i++) {
      const y = 1 - (i / (samples - 1)) * 2; // y goes from 1 to -1
      const radiusAtY = Math.sqrt(1 - y * y); // radius at y
      const theta = phi * i;

      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;

      points.push(new THREE.Vector3(x * radius, y * radius, z * radius));
    }

    return points;
  }

  /**
   * Get a random point on a sphere surface
   */
  public static randomPointOnSphere(radius: number): THREE.Vector3 {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    return this.sphericalToCartesian(radius, theta, phi);
  }

  /**
   * Clamp a value between min and max
   */
  public static clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Linear interpolation
   */
  public static lerp(start: number, end: number, t: number): number {
    return start + (end - start) * t;
  }
}

