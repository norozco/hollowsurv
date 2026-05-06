// Tick weapon cooldowns. When ready, fire the weapon: spawn a projectile or
// apply aura damage in a radius around the owner.
//
// Owner: Agent C3.
//
// Design choices:
//   - WeaponSlot lives on its **own entity** per equipped weapon. v1 has up
//     to 6 slots per the contract; we create one weapon entity per
//     runStore.player.weapons entry. This keeps bitECS happy (one component
//     instance per entity) while supporting multi-weapon naturally.
//   - We sync these weapon entities with runStore.player.weapons every tick.
//     Adding a new weapon to runStore (e.g. via level-up or `useRunStore.
//     setState(...)` from the dev console) creates a fresh weapon entity on
//     the next tick. Levels are synced from runStore so the picker is the
//     single source of truth.
//   - **Lazy init**: ArenaScene.create() spawns the player but doesn't
//     attach WeaponSlot (forbidden partition for us). We can't add a hook
//     into ArenaScene either. Instead, we run our own init in autoAttack's
//     first tick after the player entity is visible to a query — defending
//     against the "tick 0 with no player yet" case by simply skipping until
//     the PlayerTag query is non-empty.
//   - **Spatial hash**: built via collision.ts's helper at the top of this
//     system so projectile targeting (`nearest`) and aura `queryRadius`
//     work against fresh enemy positions. collisionSystem rebuilds again
//     defensively, so the hash is correct regardless of system reordering.

import { addComponent, addEntity, defineQuery, hasComponent, removeEntity } from 'bitecs';
import Phaser from 'phaser';

import { eventBus } from '../../core/eventBus';
import { acquireEntity, PoolKind } from '../../core/pool';
import { scratchIdBuffer, growIdBuffer } from '../../core/scratch';
import {
  Damage,
  Dead,
  Health,
  Hitbox,
  Lifetime,
  PlayerInput,
  PlayerTag,
  Position,
  Projectile,
  ProjectileTag,
  Sprite,
  Stats,
  Velocity,
  WeaponSlot,
} from '../components';
import {
  getEnemyHash,
  rebuildEnemyHash,
  resetPlayerInvuln,
} from './collision';
import {
  DEFAULT_PROJECTILE_LIFETIME_MS,
  PROJECTILE_LIFETIME_MS_BY_WEAPON,
  SAWBLADE_ANGULAR_SPEED_RAD_PER_SEC,
  WEAPONS,
  applyFrostSlow,
  weaponDefByNum,
  weaponIdToNum,
  weaponLevelEffect,
} from '../../content/weapons';
import { UPGRADES } from '../../content/upgrades';
import { useRunStore } from '../../stores/runStore';
import type { Component } from 'bitecs';
import type { World } from '../world';
import type { WeaponDefinition } from '../../content/weapons';

// Player query — used to find the player eid for owner / aim source.
const playerQuery = defineQuery([PlayerTag, Position]);
// All weapon entities — created and managed by us (not by ArenaScene).
const weaponSlotQuery = defineQuery([WeaponSlot]);

// Map weapon id (string) -> weapon entity eid. Tracks which weapons we've
// created so we don't double-spawn entities for the same id.
const weaponEidByWeaponId: Map<string, number> = new Map();
/**
 * Last-seen player eid. Used to detect a fresh ECS world (the scene was
 * shut down + recreated, releasing all entities). When the player eid
 * differs from what we cached, we wipe our weapon-eid map so the next sync
 * doesn't try to write into stale ids.
 */
let lastSeenPlayerEid = -1;

/**
 * Reset autoAttack state. Exposed for tests / scene shutdown. Doesn't remove
 * weapon entities from the world (that's destroyGameWorld's job); it just
 * clears our bookkeeping so a new world starts fresh.
 */
export function resetAutoAttack(): void {
  weaponEidByWeaponId.clear();
  lastSeenPlayerEid = -1;
  resetPlayerInvuln();
}

