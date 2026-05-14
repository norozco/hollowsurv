// Orbiter (sawblade / tome) tick + ensure logic. Extracted from
// `autoAttack.ts` so the weapon-fire dispatcher stays focused on combat logic.
//
// Orbiters are persistent projectile entities that revolve around the player.
// They are NOT re-fired each cooldown — `ensureOrbiters` spawns/recycles
// blades to match the equipped weapon's level (`projectileCount`) and `radius`,
// and `tickOrbiters` runs every frame to advance their orbit angle.
//
// `isOrbiter()` is read by `projectile.ts` so the projectile-motion pass can
// skip the linear velocity update (orbiters write their own position).

import { addComponent, hasComponent } from 'bitecs';

import { acquireEntity, PoolKind } from '../../core/pool';
import {
  Damage,
  Hitbox,
  Lifetime,
  Position,
  Projectile,
  ProjectileTag,
  Sprite,
  Stats,
  Velocity,
} from '../components';
import {
  SAWBLADE_ANGULAR_SPEED_RAD_PER_SEC,
  weaponLevelEffect,
} from '../../content/weapons';
import type { Component } from 'bitecs';
import type { World } from '../world';
import type { WeaponDefinition } from '../../content/weapons';

interface OrbiterState {
  eid: number;
  angle: number; // current orbit angle in radians
}
/** weaponEid -> array of OrbiterState. One entry per orbiting blade. */
const ORBITERS_BY_WEAPON: Map<number, OrbiterState[]> = new Map();
/** projectile eid -> current orbit radius. Stored per-blade so each weapon
 *  level can resize without touching its peers. */
const ORBITER_RADII: Map<number, number> = new Map();

/**
 * True when the given projectile eid is currently an orbiter. Used by
 * `projectileSystem` to skip linear velocity integration (orbiters write
 * their own position each tick via `tickOrbiters`).
 */
export function isOrbiter(projEid: number): boolean {
  for (const list of ORBITERS_BY_WEAPON.values()) {
    for (const o of list) if (o.eid === projEid) return true;
  }
  return false;
}

/**
 * Advance every orbiter's angle by `dtSec * SAWBLADE_ANGULAR_SPEED_RAD_PER_SEC`
 * and update its world position to (player + cos/sin * radius). Called from
 * `autoAttackSystem` once per tick.
 */
export function tickOrbiters(playerEid: number, dtSec: number): void {
  const px = Position.x[playerEid] ?? 0;
  const py = Position.y[playerEid] ?? 0;
  for (const list of ORBITERS_BY_WEAPON.values()) {
    for (const o of list) {
      o.angle += SAWBLADE_ANGULAR_SPEED_RAD_PER_SEC * dtSec;
      const r = ORBITER_RADII.get(o.eid) ?? 95;
      Position.x[o.eid] = px + Math.cos(o.angle) * r;
      Position.y[o.eid] = py + Math.sin(o.angle) * r;
      Velocity.vx[o.eid] = 0;
      Velocity.vy[o.eid] = 0;
    }
  }
}

function ensureComponent(world: World, comp: Component, eid: number): void {
  if (!hasComponent(world, comp, eid)) {
    addComponent(world, comp, eid);
  }
}

/**
 * Spawn/recycle orbiter projectiles for `weaponEid` so the count matches the
 * weapon's level (`projectileCount`). Updates per-blade damage and radius on
 * every call so a level-up takes effect immediately.
 *
 * Caller (autoAttack's `fireWeapon` dispatcher) is responsible for resolving
 * `weaponEid` from the weapon id; the orbiter module deliberately doesn't
 * know about `weaponEidByWeaponId` (that map is private to autoAttack).
 *
 * Returns true so the dispatcher treats the call as "fired" and applies the
 * cooldown (orbiters tick continuously regardless of cooldown).
 */
export function ensureOrbiters(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  weaponEid: number,
): boolean {
  if (weaponEid < 0) return false;

  const lvEffect = weaponLevelEffect(def, level);
  const targetCount = Math.max(1, lvEffect.projectileCount ?? 1);
  const radius = lvEffect.radius ?? 95;
  const dmgMul = Stats.damageMul[ownerEid] ?? 1;
  const dmg = lvEffect.damage * dmgMul;

  let list = ORBITERS_BY_WEAPON.get(weaponEid);
  if (!list) {
    list = [];
    ORBITERS_BY_WEAPON.set(weaponEid, list);
  }

  // Adjust count: spawn up to target, despawn extras.
  while (list.length < targetCount) {
    const projEid = acquireEntity(world, PoolKind.Projectile);
    ensureComponent(world, Position, projEid);
    ensureComponent(world, Velocity, projEid);
    ensureComponent(world, Hitbox, projEid);
    ensureComponent(world, Damage, projEid);
    ensureComponent(world, Lifetime, projEid);
    ensureComponent(world, Projectile, projEid);
    ensureComponent(world, ProjectileTag, projEid);
    ensureComponent(world, Sprite, projEid);

    Position.x[projEid] = Position.x[ownerEid] ?? 0;
    Position.y[projEid] = Position.y[ownerEid] ?? 0;
    Velocity.vx[projEid] = 0;
    Velocity.vy[projEid] = 0;
    Hitbox.radius[projEid] = def.hitboxRadius ?? 14;
    Damage.amount[projEid] = dmg;
    // Orbiters never expire on their own — set huge lifetime; tickOrbiters keeps them alive.
    Lifetime.remainingMs[projEid] = 1e9;
    Projectile.pierce[projEid] = -1; // hits everything
    Projectile.ownerEid[projEid] = ownerEid;
    Projectile.homing[projEid] = 0;
    Sprite.textureIndex[projEid] = 0;
    Sprite.tint[projEid] = def.tint;
    Sprite.scale[projEid] = 1;
    Sprite.rotation[projEid] = 0;

    ORBITER_RADII.set(projEid, radius);
    const startAngle = (list.length / targetCount) * Math.PI * 2;
    list.push({ eid: projEid, angle: startAngle });
  }
  // Update damage on all existing orbiters (in case level changed).
  for (const o of list) {
    Damage.amount[o.eid] = dmg;
    ORBITER_RADII.set(o.eid, radius);
  }

  // Don't reset cooldown — orbiters are persistent, not "fired" per shot.
  // Returning true makes autoAttackSystem set a cooldown anyway, which is fine
  // (orbiters tick continuously regardless).
  return true;
}

/**
 * Drop every orbiter slot. Called from scene shutdown via
 * `resetAutoAttack`. Doesn't remove the underlying entities (the pool
 * teardown handles that) — just clears our bookkeeping.
 */
export function resetOrbiters(): void {
  ORBITERS_BY_WEAPON.clear();
  ORBITER_RADII.clear();
}
