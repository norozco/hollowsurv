// Weapon definitions. Pure data, no Phaser/React imports.
// Owner: Agent C3.
//
// Two weapons ship with the vertical slice:
//   - 'auto-pistol' (auto_projectile archetype): fires a single bullet at the
//     nearest enemy on cooldown.
//   - 'aura' (aura archetype): periodic damage tick to every enemy within a
//     radius around the player.
//
// Schema is CONTRACTS.md §4. Behavior fns are intentionally optional in v1 —
// autoAttackSystem dispatches by archetype directly so it can handle pool
// acquisition, owner stats, and event emission consistently. We expose the
// schema-compliant `behavior` field as a no-op stub on each weapon so any
// future caller that does invoke it gets a stable signature.
//
// Level scaling (5 entries shipped — schema permits up to 8; the level-up
// ladder caps at 5 in the vertical slice and the picker won't offer level-ups
// past the highest available entry):
//   each level: +20% damage, -8% cooldown (multiplicative).
// Aura also grows its radius slightly each level.
import type { IWorld } from 'bitecs';

export type WeaponArchetype =
  | 'auto_projectile'
  | 'aura'
  | 'frost_nova'
  | 'chain'
  | 'boomerang'
  | 'orbiter'
  | 'mortar'
  | 'shotgun'
  | 'melee';

export interface WeaponLevelEffect {
  level: number; // 1..N (vertical slice ships 1..5)
  damage: number;
  cooldownMs: number;
  projectileSpeed?: number; // archetype: auto_projectile
  projectileCount?: number;
  pierce?: number; // -1 = infinite
  homing?: boolean;
  radius?: number; // archetype: aura
  tickRateMs?: number; // aura damage tick interval
  description: string;

  // --- evolution-only flags ----------------------------------------------
  // These are set on evolved weapons. Base weapons leave them undefined.
  // autoAttack reads them and threads them through the relevant fire path.

  /**
   * Phantom Shot. When true, every projectile fired by this weapon is a
   * guaranteed crit (2x damage) regardless of player.critChance.
   */
  forceCrit?: boolean;
  /**
   * Reaper's Edge. Melee strikes instantly execute (set hp to 0) any enemy
   * whose hp drops below `execBelowFrac * maxHp` after the strike's normal
   * damage is applied. 0.15 = 15% threshold.
   */
  execBelowFrac?: number;
  /**
   * Carpet Bomb. On mortar detonation, spawn this many sub-mortars at
   * random offsets around the impact site; each detonates after a short
   * delay for the standard mortar radius/damage.
   */
  subMortarCount?: number;
  /**
   * Eternal Return. Boomerang reflects off arena edges this many times
   * before its lifetime expires. 0 = no reflection (vanilla boomerang).
   */
  ricochetCount?: number;
}

export interface WeaponDefinition {
  id: string; // kebab-case, unique
  name: string;
  /** Short description shown on level-up cards. */
  description: string;
  archetype: WeaponArchetype;
  baseDamage: number;
  baseCooldownMs: number;
  levels: WeaponLevelEffect[]; // 1..N — vertical slice ships 5

  // Evolution (Vampire Survivors style). Optional. Vertical slice has no evolutions.
  evolvesTo?: string;
  evolveRequires?: {
    weaponMaxLevel: true;
    pairedAugmentId: string;
    minRunTimeMs?: number;
  };

  // Visual: tint applied to spawned projectiles / aura ring (0xRRGGBB).
  tint: number;

  // Hitbox radius for spawned projectiles (auto_projectile only). Aura uses radius.
  hitboxRadius?: number;

  /**
   * If set, this weapon is only available when playing as the named character.
   * Filters the level-up offer pool. Other characters never see it.
   */
  restrictedToCharacter?: string;

  // Behavior. Called by autoAttackSystem if it ever wants to delegate to the
  // weapon definition itself. v1 dispatches by archetype directly so the
  // system can reuse the projectile pool + spatial-hash query infrastructure.
  // Returning the cooldownMs lets a future migration just swap to behavior().
  // MUST NOT allocate.
  behavior: (
    world: IWorld,
    ownerEid: number,
    levelIndex: number,
    deltaMs: number
  ) => number;
}

// --- helpers ---------------------------------------------------------------

/**
 * Build a 5-level scaling table where each level multiplies damage by 1.2
 * (per the brief: +20% damage) and divides cooldown by 1.08 (per the brief:
 * -8% cooldown -> level cooldown = base * 0.92^(level-1)).
 *
 * Mutators: an optional callback receives the level and the level-effect so
 * callers can tweak archetype-specific fields (e.g. aura radius bumps).
 */
