import * as THREE from 'three';

/**
 * Environment system for dynamic sky, clouds, sun, moon, stars, and day/night cycle
 */
export class Environment {
  private scene: THREE.Scene;
  private sky: THREE.Mesh;
  private clouds: THREE.Group;
  private stars: THREE.Points;
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private sunLight: THREE.DirectionalLight;

  public timeOfDay: number = 0.35; // 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset, 1.0 = midnight
  public cycleDuration: number = 180; // seconds for full day/night cycle (3 minutes)
  public autoCycle: boolean = true; // automatically cycle through day/night

  // Color schemes for different times of day
  private readonly colorSchemes = {
    night: {
      sky: new THREE.Color(0x0a0a1a),
      horizon: new THREE.Color(0x1a1a2e),
      fog: new THREE.Color(0x0a0a1a),
      ambient: new THREE.Color(0x1a1a3a),
      sunLight: new THREE.Color(0x2a2a4a),
      sunIntensity: 0.05
    },
    sunrise: {
      sky: new THREE.Color(0xff6b35),
      horizon: new THREE.Color(0xffaa66),
      fog: new THREE.Color(0xffd4a3),
      ambient: new THREE.Color(0xffccaa),
      sunLight: new THREE.Color(0xffaa66),
      sunIntensity: 0.6
    },
    day: {
      sky: new THREE.Color(0x87ceeb),
      horizon: new THREE.Color(0xadd8e6),
      fog: new THREE.Color(0xddeeff),
      ambient: new THREE.Color(0xffffff),
      sunLight: new THREE.Color(0xffffff),
      sunIntensity: 1.0
    },
    sunset: {
      sky: new THREE.Color(0xff4500),
      horizon: new THREE.Color(0xff6347),
      fog: new THREE.Color(0xffaa88),
      ambient: new THREE.Color(0xffaa88),
      sunLight: new THREE.Color(0xff8844),
      sunIntensity: 0.5
    }
  };

  constructor(scene: THREE.Scene, sunLight: THREE.DirectionalLight) {
    this.scene = scene;
    this.sunLight = sunLight;

    // Create sky dome
    this.sky = this.createSkyDome();
    this.scene.add(this.sky);

    // Create clouds
    this.clouds = this.createClouds();
    this.scene.add(this.clouds);

    // Create stars
    this.stars = this.createStars();
    this.scene.add(this.stars);

    // Create sun
    this.sun = this.createCelestialBody(3, 0xffff00, true);
    this.scene.add(this.sun);

    // Create moon
    this.moon = this.createCelestialBody(2.5, 0xddddff, false);
    this.scene.add(this.moon);

    // Initial update
    this.updateEnvironment(0);
  }

  /**
   * Create a gradient sky dome
   */
  private createSkyDome(): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(450, 32, 32);

