// Flowfield system. Owner: Agent C2.
//
// Responsibilities:
//   1. Track the player's current grid cell. When it changes (or 250 ms have elapsed
//      since the last recompute) trigger a BFS recompute via core/flowfield.
//   2. Each tick, write Velocity for every (EnemyTag | BossTag) entity with Position +
//      Velocity + Stats by reading the cell's direction vector and scaling by
//      enemy speed * Stats.moveSpeedMul. Movement integration happens in C1's
//      movementSystem afterwards.
//
// Tick order (ARCHITECTURE.md §3): inputSystem -> flowfieldSystem -> movementSystem.
// No allocations in the hot path.

import { defineQuery } from 'bitecs';

import {
  ARENA_SIZE_PX,
  FLOWFIELD_CELL_PX,
  FLOWFIELD_GRID_DIM,
  createFlowfield,
  recomputeFlowfield,
  worldToCell,
  type Flowfield,
} from '../../core/flowfield';
import {
  BossTag,
  EnemyTag,
  PlayerTag,
  Position,
  Stats,
  Velocity,
} from '../components';
import { FROST_SLOW_FACTOR, isEnemySlowed } from '../../content/weapons';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

/** Maximum interval between recomputes when the player hasn't moved cell. ARCHITECTURE.md §6. */
const MAX_RECOMPUTE_INTERVAL_MS = 250;

/** Arena center, used as the fallback target if the player is somehow unspawned. */
const ARENA_CENTER_X = ARENA_SIZE_PX / 2;
const ARENA_CENTER_Y = ARENA_SIZE_PX / 2;

const playerQuery = defineQuery([PlayerTag, Position]);
const enemyQuery = defineQuery([EnemyTag, Position, Velocity, Stats]);
const bossQuery = defineQuery([BossTag, Position, Velocity, Stats]);

/**
 * Scene-local flowfield. Module-level — there's exactly one active arena per session
 * (ARCHITECTURE.md §3, "one world, one tick"). Created lazily on first call so the
 * scene-create order doesn't matter.
 */
let field: Flowfield | null = null;
/** Cached player cell at last recompute trigger; -1 forces an initial compute. */
let lastPlayerCell = -1;
/** performance.now() at last recompute. Mirrors field.lastComputeMs but separate from
 *  the field so we can short-circuit before reading it. */
let lastComputeMs = 0;
/** Last-seen runStore.runStartedAtMs. Force a recompute when a new run begins. */
let lastRunStartedAtMs = 0;

/**
 * Map enemy id (Pooled.kind value isn't enough — we need an archetype id) to base
 * speed. The spawn director writes the speed into a side-channel before this system
 * runs; see {@link enemyBaseSpeed}.
 *
 * In v1 we keep a plain Float32Array indexed by eid. The spawn director sets
 * the slot at spawn time; flowfieldSystem reads it. This avoids storing a
 * string archetype id in the ECS (forbidden — see CONTRACTS.md §1).
 */
const ENEMY_SPEED_BUFFER_SIZE = 16384; // generous; bitECS eids are dense and small.
const enemyBaseSpeed = new Float32Array(ENEMY_SPEED_BUFFER_SIZE);

/** Set the base movement speed for an enemy (px/s at moveSpeedMul=1). Called by spawnDirector. */
export function setEnemyBaseSpeed(eid: number, speed: number): void {
  if (eid >= 0 && eid < ENEMY_SPEED_BUFFER_SIZE) {
    enemyBaseSpeed[eid] = speed;
  }
}

/** Read the base movement speed previously set via {@link setEnemyBaseSpeed}. */
export function readEnemyBaseSpeed(eid: number): number {
  if (eid < 0 || eid >= ENEMY_SPEED_BUFFER_SIZE) return 0;
  return enemyBaseSpeed[eid] ?? 0;
}

/**
 * Enemy HP scaling over time. Applied at SPAWN time by spawnDirector.spawnEnemyEntity().
 * Formula: hpScale = 1 + (minutes_elapsed × 0.10).
 *   0:00 -> 1.0×   (no scaling)
 *   1:00 -> 1.1×
 *   5:00 -> 1.5×
 *  10:00 -> 2.0×
 *
 * Lives here (not in spawnDirector) because flowfield owns the runStore-elapsed
 * read path conceptually, and other systems can reuse this if needed. Pure
 * function: no allocations, no side effects.
 */
export function getEnemyHpScaleForElapsedMs(elapsedMs: number): number {
  const minutes = elapsedMs / 60000;
  return 1 + minutes * 0.10;
}

/**
 * Initialize the module-level flowfield. Idempotent — safe to call from a scene
 * create() if/when wired in. Other entry points lazily call this on first tick
 * via {@link ensureField}.
 */
export function initFlowfield(): void {
  if (!field) field = createFlowfield();
  lastPlayerCell = -1;
  lastComputeMs = 0;
}

function ensureField(): Flowfield {
  if (!field) field = createFlowfield();
  return field;
}

/**
 * Reset the system on scene shutdown / new run. Clears the cached field so a
 * fresh run starts from a known state.
 */
