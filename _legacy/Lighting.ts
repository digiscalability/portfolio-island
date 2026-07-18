import * as THREE from 'three';

export class Lighting {
  public ambientLight: THREE.AmbientLight;
  public directionalLight: THREE.DirectionalLight;

  constructor(scene: THREE.Scene) {
    // Ambient light for overall illumination
    // Ambient light for overall illumination (acts as neutral fill)
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(this.ambientLight);

    // Hemisphere light to provide soft sky/ground fill and reduce harsh contrasts
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x444422, 0.6);
    scene.add(hemi);

    // Directional light (sun) as key light
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
    this.directionalLight.position.set(8, 18, 10);
    this.directionalLight.castShadow = true;

    // Configure shadow properties
    this.directionalLight.shadow.mapSize.width = 2048;
    this.directionalLight.shadow.mapSize.height = 2048;
    this.directionalLight.shadow.camera.near = 0.5;
    this.directionalLight.shadow.camera.far = 100;
    this.directionalLight.shadow.camera.left = -50;
    this.directionalLight.shadow.camera.right = 50;
    this.directionalLight.shadow.camera.top = 50;
    this.directionalLight.shadow.camera.bottom = -50;
    // soften shadow edges a bit and reduce light acne
    try {
      (this.directionalLight.shadow as any).radius = 3;
      this.directionalLight.shadow.bias = -0.0005;
    } catch (_e) {
      // ignore if property not supported
    }

    scene.add(this.directionalLight);
  }

  public update(_deltaTime: number): void {
    // Day/night cycle now handled by Environment system
    // This method kept for compatibility
  }
}

