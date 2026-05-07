// Playable character definitions. Pure data, no Phaser/React/ECS imports.
//
// Each character carries:
//   - a starting weapon (must exist in WEAPONS)
//   - optional stat bonuses applied to ECS Stats / Health on run start
//   - cosmetic tint for the player sprite (rendered by ArenaScene)
//
// To add a character: define it here, add to CHARACTERS, and it appears in the
// MainMenu character grid automatically.

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
    description: 'Melee fighter. Strikes with a Blade when enemies close in. +30 max HP, +10% move speed.',
    tint: 0xd96a3c, // burnt orange
    startingWeaponId: 'blade',
    bonuses: {
      maxHpDelta: 30,
      moveSpeedMul: 1.1,
    },
  },
};

export const DEFAULT_CHARACTER_ID = 'ranger';

export function getCharacter(id: string): CharacterDefinition {
  return CHARACTERS[id] ?? CHARACTERS[DEFAULT_CHARACTER_ID]!;
}
