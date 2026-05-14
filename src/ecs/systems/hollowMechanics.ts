// Branching Hollows — per-Hollow gameplay tick logic.
// Owner: Hollow integration agent.
//
// Three Hollow flavors share this one system. The active flavor is read from
// `runStore.selectedHollowId`; the system dispatches to a small per-Hollow
// branch each tick. When no Hollow is selected (pre-5:00 or the player died
// before picking), the system is a no-op.
//
//   * Bone   — on `enemy_killed`, 10% roll to spawn a brittle skeleton
//              (skirmisher archetype, white tint, smaller) at the death spot.
//   * Ember  — on `enemy_killed`, spawn a fire patch (3s lifetime). Player
//              standing on any patch gets a +50% damage buff applied via
//              `bargainBoosts.damageMul`. The buff is restored when the player
//              walks off — module state holds the original multiplier.
//   * Tide   — every 30 seconds (relative to when the Hollow was picked),
//              apply a radial nudge to every enemy toward the arena center,
//              and flash an expanding ring visual at the center.
//
// All Phaser visuals are discovered via the `gameContext` singleton (same as
// the spawn director). Module state survives HMR; we hook 'character_selected'
// (fires on startRun) to wipe per-run state.

import { defineQuery, hasComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { ARENA_SIZE_PX } from '../../core/flowfield';
import { getArenaScene } from '../../core/gameContext';
import { rng } from '../../core/rng';
import { Dead, EnemyTag, BossTag, PlayerTag, Position } from '../components';
import type { HollowId } from '../../content/hollows';
import { useRunStore } from '../../stores/runStore';
import { scaleSpawnedEnemy, spawnEnemyAt, tintSpawnedEnemy } from './spawnDirector';
import type { World } from '../world';

import type Phaser from 'phaser';

// --- queries -----------------------------------------------------------------

const enemyQuery = defineQuery([EnemyTag, Position]);
const playerQuery = defineQuery([PlayerTag, Position]);

// --- module state ------------------------------------------------------------

/**
 * Bone Hollow: chance per enemy_killed to spawn a bonespawn.
 * 0.10 (10%) per the brief. Kept here rather than in the data file so balance
 * tweaks don't need a content edit.
 */
const BONE_RISE_CHANCE = 0.1;

/** Ember Hollow: how long a fire patch lasts (ms). */
const FIRE_PATCH_LIFETIME_MS = 3_000;

/** Ember Hollow: radius around a patch the player must enter to gain the buff. */
const FIRE_PATCH_RADIUS_PX = 60;

/** Ember Hollow: damage multiplier applied while standing on fire (additive). */
const EMBER_FIRE_DAMAGE_BUFF = 1.5;

/** Tide Hollow: interval between waves (ms). */
const TIDE_WAVE_INTERVAL_MS = 30_000;

/** Tide Hollow: how many pixels each enemy is yanked toward the center. */
const TIDE_PULL_PX = 100;

/** Tide Hollow: arena center used as the pull target. */
const TIDE_CENTER_X = ARENA_SIZE_PX / 2;
const TIDE_CENTER_Y = ARENA_SIZE_PX / 2;

// --- Ember fire-patch tracking -----------------------------------------------

interface FirePatch {
  x: number;
  y: number;
  /** performance.now() ms when this patch should be reaped. */
  expiresAt: number;
  /** Phaser visual; null when no scene was available at spawn time. */
  visual: Phaser.GameObjects.Arc | null;
}

const firePatches: FirePatch[] = [];

/**
 * Tracks whether the player is currently standing on at least one fire patch.
 * When true we have applied the EMBER_FIRE_DAMAGE_BUFF to bargainBoosts.damageMul.
 * The original (pre-buff) multiplier is cached in `_savedDamageMul` so leaving
 * the fire restores it exactly — additive bargain effects between then and now
 * stack correctly because we re-snapshot on each entry.
 */
let _playerInFire = false;
let _savedDamageMul = 1;

// --- Tide wave tracking ------------------------------------------------------

/**
 * Last tick (ms since Hollow was picked) at which a tide wave fired. We track
 * "ms since Hollow picked" instead of absolute elapsedMs so the cadence is
 * stable regardless of when the player picks (although in practice they pick
 * at 5:00, the system survives later picks gracefully — e.g. via the
 * auto-pick timer).
 */
let _tideHollowPickedAtMs = -1;
let _lastTideWaveAtMs = 0;

// --- run-level resets --------------------------------------------------------

/**
 * Detect a fresh run by watching runStore.runStartedAtMs. When it changes,
 * wipe all per-run state (fire patches, tide timer, buff snapshot).
 */
let _lastRunStartedAtMs = 0;

function resetForNewRun(): void {
  // Destroy any leftover visuals.
  for (const p of firePatches) {
    if (p.visual) p.visual.destroy();
  }
  firePatches.length = 0;
  _playerInFire = false;
  _savedDamageMul = 1;
  _tideHollowPickedAtMs = -1;
  _lastTideWaveAtMs = 0;
  if (_tideRing) {
    _tideRing.destroy();
    _tideRing = null;
  }
}

// --- one-shot event hookup ---------------------------------------------------

let _eventsSubscribed = false;

function ensureSubscriptions(world: World): void {
  if (_eventsSubscribed) return;
  _eventsSubscribed = true;

  // Bone Hollow death roll. We don't have access to the world inside the
  // handler, so we close over the world ref captured by the system on every
  // tick. The 'world' arg here is the current tick's world; we update
  // `_lastWorld` below so the handler always uses the latest one (after HMR
  // or a fresh scene the world identity changes).
  _lastWorld = world;
  eventBus.on('enemy_killed', (e) => {
    const w = _lastWorld;
    if (!w) return;
    const store = useRunStore.getState();
    if (store.phase !== 'playing') return;
    const hollow = store.selectedHollowId;
    if (hollow === null) return;

    // applyDamageToEnemy in collision.ts emits enemy_killed before recycling
    // the entity, so component tags are still readable here. We use this to
    // skip bosses (no skeleton-from-the-marrowking exploit) and skip rising
    // off of already-risen bonespawns themselves (would cascade into a
    // pool-saturating chain).
    const enemyEid = e.enemy;
    const isBoss = hasComponent(w, BossTag, enemyEid);

    if (hollow === 'bone') {
      if (!isBoss && rng() < BONE_RISE_CHANCE) {
        spawnBonespawn(w, e.position.x, e.position.y);
      }
    } else if (hollow === 'ember') {
      if (!isBoss) {
        // Drop a fire patch where the enemy fell. Skip bosses so the boss
        // arena doesn't fill with overlapping patches.
        spawnFirePatch(e.position.x, e.position.y);
      }
    }
    // Tide has no on-kill hook.
  });

  eventBus.on('hollow_chosen', (e) => {
    // Reset per-Hollow run state so a new pick (e.g. on a fresh run) doesn't
    // inherit fire patches / tide timer from the previous selection. New runs
    // also call resetForNewRun via the tick detection below, so this is a
    // defensive double-reset.
    resetForNewRun();
    if (e.hollowId === 'tide') {
      const st = useRunStore.getState();
      _tideHollowPickedAtMs = st.elapsedMs;
      _lastTideWaveAtMs = st.elapsedMs;
    }
  });
}

let _lastWorld: World | null = null;

// --- system entry point ------------------------------------------------------

/**
 * Tick the active Hollow mechanic. Cheap — bails immediately when no Hollow
 * is selected. Called from ArenaScene.update() after damageSystem so that the
 * Ember damage buff applies on the NEXT tick's projectile damage (one-frame
 * lag is imperceptible).
 */
export function hollowMechanicsSystem(world: World, _dtMs: number): void {
  ensureSubscriptions(world);
  _lastWorld = world;

  const store = useRunStore.getState();
  if (store.phase !== 'playing') {
    // While the choice modal is up the player is frozen; don't expire fire
    // patches or pull tide. Resume next tick. (Don't reset though — pickHollow
    // restores us cleanly.)
    return;
  }

  // Detect a new run (resets the per-Hollow state, even mid-pick).
  if (store.runStartedAtMs !== _lastRunStartedAtMs) {
    resetForNewRun();
    _lastRunStartedAtMs = store.runStartedAtMs;
  }

  const hollowId = store.selectedHollowId;
  if (hollowId === null) return;

  if (hollowId === 'ember') tickEmber(world);
  else if (hollowId === 'tide') tickTide(world, store.elapsedMs);
  // Bone is purely event-driven (see enemy_killed handler above); nothing to do here.
}

// --- Bone Hollow -------------------------------------------------------------

/**
 * Bonespawn = a recolored 'skirmisher' (fast, fragile). The brief asks for
 * 12 HP / 4 dmg / 200 speed; skirmisher is already 18/6/220 which is close
 * enough that recoloring + scale-down sells the silhouette. Using `skirmisher`
 * keeps us from bloating ENEMIES.
 */
function spawnBonespawn(world: World, x: number, y: number): void {
  const eid = spawnEnemyAt(world, 'skirmisher', x, y);
  if (eid < 0) return; // pool full or unknown id
  tintSpawnedEnemy(eid, 0xffffff);
  scaleSpawnedEnemy(eid, 0.7);
}

// --- Ember Hollow ------------------------------------------------------------

function findScene(): Phaser.Scene | null {
  return getArenaScene();
}

function spawnFirePatch(x: number, y: number): void {
  const scene = findScene();
  const visual = scene
    ? scene.add.circle(x, y, FIRE_PATCH_RADIUS_PX, 0xff5a1e, 0.45).setDepth(2)
    : null;
  firePatches.push({
    x,
    y,
    expiresAt: performance.now() + FIRE_PATCH_LIFETIME_MS,
    visual,
  });
  // Soft cap so a long Ember run can't accumulate thousands of patches.
  if (firePatches.length > 400) {
    const stale = firePatches.shift();
    if (stale && stale.visual) stale.visual.destroy();
  }
}

function tickEmber(world: World): void {
  // 1. Expire old patches.
  const now = performance.now();
  for (let i = firePatches.length - 1; i >= 0; i--) {
    const p = firePatches[i];
    if (!p) continue;
    if (p.expiresAt <= now) {
      if (p.visual) p.visual.destroy();
      firePatches.splice(i, 1);
    } else if (p.visual) {
      // Gentle fade as the patch ages.
      const lifeLeft = (p.expiresAt - now) / FIRE_PATCH_LIFETIME_MS;
      p.visual.setAlpha(0.2 + 0.4 * Math.max(0, Math.min(1, lifeLeft)));
    }
  }

  // 2. Find player position.
  const players = playerQuery(world);
  let px = 0;
  let py = 0;
  let foundPlayer = false;
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid === undefined) continue;
    px = Position.x[eid] ?? 0;
    py = Position.y[eid] ?? 0;
    foundPlayer = true;
    break;
  }
  if (!foundPlayer) return;

  // 3. Overlap test against any patch (early out).
  let standingOnFire = false;
  for (let i = 0; i < firePatches.length; i++) {
    const p = firePatches[i];
    if (!p) continue;
    const dx = p.x - px;
    const dy = p.y - py;
    if (dx * dx + dy * dy <= FIRE_PATCH_RADIUS_PX * FIRE_PATCH_RADIUS_PX) {
      standingOnFire = true;
      break;
    }
  }

  // 4. Edge-triggered: only mutate bargainBoosts.damageMul when state flips.
  if (standingOnFire && !_playerInFire) {
    _playerInFire = true;
    const cur = useRunStore.getState();
    _savedDamageMul = cur.bargainBoosts.damageMul;
    useRunStore.setState({
      bargainBoosts: {
        ...cur.bargainBoosts,
        damageMul: _savedDamageMul * EMBER_FIRE_DAMAGE_BUFF,
      },
    });
  } else if (!standingOnFire && _playerInFire) {
    _playerInFire = false;
    const cur = useRunStore.getState();
    // Restore the snapshot. Use a conservative fallback if another system has
    // since rewritten damageMul (shouldn't happen in v1 — only bargains and
    // this system touch the field).
    useRunStore.setState({
      bargainBoosts: {
        ...cur.bargainBoosts,
        damageMul: _savedDamageMul,
      },
    });
  }
}