function buildLevels(
  baseDamage: number,
  baseCooldownMs: number,
  archetype: WeaponArchetype,
  extra?: (level: number, effect: WeaponLevelEffect) => void
): WeaponLevelEffect[] {
  const levels: WeaponLevelEffect[] = [];
  for (let i = 1; i <= 5; i++) {
    const dmg = baseDamage * Math.pow(1.2, i - 1);
    const cd = baseCooldownMs * Math.pow(0.92, i - 1);
    const level: WeaponLevelEffect = {
      level: i,
      damage: Math.round(dmg * 10) / 10,
      cooldownMs: Math.round(cd),
      description: archetype === 'auto_projectile'
        ? `+20% damage, faster fire rate.`
        : `+20% damage, faster ticks, larger field.`,
    };
    if (extra) extra(i, level);
    levels.push(level);
  }
  return levels;
}

// Behavior stub. autoAttackSystem dispatches by archetype directly in v1; this
// fulfills the contract's required `behavior` field without doing anything.
function noopBehavior(
  _world: IWorld,
  _owner: number,
  _levelIndex: number,
  _deltaMs: number
): number {
  return 0;
}

// --- definitions -----------------------------------------------------------

const AUTO_PISTOL_BASE_DAMAGE = 12;
// Slower at level 1 so each level-up feels impactful. Levels: 600, 552, 508, 467, 430.
const AUTO_PISTOL_BASE_COOLDOWN_MS = 600;
const AUTO_PISTOL_PROJECTILE_SPEED = 1000;
const AUTO_PISTOL_PROJECTILE_LIFETIME_MS = 1500;
const AUTO_PISTOL_PIERCE = 1;
const AUTO_PISTOL_HITBOX_RADIUS = 8;
const AUTO_PISTOL_TINT = 0xfff2a8;

const AURA_BASE_DAMAGE = 8;
const AURA_BASE_COOLDOWN_MS = 500;
// Tighter at level 1 (80) so it's not overwhelming. Each level adds 14: 80, 94, 108, 122, 136.
const AURA_BASE_RADIUS = 80;
const AURA_TINT = 0x88ddff;

// Dialed back: was 18, now 14. With grunt 30hp this is a 3-shot, not a 1-shot.
// --- Frost Nova: periodic burst, damages + slows enemies in radius
// Tuning: was way too strong combined with slow. Lower damage + longer cooldown.
const FROST_NOVA_BASE_DAMAGE = 8;
const FROST_NOVA_BASE_COOLDOWN_MS = 3000;
const FROST_NOVA_BASE_RADIUS = 130;
const FROST_NOVA_TINT = 0xa0e8ff;
const FROST_NOVA_SLOW_DURATION_MS = 1200;
const FROST_NOVA_SLOW_FACTOR = 0.6; // 60% speed (was 40% — too punishing)

// --- Lightning: chain damage between enemies
// Tuning: 700ms cooldown stacked with chains was clearing screens. Slower + less damage.
// Balance pass: 7 -> 6 dmg/jump. Crowd-control tier — debuff, not main DPS.
const LIGHTNING_BASE_DAMAGE = 6;
const LIGHTNING_BASE_COOLDOWN_MS = 1100;
const LIGHTNING_CHAIN_RANGE = 220; // px to next jump
const LIGHTNING_TINT = 0xfff066;

// --- Boomerang: thrown projectile that returns
// Tuning: infinite pierce on both legs was AOE-overload. Cap pierce at 6.
// Balance pass: pierce 6 -> 4. Too many enemies hit per throw at base.
const BOOMERANG_BASE_DAMAGE = 8;
const BOOMERANG_BASE_COOLDOWN_MS = 950;
const BOOMERANG_PROJECTILE_SPEED = 800;
const BOOMERANG_PROJECTILE_LIFETIME_MS = 1400; // out + back
const BOOMERANG_PIERCE = 4;
const BOOMERANG_HITBOX_RADIUS = 14;
const BOOMERANG_TINT = 0xff8842;

const PIERCER_BASE_DAMAGE = 14;
const PIERCER_BASE_COOLDOWN_MS = 1000; // slow, hits up to 5 in a line
const PIERCER_PROJECTILE_SPEED = 1300;
const PIERCER_PROJECTILE_LIFETIME_MS = 1800;
const PIERCER_PIERCE = 5;
const PIERCER_HITBOX_RADIUS = 10;
const PIERCER_TINT = 0xc8ff60;

// --- Sawblade: orbiting blades that damage on contact
// Balance pass: 6 -> 5 dmg/orbiter. At L5 five blades = 25 dmg/sec was overtuned.
const SAWBLADE_BASE_DAMAGE = 5;
const SAWBLADE_BASE_COOLDOWN_MS = 350; // damage tick interval per orbiter
const SAWBLADE_BASE_RADIUS = 95; // orbit radius (px)
const SAWBLADE_HITBOX_RADIUS = 14;
const SAWBLADE_TINT = 0xb8b8c0;
const SAWBLADE_BASE_COUNT = 1; // # orbiters at level 1; +1 every level
const SAWBLADE_ANGULAR_SPEED = 3.5; // radians per second

