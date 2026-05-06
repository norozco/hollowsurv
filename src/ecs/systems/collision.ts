// Spatial-hash broad phase + circle-circle narrow phase. Applies damage and
// emits `damage_dealt` / `enemy_killed` directly (no separate event queue —
// damageSystem is a thin safety-net pass; see CONTRACTS.md §1 +
// ARCHITECTURE.md §3).
//
// Owner: Agent C3.
//
// Spatial-hash sharing:
//   The enemy spatial hash is shared with autoAttackSystem. Both systems
//   need "enemies near a point" — autoAttack for `nearest()` target
//   selection and aura `queryRadius()`, collision for projectile / player
//   overlap. We expose `rebuildEnemyHash(world)` and `getEnemyHash()`. Both
//   systems call rebuild at the top of their tick — it's idempotent and
//   cheap (~1ms at 1500 enemies, bounded). This keeps the protocol trivial
//   and resilient to system reordering.

import { addComponent, defineQuery, hasComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { scratchIdBuffer, growIdBuffer } from '../../core/scratch';
import { SpatialHash } from '../../core/spatialHash';
import {
  BossTag,
  Damage,
  Dead,
  EnemyTag,
  Health,
  Hitbox,
  PlayerTag,
  Position,
  ProjectileTag,
  Projectile,
} from '../components';
import { useRunStore } from '../../stores/runStore';
import { detonateMortar, isMortar } from './autoAttack';
import type { World } from '../world';

// --- shared spatial hash ----------------------------------------------------
// Module-local instance. autoAttackSystem imports it via the helper functions
// below; no other agent should reach for this directly.

/** Cell size 128 px — matches the ARCHITECTURE budget for spatial hash. */
const ENEMY_HASH_CELL_PX = 128;

const enemyHash = new SpatialHash(ENEMY_HASH_CELL_PX);

/**
 * (Re)populate the enemy spatial hash from the current world state. Idempotent
 * within a single tick — calling twice produces the same result as long as no
 * enemy has moved or been added/removed between calls.
 */
export function rebuildEnemyHash(world: World): void {
  enemyHash.clear();
  const enemies = enemyQuery(world);
  for (let i = 0; i < enemies.length; i++) {
    const eid = enemies[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue; // ignore corpses
    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    enemyHash.insert(eid, x, y);
  }
}

/** Direct read-only access for autoAttackSystem. Only call after rebuild. */
export function getEnemyHash(): SpatialHash {
  return enemyHash;
}

// --- queries ---------------------------------------------------------------

const enemyQuery = defineQuery([EnemyTag, Position, Hitbox]);
const projectileQuery = defineQuery([ProjectileTag, Position, Hitbox, Projectile]);
const playerQuery = defineQuery([PlayerTag, Position, Hitbox, Health]);

// --- player invuln tracking ------------------------------------------------
// Player has a brief invuln window after taking damage. Tracked in a closure
// rather than a Stats field so we don't pollute the contract. Keyed by player
// eid so a hot-reload that swaps eids doesn't carry stale state.

/** Invuln window after a player hit, in milliseconds. */
const PLAYER_INVULN_MS = 200;

const playerInvulnUntilMs: Map<number, number> = new Map();

/** Reset invuln state — called from autoAttackSystem on init / scene shutdown. */
export function resetPlayerInvuln(): void {
  playerInvulnUntilMs.clear();
}

// --- collision system ------------------------------------------------------

export function collisionSystem(world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  // Defensive rebuild: cheap and ensures correctness regardless of who else
  // populated the hash this tick.
  rebuildEnemyHash(world);

  // --- pass 1: projectile vs enemy --------------------------------------
  const projectiles = projectileQuery(world);
  for (let i = 0; i < projectiles.length; i++) {
    const peid = projectiles[i];
    if (peid === undefined) continue;
    if (hasComponent(world, Dead, peid)) continue;

    const px = Position.x[peid] ?? 0;
    const py = Position.y[peid] ?? 0;
    const pr = Hitbox.radius[peid] ?? 4;
    let pierce = Projectile.pierce[peid] ?? 0;
    const ownerEid = Projectile.ownerEid[peid] ?? 0;
    const dmg = Damage.amount[peid] ?? 0;
    if (dmg <= 0) continue;

    growIdBuffer(64);
    const queryR = pr + 64;
    enemyHash.queryRadius(px, py, queryR, scratchIdBuffer);

    for (let j = 0; j < scratchIdBuffer.length; j++) {
      const eid = scratchIdBuffer[j];
      if (eid === undefined) continue;
      if (hasComponent(world, Dead, eid)) continue;

      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      const er = Hitbox.radius[eid] ?? 12;
      const dx = ex - px;
      const dy = ey - py;
      const sumR = pr + er;
      if (dx * dx + dy * dy > sumR * sumR) continue;

      // Mortar: detonate on first contact (instead of dealing direct damage).
      if (isMortar(peid)) {
        detonateMortar(world, peid, enemyHash);
        markDead(world, peid);
        break;
      }

      // Crit + splash + berserker come from runStore (player-side augments).
      const playerStats = useRunStore.getState().player;
      const lowHp = playerStats.maxHp > 0 && playerStats.hp / playerStats.maxHp <= 0.3;
      const berserkerMul = lowHp ? 1 + playerStats.berserkerMul : 1;
      const isCrit = playerStats.critChance > 0 && Math.random() < playerStats.critChance;
      const finalDmg = (isCrit ? dmg * 2 : dmg) * berserkerMul;
      applyDamageToEnemy(world, eid, finalDmg, ownerEid);

      // Splash: deal 30% damage to other enemies near the impact.
      if (playerStats.splashRadius > 0) {
        applySplashDamage(world, ex, ey, playerStats.splashRadius, finalDmg * 0.3, ownerEid, eid);
      }

      // Knockback: push enemy away from the projectile direction.
      if (playerStats.knockbackPx > 0) {
        const len = Math.hypot(dx, dy);
        if (len > 0.0001) {
          const nx = dx / len;
          const ny = dy / len;
          Position.x[eid] = ex + nx * playerStats.knockbackPx;
          Position.y[eid] = ey + ny * playerStats.knockbackPx;
        }
      }

      if (pierce > 0) {
        pierce -= 1;
        Projectile.pierce[peid] = pierce;
        if (pierce <= 0) {
          markDead(world, peid);
          break;
        }
      } else if (pierce === 0) {
        markDead(world, peid);
        break;
      }
    }
  }

  // --- pass 2: enemy vs player ------------------------------------------
  const players = playerQuery(world);
  for (let i = 0; i < players.length; i++) {
    const pe = players[i];
    if (pe === undefined) continue;
    if (hasComponent(world, Dead, pe)) continue;

    const nowMs = performance.now();
    const invulnUntil = playerInvulnUntilMs.get(pe) ?? 0;
    if (nowMs < invulnUntil) continue;

    const px = Position.x[pe] ?? 0;
    const py = Position.y[pe] ?? 0;
    const pr = Hitbox.radius[pe] ?? 16;

    growIdBuffer(64);
    enemyHash.queryRadius(px, py, pr + 64, scratchIdBuffer);

    for (let j = 0; j < scratchIdBuffer.length; j++) {
      const eid = scratchIdBuffer[j];
      if (eid === undefined) continue;
      if (hasComponent(world, Dead, eid)) continue;

      const ex = Position.x[eid] ?? 0;
      const ey = Position.y[eid] ?? 0;
      const er = Hitbox.radius[eid] ?? 12;
      const dx = ex - px;
      const dy = ey - py;
      const sumR = pr + er;
      if (dx * dx + dy * dy > sumR * sumR) continue;

      const enemyDamage = Damage.amount[eid] ?? 0;
      if (enemyDamage <= 0) continue;

      applyDamageToPlayer(world, pe, enemyDamage, eid);
      playerInvulnUntilMs.set(pe, nowMs + PLAYER_INVULN_MS);

      // Thorns: reflect a fraction of incoming damage to the attacker.
      const thorns = useRunStore.getState().player.thornsReflect;
      if (thorns > 0) {
        applyDamageToEnemy(world, eid, enemyDamage * thorns, pe);
      }
      break;
    }
  }

  // --- pass 3: enemy <-> enemy separation -------------------------------
  // Push overlapping enemies apart by directly adjusting Position. Uses the
  // already-built spatial hash. Cheap because typical neighbor counts are <5.
  separateEnemies(world);
}

/**
 * Splash damage helper: hit all enemies within `radius` of (cx, cy) for `dmg`,
 * skipping the original target (already damaged by the projectile).
 */
function applySplashDamage(
  world: World,
  cx: number,
  cy: number,
  radius: number,
  dmg: number,
  ownerEid: number,
  skipEid: number,
): void {
  growIdBuffer(64);
  enemyHash.queryRadius(cx, cy, radius, scratchIdBuffer);
  for (let i = 0; i < scratchIdBuffer.length; i++) {
    const eid = scratchIdBuffer[i];
    if (eid === undefined || eid === skipEid) continue;
    if (hasComponent(world, Dead, eid)) continue;
    applyDamageToEnemy(world, eid, dmg, ownerEid);
  }
}

/**
 * Apply a tiny positional push to overlapping enemies so they don't all stack
 * into a single square when the player kites them. Bypasses Velocity (which
 * gets overwritten by flowfieldSystem each tick).
 */
function separateEnemies(world: World): void {
  const enemies = enemyQuery(world);
  growIdBuffer(64);
  const SEPARATION_PUSH = 3; // px per tick — gentle, cumulative
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a === undefined) continue;
    if (hasComponent(world, Dead, a)) continue;
    const ax = Position.x[a] ?? 0;
    const ay = Position.y[a] ?? 0;
    const ar = Hitbox.radius[a] ?? 12;
    enemyHash.queryRadius(ax, ay, ar * 2 + 8, scratchIdBuffer);
    for (let j = 0; j < scratchIdBuffer.length; j++) {
      const b = scratchIdBuffer[j];
      if (b === undefined || b === a) continue;
      if (hasComponent(world, Dead, b)) continue;
      const bx = Position.x[b] ?? 0;
      const by = Position.y[b] ?? 0;
      const br = Hitbox.radius[b] ?? 12;
      const dx = ax - bx;
      const dy = ay - by;
      const distSq = dx * dx + dy * dy;
      const minDist = ar + br;
      if (distSq <= 0.001 || distSq > minDist * minDist) continue;
      const dist = Math.sqrt(distSq);
      const overlap = (minDist - dist) * 0.5;
      const inv = 1 / dist;
      const nx = dx * inv;
      const ny = dy * inv;
      const push = Math.min(SEPARATION_PUSH, overlap);
      Position.x[a] = ax + nx * push;
      Position.y[a] = ay + ny * push;
      Position.x[b] = bx - nx * push;
      Position.y[b] = by - ny * push;
    }
  }
}