export function autoAttackSystem(world: World, dtMs: number): void {
  const store = useRunStore.getState();
  if (store.phase !== 'playing') return;
  _lastWorld = world;
  ensureUpgradeSubscription();

  // 1. Player check (defends against tick 0 before player entity is visible).
  const players = playerQuery(world);
  if (players.length === 0) return;
  const playerEid = players[0]!;

  // 1b. Detect fresh world (scene was destroyed + recreated): clear the
  //     weapon-eid map so we don't reference dead entities from a prior run.
  if (lastSeenPlayerEid !== -1 && lastSeenPlayerEid !== playerEid) {
    weaponEidByWeaponId.clear();
    resetPlayerInvuln();
  }
  lastSeenPlayerEid = playerEid;

  // 2. Ensure runStore has at least one weapon. Seed 'auto-pistol' at level 1
  //    if empty — the brief specifies the player starts with it equipped.
  if (store.player.weapons.length === 0) {
    seedDefaultWeapon();
  }

  // 3. Reconcile weapon entities with runStore.player.weapons.
  syncWeaponEntities(world, useRunStore.getState().player.weapons);

  // 4. Build the shared enemy spatial hash for this tick.
  rebuildEnemyHash(world);
  const enemyHash = getEnemyHash();

  // 5. Tick every WeaponSlot.
  const weaponEntities = weaponSlotQuery(world);
  const dmgMul = Stats.damageMul[playerEid] ?? 1;
  const speedMul = Stats.attackSpeedMul[playerEid] ?? 1;
  for (let i = 0; i < weaponEntities.length; i++) {
    const eid = weaponEntities[i];
    if (eid === undefined) continue;

    const weaponNum = WeaponSlot.weaponId[eid] ?? 0;
    const def = weaponDefByNum(weaponNum);
    if (!def) continue;

    let cd = WeaponSlot.cooldownMs[eid] ?? 0;
    cd -= dtMs;
    if (cd > 0) {
      WeaponSlot.cooldownMs[eid] = cd;
      continue;
    }

    const level = WeaponSlot.level[eid] ?? 1;
    const fired = fireWeapon(world, def, playerEid, level, dmgMul, enemyHash);
    if (!fired) {
      // No target — keep cooldown at 0 to retry next tick.
      WeaponSlot.cooldownMs[eid] = 0;
      continue;
    }

    const lvEffect = weaponLevelEffect(def, level);
    const nextCd = speedMul > 0 ? lvEffect.cooldownMs / speedMul : lvEffect.cooldownMs;
    WeaponSlot.cooldownMs[eid] = nextCd;
  }

  // Sync aura visual rings to follow the player.
  syncAuraVisuals(playerEid);

  // Tick orbiters (sawblade) so they revolve around the player.
  tickOrbiters(playerEid, dtMs / 1000);
}

// --- aura visual ring ------------------------------------------------------
// Three stacked concentric circles per equipped aura weapon = soft gradient.
// Cheaper than a real radial gradient and works in Phaser 4 out of the box.

interface AuraVisual {
  outer: Phaser.GameObjects.Arc;
  mid: Phaser.GameObjects.Arc;
  inner: Phaser.GameObjects.Arc;
}
const AURA_RINGS: Map<number, AuraVisual> = new Map();

function findAuraScene(): Phaser.Scene | null {
  const game = (globalThis as { __game?: Phaser.Game }).__game;
  if (!game) return null;
  const scene = game.scene.getScene('ArenaScene');
  if (!scene || !game.scene.isActive('ArenaScene')) return null;
  return scene;
}

function syncAuraVisuals(playerEid: number): void {
  const scene = findAuraScene();
  if (!scene) return;
  const px = Position.x[playerEid] ?? 0;
  const py = Position.y[playerEid] ?? 0;

  const weaponEntities = weaponSlotQuery(useRunStoreWorld());
  // Track which weapon eids are aura this tick so we can clean up unequipped ones.
  const stillEquipped = new Set<number>();
  for (let i = 0; i < weaponEntities.length; i++) {
    const eid = weaponEntities[i];
    if (eid === undefined) continue;
    const num = WeaponSlot.weaponId[eid] ?? 0;
    const def = weaponDefByNum(num);
    if (!def || def.archetype !== 'aura') continue;
    stillEquipped.add(eid);
    const level = WeaponSlot.level[eid] ?? 1;
    const lvEffect = weaponLevelEffect(def, level);
    const radius = lvEffect.radius ?? 100;
    let ring = AURA_RINGS.get(eid);
    if (!ring) {
      // 3 stacked circles with decreasing radius and increasing alpha → fake
      // radial gradient. No stroke. Depth 5 keeps it under the player (100).
      const outer = scene.add.circle(px, py, 1, def.tint, 0.06).setScale(radius).setDepth(5);
      const mid = scene.add.circle(px, py, 1, def.tint, 0.10).setScale(radius * 0.7).setDepth(5);
      const inner = scene.add.circle(px, py, 1, def.tint, 0.16).setScale(radius * 0.4).setDepth(5);
      ring = { outer, mid, inner };
      AURA_RINGS.set(eid, ring);
    } else {
      ring.outer.x = px; ring.outer.y = py; ring.outer.setScale(radius);
      ring.mid.x = px; ring.mid.y = py; ring.mid.setScale(radius * 0.7);
      ring.inner.x = px; ring.inner.y = py; ring.inner.setScale(radius * 0.4);
    }
  }
  // Remove rings whose weapon is no longer equipped (rare but possible).
  for (const [eid, ring] of AURA_RINGS) {
    if (!stillEquipped.has(eid)) {
      ring.outer.destroy();
      ring.mid.destroy();
      ring.inner.destroy();
      AURA_RINGS.delete(eid);
    }
  }
}

