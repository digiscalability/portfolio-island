import * as THREE from 'three';
import type { Material, Object3D } from 'three';

import type { Renderer } from './Renderer';

export class GraphicsDebug {
  private container: HTMLElement;
  private rendererCtrl?: Renderer;
  private scene: THREE.Scene;

  constructor(container: HTMLElement, rendererCtrl: Renderer | undefined, scene: THREE.Scene) {
    this.container = container;
    this.rendererCtrl = rendererCtrl;
    this.scene = scene;
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

      if (close) close.addEventListener('click', () => panel.remove());
    }, 0);
  }
}
