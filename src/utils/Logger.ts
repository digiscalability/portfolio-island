import DebugOverlay from './DebugOverlay';

type LogEntry = { ts: number; level: 'log'|'info'|'warn'|'error'|'debug'; msg: string };

class Logger {
  private overlay?: DebugOverlay;
  private buffer: LogEntry[] = [];
  private maxBuffer = 200;
  private installed = false;
  public enabled = true;
  private latestMetrics?: { sceneObjects?: number; geometries?: number; textures?: number; memoryMB?: number; pendingGLTF?: number };

  init() {
    if (this.installed) return;
    try {
      this.overlay = new DebugOverlay();
    } catch (e) {}
    this.hookConsole();
    this.installed = true;
    (window as any).__LOGGER = this;
  }

  private push(level: LogEntry['level'], args: any[]) {
    if (!this.enabled) return;
    const msg = args.map(a => {
      try { if (typeof a === 'object') return JSON.stringify(a); } catch (e) {}
      try { return String(a); } catch (e) { return '<unprintable>'; }
    }).join(' ');
    const entry: LogEntry = { ts: Date.now(), level, msg };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.renderOverlay();
  }

  private renderOverlay() {
    if (!this.overlay) return;
    const lines = this.buffer.slice(-20).map(e => {
      const t = new Date(e.ts).toLocaleTimeString();
      const prefix = `[${t}] ${e.level.toUpperCase()}: `;
      return prefix + e.msg;
    });
    const payload: any = { lines: lines.reverse() };
    if (this.latestMetrics) payload.metrics = this.latestMetrics;
    this.overlay.update(payload);
  }

  // Allow external code to pass system metrics (counts, memory) to be displayed alongside logs
  public updateMetrics(metrics: { sceneObjects?: number; geometries?: number; textures?: number; memoryMB?: number; pendingGLTF?: number }) {
    this.latestMetrics = metrics;
    try { this.renderOverlay(); } catch (e) {}
  }

  private hookConsole() {
    const orig = { ...console } as any;
    const levels: Array<LogEntry['level']> = ['log','info','warn','error','debug'];
    for (const l of levels) {
      (console as any)[l] = (...args: any[]) => {
        try { this.push(l, args); } catch (e) {}
        try { orig[l].apply(console, args); } catch (e) {}
      };
    }
    // capture unhandled rejections and errors
    window.addEventListener('error', (ev) => {
      try { this.push('error', [ev.message || 'window error', ev.filename || '', ev.lineno || '', ev.colno || '']); } catch (e) {}
    });
    window.addEventListener('unhandledrejection', (ev: any) => {
      try { this.push('error', ['unhandledrejection', ev.reason || ev]); } catch (e) {}
    });
  }

  setEnabled(v: boolean) { this.enabled = v; if (!v && this.overlay) this.overlay.update([]); }
  getRecent() { return this.buffer.slice(); }
}

const logger = new Logger();
export default logger;
