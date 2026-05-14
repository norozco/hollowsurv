// Seedable RNG (Mulberry32). Used for daily-seeded runs so everyone today gets
// the same enemy/spawn/loot sequence.
//
// Usage:
//   - At run start, call `setRngSeed(todaysSeed())` for daily mode, or
//     `setRngSeed(null)` for normal mode (falls through to Math.random).
//   - Hot paths that need to participate in determinism (spawn formation seeds,
//     level-up offer pools, epithet selection) call `rng()` instead of
//     `Math.random()`.
//
// Why module-global state? RunStore.startRun() switches the seed once per run.
// Every consumer reads via `rng()` — no need to thread a function through 12
// system signatures.

let _seededState: number | null = null;

/** Set or clear the global seed. Pass null to fall back to Math.random. */
export function setRngSeed(seed: number | null): void {
  _seededState = seed === null ? null : seed >>> 0;
}

/** True if a deterministic seed is currently active. */
export function isSeeded(): boolean {
  return _seededState !== null;
}

/** Get the next random number 0..1. Uses Math.random unless setRngSeed was called. */
export function rng(): number {
  if (_seededState === null) return Math.random();
  // Mulberry32
  let t = (_seededState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Compute today's daily seed from local date (YYYYMMDD as integer). Resets at midnight local time. */
export function todaysSeed(): number {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return parseInt(`${yyyy}${mm}${dd}`, 10);
}

/** Date key like '2026-05-07' for storing daily bests. */
export function todaysKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
