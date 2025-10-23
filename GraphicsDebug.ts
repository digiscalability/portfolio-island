import type { Material, Object3D } from 'three';
import * as THREE from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';

import type { Renderer } from './Renderer';

type DebugHelperOptions = {
  player?: THREE.Object3D | null;
  planet?: THREE.Object3D | null;
};

export class GraphicsDebug {
  private container: HTMLElement;
  private rendererCtrl?: Renderer;
  private scene: THREE.Scene;
  private options: DebugHelperOptions;

  private stats?: Stats;
  private helperLoopHandle = 0;
  private helpers: {
    axes?: THREE.AxesHelper;
    gravity?: THREE.ArrowHelper;
    normal?: THREE.ArrowHelper;
  } = {};

  private tempPlayerPos: THREE.Vector3 = new THREE.Vector3();
  private tempPlanetPos: THREE.Vector3 = new THREE.Vector3();
  private tempDir: THREE.Vector3 = new THREE.Vector3();

  constructor(
    container: HTMLElement,
    rendererCtrl: Renderer | undefined,
    scene: THREE.Scene,
    options: DebugHelperOptions = {},
  ) {
    this.container = container;
    this.rendererCtrl = rendererCtrl;
    this.scene = scene;
    this.options = options;
    this.createUI();
  }

  private createUI(): void {
    const panel = document.createElement('div');
    panel.id = 'graphics-debug-panel';
    panel.className = 'interaction-panel';
    panel.innerHTML = `
      <h3>Graphics Debug</h3>
      <label>Exposure <input id="debug-exposure" type="range" min="0.1" max="3" step="0.05" value="1" /></label>
      <label>Bloom Strength <input id="debug-bloom-strength" type="range" min="0" max="3" step="0.05" value="0.3" /></label>
      <label>Bloom Threshold <input id="debug-bloom-threshold" type="range" min="0" max="1" step="0.01" value="1" /></label>
      <label>Bloom Radius <input id="debug-bloom-radius" type="range" min="0" max="1" step="0.01" value="0.4" /></label>
      <label>Env Map Intensity <input id="debug-env-intensity" type="range" min="0" max="2" step="0.05" value="0.8" /></label>
      <label>SSAO Kernel Radius <input id="debug-ssao-radius" type="range" min="0" max="16" step="0.5" value="8" /></label>
      <label>SSAO Min Distance <input id="debug-ssao-min" type="range" min="0.001" max="0.05" step="0.001" value="0.005" /></label>
      <label>SSAO Max Distance <input id="debug-ssao-max" type="range" min="0.05" max="1" step="0.01" value="0.2" /></label>
      <label><input id="debug-show-stats" type="checkbox" /> Show Stats (FPS)</label>
      <label><input id="debug-player-axes" type="checkbox" /> Player Axes Helper</label>
      <label><input id="debug-gravity-vector" type="checkbox" /> Gravity Vector</label>
      <label><input id="debug-surface-normal" type="checkbox" /> Surface Normal</label>
      <button id="debug-close" class="btn secondary">Close</button>
    `;
    this.container.appendChild(panel);

    setTimeout(() => {
      const exposure = document.getElementById('debug-exposure') as HTMLInputElement;
      const bloomStrength = document.getElementById('debug-bloom-strength') as HTMLInputElement;
      const bloomThreshold = document.getElementById('debug-bloom-threshold') as HTMLInputElement;
      const bloomRadius = document.getElementById('debug-bloom-radius') as HTMLInputElement;
      const envIntensity = document.getElementById('debug-env-intensity') as HTMLInputElement;
      const ssaoRadius = document.getElementById('debug-ssao-radius') as HTMLInputElement;
      const ssaoMin = document.getElementById('debug-ssao-min') as HTMLInputElement;
      const ssaoMax = document.getElementById('debug-ssao-max') as HTMLInputElement;
      const statsToggle = document.getElementById('debug-show-stats') as HTMLInputElement | null;
      const axesToggle = document.getElementById('debug-player-axes') as HTMLInputElement | null;
      const gravityToggle = document.getElementById(
        'debug-gravity-vector',
      ) as HTMLInputElement | null;
      const normalToggle = document.getElementById(
        'debug-surface-normal',
      ) as HTMLInputElement | null;
      const close = document.getElementById('debug-close');

      const applySettings = () => {
        if (this.rendererCtrl) {
          this.rendererCtrl.setExposure(parseFloat(exposure.value));
          this.rendererCtrl.setBloomParams({
            strength: parseFloat(bloomStrength.value),
            threshold: parseFloat(bloomThreshold.value),
            radius: parseFloat(bloomRadius.value),
          });
          this.rendererCtrl.setSSAOParams({
            kernelRadius: parseFloat(ssaoRadius.value),
            minDistance: parseFloat(ssaoMin.value),
            maxDistance: parseFloat(ssaoMax.value),
          });
        }
        // Update env intensity on all materials
        this.scene.traverse((obj: Object3D) => {
          if (!('material' in obj)) return;
          const material = (obj as { material?: Material | Material[] }).material;
          if (!material) return;

          const applyIntensity = (mat: Material) => {
            if (
              'envMapIntensity' in mat &&
              typeof (mat as { envMapIntensity?: unknown }).envMapIntensity !== 'undefined'
            ) {
              (mat as { envMapIntensity: number }).envMapIntensity = parseFloat(envIntensity.value);
            }
          };

          if (Array.isArray(material)) {
            material.forEach(applyIntensity);
          } else {
            applyIntensity(material);
          }
        });
      };

      exposure.addEventListener('input', applySettings);
      bloomStrength.addEventListener('input', applySettings);
      bloomThreshold.addEventListener('input', applySettings);
      bloomRadius.addEventListener('input', applySettings);
      envIntensity.addEventListener('input', applySettings);
      ssaoRadius.addEventListener('input', applySettings);
      ssaoMin.addEventListener('input', applySettings);
      ssaoMax.addEventListener('input', applySettings);

      statsToggle?.addEventListener('change', () => {
        if (statsToggle.checked) this.enableStats(panel);
        else this.disableStats(panel);
      });

      axesToggle?.addEventListener('change', () => {
        if (axesToggle.checked) this.enableAxesHelper();
        else this.disableAxesHelper();
      });

      gravityToggle?.addEventListener('change', () => {
        if (gravityToggle.checked) this.enableGravityHelper();
        else this.disableGravityHelper();
      });

      normalToggle?.addEventListener('change', () => {
        if (normalToggle.checked) this.enableNormalHelper();
        else this.disableNormalHelper();
      });

      if (close) close.addEventListener('click', () => panel.remove());
    }, 0);
  }