// Helper: get the world from somewhere we can access. autoAttackSystem already
// has world; we expose it via a closure-private cache for the aura sync.
let _lastWorld: World | null = null;
function useRunStoreWorld(): World {
  // Fallback: empty world results in empty query. Real world set at top of system.
  return _lastWorld!;
}

// --- upgrade_chosen subscription: apply stat multipliers to ECS Stats -----
// Lazy-subscribed on first system tick. Reads UPGRADES dict, applies augment
// effects to the player's Stats / Health components.
let _upgradeSubscribed = false;
function ensureUpgradeSubscription(): void {
  if (_upgradeSubscribed) return;
  _upgradeSubscribed = true;
  eventBus.on('upgrade_chosen', (e) => {
    const world = _lastWorld;
    if (!world) return;
    const players = playerQuery(world);
    if (players.length === 0) return;
    const playerEid = players[0]!;

    // The choiceId carries `aug-<upgrade-id>-<random>`; strip random suffix
    // and look up the augment in the UPGRADES dict.
    // Format: aug-<id>-<5 chars>. Recover by dropping leading "aug-" and trailing "-<5>".
    const m = /^aug-(.+)-[a-z0-9]{5}$/.exec(e.choiceId);
    if (!m) return;
    const upgradeId = m[1]!;
    const upgrade = UPGRADES[upgradeId];
    if (!upgrade || upgrade.kind !== 'augment' || !upgrade.augment) return;
    const aug = upgrade.augment;

    if (aug.damageMul) Stats.damageMul[playerEid] = (Stats.damageMul[playerEid] ?? 1) * aug.damageMul;
    if (aug.attackSpeedMul) Stats.attackSpeedMul[playerEid] = (Stats.attackSpeedMul[playerEid] ?? 1) * aug.attackSpeedMul;
    if (aug.moveSpeedMul) Stats.moveSpeedMul[playerEid] = (Stats.moveSpeedMul[playerEid] ?? 1) * aug.moveSpeedMul;
    if (aug.pickupRadiusMul) Stats.pickupRadiusMul[playerEid] = (Stats.pickupRadiusMul[playerEid] ?? 1) * aug.pickupRadiusMul;
    if (aug.maxHpDelta) {
      Health.maxHp[playerEid] = (Health.maxHp[playerEid] ?? 100) + aug.maxHpDelta;
      Health.hp[playerEid] = Math.min(
        Health.maxHp[playerEid] ?? 100,
        (Health.hp[playerEid] ?? 100) + aug.maxHpDelta,
      );
    }
  });
}

// --- runStore <-> weapon entity reconciliation ----------------------------

interface RunWeaponEntry {
  id: string;
  level: number;
  evolved: boolean;
}

function syncWeaponEntities(world: World, weapons: readonly RunWeaponEntry[]): void {
  // Create entities for any weapon ids we haven't tracked yet.
  for (let i = 0; i < weapons.length; i++) {
    const w = weapons[i];
    if (!w) continue;
    if (!WEAPONS[w.id]) continue; // unknown weapon — skip silently
    let eid = weaponEidByWeaponId.get(w.id);
    if (eid === undefined) {
      eid = createWeaponEntity(world, w.id, w.level, w.evolved);
      weaponEidByWeaponId.set(w.id, eid);
    } else {
      // Sync level/evolved each tick — cheap, single-byte writes.
      const expectedLevel = Math.max(1, w.level | 0);
      if (WeaponSlot.level[eid] !== expectedLevel) WeaponSlot.level[eid] = expectedLevel;
      const expectedEvolved = w.evolved ? 1 : 0;
      if (WeaponSlot.evolved[eid] !== expectedEvolved) {
        WeaponSlot.evolved[eid] = expectedEvolved;
      }
    }
  }

  // Remove entities for weapons no longer in runStore (rare, but defensive).
  if (weaponEidByWeaponId.size > weapons.length) {
    const ownedIds = new Set(weapons.map((w) => w.id));
    for (const [id, eid] of weaponEidByWeaponId) {
      if (!ownedIds.has(id)) {
        // Best-effort removal; the entity has only WeaponSlot so cheap.
        try {
          removeEntity(world, eid);
        } catch {
          // ignore — entity may already be gone
        }
        weaponEidByWeaponId.delete(id);
      }
    }
  }
}