// --- helpers --------------------------------------------------------------

/**
 * Apply `amount` damage to an enemy. Updates Health, marks Dead when hp drops
 * to zero, and emits `damage_dealt` / `enemy_killed`.
 *
 * The killer is ownerEid (typically the player) so on_kill hooks can credit.
 */
function applyDamageToEnemy(
  world: World,
  enemyEid: number,
  amount: number,
  killerEid: number
): void {
  const curHp = Health.hp[enemyEid] ?? 0;
  const nextHp = curHp - amount;
  Health.hp[enemyEid] = nextHp;

  eventBus.emit({
    type: 'damage_dealt',
    target: enemyEid,
    source: killerEid,
    amount,
    isCrit: false,
  });

  if (nextHp <= 0) {
    markDead(world, enemyEid);
    const ex = Position.x[enemyEid] ?? 0;
    const ey = Position.y[enemyEid] ?? 0;
    eventBus.emit({
      type: 'enemy_killed',
      enemy: enemyEid,
      killer: killerEid,
      position: { x: ex, y: ey },
    });

    // Boss kill -> run won.
    if (hasComponent(world, BossTag, enemyEid)) {
      const store = useRunStore.getState();
      eventBus.emit({
        type: 'run_won',
        timeMs: store.elapsedMs,
        level: store.player.level,
        kills: store.kills + 1, // +1 for the kill we just emitted
      });
    }
  }
}