// --- Mortar: lobbed projectile that explodes on impact (or expiry)
const MORTAR_BASE_DAMAGE = 22;
const MORTAR_BASE_COOLDOWN_MS = 1300;
const MORTAR_PROJECTILE_SPEED = 520;
const MORTAR_PROJECTILE_LIFETIME_MS = 1100;
const MORTAR_EXPLOSION_RADIUS = 90;
const MORTAR_HITBOX_RADIUS = 10;
const MORTAR_TINT = 0xff7733;

// --- Shotgun: 3-projectile spread, short range
const SHOTGUN_BASE_DAMAGE = 7;
const SHOTGUN_BASE_COOLDOWN_MS = 850;
const SHOTGUN_PROJECTILE_SPEED = 850;
const SHOTGUN_PROJECTILE_LIFETIME_MS = 450; // short range
const SHOTGUN_PROJECTILE_COUNT = 3;
const SHOTGUN_PIERCE = 1;
const SHOTGUN_HITBOX_RADIUS = 7;
const SHOTGUN_TINT = 0xffd266;

// --- Blade: Brawler's signature melee strike. Only triggers when enemies are close.
// Balance history:
//   24 -> 12 dmg (first pass): 24 was overtuned because it hit ALL enemies in 80px.
//   12 -> 16 dmg (current):    12 made Brawler functionally identical to Ranger on
//     per-enemy damage despite eating melee risk + the post-separation flowfield
//     making "5 enemies in 80px" hard to engineer. 16 is a +33% melee-risk premium
//     (mirrors Vampire Survivors' Whip-vs-Wand ratio) without bringing back the
//     crowd-deletion problem of 24. Auto-scales Reaper's Edge via *2.
const BLADE_BASE_DAMAGE = 16;
const BLADE_BASE_COOLDOWN_MS = 600;
const BLADE_BASE_RADIUS = 80;
const BLADE_TINT = 0xff4a4a;

// --- Tome: Witch's signature. Orbiter, like Sawblade but arcane-tinted.
// 1 tome at L1, +1 per level (1..5).
const TOME_BASE_DAMAGE = 6;
const TOME_BASE_COOLDOWN_MS = 380; // damage tick interval per orbiter
const TOME_BASE_RADIUS = 100; // orbit radius (px)
const TOME_HITBOX_RADIUS = 14;
const TOME_TINT = 0x9b59d6; // arcane purple
const TOME_BASE_COUNT = 1;

// --- Longshot: Sniper's signature. Very slow, very hard-hitting auto-projectile.
const LONGSHOT_BASE_DAMAGE = 30;
const LONGSHOT_BASE_COOLDOWN_MS = 1500;
const LONGSHOT_PROJECTILE_SPEED = 1400;
const LONGSHOT_PROJECTILE_LIFETIME_MS = 1800;
const LONGSHOT_PIERCE = 1;
const LONGSHOT_HITBOX_RADIUS = 8;
const LONGSHOT_TINT = 0x4a90c9; // steel blue

// --- Hollow Curse: Cursed One's signature. Tight aura, high damage.
// Tiny radius (50px) makes you fight in melee; high per-tick damage rewards bravery.
const HOLLOW_CURSE_BASE_DAMAGE = 14;
const HOLLOW_CURSE_BASE_COOLDOWN_MS = 500;
const HOLLOW_CURSE_BASE_RADIUS = 50;
const HOLLOW_CURSE_TINT = 0x6a0044; // dark wine

// `evolvesTo` / `evolveRequires` are omitted entirely (not set to undefined)
// because `exactOptionalPropertyTypes` distinguishes "missing" from "explicit
// undefined" for optional fields with non-undefined declared types.
const autoPistol: WeaponDefinition = {
  id: 'auto-pistol',
  name: 'Auto Pistol',
  description: 'Auto-fires bullets at the nearest enemy. Reliable, single-target.',
  archetype: 'auto_projectile',
  restrictedToCharacter: 'ranger',
  baseDamage: AUTO_PISTOL_BASE_DAMAGE,
  baseCooldownMs: AUTO_PISTOL_BASE_COOLDOWN_MS,
  tint: AUTO_PISTOL_TINT,
  hitboxRadius: AUTO_PISTOL_HITBOX_RADIUS,
  evolvesTo: 'phantom-shot',
  evolveRequires: { weaponMaxLevel: true, pairedAugmentId: 'aug-crit' },
  levels: buildLevels(
    AUTO_PISTOL_BASE_DAMAGE,
    AUTO_PISTOL_BASE_COOLDOWN_MS,
    'auto_projectile',
    (_lv, eff) => {
      eff.projectileSpeed = AUTO_PISTOL_PROJECTILE_SPEED;
      eff.projectileCount = 1;
      eff.pierce = AUTO_PISTOL_PIERCE;
      eff.homing = false;
    }
  ),
  behavior: noopBehavior,
};

