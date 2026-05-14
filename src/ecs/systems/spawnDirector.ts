// Spawn director. Owner: Agent C2.
//
// Reads runStore.elapsedMs each tick. Iterates WAVES from content/waves.ts in order;
// when elapsed >= wave.atMs and the wave hasn't fired, it spawns the wave.
//
// Spawn placement:
//   - Position offset around the player at `radius` (default 600 px), formation-controlled:
//       ring   — even angular spread
//       random — uniformly random angle
//       line   — single offscreen line, evenly spaced perpendicular to a random angle
//
// Pool discipline:
//   - acquireEntity(world, PoolKind.Enemy) for grunts; PoolKind.Boss for bosses.
//   - Refuses to spawn when poolActiveCount(PoolKind.Enemy) >= cap. Drops the wave's
//     remaining grunts on the floor (logged via the eventBus would be excessive; we
//     just early-return from the spawn loop).
//
// Boss policy (documented choice):
//   - At BOSS_SPAWN_MS the director spawns the boss and *suppresses* further grunt waves
//     until the boss dies. We detect "boss alive" by querying BossTag entities each tick.
//
// Debug rendering (throwaway):
//   - The director maintains a Map<eid, Phaser.GameObjects.Rectangle> as a placeholder
//     visualisation. A real render system replaces this once SpriteGPULayer lands.
//   - The director discovers the active Phaser scene via either a `bindSpawnDirectorScene`
//     call (preferred — see TODO) or a fallback lookup against the global `__game` handle
//     exposed by main.tsx. If neither is available, sprite creation is skipped silently
//     and the simulation still runs (verifiable via runStore.kills counters etc.).

import Phaser from 'phaser';
import { addComponent, defineQuery, hasComponent, removeComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { ARENA_SIZE_PX } from '../../core/flowfield';
import {
  PoolKind,
  acquireEntity,
  poolActiveCount,
  poolCapacity,
  releaseEntity,
} from '../../core/pool';
import {
  BossTag,
  Damage,
  Dead,
  EnemyTag,
  Health,
  Hitbox,
  PlayerTag,
  Position,
  Sprite,
  Stats,
  Velocity,
} from '../components';
import { setEnemyBaseSpeed, getEnemyHpScaleForElapsedMs } from './flowfield';
import { ENEMIES, type EnemyDefinition } from '../../content/enemies';
import { WAVES, BOSS_SPAWN_MS, DEFAULT_SPAWN_RADIUS, type WaveDef, type WaveFormation } from '../../content/waves';
import { HOLLOWS, HOLLOW_CHOICE_OFFER_MS } from '../../content/hollows';
import { useRunStore } from '../../stores/runStore';
import { rng } from '../../core/rng';
import type { World } from '../world';

// --- queries -----------------------------------------------------------------

const enemyQuery = defineQuery([EnemyTag, Position]);
const bossQuery = defineQuery([BossTag, Position]);
const playerLookupQuery = defineQuery([PlayerTag, Position]);

// --- module state ------------------------------------------------------------

/** Indices of waves already fired this run. */
const firedWaves = new Set<number>();
/** Map of enemy/boss eid -> placeholder visual. Throwaway debug rendering. */
const visuals = new Map<number, Phaser.GameObjects.Rectangle>();

/** Optional explicit scene binding. If set, used directly. */
let boundScene: Phaser.Scene | null = null;
/** Tracks last attempt at fallback scene lookup so we don't spam on every tick. */
let triedFallbackLookup = false;
/**
 * Last-seen runStore.runStartedAtMs. Used to auto-reset wave gating + visuals
 * when a new run begins (menu -> playing -> menu -> playing). The scene module
 * doesn't currently call resetSpawnDirector(), so this is the safety net.
 */
let lastRunStartedAtMs = 0;

/**
 * Optional explicit hook for the scene to register itself. Not currently called
 * from ArenaScene (Agent C2 owns the spawn director but cannot edit scene code);
 * the fallback lookup via `globalThis.__game` covers vertical-slice needs.
 */
export function bindSpawnDirectorScene(scene: Phaser.Scene): void {
  boundScene = scene;
  triedFallbackLookup = false;
}

/** Reset on shutdown. Wave gating, visuals, scene reference. */
export function resetSpawnDirector(): void {
  firedWaves.clear();
  for (const r of visuals.values()) r.destroy();
  visuals.clear();
  boundScene = null;
  triedFallbackLookup = false;
  lastRunStartedAtMs = 0;
}

/**
 * Lighter reset that only clears per-run state (wave gating + visuals) and
 * keeps the scene binding. Called automatically when a new run starts.
 */
function resetForNewRun(): void {
  firedWaves.clear();
  for (const r of visuals.values()) r.destroy();
  visuals.clear();
}

// --- helpers -----------------------------------------------------------------

function getActiveScene(): Phaser.Scene | null {
  if (boundScene) return boundScene;
  if (triedFallbackLookup) return null;
  triedFallbackLookup = true;

  // Fallback: discover via the global handle that main.tsx exposes.
  const game = (globalThis as { __game?: Phaser.Game }).__game;
  if (!game) return null;
  const arena = game.scene.getScene('ArenaScene');
  if (!arena) return null;
  boundScene = arena;
  return arena;
}

/** Reach into runStore without coupling: the system runs server-side of UI. */
function getRunSnapshot(): { elapsedMs: number; runStartedAtMs: number } {
  const s = useRunStore.getState();
  return { elapsedMs: s.elapsedMs, runStartedAtMs: s.runStartedAtMs };
}

/** Resolve a player position; falls back to arena center. */
function getPlayerPos(world: World, out: { x: number; y: number }): void {
  const players = playerLookupQuery(world);
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid === undefined) continue;
    out.x = Position.x[eid] ?? ARENA_SIZE_PX / 2;
    out.y = Position.y[eid] ?? ARENA_SIZE_PX / 2;
    return;
  }
  // No player entity yet (very early in scene boot). Fall back to arena center.
  out.x = ARENA_SIZE_PX / 2;
  out.y = ARENA_SIZE_PX / 2;
}

