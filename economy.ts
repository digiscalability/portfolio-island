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
