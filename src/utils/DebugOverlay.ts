
// Simple DOM overlay for showing debug info while running in browser
export type OverlayPayload = {
  lines?: string[];
  metrics?: { sceneObjects?: number; geometries?: number; textures?: number; memoryMB?: number; pendingGLTF?: number };
};

export default class DebugOverlay {
  private container: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.position = 'fixed';
    this.container.style.left = '8px';
    this.container.style.bottom = '8px';
    this.container.style.padding = '6px 8px';
    this.container.style.background = 'rgba(0,0,0,0.5)';
    this.container.style.color = '#fff';
    this.container.style.fontFamily = 'monospace';
    this.container.style.fontSize = '12px';
    this.container.style.zIndex = '9999';
    this.container.style.pointerEvents = 'none';
    this.container.style.maxWidth = '360px';
    this.container.style.maxHeight = '50vh';
    this.container.style.overflow = 'auto';
    document.body.appendChild(this.container);
  }

  // Backwards-compatible: accept array of lines or a payload object
  update(payload: string[] | OverlayPayload) {
    let lines: string[] = [];
    let metrics: OverlayPayload['metrics'] | undefined;
    if (Array.isArray(payload)) lines = payload;
    else { lines = payload.lines || []; metrics = payload.metrics; }

    const metricLines: string[] = [];
    if (metrics) {
      if (typeof metrics.sceneObjects === 'number') metricLines.push(`objects: ${metrics.sceneObjects}`);
      if (typeof metrics.geometries === 'number') metricLines.push(`geoms: ${metrics.geometries}`);
      if (typeof metrics.textures === 'number') metricLines.push(`textures: ${metrics.textures}`);
      if (typeof metrics.memoryMB === 'number') metricLines.push(`mem: ${metrics.memoryMB.toFixed(1)} MB`);
      if (typeof metrics.pendingGLTF === 'number') metricLines.push(`pendingGLTF: ${metrics.pendingGLTF}`);
    }

    const all = (metricLines.length ? [`--- ${metricLines.join(' | ')}`, ''] : []).concat(lines || []);
    this.container.innerHTML = all.map(l => `<div>${l}</div>`).join('');
  }

  dispose() {
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }
}