const aura: WeaponDefinition = {
  id: 'aura',
  name: 'Aura',
  description: 'A damage field surrounds you, harming every enemy in range.',
  archetype: 'aura',
  baseDamage: AURA_BASE_DAMAGE,
  baseCooldownMs: AURA_BASE_COOLDOWN_MS,
  tint: AURA_TINT,
  evolvesTo: 'hollow-field',
  evolveRequires: { weaponMaxLevel: true, pairedAugmentId: 'aug-maxhp' },
  levels: buildLevels(AURA_BASE_DAMAGE, AURA_BASE_COOLDOWN_MS, 'aura', (lv, eff) => {
    // Each level grows the radius modestly: +14px per level past 1.
    eff.radius = AURA_BASE_RADIUS + (lv - 1) * 14;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1; // hits everything in radius every tick
  }),
  behavior: noopBehavior,
};

const piercer: WeaponDefinition = {
  id: 'piercer',
  name: 'Piercer',
  description: 'A heavy bolt that punches through up to 5 enemies in a line.',
  archetype: 'auto_projectile',
  baseDamage: PIERCER_BASE_DAMAGE,
  baseCooldownMs: PIERCER_BASE_COOLDOWN_MS,
  tint: PIERCER_TINT,
  hitboxRadius: PIERCER_HITBOX_RADIUS,
  levels: buildLevels(
    PIERCER_BASE_DAMAGE,
    PIERCER_BASE_COOLDOWN_MS,
    'auto_projectile',
    (_lv, eff) => {
      eff.projectileSpeed = PIERCER_PROJECTILE_SPEED;
      eff.projectileCount = 1;
      eff.pierce = PIERCER_PIERCE;
      eff.homing = false;
    }
  ),
  behavior: noopBehavior,
};