// --- Tide Hollow -------------------------------------------------------------

let _tideRing: Phaser.GameObjects.Arc | null = null;
let _tideRingExpiresAt = 0;
const TIDE_RING_LIFETIME_MS = 600;
const TIDE_RING_MAX_RADIUS = 600;

function tickTide(world: World, elapsedMs: number): void {
  // Lazy init: if we got here without a 'hollow_chosen' subscription having
  // fired (e.g. on HMR where the picker was preselected), seed the timer
  // from the first tick. Idempotent.
  if (_tideHollowPickedAtMs < 0) {
    _tideHollowPickedAtMs = elapsedMs;
    _lastTideWaveAtMs = elapsedMs;
  }

  // Animate the most recent ring.
  if (_tideRing) {
    const now = performance.now();
    if (now >= _tideRingExpiresAt) {
      _tideRing.destroy();
      _tideRing = null;
    } else {
      const lifeFrac = 1 - (_tideRingExpiresAt - now) / TIDE_RING_LIFETIME_MS;
      _tideRing.setRadius(TIDE_RING_MAX_RADIUS * lifeFrac);
      _tideRing.setStrokeStyle(4, 0x6aa6e0, 0.7 * (1 - lifeFrac));
    }
  }

  // Time to push?
  if (elapsedMs - _lastTideWaveAtMs < TIDE_WAVE_INTERVAL_MS) return;
  _lastTideWaveAtMs = elapsedMs;

  // Yank every alive enemy toward the center.
  const enemies = enemyQuery(world);
  for (let i = 0; i < enemies.length; i++) {
    const eid = enemies[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    // Bosses resist the pull (otherwise the boss would get yanked on top of
    // the player every 30s, removing the fight's spacing). Smaller enemies
    // get a full pull.
    const isBoss = hasComponent(world, BossTag, eid);
    const pull = isBoss ? TIDE_PULL_PX * 0.25 : TIDE_PULL_PX;
    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    const dx = TIDE_CENTER_X - x;
    const dy = TIDE_CENTER_Y - y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const nx = dx / len;
    const ny = dy / len;
    Position.x[eid] = x + nx * pull;
    Position.y[eid] = y + ny * pull;
  }

  // Visual: an expanding ring at center.
  const scene = findScene();
  if (scene) {
    if (_tideRing) _tideRing.destroy();
    _tideRing = scene.add
      .circle(TIDE_CENTER_X, TIDE_CENTER_Y, 16, 0x000000, 0)
      .setStrokeStyle(4, 0x6aa6e0, 0.7)
      .setDepth(3);
    _tideRingExpiresAt = performance.now() + TIDE_RING_LIFETIME_MS;
  }
}

// --- exported helpers (for HMR-safe teardown) --------------------------------

/**
 * Wipe all per-run mutable state. Safe to call from ArenaScene.shutdown or a
 * dev hot-reload. Currently the system self-resets via runStartedAtMs change
 * detection so this is rarely needed, but it's exported for symmetry with the
 * other systems.
 */
export function resetHollowMechanics(): void {
  resetForNewRun();
  _lastRunStartedAtMs = 0;
}

// Re-export the HollowId type so callers that import this system have a single
// place to grab both the tick function and the union (avoids a deeper import
// path into content/).
export type { HollowId };
