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
import type Phaser from 'phaser';

import { eventBus } from '../../core/eventBus';
import { getArenaScene } from '../../core/gameContext';
import { rng } from '../../core/rng';
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
import { detonateMortar, isForceCritProjectile, isMortar } from './autoAttack';
import { spawnDamageNumber, spawnDeathPuff } from './damageNumbers';
import { flashEnemyVisual, getEnemyTint } from './spawnDirector';
import type { World } from '../world';

// --- shared spatial hash ----------------------------------------------------
// Module-local instance. autoAttackSystem imports it via the helper functions
// below; no other agent should reach for this directly.

/** Cell size 128 px — matches the ARCHITECTURE budget for spatial hash. */
const ENEMY_HASH_CELL_PX = 128;

const enemyHash = new SpatialHash(ENEMY_HASH_CELL_PX);

// --- rebuild tick guard ---------------------------------------------------
// Avoid rebuilding the hash twice in the same tick. collisionSystem bumps
// `_hashTickId` once at the top of its tick, then calls rebuildEnemyHash.
// Anyone else who also reaches for `rebuildEnemyHash` later in the same tick
// (notably `triggerHollowfieldPulse` from autoAttack on player_hit events)
// will short-circuit. If a caller knows the hash is genuinely stale —
// because something moved or died between the rebuild and now — they can
// call `markEnemyHashStale()` to force the next `rebuildEnemyHash` to run.
let _hashTickId = 0;
let _lastHashTickId = -1;

/**
 * Mark the enemy spatial hash as stale, forcing the next `rebuildEnemyHash`
 * call to re-populate even if a rebuild has already happened this tick.
 * Cheap: just resets the per-tick guard.
 */
export function markEnemyHashStale(): void {
  _lastHashTickId = -1;
}

/**
 * (Re)populate the enemy spatial hash from the current world state. Idempotent
 * within a single tick — calling twice produces the same result as long as no
 * enemy has moved or been added/removed between calls. The second call within
 * a single tick is a no-op (see tick guard above) unless `markEnemyHashStale`
 * has been called since the last rebuild.
 */
