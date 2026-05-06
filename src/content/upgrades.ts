// Level-up choices (augments + new weapons + level-up offers).
// Owner: Agent C5.
//
// In v1, only augments are listed here. Weapon offers are generated dynamically
// in runStore.ts from the WEAPONS dictionary (so a freshly-added weapon appears
// in the offer pool with zero edits here).
//
// Augment ids are kebab-case and stable forever (they appear in saves once we
// persist owned augments per-run; not yet wired but reserved).

export type UpgradeKind = 'new_weapon' | 'level_weapon' | 'augment';

export type Rarity = 'common' | 'rare' | 'epic';

export interface AugmentEffect {
  // Multiplicative or additive deltas applied to player Stats. Owner: Agent C5.
  // Multipliers are stacked multiplicatively on top of base stats.
  moveSpeedMul?: number;
  attackSpeedMul?: number;
  damageMul?: number;
  pickupRadiusMul?: number;
  maxHpDelta?: number;
  /** Flat HP healed per enemy killed (lifesteal). Stacks additively. */
  lifestealPerKill?: number;
  /** Additive crit chance 0..1. 25% means 0.25. Stacks additively, capped at 1. */
  critChanceDelta?: number;
  /** Splash damage radius in px (additive, max wins). Projectile hits also damage nearby enemies for splashFraction of base damage. */
  splashRadiusDelta?: number;
  /** Thorns: fraction of incoming damage reflected to attacker. Stacks additively. */
  thornsReflectDelta?: number;
  /** Knockback distance (px) applied to enemies on hit. Stacks additively. */
  knockbackPxDelta?: number;
  /** Bonus damage multiplier when player HP <= 30%. e.g. 0.4 = +40% damage when low. */
  berserkerMulDelta?: number;
  /** Incoming damage reduction 0..1. Stacks multiplicatively (1 - x) per pick. */
  damageReductionDelta?: number;
}

export interface UpgradeDefinition {
  id: string; // kebab-case, stable forever (appears in saves)
  kind: UpgradeKind;
  title: string;
  description: string;
  rarity: Rarity;
  weaponId?: string; // kind === 'new_weapon' | 'level_weapon'
  augment?: AugmentEffect; // kind === 'augment'
}

export const UPGRADES: Record<string, UpgradeDefinition> = {
  'aug-damage': {
    id: 'aug-damage',
    kind: 'augment',
    title: '+10% Damage',
    description: 'Your weapons hit harder.',
    rarity: 'common',
    augment: { damageMul: 1.1 },
  },
  'aug-speed': {
    id: 'aug-speed',
    kind: 'augment',
    title: '+10% Move Speed',
    description: 'Outpace the swarm.',
    rarity: 'common',
    augment: { moveSpeedMul: 1.1 },
  },
  'aug-pickup': {
    id: 'aug-pickup',
    kind: 'augment',
    title: '+15% Pickup Radius',
    description: 'Magnetize loot from afar.',
    rarity: 'common',
    augment: { pickupRadiusMul: 1.15 },
  },
  'aug-attackspeed': {
    id: 'aug-attackspeed',
    kind: 'augment',
    title: '+10% Attack Speed',
    description: 'Fire more often.',
    rarity: 'rare',
    augment: { attackSpeedMul: 1.1 },
  },
  'aug-maxhp': {
    id: 'aug-maxhp',
    kind: 'augment',
    title: '+20 Max HP',
    description: 'Raise max HP by 20 and heal by 20.',
    rarity: 'rare',
    augment: { maxHpDelta: 20 },
  },
  'aug-lifesteal': {
    id: 'aug-lifesteal',
    kind: 'augment',
    title: 'Lifesteal +1',
    description: 'Heal 1 HP for every enemy you kill.',
    rarity: 'epic',
    augment: { lifestealPerKill: 1 },
  },
  'aug-crit': {
    id: 'aug-crit',
    kind: 'augment',
    title: '+25% Crit Chance',
    description: 'Each hit has a 25% chance to deal double damage.',
    rarity: 'rare',
    augment: { critChanceDelta: 0.25 },
  },
  'aug-splash': {
    id: 'aug-splash',
    kind: 'augment',
    title: 'Splash Damage',
    description: 'Projectile hits also deal 30% damage to enemies within 70px.',
    rarity: 'rare',
    augment: { splashRadiusDelta: 70 },
  },
  'aug-thorns': {
    id: 'aug-thorns',
    kind: 'augment',
    title: 'Thorns +20%',
    description: 'Reflect 20% of damage taken back to the attacker.',
    rarity: 'rare',
    augment: { thornsReflectDelta: 0.2 },
  },
  'aug-knockback': {
    id: 'aug-knockback',
    kind: 'augment',
    title: 'Knockback +12px',
    description: 'Hits push enemies back, breaking up clumps.',
    rarity: 'common',
    augment: { knockbackPxDelta: 12 },
  },
  'aug-berserker': {
    id: 'aug-berserker',
    kind: 'augment',
    title: 'Berserker',
    description: 'Below 30% HP, deal 40% bonus damage.',
    rarity: 'epic',
    augment: { berserkerMulDelta: 0.4 },
  },
  'aug-steelskin': {
    id: 'aug-steelskin',
    kind: 'augment',
    title: '-10% Damage Taken',
    description: 'Steel skin softens every blow.',
    rarity: 'rare',
    augment: { damageReductionDelta: 0.1 },
  },
};
