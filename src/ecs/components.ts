// All bitECS components. Single file, single source of truth.
// Coordinated edit only — see CONTRACTS.md §1, §5.
import { defineComponent, Types } from 'bitecs';

// --- spatial ----------------------------------------------------------------

// World coordinates in pixels. (0,0) = top-left of arena. Arena is 4096x4096.
export const Position = defineComponent({ x: Types.f32, y: Types.f32 });

// Pixels per second. Movement system applies dt scaling.
export const Velocity = defineComponent({ vx: Types.f32, vy: Types.f32 });

// Radius for circle-circle collision (no rotation). In pixels.
export const Hitbox = defineComponent({ radius: Types.f32 });

// --- combat -----------------------------------------------------------------

export const Health = defineComponent({ hp: Types.f32, maxHp: Types.f32 });

// Flat damage on contact / on hit. Mitigation later.
export const Damage = defineComponent({ amount: Types.f32 });

// Movement / attack speed multipliers (1.0 = baseline). Multiplied per tick.
export const Stats = defineComponent({
  moveSpeedMul: Types.f32,
  attackSpeedMul: Types.f32,
  damageMul: Types.f32,
  pickupRadiusMul: Types.f32,
});

// --- lifecycle --------------------------------------------------------------

// Time-to-live in milliseconds. lifetimeSystem decrements; recycles at <= 0.
export const Lifetime = defineComponent({ remainingMs: Types.f32 });

// Tag set by damageSystem when hp <= 0. lifetimeSystem recycles at end of tick.
export const Dead = defineComponent();

// Tracks which pool kind this entity came from. Used by recycleEntity().
// Values come from PoolKind enum in src/core/pool.ts.
export const Pooled = defineComponent({ kind: Types.ui8 });

// --- rendering --------------------------------------------------------------

// Index into the SpriteGPULayer sprite atlas. Owned by render.ts.
export const Sprite = defineComponent({
  textureIndex: Types.ui16, // which atlas frame
  tint: Types.ui32, // 0xRRGGBB; 0xFFFFFF = no tint
  scale: Types.f32, // 1.0 = native size
  rotation: Types.f32, // radians; 0 = facing right
});

// --- player / weapons -------------------------------------------------------

export const PlayerTag = defineComponent();

// Player input snapshot, written by inputSystem each tick.
// dirX/dirY are -1 / 0 / 1 (WASD); aimX/aimY are normalized (-1..1) for manual aim.
// manualAim: 1 = on (C toggled), 0 = off (auto-aim nearest).
export const PlayerInput = defineComponent({
  dirX: Types.i8,
  dirY: Types.i8,
  aimX: Types.f32,
  aimY: Types.f32,
  manualAim: Types.ui8,
});

// One slot per equipped weapon. Up to 6 slots. Index into content/weapons.ts by weaponId.
// weaponId is a ui16 mapped to string at content load (avoids string storage in ECS).
export const WeaponSlot = defineComponent({
  weaponId: Types.ui16,
  level: Types.ui8,
  cooldownMs: Types.f32, // remaining ms until next fire
  evolved: Types.ui8, // 0 / 1
});

// --- enemies / projectiles --------------------------------------------------

export const EnemyTag = defineComponent();
export const BossTag = defineComponent();
export const ProjectileTag = defineComponent();

// Projectile-specific behavior data.
// pierce: how many enemies it can hit before recycling. -1 = infinite.
// ownerEid: who fired it (for kill credit + on_kill events).
// homing: 0 / 1; if 1, projectileSystem nudges velocity toward nearest enemy.
export const Projectile = defineComponent({
  pierce: Types.i8,
  ownerEid: Types.ui32,
  homing: Types.ui8,
});

// XP / pickup orbs.
// kind: 0 = xp, 1 = gold, 2 = heal (matches GameEvent.pickup_collected.kind).
// value: xp amount or gold amount or hp restored.
// magnetized: 0 / 1; if 1, pickupSystem accelerates toward player ignoring physics.
export const Pickup = defineComponent({
  kind: Types.ui8,
  value: Types.f32,
  magnetized: Types.ui8,
});

export const XPValue = defineComponent({ amount: Types.f32 });