  private enableStats(panel: HTMLElement): void {
    if (this.stats) return;
    this.stats = new Stats();
    this.stats.dom.style.position = 'relative';
    this.stats.dom.style.marginTop = '8px';
    panel.appendChild(this.stats.dom);
    this.startHelperLoop();
  }

  private disableStats(panel: HTMLElement): void {
    if (!this.stats) return;
    panel.removeChild(this.stats.dom);
    this.stats.dom.remove();
    this.stats = undefined;
    this.stopHelperLoopIfIdle();
  }

  private enableAxesHelper(): void {
    if (this.helpers.axes) return;
    const player = this.options.player;
    const helper = new THREE.AxesHelper(1.5);
    helper.matrixAutoUpdate = true;
    helper.visible = true;
    this.helpers.axes = helper;
    if (player) {
      player.add(helper);
    } else {
      this.scene.add(helper);
    }
    this.startHelperLoop();
  }

  private disableAxesHelper(): void {
    const helper = this.helpers.axes;
    if (!helper) return;
    helper.removeFromParent();
    this.helpers.axes = undefined;
    this.stopHelperLoopIfIdle();
  }

  private enableGravityHelper(): void {
    if (this.helpers.gravity) return;
    const helper = new THREE.ArrowHelper(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(),
      3,
      0xff6b6b,
    );
    helper.name = 'GravityVectorHelper';
    this.helpers.gravity = helper;
    this.scene.add(helper);
    this.startHelperLoop();
  }

  private disableGravityHelper(): void {
    const helper = this.helpers.gravity;
    if (!helper) return;
    helper.removeFromParent();
    this.helpers.gravity = undefined;
    this.stopHelperLoopIfIdle();
  }

  private enableNormalHelper(): void {
    if (this.helpers.normal) return;
    const helper = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      3,
      0x4ade80,
    );
    helper.name = 'SurfaceNormalHelper';
    this.helpers.normal = helper;
    this.scene.add(helper);
    this.startHelperLoop();
  }

  private disableNormalHelper(): void {
    const helper = this.helpers.normal;
    if (!helper) return;
    helper.removeFromParent();
    this.helpers.normal = undefined;
    this.stopHelperLoopIfIdle();
  }

  private startHelperLoop(): void {
    if (this.helperLoopHandle) return;
    const loop = () => {
      this.helperLoopHandle = requestAnimationFrame(loop);
      this.updateHelpers();
    };
    this.helperLoopHandle = requestAnimationFrame(loop);
  }

  private stopHelperLoopIfIdle(): void {
    if (this.stats || this.helpers.axes || this.helpers.gravity || this.helpers.normal) {
      return;
    }
    if (this.helperLoopHandle) {
      cancelAnimationFrame(this.helperLoopHandle);
      this.helperLoopHandle = 0;
    }
  }

  private updateHelpers(): void {
    if (this.stats) {
      this.stats.update();
    }

    const player = this.options.player ?? null;
    if (player) {
      player.getWorldPosition(this.tempPlayerPos);
    }

    const planet = this.options.planet ?? null;
    if (planet) {
      planet.getWorldPosition(this.tempPlanetPos);
    } else {
      this.tempPlanetPos.set(0, 0, 0);
    }

    if (this.helpers.axes && player) {
      this.helpers.axes.position.set(0, 0, 0);
    }

    if ((this.helpers.gravity || this.helpers.normal) && player) {
      const origin = this.tempPlayerPos;
      const toCenter = this.tempDir.subVectors(this.tempPlanetPos, origin);
      const distance = toCenter.length();
      if (distance > 0.0001) {
        const gravityDir = toCenter.clone().normalize();
        const normalDir = gravityDir.clone().multiplyScalar(-1);

        if (this.helpers.gravity) {
          this.helpers.gravity.position.copy(origin);
          this.helpers.gravity.setDirection(gravityDir);
          this.helpers.gravity.setLength(Math.min(4, distance));
        }

        if (this.helpers.normal) {
          this.helpers.normal.position.copy(origin);
          this.helpers.normal.setDirection(normalDir);
          this.helpers.normal.setLength(Math.min(4, distance));
        }
      }
    }
  }
}