export function rebuildEnemyHash(world: World): void {
  if (_lastHashTickId === _hashTickId) return;
  _lastHashTickId = _hashTickId;
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

  // Start of a new tick: bump the hash tick id so the first rebuild this
  // tick runs and any subsequent same-tick rebuild calls are short-circuited.
  _hashTickId += 1;

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
      const storeSnap = useRunStore.getState();
      const playerStats = storeSnap.player;
      const lowHp = playerStats.maxHp > 0 && playerStats.hp / playerStats.maxHp <= 0.3;
      const berserkerMul = lowHp ? 1 + playerStats.berserkerMul : 1;
      // Use rng() for deterministic crit rolls under Daily Seed mode.
      // Evolved-weapon force-crit (Phantom Shot) bypasses the roll entirely:
      // every projectile from a forceCrit weapon is treated as a crit.
      const isCrit = isForceCritProjectile(peid)
        ? true
        : playerStats.critChance > 0 && rng() < playerStats.critChance;
      // Devil's Bargain: bargainBoosts.damageMul is the player-outgoing
      // multiplier applied on top of Stats.damageMul (already baked into `dmg`
      // by autoAttack) plus crit and berserker. Identity (1) means no change.
      const bargainDamageMul = storeSnap.bargainBoosts.damageMul;
      const finalDmg = (isCrit ? dmg * 2 : dmg) * berserkerMul * bargainDamageMul;
      applyDamageToEnemy(world, eid, finalDmg, ownerEid, isCrit);

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
    // Devil's Bargain: bargainBoosts.invulnUntilMs is a per-bargain
    // invulnerability window (Cleansing Flame's 5s shield, Second Wind's
    // 1.5s revive grace). Skipping the rest of the player damage pass means
    // we don't even start the post-hit invuln window. Identity (0) means
    // un-bargained runs are unaffected.
    const bargainInvulnUntil = useRunStore.getState().bargainBoosts.invulnUntilMs;
    if (nowMs < bargainInvulnUntil) continue;

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
 * Visual side-effects (damage number, hit flash, death puff) are fired here
 * so every damage source — projectiles, splash, aura, thorns — gets identical
 * game-feel without duplicating the wiring at each call site.
 */
function applyDamageToEnemy(
  world: World,
  enemyEid: number,
  amount: number,
  killerEid: number,
  isCrit: boolean = false,
): void {
  const curHp = Health.hp[enemyEid] ?? 0;
  const nextHp = curHp - amount;
  Health.hp[enemyEid] = nextHp;

  // Capture pre-death position for the damage number / death puff. Read once
  // since the entity may be marked Dead below.
  const ex = Position.x[enemyEid] ?? 0;
  const ey = Position.y[enemyEid] ?? 0;

  eventBus.emit({
    type: 'damage_dealt',
    target: enemyEid,
    source: killerEid,
    amount,
    isCrit,
  });

  // Floating damage number — small numerical feedback above the hit.
  spawnDamageNumber(ex, ey - 16, amount, isCrit);

  // Hit flash — brief white tint on the enemy rectangle.
  flashEnemyVisual(enemyEid);

  if (nextHp <= 0) {
    markDead(world, enemyEid);
    // Death puff — small ash burst at the dying enemy's position.
    spawnDeathPuff(ex, ey, getEnemyTint(enemyEid));
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
 *
 * Devil's Bargain hooks:
 *   - `damageTakenMul` scales incoming damage on top of Steel Skin
 *     (combined: amount * damageTakenMul * (1 - damageReduction)).
 *   - `reviveTokens` rescues the player on lethal damage: full heal, 1.5s
 *     grace invuln, do NOT emit `run_lost`. Brief tween flash on the player
 *     visual signals the revive without needing a new event.
 */
function applyDamageToPlayer(
  _world: World,
  playerEid: number,
  amount: number,
  sourceEid: number
): void {
  const store = useRunStore.getState();
  // Steel Skin (player.damageReduction) + Devil's Bargain (damageTakenMul)
  // stack: damageTakenMul scales the raw amount BEFORE Steel Skin applies.
  const reduction = store.player.damageReduction;
  const damageTakenMul = store.bargainBoosts.damageTakenMul;
  const scaled = amount * damageTakenMul * (1 - reduction);
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
    // Devil's Bargain: Second Wind — consume a revive token instead of dying.
    // Full-heal, set a 1.5s grace invuln (via bargainBoosts.invulnUntilMs so
    // it stacks with the post-hit invuln map check), and skip run_lost.
    if (store.bargainBoosts.reviveTokens > 0) {
      const maxHp = Health.maxHp[playerEid] ?? store.player.maxHp;
      Health.hp[playerEid] = maxHp;
      const reviveInvulnUntil = performance.now() + 1500;
      useRunStore.setState((s) => ({
        bargainBoosts: {
          ...s.bargainBoosts,
          reviveTokens: s.bargainBoosts.reviveTokens - 1,
          invulnUntilMs: Math.max(s.bargainBoosts.invulnUntilMs, reviveInvulnUntil),
        },
        player: {
          ...s.player,
          hp: maxHp,
        },
      }));
      // Visual: brief player flash so the revive is legible without a new event.
      flashPlayerVisual();
      return;
    }
    eventBus.emit({
      type: 'run_lost',
      timeMs: store.elapsedMs,
      level: store.player.level,
      kills: store.kills,
    });
  }
}

/**
 * Brief tween flash on the Phaser player rectangle. Used as the revive
 * indicator when a Devil's Bargain reviveToken is consumed. Cheap: pulses
 * alpha three times via a yoyo'd tween. No-op if the scene isn't active
 * (we never crash because of the revive visual being unavailable).
 */
function flashPlayerVisual(): void {
  const scene = getArenaScene();
  if (!scene) return;
  // The player sprite is the rectangle at depth 100 — we identify it via the
  // ArenaScene's children list rather than threading a getter, to keep the
  // collision module independent of the scene API surface.
  const sceneWithProp = scene as Phaser.Scene & {
    playerSprite?: Phaser.GameObjects.Rectangle | null;
  };
  const sprite = sceneWithProp.playerSprite ?? null;
  if (!sprite) return;
  scene.tweens.add({
    targets: sprite,
    alpha: { from: 0.2, to: 1 },
    duration: 200,
    yoyo: true,
    repeat: 2,
  });
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