    // Create shader material for dynamic gradient sky
    const material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x87ceeb) },
        bottomColor: { value: new THREE.Color(0xffffff) },
        offset: { value: 33 },
        exponent: { value: 0.6 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPosition.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
      side: THREE.BackSide
    });

    return new THREE.Mesh(geometry, material);
  }

  /**
   * Create volumetric clouds
   */
  private createClouds(): THREE.Group {
    const cloudGroup = new THREE.Group();
    const cloudCount = 25;
    const cloudRadius = 200; // orbit radius around island

    for (let i = 0; i < cloudCount; i++) {
      const cloud = this.createSingleCloud();

      // Position clouds in a sphere around the island at varying heights
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.3 + Math.PI * 0.25; // Keep clouds in upper hemisphere

      cloud.position.set(
        Math.sin(phi) * Math.cos(theta) * cloudRadius,
        Math.abs(Math.cos(phi) * cloudRadius * 0.5) + 30, // Height between 30-130
        Math.sin(phi) * Math.sin(theta) * cloudRadius
      );

      cloud.rotation.y = Math.random() * Math.PI * 2;
      cloud.userData.speed = 0.3 + Math.random() * 0.5; // Random drift speed
      cloud.userData.orbitSpeed = (0.01 + Math.random() * 0.02) * (Math.random() > 0.5 ? 1 : -1);

      cloudGroup.add(cloud);
    }

    return cloudGroup;
  }

  /**
   * Create a single fluffy cloud from spheres
   */
  private createSingleCloud(): THREE.Group {
    const cloud = new THREE.Group();
    const geometry = new THREE.SphereGeometry(1, 8, 8);
    const material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false
    });

    // Create cloud puffs
    const puffCount = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < puffCount; i++) {
      const puff = new THREE.Mesh(geometry, material);
      const scale = 3 + Math.random() * 4;
      puff.scale.set(scale, scale * 0.6, scale * 0.8);
      puff.position.set(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 6
      );
      cloud.add(puff);
    }

    const cloudScale = 0.8 + Math.random() * 0.6;
    cloud.scale.set(cloudScale, cloudScale, cloudScale);

    return cloud;
  }

  /**
   * Create starfield for night sky
   */
  private createStars(): THREE.Points {
    const starCount = 3000;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      // Random position on sphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const radius = 400;

      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * radius;
      positions[i * 3 + 1] = Math.cos(phi) * radius;
      positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * radius;

      // Star colors (white, blue-white, yellow-white)
      const colorChoice = Math.random();
      if (colorChoice < 0.7) {
        // White stars
        colors[i * 3] = 1.0;
        colors[i * 3 + 1] = 1.0;
        colors[i * 3 + 2] = 1.0;
      } else if (colorChoice < 0.85) {
        // Blue-white stars
        colors[i * 3] = 0.8;
        colors[i * 3 + 1] = 0.9;
        colors[i * 3 + 2] = 1.0;
      } else {
        // Yellow-white stars
        colors[i * 3] = 1.0;
        colors[i * 3 + 1] = 0.95;
        colors[i * 3 + 2] = 0.8;
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.0, // Start invisible, fade in at night
      sizeAttenuation: false
    });

    return new THREE.Points(geometry, material);
  }

  /**
   * Create sun or moon sphere
   */
  private createCelestialBody(size: number, color: number, emissive: boolean): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(size, 32, 32);
    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 1.0
    });

    if (emissive) {
      // Sun glows
      (material as any).emissive = new THREE.Color(color);
      (material as any).emissiveIntensity = 0.8;
    }

    const mesh = new THREE.Mesh(geometry, material);
    return mesh;
  }

  /**
   * Update environment based on time of day
   */
  public update(deltaTime: number): void {
    // Auto-cycle day/night
    if (this.autoCycle) {
      this.timeOfDay += deltaTime / this.cycleDuration;
      if (this.timeOfDay >= 1.0) {
        this.timeOfDay -= 1.0;
      }
    }

    this.updateEnvironment(deltaTime);
  }

  /**
   * Update all environment elements
   */
  private updateEnvironment(deltaTime: number): void {
    // Calculate interpolated colors based on time of day
    const colors = this.getInterpolatedColors();

    // Update sky dome
    const skyMaterial = this.sky.material as THREE.ShaderMaterial;
    skyMaterial.uniforms.topColor.value.copy(colors.sky);
    skyMaterial.uniforms.bottomColor.value.copy(colors.horizon);

    // Update fog
    if (this.scene.fog && this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(colors.fog);
    }

    // Update sun and moon positions
    this.updateCelestialBodies();

    // Update stars visibility (visible at night)
    const starsMaterial = this.stars.material as THREE.PointsMaterial;
    const nightFactor = this.getNightFactor();
    starsMaterial.opacity = nightFactor * 0.9;

    // Update sun light
    this.sunLight.color.copy(colors.sunLight);
    this.sunLight.intensity = colors.sunIntensity;

    // Animate clouds
    this.animateClouds(deltaTime);

    // Gentle star rotation
    this.stars.rotation.y += deltaTime * 0.002;
  }

  /**
   * Get color scheme interpolated between time periods
   */
  private getInterpolatedColors() {
    let scheme1, scheme2, blend: number;

    if (this.timeOfDay < 0.2) {
      // Night to sunrise (0.0 - 0.2)
      scheme1 = this.colorSchemes.night;
      scheme2 = this.colorSchemes.sunrise;
      blend = this.timeOfDay / 0.2;
    } else if (this.timeOfDay < 0.4) {
      // Sunrise to day (0.2 - 0.4)
      scheme1 = this.colorSchemes.sunrise;
      scheme2 = this.colorSchemes.day;
      blend = (this.timeOfDay - 0.2) / 0.2;
    } else if (this.timeOfDay < 0.7) {
      // Day (0.4 - 0.7)
      scheme1 = this.colorSchemes.day;
      scheme2 = this.colorSchemes.day;
      blend = 0;
    } else if (this.timeOfDay < 0.85) {
      // Day to sunset (0.7 - 0.85)
      scheme1 = this.colorSchemes.day;
      scheme2 = this.colorSchemes.sunset;
      blend = (this.timeOfDay - 0.7) / 0.15;
    } else {
      // Sunset to night (0.85 - 1.0)
      scheme1 = this.colorSchemes.sunset;
      scheme2 = this.colorSchemes.night;
      blend = (this.timeOfDay - 0.85) / 0.15;
    }

    return {
      sky: new THREE.Color().lerpColors(scheme1.sky, scheme2.sky, blend),
      horizon: new THREE.Color().lerpColors(scheme1.horizon, scheme2.horizon, blend),
      fog: new THREE.Color().lerpColors(scheme1.fog, scheme2.fog, blend),
      ambient: new THREE.Color().lerpColors(scheme1.ambient, scheme2.ambient, blend),
      sunLight: new THREE.Color().lerpColors(scheme1.sunLight, scheme2.sunLight, blend),
      sunIntensity: THREE.MathUtils.lerp(scheme1.sunIntensity, scheme2.sunIntensity, blend)
    };
  }

  /**
   * Calculate how "night-like" it currently is (0 = day, 1 = night)
   */
  private getNightFactor(): number {
    // Night is strongest at 0.0 and 1.0, weakest at 0.5
    const distFromNoon = Math.abs(this.timeOfDay - 0.5);
    return Math.max(0, Math.min(1, (distFromNoon - 0.15) / 0.35));
  }

  /**
   * Update sun and moon positions in sky
   */
  private updateCelestialBodies(): void {
    // Sun follows day cycle (rises at 0.25, sets at 0.75)
    const sunAngle = (this.timeOfDay - 0.25) * Math.PI * 2;
    const celestialRadius = 300;

    this.sun.position.set(
      Math.cos(sunAngle) * celestialRadius,
      Math.sin(sunAngle) * celestialRadius,
      50
    );

    // Moon is opposite to sun
    const moonAngle = sunAngle + Math.PI;
    this.moon.position.set(
      Math.cos(moonAngle) * celestialRadius,
      Math.sin(moonAngle) * celestialRadius,
      50
    );

    // Update directional light position to follow sun
    this.sunLight.position.copy(this.sun.position).normalize().multiplyScalar(100);

    // Fade sun/moon visibility based on their height
    const sunHeight = Math.sin(sunAngle);
    const moonHeight = Math.sin(moonAngle);

    (this.sun.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, sunHeight + 0.3));
    (this.moon.material as THREE.MeshBasicMaterial).opacity = Math.max(0, Math.min(1, moonHeight + 0.3));
  }

  /**
   * Animate clouds drifting and orbiting
   */
  private animateClouds(deltaTime: number): void {
    this.clouds.children.forEach((cloud) => {
      // Drift animation
      cloud.position.x += Math.sin(cloud.userData.speed * Date.now() * 0.0001) * deltaTime * 0.5;
      cloud.position.z += Math.cos(cloud.userData.speed * Date.now() * 0.0001) * deltaTime * 0.5;

      // Gentle orbital rotation
      const angle = cloud.userData.orbitSpeed * deltaTime;
      const x = cloud.position.x;
      const z = cloud.position.z;
      cloud.position.x = x * Math.cos(angle) - z * Math.sin(angle);
      cloud.position.z = x * Math.sin(angle) + z * Math.cos(angle);

      // Gentle bobbing
      cloud.position.y += Math.sin(Date.now() * 0.0005 + cloud.userData.speed) * deltaTime * 0.1;
    });

    // Slowly rotate entire cloud layer for variety
    this.clouds.rotation.y += deltaTime * 0.005;
  }

  /**
   * Set specific time of day (0.0 - 1.0)
   */
  public setTimeOfDay(time: number): void {
    this.timeOfDay = Math.max(0, Math.min(1, time));
    this.updateEnvironment(0);
  }

  /**
   * Toggle auto day/night cycle
   */
  public setAutoCycle(enabled: boolean): void {
    this.autoCycle = enabled;
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    // Dispose sky
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();

    // Dispose clouds
    this.clouds.children.forEach((cloud) => {
      cloud.children.forEach((puff) => {
        (puff as THREE.Mesh).geometry.dispose();
        ((puff as THREE.Mesh).material as THREE.Material).dispose();
      });
    });

    // Dispose stars
    this.stars.geometry.dispose();
    (this.stars.material as THREE.Material).dispose();

    // Dispose celestial bodies
    this.sun.geometry.dispose();
    (this.sun.material as THREE.Material).dispose();
    this.moon.geometry.dispose();
    (this.moon.material as THREE.Material).dispose();

    // Remove from scene
    this.scene.remove(this.sky);
    this.scene.remove(this.clouds);
    this.scene.remove(this.stars);
    this.scene.remove(this.sun);
    this.scene.remove(this.moon);
  }
}
