/**
 * Secrets — the island's rumor-driven discovery loop (Outer Wilds pattern
 * from the engagement research, client-authored v1).
 *
 * Nine authored secret spots at real landmarks. Their RUMOR lines surface in
 * two places — the Island Journal's ledger ("Secrets: n of 9", cryptic lines
 * for the unfound) and, occasionally, woven verbatim into AI-NPC chat
 * openings (the LLM flavors AROUND the authored sentence; it cannot corrupt
 * directions it never generates). Walking within the discovery radius of a
 * spot finds it: flash + chime + a few coins + a journal tick.
 *
 * Positions are resolved at runtime by main-simple (they live on Island /
 * GameScene); this module owns only definitions + persistence (the Passport
 * pattern: Set + localStorage, discover() true only on NEW finds).
 */

export interface SecretDef {
  id: string;
  /** Cryptic hint shown in the journal + fed to NPC chat. */
  rumor: string;
  /** Revealed name on the found flash + journal. */
  title: string;
}

export const SECRETS: SecretDef[] = [
  {
    id: 'lighthouse',
    rumor: 'They say the keeper tends a spark that has never once gone out.',
    title: 'The Ever-Lit Lamp',
  },
  {
    id: 'summit',
    rumor: 'Something glints where the trail runs out of mountain.',
    title: 'The Summit Beacon',
  },
  {
    id: 'garden',
    rumor: 'The Gardener hums to something hidden behind her walls.',
    title: 'The Walled Garden',
  },
  {
    id: 'scarecrow',
    rumor: 'Farmhands swear the scarecrow wears a different smile at dusk.',
    title: "The Scarecrow's Post",
  },
  {
    id: 'bandstand',
    rumor: 'Listen close at the bandstand — the wind hums along.',
    title: "The Musician's Stage",
  },
  {
    id: 'easel',
    rumor: 'The Artist never shows anyone what is on the canvas.',
    title: "The Artist's Vantage",
  },
  {
    id: 'story-circle',
    rumor: 'Old tales gather wherever the logs make a ring.',
    title: 'The Story Circle',
  },
  {
    id: 'heron-shore',
    rumor: 'Two grey fishers know the quietest stretch of shore.',
    title: 'The Heron Shallows',
  },
  {
    id: 'hall',
    rumor: 'Every journey on this island is said to begin at the same door.',
    title: 'The Town Hall Steps',
  },
];

const KEY = 'ds_secrets';

export class Secrets {
  private found = new Set<string>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) for (const id of JSON.parse(raw) as string[]) this.found.add(id);
    } catch {
      /* fresh ledger */
    }
  }

  has(id: string): boolean {
    return this.found.has(id);
  }

  /** True only on a NEW find (the Passport.visit contract). */
  discover(id: string): boolean {
    if (this.found.has(id) || !SECRETS.some((s) => s.id === id)) return false;
    this.found.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.found]));
    } catch {
      /* session-only */
    }
    return true;
  }

  count(): number {
    return this.found.size;
  }

  total(): number {
    return SECRETS.length;
  }

  /** Cryptic lines for secrets still out there (journal + NPC rumor feed). */
  unfoundRumors(): string[] {
    return SECRETS.filter((s) => !this.found.has(s.id)).map((s) => s.rumor);
  }
}