/** Compute (offsetX, offsetY) for the i-th spawn of a wave. */
function offsetForFormation(
  formation: WaveFormation,
  index: number,
  total: number,
  radius: number,
  formationSeedAngle: number,
  out: { dx: number; dy: number },
): void {
  switch (formation) {
    case 'ring': {
      const angle = formationSeedAngle + (index / total) * Math.PI * 2;
      out.dx = Math.cos(angle) * radius;
      out.dy = Math.sin(angle) * radius;
      return;
    }
    case 'random': {
      // Spawn within a 90-degree sector centered on formationSeedAngle so the
      // player always has a "safe direction" to flee. Without this the wave
      // statistically forms a ring at high counts (4 enemies cover most of 360°).
      //
      // `rng()` is seeded by runStore.startRun() when daily mode is active so
      // every player today sees the same spawn angles. In normal mode it falls
      // back to Math.random.
      const SECTOR_RAD = Math.PI / 2; // 90 degrees
      const angle = formationSeedAngle + (rng() - 0.5) * SECTOR_RAD;
      const r = radius * (0.9 + rng() * 0.2);
      out.dx = Math.cos(angle) * r;
      out.dy = Math.sin(angle) * r;
      return;
    }
    case 'line': {
      // Spawn along a line perpendicular to formationSeedAngle, offset by radius.
      const along = (index - (total - 1) / 2) * 48; // 48 px gap.
      const cos = Math.cos(formationSeedAngle);
      const sin = Math.sin(formationSeedAngle);
      out.dx = cos * radius + -sin * along;
      out.dy = sin * radius + cos * along;
      return;
    }
  }
}

const _offsetScratch = { dx: 0, dy: 0 };
const _playerPosScratch = { x: 0, y: 0 };

/**
 * Spawn a single enemy from a definition at world position (x, y). Returns the eid.
 *
 * Exposed via `spawnEnemyAt()` so the Hollow mechanics system can spawn bone
 * skeletons on enemy death without duplicating the component-init plumbing.
 */
function spawnEnemyEntity(
  world: World,
  scene: Phaser.Scene | null,
  def: EnemyDefinition,
  x: number,
  y: number,
): number {
  const kind = def.isBoss ? PoolKind.Boss : PoolKind.Enemy;
  const eid = acquireEntity(world, kind);

  // Components: Position, Velocity, Health, Hitbox, Damage, Stats, EnemyTag/BossTag, Sprite, Pooled (added by acquireEntity).
  addComponent(world, Position, eid);
  addComponent(world, Velocity, eid);
  addComponent(world, Health, eid);
  addComponent(world, Hitbox, eid);
  addComponent(world, Damage, eid);
  addComponent(world, Stats, eid);
  addComponent(world, Sprite, eid);
  // Bosses get BOTH tags. EnemyTag puts them in the collision hash; BossTag
  // marks them for run_won emission and separation skip.
  addComponent(world, EnemyTag, eid);
  if (def.isBoss) addComponent(world, BossTag, eid);

  Position.x[eid] = x;
  Position.y[eid] = y;
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  // Apply elapsed-time HP scaling at spawn (balance pass: +10% per minute).
  const hpScale = getEnemyHpScaleForElapsedMs(useRunStore.getState().elapsedMs);
  Health.hp[eid] = def.hp * hpScale;
  Health.maxHp[eid] = def.hp * hpScale;
  Hitbox.radius[eid] = def.hitboxRadius;
  Damage.amount[eid] = def.damage;
  Stats.moveSpeedMul[eid] = 1.0;
  Stats.attackSpeedMul[eid] = 1.0;
  Stats.damageMul[eid] = 1.0;
  Stats.pickupRadiusMul[eid] = 1.0;
  Sprite.textureIndex[eid] = def.textureIndex;
  Sprite.tint[eid] = def.tint;
  Sprite.scale[eid] = 1.0;
  Sprite.rotation[eid] = 0;

  // Cache the base move speed for the flowfield system. Avoids storing a string id.
  setEnemyBaseSpeed(eid, def.moveSpeed);

  // Defensive: pool reuse may leave a Dead tag on a recycled eid. Strip it.
  if (hasComponent(world, Dead, eid)) removeComponent(world, Dead, eid);

  // Throwaway debug rendering.
  if (scene) {
    const sizePx = def.hitboxRadius * 2;
    const rect = scene.add.rectangle(x, y, sizePx, sizePx, def.tint);
    if (def.isBoss) rect.setStrokeStyle(2, 0xffffff);
    visuals.set(eid, rect);
  }

  return eid;
}