const frostNova: WeaponDefinition = {
  id: 'frost-nova',
  name: 'Frost Nova',
  description: 'Periodic icy burst around you. Damages and slows nearby enemies.',
  archetype: 'frost_nova',
  baseDamage: FROST_NOVA_BASE_DAMAGE,
  baseCooldownMs: FROST_NOVA_BASE_COOLDOWN_MS,
  tint: FROST_NOVA_TINT,
  levels: buildLevels(FROST_NOVA_BASE_DAMAGE, FROST_NOVA_BASE_COOLDOWN_MS, 'frost_nova', (lv, eff) => {
    eff.radius = FROST_NOVA_BASE_RADIUS + (lv - 1) * 18;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

const lightning: WeaponDefinition = {
  id: 'lightning',
  name: 'Lightning',
  description: 'Strikes one enemy, then arcs to nearby ones. Higher level = more jumps.',
  archetype: 'chain',
  baseDamage: LIGHTNING_BASE_DAMAGE,
  baseCooldownMs: LIGHTNING_BASE_COOLDOWN_MS,
  tint: LIGHTNING_TINT,
  levels: buildLevels(LIGHTNING_BASE_DAMAGE, LIGHTNING_BASE_COOLDOWN_MS, 'chain', (lv, eff) => {
    // projectileCount doubles as the chain count for this archetype.
    eff.projectileCount = 2 + lv; // L1: 3 jumps total; L5: 7
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

const boomerang: WeaponDefinition = {
  id: 'boomerang',
  name: 'Boomerang',
  description: 'Throws a curved blade that flies out and returns, hitting twice.',
  archetype: 'boomerang',
  baseDamage: BOOMERANG_BASE_DAMAGE,
  baseCooldownMs: BOOMERANG_BASE_COOLDOWN_MS,
  tint: BOOMERANG_TINT,
  hitboxRadius: BOOMERANG_HITBOX_RADIUS,
  evolvesTo: 'eternal-return',
  evolveRequires: { weaponMaxLevel: true, pairedAugmentId: 'aug-attackspeed' },
  levels: buildLevels(BOOMERANG_BASE_DAMAGE, BOOMERANG_BASE_COOLDOWN_MS, 'boomerang', (lv, eff) => {
    eff.projectileSpeed = BOOMERANG_PROJECTILE_SPEED;
    eff.projectileCount = 1;
    // Pierce grows with level: 6, 7, 8, 9, 10
    eff.pierce = BOOMERANG_PIERCE + (lv - 1);
    eff.homing = false;
  }),
  behavior: noopBehavior,
};

const sawblade: WeaponDefinition = {
  id: 'sawblade',
  name: 'Sawblade',
  description: 'Spinning blades orbit you, shredding anything they touch. More blades each level.',
  archetype: 'orbiter',
  baseDamage: SAWBLADE_BASE_DAMAGE,
  baseCooldownMs: SAWBLADE_BASE_COOLDOWN_MS,
  tint: SAWBLADE_TINT,
  hitboxRadius: SAWBLADE_HITBOX_RADIUS,
  levels: buildLevels(SAWBLADE_BASE_DAMAGE, SAWBLADE_BASE_COOLDOWN_MS, 'orbiter', (lv, eff) => {
    eff.projectileCount = SAWBLADE_BASE_COUNT + (lv - 1); // 1, 2, 3, 4, 5 blades
    eff.radius = SAWBLADE_BASE_RADIUS;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

const mortar: WeaponDefinition = {
  id: 'mortar',
  name: 'Mortar',
  description: 'Slow shells that explode on impact, blasting everything nearby.',
  archetype: 'mortar',
  baseDamage: MORTAR_BASE_DAMAGE,
  baseCooldownMs: MORTAR_BASE_COOLDOWN_MS,
  tint: MORTAR_TINT,
  hitboxRadius: MORTAR_HITBOX_RADIUS,
  evolvesTo: 'carpet-bomb',
  evolveRequires: { weaponMaxLevel: true, pairedAugmentId: 'aug-splash' },
  levels: buildLevels(MORTAR_BASE_DAMAGE, MORTAR_BASE_COOLDOWN_MS, 'mortar', (_lv, eff) => {
    eff.projectileSpeed = MORTAR_PROJECTILE_SPEED;
    eff.projectileCount = 1;
    eff.pierce = 0; // explodes on first contact
    eff.radius = MORTAR_EXPLOSION_RADIUS;
  }),
  behavior: noopBehavior,
};

const shotgun: WeaponDefinition = {
  id: 'shotgun',
  name: 'Shotgun',
  description: 'Fires 3 pellets in a spread. Brutal up close, weak at range.',
  archetype: 'shotgun',
  baseDamage: SHOTGUN_BASE_DAMAGE,
  baseCooldownMs: SHOTGUN_BASE_COOLDOWN_MS,
  tint: SHOTGUN_TINT,
  hitboxRadius: SHOTGUN_HITBOX_RADIUS,
  levels: buildLevels(SHOTGUN_BASE_DAMAGE, SHOTGUN_BASE_COOLDOWN_MS, 'shotgun', (lv, eff) => {
    eff.projectileSpeed = SHOTGUN_PROJECTILE_SPEED;
    // Pellet count grows with level: 3, 4, 5, 6, 7
    eff.projectileCount = SHOTGUN_PROJECTILE_COUNT + (lv - 1);
    eff.pierce = SHOTGUN_PIERCE;
    eff.homing = false;
  }),
  behavior: noopBehavior,
};

const blade: WeaponDefinition = {
  id: 'blade',
  name: 'Blade',
  description: 'A close-range strike that flashes out when enemies press in. Brawler only.',
  archetype: 'melee',
  baseDamage: BLADE_BASE_DAMAGE,
  baseCooldownMs: BLADE_BASE_COOLDOWN_MS,
  tint: BLADE_TINT,
  restrictedToCharacter: 'brawler',
  evolvesTo: 'reapers-edge',
  evolveRequires: { weaponMaxLevel: true, pairedAugmentId: 'aug-knockback' },
  levels: buildLevels(BLADE_BASE_DAMAGE, BLADE_BASE_COOLDOWN_MS, 'melee', (lv, eff) => {
    eff.radius = BLADE_BASE_RADIUS + (lv - 1) * 8;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

const tome: WeaponDefinition = {
  id: 'tome',
  name: 'Tome',
  description: 'Arcane tomes circle you, striking what they touch. More tomes each level. Witch only.',
  archetype: 'orbiter',
  baseDamage: TOME_BASE_DAMAGE,
  baseCooldownMs: TOME_BASE_COOLDOWN_MS,
  tint: TOME_TINT,
  hitboxRadius: TOME_HITBOX_RADIUS,
  restrictedToCharacter: 'witch',
  levels: buildLevels(TOME_BASE_DAMAGE, TOME_BASE_COOLDOWN_MS, 'orbiter', (lv, eff) => {
    eff.projectileCount = TOME_BASE_COUNT + (lv - 1); // 1, 2, 3, 4, 5 tomes
    eff.radius = TOME_BASE_RADIUS;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

const longshot: WeaponDefinition = {
  id: 'longshot',
  name: 'Longshot',
  description: 'A devastating shot from afar. Slow to fire, brutal on contact. Sniper only.',
  archetype: 'auto_projectile',
  baseDamage: LONGSHOT_BASE_DAMAGE,
  baseCooldownMs: LONGSHOT_BASE_COOLDOWN_MS,
  tint: LONGSHOT_TINT,
  hitboxRadius: LONGSHOT_HITBOX_RADIUS,
  restrictedToCharacter: 'sniper',
  levels: buildLevels(
    LONGSHOT_BASE_DAMAGE,
    LONGSHOT_BASE_COOLDOWN_MS,
    'auto_projectile',
    (_lv, eff) => {
      eff.projectileSpeed = LONGSHOT_PROJECTILE_SPEED;
      eff.projectileCount = 1;
      eff.pierce = LONGSHOT_PIERCE;
      eff.homing = false;
    }
  ),
  behavior: noopBehavior,
};

const hollowCurse: WeaponDefinition = {
  id: 'hollow-curse',
  name: 'Hollow Curse',
  description: 'A tight, vicious aura that withers anything near. Cursed One only.',
  archetype: 'aura',
  baseDamage: HOLLOW_CURSE_BASE_DAMAGE,
  baseCooldownMs: HOLLOW_CURSE_BASE_COOLDOWN_MS,
  tint: HOLLOW_CURSE_TINT,
  restrictedToCharacter: 'cursed-one',
  levels: buildLevels(HOLLOW_CURSE_BASE_DAMAGE, HOLLOW_CURSE_BASE_COOLDOWN_MS, 'aura', (lv, eff) => {
    // Grows slowly: 50, 58, 66, 74, 82. Still much smaller than regular Aura.
    eff.radius = HOLLOW_CURSE_BASE_RADIUS + (lv - 1) * 8;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

// --- evolutions ----------------------------------------------------------
// Five Vampire-Survivors-style evolutions. Each unlocks when the base weapon
// reaches max level AND the paired augment is owned (see evolveRequires on
// the base weapon definitions above). The level-up picker surfaces the
// evolution as an "EVOLVE: <name>" offer; picking it replaces the base
// weapon at level 1 (with bumped stats baked into the levels table).
//
// All evolutions start at level 1 but ship with damage roughly 2x the
// equivalent base level for the same level entry, plus an evolution-only
// behavioral flag (forceCrit / execBelowFrac / subMortarCount / ricochetCount)
// where applicable.

// 1) Phantom Shot — Auto Pistol + Crit. Same projectile pattern, +50%
//    projectile speed, guaranteed crit on every hit.
const PHANTOM_SHOT_BASE_DAMAGE = AUTO_PISTOL_BASE_DAMAGE * 2;
const PHANTOM_SHOT_BASE_COOLDOWN_MS = AUTO_PISTOL_BASE_COOLDOWN_MS;
const PHANTOM_SHOT_PROJECTILE_SPEED = Math.round(AUTO_PISTOL_PROJECTILE_SPEED * 1.5);
const PHANTOM_SHOT_PROJECTILE_LIFETIME_MS = AUTO_PISTOL_PROJECTILE_LIFETIME_MS;
const PHANTOM_SHOT_HITBOX_RADIUS = AUTO_PISTOL_HITBOX_RADIUS + 2;
const PHANTOM_SHOT_TINT = 0xffd24a; // gold

const phantomShot: WeaponDefinition = {
  id: 'phantom-shot',
  name: 'Phantom Shot',
  description: 'Evolved Pistol. Every shot is a guaranteed crit.',
  archetype: 'auto_projectile',
  restrictedToCharacter: 'ranger',
  baseDamage: PHANTOM_SHOT_BASE_DAMAGE,
  baseCooldownMs: PHANTOM_SHOT_BASE_COOLDOWN_MS,
  tint: PHANTOM_SHOT_TINT,
  hitboxRadius: PHANTOM_SHOT_HITBOX_RADIUS,
  levels: buildLevels(
    PHANTOM_SHOT_BASE_DAMAGE,
    PHANTOM_SHOT_BASE_COOLDOWN_MS,
    'auto_projectile',
    (_lv, eff) => {
      eff.projectileSpeed = PHANTOM_SHOT_PROJECTILE_SPEED;
      eff.projectileCount = 1;
      eff.pierce = AUTO_PISTOL_PIERCE + 1;
      eff.homing = false;
      eff.forceCrit = true;
    }
  ),
  behavior: noopBehavior,
};

// 2) Hollow Field — Aura + Max HP. 50% larger radius, ticks twice as fast.
const HOLLOW_FIELD_BASE_DAMAGE = AURA_BASE_DAMAGE * 2;
const HOLLOW_FIELD_BASE_COOLDOWN_MS = Math.round(AURA_BASE_COOLDOWN_MS / 2);
const HOLLOW_FIELD_BASE_RADIUS = Math.round(AURA_BASE_RADIUS * 1.5);
const HOLLOW_FIELD_TINT = 0xc488ff; // violet

const hollowField: WeaponDefinition = {
  id: 'hollow-field',
  name: 'Hollow Field',
  description: 'Evolved Aura. Larger radius, double tick rate.',
  archetype: 'aura',
  baseDamage: HOLLOW_FIELD_BASE_DAMAGE,
  baseCooldownMs: HOLLOW_FIELD_BASE_COOLDOWN_MS,
  tint: HOLLOW_FIELD_TINT,
  levels: buildLevels(HOLLOW_FIELD_BASE_DAMAGE, HOLLOW_FIELD_BASE_COOLDOWN_MS, 'aura', (lv, eff) => {
    eff.radius = HOLLOW_FIELD_BASE_RADIUS + (lv - 1) * 20;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1;
  }),
  behavior: noopBehavior,
};

// 3) Reaper's Edge — Blade + Knockback. Bigger radius, executes enemies
//    below 15% HP after the strike.
const REAPERS_EDGE_BASE_DAMAGE = BLADE_BASE_DAMAGE * 2;
const REAPERS_EDGE_BASE_COOLDOWN_MS = BLADE_BASE_COOLDOWN_MS;
const REAPERS_EDGE_BASE_RADIUS = BLADE_BASE_RADIUS + 40;
const REAPERS_EDGE_EXEC_FRAC = 0.15;
const REAPERS_EDGE_TINT = 0xa8253a; // crimson

const reapersEdge: WeaponDefinition = {
  id: 'reapers-edge',
  name: "Reaper's Edge",
  description: 'Evolved Blade. Strikes execute enemies below 15% HP.',
  archetype: 'melee',
  baseDamage: REAPERS_EDGE_BASE_DAMAGE,
  baseCooldownMs: REAPERS_EDGE_BASE_COOLDOWN_MS,
  tint: REAPERS_EDGE_TINT,
  restrictedToCharacter: 'brawler',
  levels: buildLevels(REAPERS_EDGE_BASE_DAMAGE, REAPERS_EDGE_BASE_COOLDOWN_MS, 'melee', (lv, eff) => {
    eff.radius = REAPERS_EDGE_BASE_RADIUS + (lv - 1) * 10;
    eff.tickRateMs = eff.cooldownMs;
    eff.pierce = -1;
    eff.execBelowFrac = REAPERS_EDGE_EXEC_FRAC;
  }),
  behavior: noopBehavior,
};

// 4) Carpet Bomb — Mortar + Splash. Primary shell detonates, then spawns
//    4 sub-mortar explosions in a tight ring around the impact site.
const CARPET_BOMB_BASE_DAMAGE = MORTAR_BASE_DAMAGE * 2;
const CARPET_BOMB_BASE_COOLDOWN_MS = MORTAR_BASE_COOLDOWN_MS;
const CARPET_BOMB_SUB_COUNT = 4;
const CARPET_BOMB_TINT = 0xff5a25; // hot orange

const carpetBomb: WeaponDefinition = {
  id: 'carpet-bomb',
  name: 'Carpet Bomb',
  description: 'Evolved Mortar. Each shell scatters into four sub-detonations.',
  archetype: 'mortar',
  baseDamage: CARPET_BOMB_BASE_DAMAGE,
  baseCooldownMs: CARPET_BOMB_BASE_COOLDOWN_MS,
  tint: CARPET_BOMB_TINT,
  hitboxRadius: MORTAR_HITBOX_RADIUS,
  levels: buildLevels(CARPET_BOMB_BASE_DAMAGE, CARPET_BOMB_BASE_COOLDOWN_MS, 'mortar', (_lv, eff) => {
    eff.projectileSpeed = MORTAR_PROJECTILE_SPEED;
    eff.projectileCount = 1;
    eff.pierce = 0;
    eff.radius = MORTAR_EXPLOSION_RADIUS;
    eff.subMortarCount = CARPET_BOMB_SUB_COUNT;
  }),
  behavior: noopBehavior,
};

// 5) Eternal Return — Boomerang + Attack Speed. Ricochets off the four
//    arena edges up to 3 times before recycling.
const ETERNAL_RETURN_BASE_DAMAGE = BOOMERANG_BASE_DAMAGE * 2;
const ETERNAL_RETURN_BASE_COOLDOWN_MS = Math.round(BOOMERANG_BASE_COOLDOWN_MS * 0.8);
const ETERNAL_RETURN_PROJECTILE_LIFETIME_MS = BOOMERANG_PROJECTILE_LIFETIME_MS + 600;
const ETERNAL_RETURN_TINT = 0xfff066;

const eternalReturn: WeaponDefinition = {
  id: 'eternal-return',
  name: 'Eternal Return',
  description: 'Evolved Boomerang. Ricochets off arena edges before returning.',
  archetype: 'boomerang',
  baseDamage: ETERNAL_RETURN_BASE_DAMAGE,
  baseCooldownMs: ETERNAL_RETURN_BASE_COOLDOWN_MS,
  tint: ETERNAL_RETURN_TINT,
  hitboxRadius: BOOMERANG_HITBOX_RADIUS + 2,
  levels: buildLevels(ETERNAL_RETURN_BASE_DAMAGE, ETERNAL_RETURN_BASE_COOLDOWN_MS, 'boomerang', (lv, eff) => {
    eff.projectileSpeed = BOOMERANG_PROJECTILE_SPEED;
    eff.projectileCount = 1;
    eff.pierce = BOOMERANG_PIERCE + 2 + (lv - 1);
    eff.homing = false;
    eff.ricochetCount = 3;
  }),
  behavior: noopBehavior,
};

export const WEAPONS: Record<string, WeaponDefinition> = {
  [autoPistol.id]: autoPistol,
  [aura.id]: aura,
  [piercer.id]: piercer,
  [frostNova.id]: frostNova,
  [lightning.id]: lightning,
  [boomerang.id]: boomerang,
  [sawblade.id]: sawblade,
  [mortar.id]: mortar,
  [shotgun.id]: shotgun,
  [blade.id]: blade,
  [tome.id]: tome,
  [longshot.id]: longshot,
  [hollowCurse.id]: hollowCurse,
  // Evolutions — surfaced via runStore.generateOffers when the base weapon is
  // at max level AND its paired augment is owned. Restricted-to-character is
  // inherited from the base where applicable so the picker filter still works.
  [phantomShot.id]: phantomShot,
  [hollowField.id]: hollowField,
  [reapersEdge.id]: reapersEdge,
  [carpetBomb.id]: carpetBomb,
  [eternalReturn.id]: eternalReturn,
};

// Slow side-channel — frost_nova writes; flowfield reads. Indexed by enemy eid.
// performance.now() value of when the slow expires; 0 = not slowed.
export const ENEMY_SLOW_BUFFER_SIZE = 16384;
export const enemySlowUntilMs = new Float32Array(ENEMY_SLOW_BUFFER_SIZE);
export const FROST_SLOW_FACTOR = FROST_NOVA_SLOW_FACTOR;
export function applyFrostSlow(eid: number): void {
  if (eid >= 0 && eid < ENEMY_SLOW_BUFFER_SIZE) {
    enemySlowUntilMs[eid] = performance.now() + FROST_NOVA_SLOW_DURATION_MS;
  }
}
export function isEnemySlowed(eid: number): boolean {
  if (eid < 0 || eid >= ENEMY_SLOW_BUFFER_SIZE) return false;
  return performance.now() < (enemySlowUntilMs[eid] ?? 0);
}

// --- runtime support: string id <-> ui16 numeric id ------------------------
// CONTRACTS.md §1 says WeaponSlot.weaponId is a ui16 mapped to string at
// content load. This module is the single source of truth for that mapping.

const ID_TO_NUM: Map<string, number> = new Map();
const NUM_TO_ID: Map<number, string> = new Map();
let nextWeaponNumericId = 1; // reserve 0 as "unset / no weapon"

function ensureWeaponMapping(weaponId: string): number {
  const existing = ID_TO_NUM.get(weaponId);
  if (existing !== undefined) return existing;
  const n = nextWeaponNumericId++;
  ID_TO_NUM.set(weaponId, n);
  NUM_TO_ID.set(n, weaponId);
  return n;
}

// Pre-register all v1 weapons so ids are stable from boot.
for (const id of Object.keys(WEAPONS)) ensureWeaponMapping(id);

/** Look up the ui16 numeric id for a weapon string id. Registers if new. */
export function weaponIdToNum(id: string): number {
  return ensureWeaponMapping(id);
}

/** Look up the string weapon id from its ui16 numeric id; '' if unknown. */
export function weaponNumToId(num: number): string {
  return NUM_TO_ID.get(num) ?? '';
}

/** Get a weapon definition by ui16 numeric id; undefined if unknown. */
export function weaponDefByNum(num: number): WeaponDefinition | undefined {
  const id = NUM_TO_ID.get(num);
  if (id === undefined) return undefined;
  return WEAPONS[id];
}

/**
 * Lookup the level entry for a given weapon and 1-based level. Caps at the
 * highest available entry so over-leveled weapons just use the top level.
 */
export function weaponLevelEffect(def: WeaponDefinition, level: number): WeaponLevelEffect {
  const idx = Math.max(1, Math.min(def.levels.length, level)) - 1;
  // levels is non-empty for every shipped weapon; non-null assertion is safe.
  return def.levels[idx]!;
}

// Projectile-archetype constants not represented in WeaponLevelEffect schema.
// Keys are weapon ids; autoAttackSystem reads these when spawning bullets.
export const PROJECTILE_LIFETIME_MS_BY_WEAPON: Record<string, number> = {
  'auto-pistol': AUTO_PISTOL_PROJECTILE_LIFETIME_MS,
  'piercer': PIERCER_PROJECTILE_LIFETIME_MS,
  'boomerang': BOOMERANG_PROJECTILE_LIFETIME_MS,
  'mortar': MORTAR_PROJECTILE_LIFETIME_MS,
  'shotgun': SHOTGUN_PROJECTILE_LIFETIME_MS,
  // evolutions — inherit the same projectile lifetimes as their base where
  // it matters (autoAttack falls back to DEFAULT_PROJECTILE_LIFETIME_MS otherwise).
  'phantom-shot': PHANTOM_SHOT_PROJECTILE_LIFETIME_MS,
  'carpet-bomb': MORTAR_PROJECTILE_LIFETIME_MS,
  'eternal-return': ETERNAL_RETURN_PROJECTILE_LIFETIME_MS,
};

/** Sawblade orbiter angular speed (rad/s). Used by projectile.ts orbit update. */
export const SAWBLADE_ANGULAR_SPEED_RAD_PER_SEC = SAWBLADE_ANGULAR_SPEED;

/** Default projectile lifetime when a weapon doesn't override it. */
export const DEFAULT_PROJECTILE_LIFETIME_MS = 1500;

