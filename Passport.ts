/**
 * Portfolio Passport.
 *
 * The island is fun, but its job is to route visitors through the actual work.
 * The passport turns that into a light game loop: visiting each of the four
 * substantive portfolio zones stamps the passport, and collecting all four
 * unlocks the Founder's Golden Crown. "Welcome" is the intro, not a stamp.
 *
 * State is persisted in localStorage so progress (and the reward) survive
 * reloads. This module is pure state + callbacks; the UI and reward-granting
 * live in SimpleUI / main-simple.
 */

export const PASSPORT_ZONES = ['professional', 'projects', 'personal', 'contact'] as const;
export type PassportZone = (typeof PASSPORT_ZONES)[number];

/** Display label + icon for each stamp (kept in sync with the portfolio menu). */
export const PASSPORT_META: Record<PassportZone, { icon: string; label: string }> = {
  professional: { icon: '💼', label: 'Professional' },
  projects: { icon: '🚀', label: 'Projects' },
  personal: { icon: '🎨', label: 'Personal' },
  contact: { icon: '📬', label: 'Contact' },
};

const STORAGE_VISITED = 'ds_passport';
const STORAGE_REWARD = 'ds_passport_reward';

function isPassportZone(zone: string): zone is PassportZone {
  return (PASSPORT_ZONES as readonly string[]).includes(zone);
}

export class Passport {
  private visited = new Set<PassportZone>();
  private rewardGranted = false;
  private onComplete: (() => void) | null = null;

  constructor() {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_VISITED) ?? '[]');
      if (Array.isArray(saved)) {
        for (const z of saved) if (typeof z === 'string' && isPassportZone(z)) this.visited.add(z);
      }
      this.rewardGranted = localStorage.getItem(STORAGE_REWARD) === '1';
    } catch {
      /* fresh passport */
    }
  }

  /** Fired the first time the passport becomes complete (reward moment). */
  setOnComplete(cb: () => void): void {
    this.onComplete = cb;
  }

  isStampZone(zone: string): boolean {
    return isPassportZone(zone);
  }
  has(zone: string): boolean {
    return isPassportZone(zone) && this.visited.has(zone);
  }
  count(): number {
    return this.visited.size;
  }
  total(): number {
    return PASSPORT_ZONES.length;
  }
  isComplete(): boolean {
    return this.visited.size >= PASSPORT_ZONES.length;
  }
  rewardAlreadyGranted(): boolean {
    return this.rewardGranted;
  }

  /**
   * Record a visit. Returns true only if this was a NEW stamp (so the caller
   * can show a one-off "stamped!" toast). Fires onComplete once, when the last
   * stamp lands and the reward hasn't been granted before.
   */
  visit(zone: string): boolean {
    if (!isPassportZone(zone) || this.visited.has(zone)) return false;
    this.visited.add(zone);
    this.persist();
    if (this.isComplete() && !this.rewardGranted) {
      this.rewardGranted = true;
      try {
        localStorage.setItem(STORAGE_REWARD, '1');
      } catch {
        /* ignore */
      }
      this.onComplete?.();
    }
    return true;
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_VISITED, JSON.stringify([...this.visited]));
    } catch {
      /* ignore */
    }
  }
}
