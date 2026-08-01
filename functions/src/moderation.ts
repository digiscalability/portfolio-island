/**
 * Server-side moderation for the NPC brain — a compact mirror of the client
 * Moderation.ts intent. Runs on BOTH the visitor's message (in) and the model's
 * reply (out), so nothing offensive is ever fed to the model OR echoed above an
 * avatar on this public, brand-bearing site.
 *
 * The normaliser folds leetspeak, padding and repeats AND strips every
 * non-letter — so spacing evasion ("n i g g e r") collapses to a plain word and
 * is caught by the same anywhere-match test.
 */

// Severe terms — matched anywhere in the normalised text.
const SLURS = [
  'nigger', 'nigga', 'faggot', 'fagot', 'retard', 'chink', 'spic', 'kike',
  'wetback', 'tranny', 'towelhead', 'paki', 'coon', 'gook', 'beaner', 'raghead',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[4@]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, '') // drop padding/space/punct → spacing evasion collapses
    .replace(/(.)\1{2,}/g, '$1$1'); // collapse 3+ repeats (haaate → haate)
}

/** True if the text contains a severe slur under evasion-normalisation. */
export function containsSlur(text: string): boolean {
  const n = normalize(text);
  return SLURS.some((w) => n.includes(w));
}

/**
 * Sanitise the model's reply for public display. Returns '' to mean "reject
 * this reply entirely" (the caller then degrades to a canned line) — we never
 * partially publish a reply that tripped the filter.
 */
export function scrubReply(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!t) return '';
  return containsSlur(t) ? '' : t;
}