function createWeaponEntity(
  world: World,
  weaponId: string,
  level: number,
  evolved: boolean
): number {
  // We reuse acquireEntity with PoolKind.DamageNumber? No — weapons aren't a
  // pooled kind. Just create a raw entity via bitECS's addEntity. To match
  // existing patterns, we call addEntity here directly; weapon entities live
  // until the run ends and the world is destroyed.
  const eid = addEntityRaw(world);
  addComponent(world, WeaponSlot, eid);
  WeaponSlot.weaponId[eid] = weaponIdToNum(weaponId);
  WeaponSlot.level[eid] = Math.max(1, level | 0);
  WeaponSlot.evolved[eid] = evolved ? 1 : 0;
  // Start at 0 so the weapon fires immediately on equip — survivors-style.
  WeaponSlot.cooldownMs[eid] = 0;
  return eid;
}

function addEntityRaw(world: World): number {
  return addEntity(world);
}

function seedDefaultWeapon(): void {
  // Sets runStore.player.weapons to include 'auto-pistol' at level 1. This is
  // the only place in the combat partition where we mutate runStore — the
  // alternative (waiting for the level-up picker to assign one) would mean a
  // freshly-started run has zero firing weapons. The brief's vertical-slice
  // requirement is the player auto-attacks from t=0.
  useRunStore.setState((s) => {
    if (s.player.weapons.length > 0) return s;
    return {
      player: {
        ...s.player,
        weapons: [{ id: 'auto-pistol', level: 1, evolved: false }],
      },
    };
  });
}

// --- per-archetype fire paths ---------------------------------------------

const PROJECTILE_TARGET_RANGE = 800;

function fireWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  if (def.archetype === 'auto_projectile') {
    return fireProjectileWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'aura') {
    return fireAuraWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'frost_nova') {
    return fireFrostNovaWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'chain') {
    return fireLightningWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'boomerang') {
    return fireBoomerangWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'orbiter') {
    return ensureOrbiters(world, def, ownerEid, level);
  }
  if (def.archetype === 'mortar') {
    return fireMortarWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'shotgun') {
    return fireShotgunWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  return false;
}

function fireProjectileWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;

  let dirX = 0;
  let dirY = 0;
  let targetEid = 0;

  if ((PlayerInput.manualAim[ownerEid] ?? 0) === 1) {
    dirX = PlayerInput.aimX[ownerEid] ?? 0;
    dirY = PlayerInput.aimY[ownerEid] ?? 0;
    if (dirX === 0 && dirY === 0) {
      targetEid = enemyHash.nearest(ox, oy, PROJECTILE_TARGET_RANGE);
    }
  } else {
    targetEid = enemyHash.nearest(ox, oy, PROJECTILE_TARGET_RANGE);
  }

  if (targetEid > 0) {
    const tx = Position.x[targetEid] ?? ox;
    const ty = Position.y[targetEid] ?? oy;
    const dx = tx - ox;
    const dy = ty - oy;
    const len = Math.hypot(dx, dy);
    if (len <= 0.0001) return false;
    const inv = 1 / len;
    dirX = dx * inv;
    dirY = dy * inv;
  } else if (dirX === 0 && dirY === 0) {
    return false;
  } else {
    const len = Math.hypot(dirX, dirY);
    if (len > 0.0001) {
      const inv = 1 / len;
      dirX *= inv;
      dirY *= inv;
    }
  }

  const lvEffect = weaponLevelEffect(def, level);
  const speed = lvEffect.projectileSpeed ?? 600;
  const pierce = lvEffect.pierce ?? 0;
  const lifetimeMs =
    PROJECTILE_LIFETIME_MS_BY_WEAPON[def.id] ?? DEFAULT_PROJECTILE_LIFETIME_MS;
  const hitboxR = def.hitboxRadius ?? 6;
  const damageAmount = lvEffect.damage * dmgMul;

  const projEid = acquireEntity(world, PoolKind.Projectile);

  ensureComponent(world, Position, projEid);
  ensureComponent(world, Velocity, projEid);
  ensureComponent(world, Hitbox, projEid);
  ensureComponent(world, Damage, projEid);
  ensureComponent(world, Lifetime, projEid);
  ensureComponent(world, Projectile, projEid);
  ensureComponent(world, ProjectileTag, projEid);
  ensureComponent(world, Sprite, projEid);

  Position.x[projEid] = ox;
  Position.y[projEid] = oy;
  Velocity.vx[projEid] = dirX * speed;
  Velocity.vy[projEid] = dirY * speed;
  Hitbox.radius[projEid] = hitboxR;
  Damage.amount[projEid] = damageAmount;
  Lifetime.remainingMs[projEid] = lifetimeMs;
  Projectile.pierce[projEid] = pierce;
  Projectile.ownerEid[projEid] = ownerEid;
  Projectile.homing[projEid] = lvEffect.homing ? 1 : 0;
  Sprite.textureIndex[projEid] = 0;
  Sprite.tint[projEid] = def.tint;
  Sprite.scale[projEid] = 1;
  Sprite.rotation[projEid] = Math.atan2(dirY, dirX);

  eventBus.emit({
    type: 'weapon_fired',
    weaponId: def.id,
    source: ownerEid,
    targetEid: targetEid > 0 ? targetEid : 0,
  });
  eventBus.emit({
    type: 'projectile_spawned',
    projectile: projEid,
    weaponId: def.id,
  });

  return true;
}

function fireAuraWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  const lvEffect = weaponLevelEffect(def, level);
  const radius = lvEffect.radius ?? 100;
  if (radius <= 0) return false;

  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;
  const damageAmount = lvEffect.damage * dmgMul;

  growIdBuffer(64);
  enemyHash.queryRadius(ox, oy, radius, scratchIdBuffer);

  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined) continue;
    const curHp = Health.hp[eid] ?? 0;
    if (curHp <= 0) continue;
    const nextHp = curHp - damageAmount;
    Health.hp[eid] = nextHp;

    eventBus.emit({
      type: 'damage_dealt',
      target: eid,
      source: ownerEid,
      amount: damageAmount,
      isCrit: false,
    });

    if (nextHp <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({
        type: 'enemy_killed',
        enemy: eid,
        killer: ownerEid,
        position: { x: ex, y: ey },
      });
      // Mark Dead so collision pass skips and lifetimeSystem recycles.
      ensureComponent(world, Dead, eid);
    }
  }

  eventBus.emit({
    type: 'weapon_fired',
    weaponId: def.id,
    source: ownerEid,
    targetEid: 0,
  });
  return true;
}

// --- frost nova: aura-burst that damages and slows ------------------------

function fireFrostNovaWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  const lvEffect = weaponLevelEffect(def, level);
  const radius = lvEffect.radius ?? 130;
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;
  const damageAmount = lvEffect.damage * dmgMul;

  growIdBuffer(64);
  enemyHash.queryRadius(ox, oy, radius, scratchIdBuffer);

  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    const curHp = Health.hp[eid] ?? 0;
    if (curHp <= 0) continue;
    const nextHp = curHp - damageAmount;
    Health.hp[eid] = nextHp;
    applyFrostSlow(eid);

    eventBus.emit({ type: 'damage_dealt', target: eid, source: ownerEid, amount: damageAmount, isCrit: false });

    if (nextHp <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({ type: 'enemy_killed', enemy: eid, killer: ownerEid, position: { x: ex, y: ey } });
      ensureComponent(world, Dead, eid);
    }
  }

  // Brief expanding ring visual.
  spawnFrostBurstVisual(ox, oy, radius, def.tint);

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: 0 });
  return true;
}

function spawnFrostBurstVisual(x: number, y: number, radius: number, tint: number): void {
  const scene = findAuraScene();
  if (!scene) return;
  const ring = scene.add.circle(x, y, 1, tint, 0.45).setDepth(6).setScale(8);
  ring.setStrokeStyle(3, tint, 0.9);
  scene.tweens.add({
    targets: ring,
    scale: radius,
    alpha: 0,
    duration: 400,
    ease: 'Cubic.out',
    onComplete: () => ring.destroy(),
  });
}

// --- lightning: chain damage between enemies ------------------------------

function fireLightningWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  const lvEffect = weaponLevelEffect(def, level);
  const chainCount = Math.max(1, lvEffect.projectileCount ?? 3);
  const baseDmg = lvEffect.damage * dmgMul;

  // Start: nearest enemy to player.
  const px = Position.x[ownerEid] ?? 0;
  const py = Position.y[ownerEid] ?? 0;
  let target = enemyHash.nearest(px, py, PROJECTILE_TARGET_RANGE);
  if (target <= 0) return false;

  const visited = new Set<number>();
  const points: { x: number; y: number }[] = [{ x: px, y: py }];
  let dmg = baseDmg;
  for (let i = 0; i < chainCount; i++) {
    if (target <= 0 || visited.has(target)) break;
    visited.add(target);

    const ex = Position.x[target] ?? 0;
    const ey = Position.y[target] ?? 0;
    points.push({ x: ex, y: ey });

    if (!hasComponent(world, Dead, target)) {
      const curHp = Health.hp[target] ?? 0;
      const nextHp = curHp - dmg;
      Health.hp[target] = nextHp;
      eventBus.emit({ type: 'damage_dealt', target, source: ownerEid, amount: dmg, isCrit: false });
      if (nextHp <= 0) {
        eventBus.emit({ type: 'enemy_killed', enemy: target, killer: ownerEid, position: { x: ex, y: ey } });
        ensureComponent(world, Dead, target);
      }
    }

    // Find next: nearest enemy to current target, excluding visited.
    let nextTarget = -1;
    let bestD2 = LIGHTNING_CHAIN_RANGE * LIGHTNING_CHAIN_RANGE;
    growIdBuffer(64);
    enemyHash.queryRadius(ex, ey, LIGHTNING_CHAIN_RANGE, scratchIdBuffer);
    for (let j = 0; j < scratchIdBuffer.length; j++) {
      const cand = scratchIdBuffer[j];
      if (cand === undefined || cand === target || visited.has(cand)) continue;
      if (hasComponent(world, Dead, cand)) continue;
      const cx = Position.x[cand] ?? 0;
      const cy = Position.y[cand] ?? 0;
      const d2 = (cx - ex) ** 2 + (cy - ey) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        nextTarget = cand;
      }
    }
    target = nextTarget;
    dmg *= 0.7; // 30% damage falloff per jump
  }

  spawnLightningVisual(points, def.tint);

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: 0 });
  return true;
}

const LIGHTNING_CHAIN_RANGE = 220;

function spawnLightningVisual(points: { x: number; y: number }[], tint: number): void {
  const scene = findAuraScene();
  if (!scene || points.length < 2) return;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const line = scene.add.line(0, 0, a.x, a.y, b.x, b.y, tint, 0.9);
    line.setOrigin(0, 0).setLineWidth(2).setDepth(50);
    scene.tweens.add({
      targets: line,
      alpha: 0,
      duration: 220,
      onComplete: () => line.destroy(),
    });
  }
}

// --- boomerang: thrown projectile that flips velocity at lifetime midpoint -

const BOOMERANG_FLIP_AT_MS = new Float32Array(2048); // proj eid -> performance.now() to flip

export function isBoomerang(projEid: number): boolean {
  if (projEid < 0 || projEid >= BOOMERANG_FLIP_AT_MS.length) return false;
  return (BOOMERANG_FLIP_AT_MS[projEid] ?? 0) > 0;
}

export function consumeBoomerangFlip(projEid: number): boolean {
  if (projEid < 0 || projEid >= BOOMERANG_FLIP_AT_MS.length) return false;
  const at = BOOMERANG_FLIP_AT_MS[projEid] ?? 0;
  if (at > 0 && performance.now() >= at) {
    BOOMERANG_FLIP_AT_MS[projEid] = 0;
    return true;
  }
  return false;
}

function fireBoomerangWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>
): boolean {
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;
  const target = enemyHash.nearest(ox, oy, PROJECTILE_TARGET_RANGE);
  if (target <= 0) return false;
  const tx = Position.x[target] ?? ox;
  const ty = Position.y[target] ?? oy;
  const dx = tx - ox;
  const dy = ty - oy;
  const len = Math.hypot(dx, dy);
  if (len <= 0.0001) return false;
  const inv = 1 / len;
  const dirX = dx * inv;
  const dirY = dy * inv;

  const lvEffect = weaponLevelEffect(def, level);
  const speed = lvEffect.projectileSpeed ?? 800;
  const lifetimeMs = PROJECTILE_LIFETIME_MS_BY_WEAPON[def.id] ?? 1400;
  const damageAmount = lvEffect.damage * dmgMul;

  const projEid = acquireEntity(world, PoolKind.Projectile);
  ensureComponent(world, Position, projEid);
  ensureComponent(world, Velocity, projEid);
  ensureComponent(world, Hitbox, projEid);
  ensureComponent(world, Damage, projEid);
  ensureComponent(world, Lifetime, projEid);
  ensureComponent(world, Projectile, projEid);
  ensureComponent(world, ProjectileTag, projEid);
  ensureComponent(world, Sprite, projEid);

  Position.x[projEid] = ox;
  Position.y[projEid] = oy;
  Velocity.vx[projEid] = dirX * speed;
  Velocity.vy[projEid] = dirY * speed;
  Hitbox.radius[projEid] = def.hitboxRadius ?? 14;
  Damage.amount[projEid] = damageAmount;
  Lifetime.remainingMs[projEid] = lifetimeMs;
  Projectile.pierce[projEid] = lvEffect.pierce ?? 6;
  Projectile.ownerEid[projEid] = ownerEid;
  Projectile.homing[projEid] = 0;
  Sprite.textureIndex[projEid] = 0;
  Sprite.tint[projEid] = def.tint;
  Sprite.scale[projEid] = 1;
  Sprite.rotation[projEid] = Math.atan2(dirY, dirX);

  // Schedule flip at midpoint. projectile.ts checks this each tick.
  if (projEid < BOOMERANG_FLIP_AT_MS.length) {
    BOOMERANG_FLIP_AT_MS[projEid] = performance.now() + lifetimeMs / 2;
  }

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: target });
  eventBus.emit({ type: 'projectile_spawned', projectile: projEid, weaponId: def.id });
  return true;
}

