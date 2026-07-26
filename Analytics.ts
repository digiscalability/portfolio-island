/**
 * Analytics — custom conversion events on top of Vercel Web Analytics.
 *
 * Pageviews answer "did anyone visit". For a portfolio the useful question is
 * "did the island do its job" — so these events form a funnel:
 *
 *   pageview → world_ready → zone_explored → contact_opened → external_link
 *
 * `world_ready` vs pageviews is also the device-compatibility signal: a gap
 * there means visitors are arriving but never getting the 3D scene running.
 *
 * Everything is deferred, deduplicated and failure-safe — an ad-blocker, an
 * offline visitor, or a missing plan feature must never break the game. In dev
 * nothing is sent; events are logged and pushed to `window.__analyticsLog` so
 * the wiring can be asserted without polluting production numbers.
 */

type Props = Record<string, string | number | boolean | null>;

const seen = new Set<string>();

declare global {
  interface Window {
    __analyticsLog?: Array<{ name: string; props?: Props }>;
  }
}

/** Fire an event. Safe to call from anywhere; never throws. */
export function track(name: string, props?: Props): void {
  try {
    if (import.meta.env.DEV) {
      (window.__analyticsLog ??= []).push({ name, props });
      console.info('[analytics]', name, props ?? '');
      return;
    }
    void import('@vercel/analytics')
      .then((m) => m.track(name, props))
      .catch(() => {
        /* blocked, offline, or not enabled — ignore */
      });
  } catch {
    /* never let telemetry break the app */
  }
}

/**
 * Fire at most once per page session. Use for milestones, so one visitor
 * re-opening the same panel doesn't inflate the funnel.
 */
export function trackOnce(name: string, props?: Props): void {
  const key = props ? `${name}|${JSON.stringify(props)}` : name;
  if (seen.has(key)) return;
  seen.add(key);
  track(name, props);
}

/**
 * Collapse an outbound URL to a short, stable label. Full URLs make noisy
 * dimensions and can carry query junk, so only the destination is recorded.
 */
export function linkLabel(href: string): string {
  try {
    if (href.startsWith('mailto:')) return 'email';
    const host = new URL(href, window.location.href).hostname.replace(/^www\./, '');
    if (host.includes('linkedin')) return 'linkedin';
    if (host.includes('github')) return 'github';
    if (host.includes('digiscalability')) return 'digiscalability.com';
    return host || 'other';
  } catch {
    return 'other';
  }
}
