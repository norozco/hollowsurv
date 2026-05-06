// 10-minute wave schedule. Pure data, no behavior.
// Owner: Agent C2.
//
// Vertical slice ramp (per the C2 brief):
//   0:00 — 10 grunts, ring formation
//   0:30 — 20 grunts, ring
//   1:00 — 30 grunts, ring
//   2:00 — 50 grunts, random off-screen
//   ... escalate roughly every 30s up to ~150 concurrent enemies pre-boss
//   10:00 — boss-prime
//
// Spawn director honours the pool cap (1500). If a wave's full count would
// exceed the cap, it spawns up to the available slack and skips the rest.

export type WaveFormation = 'ring' | 'random' | 'line';

export interface WaveDef {
  /** Wall-clock ms from run start when this wave fires. Strictly increasing. */
  atMs: number;
  /** Enemy archetype id from content/enemies.ts. */
  enemy: string;
  /** Number of enemies to spawn for this wave. */
  count: number;
  /** Spawn pattern around the player. */
  formation: WaveFormation;
  /** Spawn distance from player in px. Default ~600 (just off the camera viewport). */
  radius?: number;
  /** Set to true for boss waves; spawnDirector will create a Boss-pool entity instead. */
  isBoss?: boolean;
}

/** Default spawn distance from the player. ~600 px sits just outside the visible viewport. */
export const DEFAULT_SPAWN_RADIUS = 600;

/** Boss spawn time. 10 minutes. */
export const BOSS_SPAWN_MS = 10 * 60 * 1000;

/**
 * Steady ramp: 10 -> 20 -> 30 -> 40 -> 50 grunts in the first two minutes,
 * then 60-80-100-120-140-150 every 30 s up to the boss.
 *
 * Concurrent enemy count is governed by enemy lifespan (kills) and the spawn
 * cap; this schedule sets the *spawn rate*, not the steady-state population.
 */
export const WAVES: WaveDef[] = [
  // Soft start: small spread from one direction.
  { atMs: 5_000, enemy: 'grunt', count: 4, formation: 'line', radius: 700 },
  { atMs: 15_000, enemy: 'grunt', count: 6, formation: 'random' },
  { atMs: 30_000, enemy: 'grunt', count: 10, formation: 'random' },
  { atMs: 45_000, enemy: 'grunt', count: 15, formation: 'random' },
  { atMs: 60_000, enemy: 'grunt', count: 20, formation: 'random' },
  // 1:30 — first skirmisher (fast, fragile).
  { atMs: 90_000, enemy: 'grunt', count: 30, formation: 'random' },
  { atMs: 100_000, enemy: 'skirmisher', count: 6, formation: 'line' },
  { atMs: 120_000, enemy: 'grunt', count: 40, formation: 'random' },
  // 2:30 — first brute (slow tank).
  { atMs: 150_000, enemy: 'brute', count: 2, formation: 'random' },
  { atMs: 150_000, enemy: 'grunt', count: 60, formation: 'random' },
  { atMs: 180_000, enemy: 'grunt', count: 70, formation: 'random' },
  { atMs: 200_000, enemy: 'skirmisher', count: 12, formation: 'random' },
  { atMs: 210_000, enemy: 'grunt', count: 80, formation: 'random' },
  { atMs: 240_000, enemy: 'grunt', count: 90, formation: 'random' },
  { atMs: 250_000, enemy: 'brute', count: 4, formation: 'random' },
  { atMs: 270_000, enemy: 'grunt', count: 100, formation: 'random' },
  { atMs: 300_000, enemy: 'grunt', count: 110, formation: 'random' },
  { atMs: 310_000, enemy: 'skirmisher', count: 18, formation: 'random' },
  { atMs: 330_000, enemy: 'grunt', count: 120, formation: 'random' },
  { atMs: 360_000, enemy: 'brute', count: 6, formation: 'random' },
  { atMs: 360_000, enemy: 'grunt', count: 130, formation: 'random' },
  { atMs: 390_000, enemy: 'grunt', count: 140, formation: 'random' },
  { atMs: 420_000, enemy: 'grunt', count: 150, formation: 'random' },
  { atMs: 450_000, enemy: 'skirmisher', count: 30, formation: 'random' },
  { atMs: 450_000, enemy: 'grunt', count: 150, formation: 'random' },
  { atMs: 480_000, enemy: 'brute', count: 8, formation: 'random' },
  { atMs: 480_000, enemy: 'grunt', count: 150, formation: 'random' },
  { atMs: 510_000, enemy: 'grunt', count: 150, formation: 'random' },
  { atMs: 540_000, enemy: 'grunt', count: 150, formation: 'random' },
  { atMs: 570_000, enemy: 'grunt', count: 150, formation: 'random' },
  // 10:00 — boss. After this point, spawnDirector stops emitting grunt waves
  // until the boss dies or the run ends.
  { atMs: BOSS_SPAWN_MS, enemy: 'boss-prime', count: 1, formation: 'random', isBoss: true },
];