/**
 * Apply `amount` damage to the player. Emits `damage_dealt` (canonical form
 * — runStore listens for it). Does NOT also emit `player_hit` because
 * runStore would double-decrement (it handles both). See coordinator notes.
 *
 * If the player drops to 0 hp we emit `run_lost` so runStore transitions
 * out of `playing` and the run summary modal can show.
 */
function applyDamageToPlayer(
  _world: World,
  playerEid: number,
  amount: number,
  sourceEid: number
): void {
  // Steel Skin: scale incoming damage by (1 - reduction).
  const reduction = useRunStore.getState().player.damageReduction;
  const scaled = amount * (1 - reduction);
  const curHp = Health.hp[playerEid] ?? 0;
  const nextHp = Math.max(0, curHp - scaled);
  Health.hp[playerEid] = nextHp;

  eventBus.emit({
    type: 'damage_dealt',
    target: playerEid,
    source: sourceEid,
    amount: scaled,
    isCrit: false,
  });

  if (nextHp <= 0) {
    const store = useRunStore.getState();
    eventBus.emit({
      type: 'run_lost',
      timeMs: store.elapsedMs,
      level: store.player.level,
      kills: store.kills,
    });
  }
}

/** Add the Dead tag if not present. lifetimeSystem recycles at end of tick. */
function markDead(world: World, eid: number): void {
  if (!hasComponent(world, Dead, eid)) {
    // Use addComponent through bitECS via release path — but we don't want to
    // recycle here, just tag. Import addComponent directly.
    addDeadTag(world, eid);
  }
}

function addDeadTag(world: World, eid: number): void {
  addComponent(world, Dead, eid);
}
