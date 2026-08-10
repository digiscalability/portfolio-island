// Pure economy arithmetic — leaf module (no three.js, no DOM) so tests can
// import it without booting the app (main-simple self-boots on import).
//
// Satiation (approved economy spec): each buyer takes the first
// `cap - soldToday` items of the day at full price and the rest at the
// satiated price — a soft cap on every coin faucet, surfaced diegetically
// ("icebox full", "ovens full") so it never reads as a bug.
export function saleSplit(
  n: number,
  soldToday: number,
  cap: number,
  fullPrice: number,
  satiatedPrice: number,
): { full: number; earn: number } {
  const full = Math.max(0, Math.min(n, cap - soldToday));
  return { full, earn: full * fullPrice + (n - full) * satiatedPrice };
}

/** The providers a daily special can feature (grocer deliberately excluded —
 *  it shares the canteen's produce cap, so specialing it would double-dip). */
export type ProviderKey = 'fisherman' | 'baker' | 'canteen' | 'bank' | 'carpenter';
const FEATURED_CYCLE: ProviderKey[] = ['fisherman', 'baker', 'canteen', 'bank', 'carpenter'];

/** Deterministic daily special: one provider pays a premium, rotating by day.
 *  The premium multiplies ONLY the full price (the caller keeps the satiated
 *  tail at 1c), so the faucet stays hard-capped at cap × fullPrice × mult and
 *  can never become uncapped. Pure + seedless so every client agrees on the
 *  day's special from the date alone (no backend required). */
export function featuredSell(
  dayKey: string,
  marketDay = false,
): { provider: ProviderKey; mult: number } {
  let h = 0;
  for (let i = 0; i < dayKey.length; i++) h = (h * 31 + dayKey.charCodeAt(i)) >>> 0;
  return { provider: FEATURED_CYCLE[h % FEATURED_CYCLE.length], mult: marketDay ? 2.5 : 2 };
}
