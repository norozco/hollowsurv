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

import { eventBus } from '../../core/eventBus';
import { getArenaScene } from '../../core/gameContext';
import { acquireEntity, PoolKind, POOL_CAPS } from '../../core/pool';
import { rng } from '../../core/rng';
import { scratchIdBuffer, growIdBuffer } from '../../core/scratch';
import {
  BossTag,
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
  WEAPONS,
  applyFrostSlow,
  isEnemySlowed,
  weaponDefByNum,
  weaponIdToNum,
  weaponLevelEffect,
} from '../../content/weapons';
import { UPGRADES } from '../../content/upgrades';
import { getCharacter } from '../../content/characters';
import { useRunStore } from '../../stores/runStore';
import { hasSynergy, tickSynergies } from './synergies';
import { resetAuraVisuals, syncAuraVisuals } from './auraVisuals';
import {
  ensureOrbiters,
  isOrbiter as orbiterIsOrbiter,
  resetOrbiters,
  tickOrbiters,
} from './orbiter';
import type { Component } from 'bitecs';
import type { World } from '../world';
import type { WeaponDefinition } from '../../content/weapons';

// Re-export so projectile.ts (which imports `isOrbiter` from autoAttack) keeps
// working with the same import surface after the orbiter split.
export const isOrbiter = orbiterIsOrbiter;

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
  resetAuraVisuals();
  resetOrbiters();
}

export function autoAttackSystem(world: World, dtMs: number): void {
  const store = useRunStore.getState();
  if (store.phase !== 'playing') return;
  _lastWorld = world;
  ensureUpgradeSubscription();
  // Hidden synergies: cheap O(synergies * weapons) scan. Emits one-shot
  // 'synergy_activated' events when a pair first completes — wires the toast.
  tickSynergies();

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
  syncAuraVisuals(world, playerEid);

  // Tick orbiters (sawblade) so they revolve around the player.
  tickOrbiters(playerEid, dtMs / 1000);
}

// Closure-private cache for the world reference. Used by the lazy upgrade /
// damage / character event subscriptions below — they fire outside the system
// tick so they can't get `world` from a parameter.
let _lastWorld: World | null = null;

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

  // Hollowfield synergy (Aura + Thorns): when the player takes damage, fire
  // an extra free aura tick around them. Listens for damage_dealt where the
  // target is the player; cheap O(1) gating with hasSynergy + a player-id check.
  eventBus.on('damage_dealt', (e) => {
    if (!hasSynergy('hollowfield')) return;
    const world = _lastWorld;
    if (!world) return;
    const players = playerQuery(world);
    if (players.length === 0) return;
    const playerEid = players[0]!;
    if (e.target !== playerEid) return;
    triggerHollowfieldPulse(world, playerEid);
  });

  eventBus.on('character_selected', (e) => {
    const world = _lastWorld;
    if (!world) return;
    const players = playerQuery(world);
    if (players.length === 0) return;
    const playerEid = players[0]!;

    const character = getCharacter(e.characterId);
    const b = character.bonuses;

    // Reset stats to 1.0 baseline first so picking a different character mid-session
    // doesn't compound. Augments picked later in pickUpgrade re-multiply on top.
    Stats.damageMul[playerEid] = 1;
    Stats.attackSpeedMul[playerEid] = 1;
    Stats.moveSpeedMul[playerEid] = 1;
    Stats.pickupRadiusMul[playerEid] = 1;

    if (b.damageMul) Stats.damageMul[playerEid] *= b.damageMul;
    if (b.attackSpeedMul) Stats.attackSpeedMul[playerEid] *= b.attackSpeedMul;
    if (b.moveSpeedMul) Stats.moveSpeedMul[playerEid] *= b.moveSpeedMul;
    if (b.pickupRadiusMul) Stats.pickupRadiusMul[playerEid] *= b.pickupRadiusMul;

    if (b.maxHpDelta) {
      const newMax = (Health.maxHp[playerEid] ?? 100) + b.maxHpDelta;
      Health.maxHp[playerEid] = newMax;
      Health.hp[playerEid] = newMax; // full heal at run start
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
    // The orbiter module is generic — it needs the weapon entity eid to key
    // its ORBITERS_BY_WEAPON map (autoAttack owns the weaponId -> eid map so
    // the lookup stays here).
    const weaponEid = weaponEidByWeaponId.get(def.id) ?? -1;
    return ensureOrbiters(world, def, ownerEid, level, weaponEid);
  }
  if (def.archetype === 'mortar') {
    return fireMortarWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'shotgun') {
    return fireShotgunWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
  }
  if (def.archetype === 'melee') {
    return fireBladeWeapon(world, def, ownerEid, level, dmgMul, enemyHash);
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
  // Evolved projectiles render slightly larger / brighter to signal the upgrade.
  Sprite.scale[projEid] = lvEffect.forceCrit ? 1.4 : 1;
  Sprite.rotation[projEid] = Math.atan2(dirY, dirX);

  // Phantom Shot: every projectile is a guaranteed crit. The collision system
  // reads `PROJECTILE_FORCE_CRIT[projEid]` to bypass the random roll. Clear
  // first so a recycled projectile slot doesn't carry the flag from a prior
  // life — the projectile pool re-uses eids aggressively.
  PROJECTILE_FORCE_CRIT[projEid] = lvEffect.forceCrit ? 1 : 0;

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
      // Boss kill via aura must trigger run_won — collision.ts handles this
      // for projectile hits, but non-projectile kill paths need explicit wiring.
      emitRunWonIfBoss(world, eid);
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
      emitRunWonIfBoss(world, eid);
    }
  }

  // Brief expanding ring visual.
  spawnFrostBurstVisual(ox, oy, radius, def.tint);

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: 0 });
  return true;
}