// --- orbiter (sawblade): persistent entities orbiting the player ----------

interface OrbiterState {
  eid: number;
  angle: number; // current orbit angle in radians
}
/** weaponEid -> array of OrbiterState. One entry per orbiting blade. */
const ORBITERS_BY_WEAPON: Map<number, OrbiterState[]> = new Map();

export function isOrbiter(projEid: number): boolean {
  for (const list of ORBITERS_BY_WEAPON.values()) {
    for (const o of list) if (o.eid === projEid) return true;
  }
  return false;
}

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

const ORBITER_RADII: Map<number, number> = new Map();

function ensureOrbiters(world: World, def: WeaponDefinition, ownerEid: number, level: number): boolean {
  // Find or create the weapon entity for this weapon (we need a key).
  let weaponEid = -1;
  for (const [id, eid] of weaponEidByWeaponId) {
    if (id === def.id) { weaponEid = eid; break; }
  }
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

  // Sync angles so existing orbiters spread evenly each level-up.
  if (list.length > 0) {
    for (let i = 0; i < list.length; i++) {
      // keep current rotation but normalize spacing — not strictly required; cheap to skip.
    }
  }

  // Don't reset cooldown — orbiters are persistent, not "fired" per shot.
  // Returning true makes autoAttackSystem set a cooldown anyway, which is fine
  // (orbiters tick continuously regardless).
  return true;
}

// --- mortar: explosion on impact or lifetime expiry -----------------------

const MORTAR_PROJECTILES: Map<number, { radius: number; damage: number; tint: number }> = new Map();
export function isMortar(projEid: number): boolean {
  return MORTAR_PROJECTILES.has(projEid);
}
export function detonateMortar(
  world: World,
  projEid: number,
  enemyHashAccess: ReturnType<typeof getEnemyHash>,
): void {
  const data = MORTAR_PROJECTILES.get(projEid);
  if (!data) return;
  MORTAR_PROJECTILES.delete(projEid);
  const x = Position.x[projEid] ?? 0;
  const y = Position.y[projEid] ?? 0;
  growIdBuffer(64);
  enemyHashAccess.queryRadius(x, y, data.radius, scratchIdBuffer);
  const ownerEid = Projectile.ownerEid[projEid] ?? 0;
  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    const curHp = Health.hp[eid] ?? 0;
    if (curHp <= 0) continue;
    const next = curHp - data.damage;
    Health.hp[eid] = next;
    eventBus.emit({ type: 'damage_dealt', target: eid, source: ownerEid, amount: data.damage, isCrit: false });
    if (next <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({ type: 'enemy_killed', enemy: eid, killer: ownerEid, position: { x: ex, y: ey } });
      ensureComponent(world, Dead, eid);
    }
  }
  // Visual: brief ring at impact.
  const scene = findAuraScene();
  if (scene) {
    const ring = scene.add.circle(x, y, 1, data.tint, 0.6).setDepth(8).setScale(8);
    ring.setStrokeStyle(2, data.tint, 0.95);
    scene.tweens.add({
      targets: ring,
      scale: data.radius,
      alpha: 0,
      duration: 320,
      ease: 'Cubic.out',
      onComplete: () => ring.destroy(),
    });
  }
}

function fireMortarWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>,
): boolean {
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;
  const target = enemyHash.nearest(ox, oy, PROJECTILE_TARGET_RANGE);
  if (target <= 0) return false;
  const tx = Position.x[target] ?? ox;
  const ty = Position.y[target] ?? oy;
  const dx = tx - ox;
  const dy = ty - oy;
  const len = Math.hypot(dx, dy);
  if (len <= 0.0001) return false;
  const inv = 1 / len;
  const dirX = dx * inv;
  const dirY = dy * inv;

  const lvEffect = weaponLevelEffect(def, level);
  const speed = lvEffect.projectileSpeed ?? 520;
  const lifetimeMs = PROJECTILE_LIFETIME_MS_BY_WEAPON[def.id] ?? 1100;
  const radius = lvEffect.radius ?? 90;
  const damageAmount = lvEffect.damage * dmgMul;

  const projEid = acquireEntity(world, PoolKind.Projectile);
  ensureComponent(world, Position, projEid);
  ensureComponent(world, Velocity, projEid);
  ensureComponent(world, Hitbox, projEid);
  ensureComponent(world, Damage, projEid);
  ensureComponent(world, Lifetime, projEid);
  ensureComponent(world, Projectile, projEid);
  ensureComponent(world, ProjectileTag, projEid);
  ensureComponent(world, Sprite, projEid);

  Position.x[projEid] = ox;
  Position.y[projEid] = oy;
  Velocity.vx[projEid] = dirX * speed;
  Velocity.vy[projEid] = dirY * speed;
  Hitbox.radius[projEid] = def.hitboxRadius ?? 10;
  // Direct hit damage = 0 — collision still triggers detonation via the side-channel.
  Damage.amount[projEid] = 0;
  Lifetime.remainingMs[projEid] = lifetimeMs;
  Projectile.pierce[projEid] = 0;
  Projectile.ownerEid[projEid] = ownerEid;
  Projectile.homing[projEid] = 0;
  Sprite.textureIndex[projEid] = 0;
  Sprite.tint[projEid] = def.tint;
  Sprite.scale[projEid] = 1;
  Sprite.rotation[projEid] = Math.atan2(dirY, dirX);

  MORTAR_PROJECTILES.set(projEid, { radius, damage: damageAmount, tint: def.tint });

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: target });
  eventBus.emit({ type: 'projectile_spawned', projectile: projEid, weaponId: def.id });
  return true;
}

// --- shotgun: cone-spread of pellets --------------------------------------

function fireShotgunWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>,
): boolean {
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;
  const target = enemyHash.nearest(ox, oy, PROJECTILE_TARGET_RANGE);
  if (target <= 0) return false;
  const tx = Position.x[target] ?? ox;
  const ty = Position.y[target] ?? oy;
  const baseAngle = Math.atan2(ty - oy, tx - ox);

  const lvEffect = weaponLevelEffect(def, level);
  const speed = lvEffect.projectileSpeed ?? 850;
  const lifetimeMs = PROJECTILE_LIFETIME_MS_BY_WEAPON[def.id] ?? 450;
  const pelletCount = Math.max(1, lvEffect.projectileCount ?? 3);
  const damageAmount = lvEffect.damage * dmgMul;

  // Spread evenly across a cone centered on baseAngle.
  const SPREAD = 0.5; // ~30° total
  for (let i = 0; i < pelletCount; i++) {
    const t = pelletCount === 1 ? 0 : i / (pelletCount - 1) - 0.5; // -0.5..0.5
    const angle = baseAngle + t * SPREAD;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    const projEid = acquireEntity(world, PoolKind.Projectile);
    ensureComponent(world, Position, projEid);
    ensureComponent(world, Velocity, projEid);
    ensureComponent(world, Hitbox, projEid);
    ensureComponent(world, Damage, projEid);
    ensureComponent(world, Lifetime, projEid);
    ensureComponent(world, Projectile, projEid);
    ensureComponent(world, ProjectileTag, projEid);
    ensureComponent(world, Sprite, projEid);

    Position.x[projEid] = ox;
    Position.y[projEid] = oy;
    Velocity.vx[projEid] = dirX * speed;
    Velocity.vy[projEid] = dirY * speed;
    Hitbox.radius[projEid] = def.hitboxRadius ?? 7;
    Damage.amount[projEid] = damageAmount;
    Lifetime.remainingMs[projEid] = lifetimeMs;
    Projectile.pierce[projEid] = lvEffect.pierce ?? 1;
    Projectile.ownerEid[projEid] = ownerEid;
    Projectile.homing[projEid] = 0;
    Sprite.textureIndex[projEid] = 0;
    Sprite.tint[projEid] = def.tint;
    Sprite.scale[projEid] = 1;
    Sprite.rotation[projEid] = angle;
  }

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: target });
  return true;
}

// --- helpers --------------------------------------------------------------

function ensureComponent(world: World, comp: Component, eid: number): void {
  if (!hasComponent(world, comp, eid)) {
    addComponent(world, comp, eid);
  }
}

void WEAPONS;