/** Recycle an enemy eid: release the entity and remove its visual if any. */
function recycleEnemy(world: World, eid: number): void {
  const rect = visuals.get(eid);
  if (rect) {
    rect.destroy();
    visuals.delete(eid);
  }
  releaseEntity(world, eid);
}

/** Spawn one wave's worth of enemies. */
function fireWave(world: World, scene: Phaser.Scene | null, wave: WaveDef): void {
  // Branching Hollows: boss waves substitute the selected Hollow's boss id.
  // When no Hollow was picked (e.g. the player died before 5:00), we fall back
  // to the wave's literal `enemy` value (boss-prime).
  let enemyId = wave.enemy;
  if (wave.isBoss === true) {
    const hollowId = useRunStore.getState().selectedHollowId;
    if (hollowId !== null) {
      const hollow = HOLLOWS[hollowId];
      if (hollow && ENEMIES[hollow.bossEnemyId]) {
        enemyId = hollow.bossEnemyId;
      }
    }
  }
  const def = ENEMIES[enemyId];
  if (!def) {
    // Unknown enemy id in waves.ts. Skip rather than throw — better to keep
    // the run alive than crash from a content typo.
    return;
  }

  getPlayerPos(world, _playerPosScratch);
  const radius = wave.radius ?? DEFAULT_SPAWN_RADIUS;
  // Seeded via core/rng so daily-mode runs share formation angles across players.
  const formationSeed = rng() * Math.PI * 2;

  const isBoss = wave.isBoss === true;
  const cap = isBoss ? poolCapacity(PoolKind.Boss) : poolCapacity(PoolKind.Enemy);
  let active = isBoss ? poolActiveCount(PoolKind.Boss) : poolActiveCount(PoolKind.Enemy);

  for (let i = 0; i < wave.count; i++) {
    if (active >= cap) break;
    offsetForFormation(wave.formation, i, wave.count, radius, formationSeed, _offsetScratch);
    const x = _playerPosScratch.x + _offsetScratch.dx;
    const y = _playerPosScratch.y + _offsetScratch.dy;
    const eid = spawnEnemyEntity(world, scene, def, x, y);
    active += 1;

    if (isBoss) {
      eventBus.emit({ type: 'boss_spawned', boss: eid });
    }
  }
}

/** Garbage-collect visuals whose ECS entity has been despawned/recycled. */
function syncVisuals(world: World): void {
  if (visuals.size === 0) return;
  const dead: number[] = [];
  for (const [eid, rect] of visuals) {
    const alive =
      hasComponent(world, EnemyTag, eid) || hasComponent(world, BossTag, eid);
    if (!alive) {
      rect.destroy();
      dead.push(eid);
      continue;
    }
    rect.x = Position.x[eid] ?? rect.x;
    rect.y = Position.y[eid] ?? rect.y;
  }
  for (const eid of dead) visuals.delete(eid);
}

/** Are any boss-tagged entities alive? */
function isBossAlive(world: World): boolean {
  const bosses = bossQuery(world);
  for (let i = 0; i < bosses.length; i++) {
    const eid = bosses[i];
    if (eid === undefined) continue;
    if (!hasComponent(world, Dead, eid)) return true;
  }
  return false;
}

// --- system entry point ------------------------------------------------------

/**
 * Tick the spawn director. Called once per frame after movementSystem (per the
 * tick order in CONTRACTS.md §6).
 *
 * No allocations except for the visuals map (one-time per spawn / despawn).
 */