function spawnFrostBurstVisual(x: number, y: number, radius: number, tint: number): void {
  const scene = getArenaScene();
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
  let chainCount = Math.max(1, lvEffect.projectileCount ?? 3);
  // Chainstrike synergy (Lightning + Crit): when this fire crits, chain to
  // 2x the enemies. We roll once per fire so the whole chain is either
  // "crit-extended" or normal — keeps the visual coherent.
  if (hasSynergy('chainstrike')) {
    const critChance = useRunStore.getState().player.critChance;
    // Use rng() so Chainstrike crit roll is deterministic under Daily Seed.
    if (critChance > 0 && rng() < critChance) {
      chainCount *= 2;
    }
  }
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
        emitRunWonIfBoss(world, target);
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
  const scene = getArenaScene();
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

// Sized off the projectile pool cap so this can never silently corrupt if
// POOL_CAPS[Projectile] is raised. +1 because eids are 1-based at boundary;
// +small margin keeps a few slots safe against off-by-one if the pool ever
// grows during init. Indexed by projectile eid.
const BOOMERANG_FLIP_AT_MS = new Float32Array(POOL_CAPS[PoolKind.Projectile] + 64);

// --- evolution side-channels --------------------------------------------
// One Uint8Array per per-projectile evolution flag. Reusing the same shape
// keeps allocation predictable and lookup branch-free (just `arr[eid] === 1`).
// The collision system reads `PROJECTILE_FORCE_CRIT` to honour Phantom Shot's
// guaranteed crit; `RICOCHETS_REMAINING` lets `projectileSystem` bounce
// Eternal Return projectiles off arena edges before lifetime expiry.
const PROJECTILE_FORCE_CRIT = new Uint8Array(POOL_CAPS[PoolKind.Projectile] + 64);
const RICOCHETS_REMAINING = new Uint8Array(POOL_CAPS[PoolKind.Projectile] + 64);

/** Read whether the projectile must crit on every hit (Phantom Shot). */
export function isForceCritProjectile(projEid: number): boolean {
  if (projEid < 0 || projEid >= PROJECTILE_FORCE_CRIT.length) return false;
  return PROJECTILE_FORCE_CRIT[projEid] === 1;
}

/**
 * Read the remaining number of ricochets for a projectile. Used by
 * projectileSystem to reflect Eternal Return off arena edges. Returns 0
 * for non-ricochet projectiles, which lets the caller no-op cheaply.
 */
export function getRicochetsRemaining(projEid: number): number {
  if (projEid < 0 || projEid >= RICOCHETS_REMAINING.length) return 0;
  return RICOCHETS_REMAINING[projEid] ?? 0;
}

/** Decrement the ricochet count for a projectile. Returns the new value. */
export function consumeRicochet(projEid: number): number {
  if (projEid < 0 || projEid >= RICOCHETS_REMAINING.length) return 0;
  const cur = RICOCHETS_REMAINING[projEid] ?? 0;
  if (cur <= 0) return 0;
  RICOCHETS_REMAINING[projEid] = cur - 1;
  return cur - 1;
}

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
  // Eternal Return: arena-edge ricochets. Vanilla Boomerang leaves
  // ricochetCount undefined so RICOCHETS_REMAINING ends up 0 (no bounce).
  // Always clear the slot so a recycled projectile doesn't carry a stale value.
  if (projEid < RICOCHETS_REMAINING.length) {
    RICOCHETS_REMAINING[projEid] = lvEffect.ricochetCount ?? 0;
  }

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: target });
  eventBus.emit({ type: 'projectile_spawned', projectile: projEid, weaponId: def.id });
  return true;
}

