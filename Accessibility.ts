/**
 * Accessibility — a tiny global settings singleton.
 *
 * Right now it carries one lever: `reducedMotion`. A spinning 3D planet with a
 * cinematic fly-in, follow-cam swoop, pulsing gates, and weather particles can
 * be nauseating for motion-sensitive players, so reduced motion tones those
 * down. It seeds from the OS `prefers-reduced-motion` setting, and a manual
 * toggle (persisted) overrides it. Systems read `a11y.reducedMotion` directly.
 */
class Accessibility {
  public reducedMotion = false;
  private listeners: Array<(v: boolean) => void> = [];

  public init(): void {
    try {
      const stored = localStorage.getItem('ds_reduced_motion');
      if (stored !== null) {
        this.reducedMotion = stored === '1';
        return;
      }
    } catch {
      /* localStorage blocked — fall through to the OS preference */
    }
    try {
      this.reducedMotion =
        typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reducedMotion = false;
    }
  }

  public setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    try {
      localStorage.setItem('ds_reduced_motion', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(v);
  }

  /** Subscribe to changes (e.g. to re-tune a live system). */
  public onChange(cb: (v: boolean) => void): void {
    this.listeners.push(cb);
  }
}

export const a11y = new Accessibility();
