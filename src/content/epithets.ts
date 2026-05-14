// Run-time epithet pool. Pure data, no imports.
//
// One epithet is rolled per run by runStore.startRun and attached to the
// player's name in the announcement overlay and RunSummary screen
// (e.g. "Lucas, you are the Forsaken." / "Sleep well, Lucas the Forsaken.").
//
// Epithets are NOT persisted — they re-roll every run.

export const EPITHETS: string[] = [
  'the Forsaken',
  'the Hollow',
  'the Last',
  'the Unbroken',
  'the Forgotten',
  'the Pyre',
  'the Marrow-Eater',
  'the Tide-Worn',
  'the Bone-Chosen',
  'the Quiet',
  'the Cinder',
  'the Withered',
];

/**
 * Pick a random epithet from the pool.
 *
 * @param rngOrSeed Optional rng function returning [0, 1). Defaults to Math.random.
 *                  Pass a seeded RNG when determinism is needed (tests, replays).
 */
export function pickRandomEpithet(rngOrSeed?: () => number): string {
  const r = rngOrSeed ?? Math.random;
  return EPITHETS[Math.floor(r() * EPITHETS.length)] ?? EPITHETS[0]!;
}
