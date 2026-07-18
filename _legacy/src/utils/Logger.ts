import DebugOverlay, { OverlayPayload } from './DebugOverlay';

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
    } catch {
      /* ignore overlay creation failures */
    }
    this.hookConsole();
    this.installed = true;
    window.__LOGGER = this;
  }

  private formatArg(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
      return String(value);
    }
    if (value instanceof Error) {
      return value.stack ?? value.message;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private push(level: LogEntry['level'], args: unknown[]) {
    if (!this.enabled) return;
    const msg = args.map((arg) => this.formatArg(arg)).join(' ');
    const entry: LogEntry = { ts: Date.now(), level, msg };
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.renderOverlay();
  }

  private renderOverlay() {
    if (!this.overlay) return;
    const lines = this.buffer.slice(-20).map((entry) => {
      const t = new Date(entry.ts).toLocaleTimeString();
      const prefix = `[${t}] ${entry.level.toUpperCase()}: `;
      return prefix + entry.msg;
    });
    const payload: OverlayPayload = {
      lines: [...lines].reverse(),
      metrics: this.latestMetrics,
    };
    this.overlay.update(payload);
  }

  // Allow external code to pass system metrics (counts, memory) to be displayed alongside logs
  public updateMetrics(metrics: { sceneObjects?: number; geometries?: number; textures?: number; memoryMB?: number; pendingGLTF?: number }) {
    this.latestMetrics = metrics;
    this.renderOverlay();
  }

  private hookConsole() {
    const original = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    } satisfies Record<LogEntry['level'], (...args: unknown[]) => void>;
    const levels: Array<LogEntry['level']> = ['log','info','warn','error','debug'];
    const consoleMutable = console as Console & Record<LogEntry['level'], (...args: unknown[]) => void>;
    for (const l of levels) {
      consoleMutable[l] = (...args: unknown[]) => {
        this.push(l, args);
        original[l](...args);
      };
    }
    // capture unhandled rejections and errors
    window.addEventListener('error', (ev) => {
      this.push('error', [ev.message ?? 'window error', ev.filename ?? '', ev.lineno ?? '', ev.colno ?? '']);
    });
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      this.push('error', ['unhandledrejection', ev.reason ?? 'unknown reason']);
    });
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v && this.overlay) this.overlay.update([]);
  }

  getRecent() {
    return this.buffer.slice();
  }
}

const logger = new Logger();
export default logger;

declare global {
  interface Window {
    __LOGGER?: Logger;
  }
}
