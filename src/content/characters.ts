// Playable character definitions. Pure data, no Phaser/React/ECS imports.
//
// Each character carries:
//   - a starting weapon (must exist in WEAPONS)
//   - optional stat bonuses applied to ECS Stats / Health on run start
//   - cosmetic tint for the player sprite (rendered by ArenaScene)
//   - an optional unlock condition (string + checker baked into metaStore)
//
// To add a character: define it here, add to CHARACTERS, and it appears in the
// MainMenu character grid automatically.
//
// Unlock chain (live tracking happens in metaStore.recordRunCompletion):
//   - 'ranger', 'brawler' — unlocked from the start.
//   - 'witch'      — Survive 5:00 as Brawler (won OR lost).
//   - 'sniper'     — Survive 8:00 as Ranger (won OR lost).
//   - 'cursed-one' — Survive 6:00 with any character (won OR lost).
//
// `unlockCondition` is the player-facing copy shown on locked cards in the
// character grid. The actual unlock logic lives in metaStore so the unlock can
// be checked without importing characters.ts (avoids a circular dep).

export interface CharacterBonuses {
  /** Adds to player maxHp at run start. Also heals up to new max. */
  maxHpDelta?: number;
  /** Multiplier on Stats.moveSpeedMul. */
  moveSpeedMul?: number;
  /** Multiplier on Stats.attackSpeedMul. */
  attackSpeedMul?: number;
  /** Multiplier on Stats.damageMul. */
  damageMul?: number;
  /** Multiplier on Stats.pickupRadiusMul. */
  pickupRadiusMul?: number;
}

export interface CharacterDefinition {
  id: string;
  name: string;
  description: string;
  /** Hex color used by ArenaScene for the player rectangle (placeholder art). */
  tint: number;
  startingWeaponId: string;
  bonuses: CharacterBonuses;
  /**
   * Player-facing copy describing how to unlock this character. Shown on the
   * locked card in MainMenu. Absent on starter characters (always unlocked).
   */
  unlockCondition?: string;
}

export const CHARACTERS: Record<string, CharacterDefinition> = {
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    description: 'Sharpshooter. Starts with Auto Pistol. Baseline stats.',
    tint: 0xe8d4a8, // tan (current default)
    startingWeaponId: 'auto-pistol',
    bonuses: {},
  },
  brawler: {
    id: 'brawler',
    name: 'Brawler',
    description: 'Melee fighter. The Blade hits harder than any pistol — but only when enemies close in. +30 max HP, +10% move speed.',
    tint: 0xd96a3c, // burnt orange
    startingWeaponId: 'blade',
    bonuses: {
      maxHpDelta: 30,
      moveSpeedMul: 1.1,
    },
  },
  witch: {
    id: 'witch',
    name: 'Witch',
    description: 'Arcane scholar. Tomes orbit and strike. Frail but greedy.',
    tint: 0x9b59d6, // arcane purple
    startingWeaponId: 'tome',
    bonuses: {
      pickupRadiusMul: 1.3,
      maxHpDelta: -10,
    },
    unlockCondition: 'Survive 5:00 as Brawler',
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    description: 'Cold-eyed marksman. Each shot devastates from afar.',
    tint: 0x4a90c9, // steel blue
    startingWeaponId: 'longshot',
    bonuses: {
      damageMul: 1.2,
    },
    unlockCondition: 'Survive 8:00 as Ranger',
  },
  'cursed-one': {
    id: 'cursed-one',
    name: 'Cursed One',
    description: 'What remains of the last to fall. Fragile, vicious.',
    tint: 0x6a0044, // dark wine
    startingWeaponId: 'hollow-curse',
    bonuses: {
      maxHpDelta: -70,
      damageMul: 2.0,
    },
    unlockCondition: 'Survive 6:00 with any character',
  },
};

export const DEFAULT_CHARACTER_ID = 'ranger';

export function getCharacter(id: string): CharacterDefinition {
  return CHARACTERS[id] ?? CHARACTERS[DEFAULT_CHARACTER_ID]!;
}

/** True if the given character id appears in the player's unlock list. */
export function isCharacterUnlocked(id: string, unlockedIds: readonly string[]): boolean {
  return unlockedIds.includes(id);
}
