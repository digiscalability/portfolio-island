/**
 * Unit tests for MathUtils.
 * Run with: npx vitest or npx jest (depending on project setup).
 *
 * Note: Three.js is mocked below so these tests run in Node without WebGL.
 */

// Minimal THREE.Vector3 stub so tests run without a browser/WebGL context.
jest.mock('three', () => {
  class Vector3 {
    x: number;
    y: number;
    z: number;
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
    sub(v: Vector3) {
      return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
    }
    normalize() {
      const len = Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
      if (len === 0) return this;
      this.x /= len;
      this.y /= len;
      this.z /= len;
      return this;
    }
    add(v: Vector3) {
      return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
    }
    multiplyScalar(s: number) {
      return new Vector3(this.x * s, this.y * s, this.z * s);
    }
    copy(v: Vector3) {
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
      return this;
    }
    distanceTo(v: Vector3) {
      return Math.sqrt((this.x - v.x) ** 2 + (this.y - v.y) ** 2 + (this.z - v.z) ** 2);
    }
    length() {
      return Math.sqrt(this.x ** 2 + this.y ** 2 + this.z ** 2);
    }
  }

  // Stub Object3D so alignToSphere doesn't crash
  class Object3D {
    position = new Vector3();
    quaternion = { copy: jest.fn() };
  }

  class Quaternion {
    setFromUnitVectors = jest.fn().mockReturnValue(this);
  }

  return { Vector3, Object3D, Quaternion };
});

import { MathUtils } from './MathUtils';
import * as THREE from 'three';

describe('MathUtils.clamp', () => {
  it('clamps below min', () => expect(MathUtils.clamp(-5, 0, 10)).toBe(0));
  it('clamps above max', () => expect(MathUtils.clamp(15, 0, 10)).toBe(10));
  it('leaves in-range values unchanged', () => expect(MathUtils.clamp(5, 0, 10)).toBe(5));
  it('handles min === max', () => expect(MathUtils.clamp(7, 3, 3)).toBe(3));
});

describe('MathUtils.lerp', () => {
  it('returns start at t=0', () => expect(MathUtils.lerp(0, 100, 0)).toBe(0));
  it('returns end at t=1', () => expect(MathUtils.lerp(0, 100, 1)).toBe(100));
  it('returns midpoint at t=0.5', () => expect(MathUtils.lerp(0, 100, 0.5)).toBe(50));
  it('handles negative values', () => expect(MathUtils.lerp(-10, 10, 0.5)).toBe(0));
});

describe('MathUtils.sphericalToCartesian', () => {
  it('places point at north pole (phi=0)', () => {
    const v = MathUtils.sphericalToCartesian(1, 0, 0);
    expect(v.y).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });

  it('produces a point on the equator (phi=PI/2, theta=0)', () => {
    const v = MathUtils.sphericalToCartesian(1, 0, Math.PI / 2);
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(0);
  });

  it('scales by radius', () => {
    const v = MathUtils.sphericalToCartesian(5, 0, 0);
    expect(v.y).toBeCloseTo(5);
  });
});

describe('MathUtils.getSurfaceNormal', () => {
  it('returns unit vector pointing away from centre', () => {
    const pos = new THREE.Vector3(3, 4, 0);
    const center = new THREE.Vector3(0, 0, 0);
    const normal = MathUtils.getSurfaceNormal(pos, center);
    expect(normal.length()).toBeCloseTo(1);
    expect(normal.x).toBeCloseTo(0.6);
    expect(normal.y).toBeCloseTo(0.8);
  });
});

describe('MathUtils.fibonacciSphere', () => {
  it('returns the requested number of points', () => {
    const pts = MathUtils.fibonacciSphere(50, 1);
    expect(pts).toHaveLength(50);
  });

  it('all points lie on the sphere surface (radius 5)', () => {
    const radius = 5;
    const pts = MathUtils.fibonacciSphere(20, radius);
    pts.forEach((p) => {
      expect(p.length()).toBeCloseTo(radius, 1);
    });
  });
});

describe('MathUtils.randomPointOnSphere', () => {
  it('returns a point on the sphere surface', () => {
    const radius = 10;
    const pt = MathUtils.randomPointOnSphere(radius);
    expect(pt.length()).toBeCloseTo(radius, 1);
  });
});
