// Enemy archetype definitions. Pure data, no Phaser/React/ECS imports.
// Owner: Agent C2.
//
// Vertical slice ships two archetypes:
//   - 'grunt'      — baseline melee chaser. Wave fodder.
//   - 'boss-prime' — single 10:00 boss. Slow, tanky, hits hard.
//
// Other archetypes (runner/tank/shooter) reserved in the type union for later
// content drops; spawnDirector ignores anything not in ENEMIES.

export type EnemyArchetype =
  | 'grunt' // baseline melee chaser
  | 'runner' // fast, low hp (reserved)
  | 'tank' // slow, high hp (reserved)
  | 'shooter' // ranged (reserved)
  | 'boss';

export interface EnemyDefinition {
  id: string; // kebab-case, stable forever
  archetype: EnemyArchetype;
  hp: number;
  damage: number;
  /** Movement speed in px/s at moveSpeedMul = 1. */
  moveSpeed: number;
  hitboxRadius: number;
  /** Hex tint for the placeholder rectangle and (later) the sprite. */
  tint: number;
  /** Atlas index for the render system. v1 uses placeholder rectangles; this is reserved. */
  textureIndex: number;
  xpDrop: number;
  isBoss: boolean;
}

export const ENEMIES: Record<string, EnemyDefinition> = {
  grunt: {
    id: 'grunt',
    archetype: 'grunt',
    hp: 30,
    damage: 10,
    moveSpeed: 130,
    hitboxRadius: 20,
    tint: 0xc94a4a,
    textureIndex: 0,
    xpDrop: 1,
    isBoss: false,
  },
  // Fast, fragile harasser. Smaller and brighter than grunts. Punishes standing still.
  skirmisher: {
    id: 'skirmisher',
    archetype: 'runner',
    hp: 18,
    damage: 6,
    moveSpeed: 220,
    hitboxRadius: 14,
    tint: 0xffaa3c,
    textureIndex: 0,
    xpDrop: 1,
    isBoss: false,
  },
  // Slow, beefy tank. Big hitbox + heavy contact damage. Best avoided.
  brute: {
    id: 'brute',
    archetype: 'tank',
    hp: 280,
    damage: 22,
    moveSpeed: 70,
    hitboxRadius: 32,
    tint: 0x6044a8,
    textureIndex: 0,
    xpDrop: 5,
    isBoss: false,
  },
  // Balance pass: 5000 -> 3500 HP. The 10-min boss should be hard but killable
  // with a rebalanced weapon roster; 5000 was a kill-time wall. Kept as the
  // fallback boss when no Hollow has been chosen (e.g. the player died before
  // the 5:00 portal mark).
  'boss-prime': {
    id: 'boss-prime',
    archetype: 'boss',
    hp: 3500,
    damage: 25,
    moveSpeed: 60,
    hitboxRadius: 80,
    tint: 0x8a2be2,
    textureIndex: 1,
    xpDrop: 50,
    isBoss: true,
  },
  // Bone Hollow final boss. The king of the marrow road — durable but slower.
  marrowking: {
    id: 'marrowking',
    archetype: 'boss',
    hp: 4000,
    damage: 30,
    moveSpeed: 80,
    hitboxRadius: 80,
    tint: 0xeeeeee,
    textureIndex: 1,
    xpDrop: 50,
    isBoss: true,
  },
  // Ember Hollow final boss. Hot-blooded effigy. Burns even after death.
  effigy: {
    id: 'effigy',
    archetype: 'boss',
    hp: 4000,
    damage: 30,
    moveSpeed: 70,
    hitboxRadius: 80,
    tint: 0xff6a3c,
    textureIndex: 1,
    xpDrop: 50,
    isBoss: true,
  },
  // Tide Hollow final boss. Drifts but lands hard. Slightly chunkier than the others.
  'hollow-deep': {
    id: 'hollow-deep',
    archetype: 'boss',
    hp: 5000,
    damage: 28,
    moveSpeed: 65,
    hitboxRadius: 90,
    tint: 0x2a5a9a,
    textureIndex: 1,
    xpDrop: 50,
    isBoss: true,
  },
};

/** Convenience: look up the base move speed of an archetype id. Returns 0 if unknown. */
export function getEnemySpeed(id: string): number {
  const def = ENEMIES[id];
  return def ? def.moveSpeed : 0;
}
