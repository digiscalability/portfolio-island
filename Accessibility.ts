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
        this.syncRootClass();
        return;
      }
    } catch {
      /* localStorage blocked — fall through to the OS preference */
    }
    try {
      this.reducedMotion =
        typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reducedMotion = false;
    }
    this.syncRootClass();
  }

  public setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.syncRootClass();
    try {
      localStorage.setItem('ds_reduced_motion', v ? '1' : '0');
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(v);
  }

  /** Mirror the flag onto <html> so CSS can honour the IN-APP toggle the same
   *  way @media (prefers-reduced-motion) honours the OS preference. Inline
   *  styles and injected keyframes are unreachable from a media query, but
   *  not from `html.reduced-motion` rules (see style.css). */
  private syncRootClass(): void {
    try {
      document.documentElement.classList.toggle('reduced-motion', this.reducedMotion);
    } catch {
      /* no DOM (headless tests) */
    }
  }

  /** Subscribe to changes (e.g. to re-tune a live system). */
  public onChange(cb: (v: boolean) => void): void {
    this.listeners.push(cb);
  }
}

export const a11y = new Accessibility();