export function resetFlowfieldSystem(): void {
  field = null;
  lastPlayerCell = -1;
  lastComputeMs = 0;
  lastRunStartedAtMs = 0;
  // Keep the enemyBaseSpeed buffer — bitECS eids may persist across worlds via
  // pool reuse, and zeros are a safe default. New spawns overwrite the slots.
  enemyBaseSpeed.fill(0);
}

/**
 * Tick the flowfield system. Runs after inputSystem, before movementSystem.
 * No allocations; no event emissions.
 */
export function flowfieldSystem(world: World, _dt: number): void {
  const store = useRunStore.getState();
  if (store.phase !== 'playing') return;

  const f = ensureField();

  // Auto-reset when a new run begins so the cached cell from the previous run
  // doesn't suppress the first recompute.
  if (store.runStartedAtMs !== lastRunStartedAtMs) {
    lastPlayerCell = -1;
    lastComputeMs = 0;
    lastRunStartedAtMs = store.runStartedAtMs;
  }

  // --- locate player ------------------------------------------------------
  const players = playerQuery(world);
  let playerEid = -1;
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid !== undefined) {
      playerEid = eid;
      break;
    }
  }

  let goalX = ARENA_CENTER_X;
  let goalY = ARENA_CENTER_Y;
  if (playerEid >= 0) {
    goalX = Position.x[playerEid] ?? ARENA_CENTER_X;
    goalY = Position.y[playerEid] ?? ARENA_CENTER_Y;
  }

  // --- recompute trigger --------------------------------------------------
  const playerCell = worldToCell(goalX, goalY);
  const now = performance.now();
  const cellChanged = playerCell !== lastPlayerCell;
  const timedOut = now - lastComputeMs >= MAX_RECOMPUTE_INTERVAL_MS;

  if (playerCell >= 0 && (cellChanged || timedOut || lastPlayerCell < 0)) {
    recomputeFlowfield(f, playerCell);
    lastPlayerCell = playerCell;
    lastComputeMs = now;
  }

  // --- write enemy velocities --------------------------------------------
  // Process EnemyTag and BossTag entities. Bosses use the same flowfield;
  // their slow speed is set in the archetype definition.
  applyToQuery(f, world, enemyQuery, goalX, goalY);
  applyToQuery(f, world, bossQuery, goalX, goalY);
}

/**
 * Internal: read each entity's cell, look up the field's direction vector, and
 * write Velocity. Falls back to a normalised vector toward the goal if the
 * entity is out of grid bounds (e.g. spawned just outside the arena before
 * being pulled in).
 */
function applyToQuery(
  f: Flowfield,
  world: World,
  query: ReturnType<typeof defineQuery>,
  goalX: number,
  goalY: number,
): void {
  const entities = query(world);
  const dxArr = f.dx;
  const dyArr = f.dy;
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i];
    if (eid === undefined) continue;
    // Per-eid speed variation 0.85x–1.15x so enemies don't all walk in lockstep.
    // Pseudo-random but stable per entity id (no allocations).
    const speedJitter = 0.85 + ((eid * 0.6180339887) % 1) * 0.3;
    // Frost slow: scaled down for the duration of the slow window.
    const slowMul = isEnemySlowed(eid) ? FROST_SLOW_FACTOR : 1;
    const speed = (enemyBaseSpeed[eid] ?? 0) * (Stats.moveSpeedMul[eid] ?? 1) * speedJitter * slowMul;
    if (speed <= 0) {
      Velocity.vx[eid] = 0;
      Velocity.vy[eid] = 0;
      continue;
    }
    const px = Position.x[eid] ?? 0;
    const py = Position.y[eid] ?? 0;

    // Per-cell index lookup. Inline to avoid the worldToCell branch in the hot path.
    const inGrid =
      px >= 0 && py >= 0 && px < ARENA_SIZE_PX && py < ARENA_SIZE_PX;

    let vx = 0;
    let vy = 0;

    if (inGrid) {
      const cx = (px / FLOWFIELD_CELL_PX) | 0;
      const cy = (py / FLOWFIELD_CELL_PX) | 0;
      const cell = cy * FLOWFIELD_GRID_DIM + cx;
      const fdx = dxArr[cell] ?? 0;
      const fdy = dyArr[cell] ?? 0;
      if (fdx !== 0 || fdy !== 0) {
        // Normalise diagonal so total speed is consistent with cardinal moves.
        // (1,1) -> 1/sqrt(2); (1,0) -> 1.
        const inv =
          fdx !== 0 && fdy !== 0 ? 0.7071067811865475 : 1;
        vx = fdx * inv * speed;
        vy = fdy * inv * speed;
      }
    } else {
      // Out-of-grid fallback: head straight toward the player. Covers the brief
      // window between spawn (offscreen) and entering the arena.
      const ddx = goalX - px;
      const ddy = goalY - py;
      const len = Math.hypot(ddx, ddy);
      if (len > 0.0001) {
        const inv = 1 / len;
        vx = ddx * inv * speed;
        vy = ddy * inv * speed;
      }
    }

    Velocity.vx[eid] = vx;
    Velocity.vy[eid] = vy;
  }
}