export function spawnDirectorSystem(world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  const scene = getActiveScene();
  const snapshot = getRunSnapshot();
  const elapsed = snapshot.elapsedMs;

  // Auto-reset on new run. runStartedAtMs is set by runStore.startRun() and is
  // monotonically increasing per run; a change means the previous run is gone.
  if (snapshot.runStartedAtMs !== lastRunStartedAtMs) {
    resetForNewRun();
    lastRunStartedAtMs = snapshot.runStartedAtMs;
  }

  // Branching Hollows: at 5:00 the player picks a Hollow. We flip the phase to
  // 'hollow_select' so every other system (including this one — see the
  // top-of-fn guard) early-returns until pickHollow() resumes play. We only
  // fire the offer once per run (gated on selectedHollowId === null AND
  // hollowChoicePending === false). If the player already picked, both
  // conditions are false; if the offer's currently up, hollowChoicePending
  // is true; the next tick won't re-offer because phase !== 'playing'.
  {
    const s = useRunStore.getState();
    if (
      elapsed >= HOLLOW_CHOICE_OFFER_MS &&
      s.selectedHollowId === null &&
      !s.hollowChoicePending
    ) {
      useRunStore.setState({
        hollowChoicePending: true,
        phase: 'hollow_select',
      });
      eventBus.emit({ type: 'hollow_choice_offered' });
      // Return early: with phase now 'hollow_select' no spawning should happen
      // this tick anyway, and the top guard will catch us next frame.
      return;
    }
  }

  // Detect "boss is currently alive" once per tick — used to gate post-10:00 grunt waves.
  const bossAlive = isBossAlive(world);

  // Fire any waves whose time has come. Keep the index stable (don't sort WAVES).
  for (let i = 0; i < WAVES.length; i++) {
    if (firedWaves.has(i)) continue;
    const wave = WAVES[i];
    if (!wave) continue;
    if (elapsed < wave.atMs) break; // WAVES is time-sorted; no point checking later.

    const isBossWave = wave.isBoss === true;

    // Boss-suppression rule: once we've passed BOSS_SPAWN_MS, *non-boss* waves
    // only fire when the boss is dead. Boss waves themselves always fire.
    if (!isBossWave && elapsed >= BOSS_SPAWN_MS && bossAlive) {
      // Mark fired so we don't re-evaluate every tick. This is the documented
      // post-boss policy: skip remaining grunt waves (none in current schedule).
      firedWaves.add(i);
      continue;
    }

    fireWave(world, scene, wave);
    firedWaves.add(i);
    eventBus.emit({ type: 'wave_started', waveIndex: i, timeMs: elapsed });
  }

  // Sweep any enemies whose Dead tag landed this tick. The lifetimeSystem (Agent C3)
  // is the canonical recycler, but until that's implemented we handle Dead enemies
  // ourselves to keep visuals in sync. Once C3 lands lifetimeSystem, this loop
  // becomes a no-op (no entity will reach the spawn director with a Dead tag).
  const enemies = enemyQuery(world);
  for (let i = 0; i < enemies.length; i++) {
    const eid = enemies[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) recycleEnemy(world, eid);
  }
  const bosses = bossQuery(world);
  for (let i = 0; i < bosses.length; i++) {
    const eid = bosses[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) recycleEnemy(world, eid);
  }

  syncVisuals(world);
}

// --- public spawn helpers (Hollow mechanics) ---------------------------------

/**
 * Spawn a single enemy of the given archetype id at world position (x, y). Used
 * by `hollowMechanicsSystem` to summon Bone Hollow skeletons on enemy death.
 *
 * Returns the new entity's eid, or -1 if the archetype id is unknown or the
 * pool is at cap. Visual + flowfield wiring is identical to wave spawns.
 *
 * The caller is responsible for any per-Hollow tints/scale overrides (apply
 * AFTER this call by writing Sprite fields directly).
 */
export function spawnEnemyAt(world: World, enemyId: string, x: number, y: number): number {
  const def = ENEMIES[enemyId];
  if (!def) return -1;
  const cap = def.isBoss ? poolCapacity(PoolKind.Boss) : poolCapacity(PoolKind.Enemy);
  const active = def.isBoss ? poolActiveCount(PoolKind.Boss) : poolActiveCount(PoolKind.Enemy);
  if (active >= cap) return -1;
  const scene = getActiveScene();
  return spawnEnemyEntity(world, scene, def, x, y);
}

/**
 * Override the visual tint of a previously-spawned enemy. Useful for Bone
 * Hollow bonespawns (we recolor a `skirmisher` to white). Writes the Sprite
 * component AND the placeholder rectangle.
 */
export function tintSpawnedEnemy(eid: number, tint: number): void {
  Sprite.tint[eid] = tint;
  const rect = visuals.get(eid);
  if (rect) rect.fillColor = tint;
}

/** Scale the placeholder visual of a spawned enemy (multiplier; 1 = native). */
export function scaleSpawnedEnemy(eid: number, scale: number): void {
  Sprite.scale[eid] = scale;
  const rect = visuals.get(eid);
  if (rect) rect.setScale(scale);
}