// --- mortar: explosion on impact or lifetime expiry -----------------------

interface MortarShellData {
  radius: number;
  damage: number;
  tint: number;
  /** Carpet Bomb only: spawn this many sub-detonations around the impact site. 0 = vanilla mortar. */
  subMortarCount: number;
}
const MORTAR_PROJECTILES: Map<number, MortarShellData> = new Map();
export function isMortar(projEid: number): boolean {
  return MORTAR_PROJECTILES.has(projEid);
}

/**
 * Apply mortar splash damage at (cx, cy) for `radius` and `damage`. Shared by
 * primary detonations and Carpet Bomb sub-detonations (which deliberately
 * skip the sub-detonation cascade — sub-mortars never spawn their own subs).
 */
function applyMortarSplash(
  world: World,
  enemyHashAccess: ReturnType<typeof getEnemyHash>,
  cx: number,
  cy: number,
  radius: number,
  damage: number,
  tint: number,
  ownerEid: number,
): void {
  growIdBuffer(64);
  enemyHashAccess.queryRadius(cx, cy, radius, scratchIdBuffer);
  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    const curHp = Health.hp[eid] ?? 0;
    if (curHp <= 0) continue;
    const next = curHp - damage;
    Health.hp[eid] = next;
    eventBus.emit({ type: 'damage_dealt', target: eid, source: ownerEid, amount: damage, isCrit: false });
    if (next <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({ type: 'enemy_killed', enemy: eid, killer: ownerEid, position: { x: ex, y: ey } });
      ensureComponent(world, Dead, eid);
      emitRunWonIfBoss(world, eid);
    }
  }
  // Visual: brief ring at impact.
  const scene = getArenaScene();
  if (scene) {
    const ring = scene.add.circle(cx, cy, 1, tint, 0.6).setDepth(8).setScale(8);
    ring.setStrokeStyle(2, tint, 0.95);
    scene.tweens.add({
      targets: ring,
      scale: radius,
      alpha: 0,
      duration: 320,
      ease: 'Cubic.out',
      onComplete: () => ring.destroy(),
    });
  }
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
  const ownerEid = Projectile.ownerEid[projEid] ?? 0;

  // Primary detonation.
  applyMortarSplash(world, enemyHashAccess, x, y, data.radius, data.damage, data.tint, ownerEid);

  // Carpet Bomb cluster: spawn `subMortarCount` sub-explosions at evenly-spaced
  // offsets around the primary. Each sub does the same radius/damage as the
  // primary but is rolled out over a short stagger (200ms each) so the player
  // sees a chain of impacts rather than one fat ring. Sub-detonations route
  // through `applyMortarSplash` directly so they bypass the sub-cascade.
  if (data.subMortarCount > 0) {
    const scene = getArenaScene();
    const offset = data.radius * 0.9;
    for (let i = 0; i < data.subMortarCount; i++) {
      const angle = (i / data.subMortarCount) * Math.PI * 2;
      const ox = x + Math.cos(angle) * offset;
      const oy = y + Math.sin(angle) * offset;
      const delayMs = 200 + i * 100;
      // Brief "incoming" marker — small dot that pulses up to the detonation size.
      if (scene) {
        const marker = scene.add.circle(ox, oy, 1, data.tint, 0.4).setDepth(7).setScale(3);
        marker.setStrokeStyle(1, data.tint, 0.6);
        scene.tweens.add({
          targets: marker,
          scale: 8,
          alpha: 0.8,
          duration: delayMs,
          ease: 'Quad.in',
          onComplete: () => marker.destroy(),
        });
      }
      // Fire the sub-detonation after the delay. The world reference here is
      // captured in the closure — safe because mortar lifetimes are short and
      // the run/world is destroyed via the autoAttack reset path.
      setTimeout(() => {
        if (useRunStore.getState().phase !== 'playing') return;
        const hash = getEnemyHash();
        applyMortarSplash(world, hash, ox, oy, data.radius, data.damage, data.tint, ownerEid);
      }, delayMs);
    }
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

  MORTAR_PROJECTILES.set(projEid, {
    radius,
    damage: damageAmount,
    tint: def.tint,
    // Carpet Bomb: detonateMortar reads this and scatters N sub-mortars at the
    // impact site. Vanilla mortar omits the field so subMortarCount stays 0.
    subMortarCount: lvEffect.subMortarCount ?? 0,
  });

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
  let pelletCount = Math.max(1, lvEffect.projectileCount ?? 3);
  const damageAmount = lvEffect.damage * dmgMul;

  // Last Stand synergy (Shotgun + Berserker): below 30% HP, shotgun fires a
  // full 360 ring of 8 pellets instead of the usual narrow cone.
  let spread = 0.5; // radians, ~30° total cone by default
  let fullRing = false;
  if (hasSynergy('last_stand')) {
    const player = useRunStore.getState().player;
    const lowHp = player.maxHp > 0 && player.hp / player.maxHp <= 0.3;
    if (lowHp) {
      pelletCount = 8;
      spread = Math.PI * 2;
      fullRing = true;
    }
  }
  for (let i = 0; i < pelletCount; i++) {
    let angle: number;
    if (fullRing) {
      // Evenly distribute around a full circle.
      angle = baseAngle + (i / pelletCount) * spread;
    } else {
      const t = pelletCount === 1 ? 0 : i / (pelletCount - 1) - 0.5; // -0.5..0.5
      angle = baseAngle + t * spread;
    }
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

// --- blade (melee): only triggers when an enemy is in range --------------

function fireBladeWeapon(
  world: World,
  def: WeaponDefinition,
  ownerEid: number,
  level: number,
  dmgMul: number,
  enemyHash: ReturnType<typeof getEnemyHash>,
): boolean {
  const lvEffect = weaponLevelEffect(def, level);
  const radius = lvEffect.radius ?? 80;
  const ox = Position.x[ownerEid] ?? 0;
  const oy = Position.y[ownerEid] ?? 0;

  // Only "fire" if at least one enemy is in range. Returning false keeps the
  // cooldown at 0 so the strike happens the instant something gets close.
  growIdBuffer(64);
  enemyHash.queryRadius(ox, oy, radius, scratchIdBuffer);
  if (scratchIdBuffer.length === 0) return false;

  const baseDamage = lvEffect.damage * dmgMul;
  // Frostbite synergy (Blade + Frost Nova): blade strikes deal 3x to slowed enemies.
  const frostbiteActive = hasSynergy('frostbite');
  // Reaper's Edge: if execBelowFrac is set, enemies whose post-strike HP is
  // below this fraction of their max are instantly executed (clamped to 0).
  // Vanilla Blade leaves this undefined so the branch is a no-op.
  const execBelowFrac = lvEffect.execBelowFrac ?? 0;
  let strikePos: { x: number; y: number } | null = null;

  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    const curHp = Health.hp[eid] ?? 0;
    if (curHp <= 0) continue;
    const dmg = frostbiteActive && isEnemySlowed(eid) ? baseDamage * 3 : baseDamage;
    let next = curHp - dmg;
    // Execution check. Bosses are intentionally included — the brief reads
    // "instantly kill enemies below 15% HP", and treating bosses as immune
    // would silently weaken the evolution for the only fight that matters at
    // 10:00. Capping at 1.0 keeps the floor sensible.
    if (next > 0 && execBelowFrac > 0) {
      const maxHp = Health.maxHp[eid] ?? next;
      if (maxHp > 0 && next < maxHp * execBelowFrac) {
        next = 0;
      }
    }
    Health.hp[eid] = next;
    if (!strikePos) {
      strikePos = { x: Position.x[eid] ?? ox, y: Position.y[eid] ?? oy };
    }
    eventBus.emit({ type: 'damage_dealt', target: eid, source: ownerEid, amount: dmg, isCrit: false });
    if (next <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({ type: 'enemy_killed', enemy: eid, killer: ownerEid, position: { x: ex, y: ey } });
      ensureComponent(world, Dead, eid);
      emitRunWonIfBoss(world, eid);
    }
  }

  // Strike visual: a brief slash arc at the player position toward the first hit enemy.
  spawnBladeSlashVisual(ox, oy, strikePos ?? { x: ox + radius, y: oy }, radius, def.tint);

  eventBus.emit({ type: 'weapon_fired', weaponId: def.id, source: ownerEid, targetEid: 0 });
  return true;
}

function spawnBladeSlashVisual(
  ox: number,
  oy: number,
  toward: { x: number; y: number },
  radius: number,
  tint: number,
): void {
  const scene = getArenaScene();
  if (!scene) return;
  // A short, fast crescent-like swoosh: a thin arc that expands and fades.
  const angle = Math.atan2(toward.y - oy, toward.x - ox);
  const length = radius * 0.9;
  const startX = ox + Math.cos(angle) * 14;
  const startY = oy + Math.sin(angle) * 14;
  const endX = ox + Math.cos(angle) * length;
  const endY = oy + Math.sin(angle) * length;
  const line = scene.add.line(0, 0, startX, startY, endX, endY, tint, 0.95).setOrigin(0, 0).setDepth(50);
  line.setLineWidth(5);
  scene.tweens.add({
    targets: line,
    alpha: 0,
    duration: 160,
    onComplete: () => line.destroy(),
  });
  // Tiny burst at the strike location.
  const burst = scene.add.circle(toward.x, toward.y, 1, tint, 0.7).setDepth(50).setScale(4);
  scene.tweens.add({
    targets: burst,
    scale: 18,
    alpha: 0,
    duration: 200,
    ease: 'Cubic.out',
    onComplete: () => burst.destroy(),
  });
}

// --- helpers --------------------------------------------------------------

function ensureComponent(world: World, comp: Component, eid: number): void {
  if (!hasComponent(world, comp, eid)) {
    addComponent(world, comp, eid);
  }
}

/**
 * If the just-killed `eid` carries `BossTag`, emit `run_won` so the meta
 * stats / end-screen flow fires. Mirrors the pattern in
 * `collision.applyDamageToEnemy`; needed in every non-projectile kill path
 * (aura, frost nova, chain lightning, blade melee, mortar AoE, Hollowfield
 * pulse, orbiter — but orbiters route through the projectile collision pass
 * which already handles this).
 *
 * Call AFTER you've emitted `enemy_killed` and tagged the entity `Dead`,
 * so the kill count in the `run_won` payload is +1 from `store.kills`.
 */
function emitRunWonIfBoss(world: World, eid: number): void {
  if (!hasComponent(world, BossTag, eid)) return;
  const store = useRunStore.getState();
  eventBus.emit({
    type: 'run_won',
    timeMs: store.elapsedMs,
    level: store.player.level,
    kills: store.kills + 1, // +1 for the kill we just emitted
  });
}

// --- Hollowfield synergy pulse --------------------------------------------
// Free aura burst fired when the player takes damage. Reuses aura-style
// queryRadius logic but bypasses the weapon cooldown — by design, this can
// chain with the normal aura tick on the same frame.
function triggerHollowfieldPulse(world: World, playerEid: number): void {
  // Find the equipped aura weapon (gated already by hasSynergy('hollowfield'),
  // but defend in case the player swapped it mid-frame).
  const weapons = useRunStore.getState().player.weapons;
  let auraSlot: { id: string; level: number } | null = null;
  for (let i = 0; i < weapons.length; i++) {
    const w = weapons[i];
    if (!w) continue;
    if (w.id === 'aura') { auraSlot = w; break; }
  }
  if (!auraSlot) return;
  const def = WEAPONS[auraSlot.id];
  if (!def) return;
  const lvEffect = weaponLevelEffect(def, auraSlot.level);
  const radius = lvEffect.radius ?? 100;
  if (radius <= 0) return;
  const dmgMul = Stats.damageMul[playerEid] ?? 1;
  const damageAmount = lvEffect.damage * dmgMul;

  const ox = Position.x[playerEid] ?? 0;
  const oy = Position.y[playerEid] ?? 0;

  // Ensure the spatial hash is current — collisionSystem already rebuilt it
  // this tick, but the damage_dealt event we're reacting to could fire
  // mid-pass. Rebuild defensively; it's idempotent.
  rebuildEnemyHash(world);
  const enemyHash = getEnemyHash();
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
    eventBus.emit({
      type: 'damage_dealt',
      target: eid,
      source: playerEid,
      amount: damageAmount,
      isCrit: false,
    });
    if (nextHp <= 0) {
      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      eventBus.emit({ type: 'enemy_killed', enemy: eid, killer: playerEid, position: { x: ex, y: ey } });
      ensureComponent(world, Dead, eid);
      emitRunWonIfBoss(world, eid);
    }
  }
}

void WEAPONS;
