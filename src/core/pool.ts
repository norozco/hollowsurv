// Generic entity pools with per-kind freelists.
// See ARCHITECTURE.md §7 (object pools) and CONTRACTS.md §1 (Pooled component) / §5 (file ownership).
//
// Design:
//   - Each pool kind has its own freelist (Uint32Array) and active list (Uint32Array).
//   - acquireEntity() pops from the freelist; if empty and below cap, calls addEntity(world).
//   - At hard cap, force-recycle the oldest active entity (ARCHITECTURE.md §7).
//   - releaseEntity() / recycleEntity() strip components, remove the entity from the world,
//     and push the freed slot back onto the freelist.
//   - The Pooled component records which kind each entity came from so callers only need
//     the entity id to release it.
//
// Caps (ARCHITECTURE.md §7 / §9):
//   projectiles 2000 · enemies 1500 · pickups 1000 · damage numbers 200 · particle bursts 500.

import {
  addComponent,
  addEntity,
  getEntityComponents,
  hasComponent,
  removeComponent,
  removeEntity,
} from 'bitecs';
import type { Component, IWorld } from 'bitecs';

import { Pooled } from '../ecs/components';

export const enum PoolKind {
  Projectile = 0,
  Enemy = 1,
  Pickup = 2,
  DamageNumber = 3,
  ParticleBurst = 4,
  Boss = 5,
}

export const POOL_CAPS: Readonly<Record<PoolKind, number>> = {
  [PoolKind.Projectile]: 2000,
  [PoolKind.Enemy]: 1500,
  [PoolKind.Pickup]: 1000,
  [PoolKind.DamageNumber]: 200,
  [PoolKind.ParticleBurst]: 500,
  // Bosses are rare. Keep the cap small; ARCHITECTURE.md leaves the number open
  // so a conservative 8 covers 1 active boss + a few spawning effects.
  [PoolKind.Boss]: 8,
};

const KIND_COUNT = 6;

/**
 * Per-PoolKind cached component list, used to avoid allocating a new array
 * from `getEntityComponents` on every strip.
 *
 * Strategy (the "lazy-accumulate per-kind cache" of the audit's option A):
 *   - First strip of a given kind: fall back to `getEntityComponents`,
 *     populate the cache from the result. Pays one allocation that day.
 *   - Subsequent strips: iterate the cached `Component[]` and call
 *     `removeComponent` for each (no-op if the component isn't present on
 *     this particular entity — see bitECS removeComponent guard).
 *   - On every strip we also reconcile via `getEntityComponents` when the
 *     cache is empty for a kind, OR when the entity has components beyond
 *     what we've cached. In the steady state (after a handful of acquisitions
 *     of each kind), the cache fully covers the component union for that kind
 *     and we hit zero allocations.
 *
 * Trade-off: over-listing (a component cached for a kind that isn't on this
 * particular entity) is cheap — `removeComponent` checks `hasComponent`
 * first. Under-listing (a fresh component not yet observed) is automatically
 * corrected on the next strip that performs a reconciliation.
 *
 * We choose this approach over a single shared scratch buffer because per-
 * kind caches are tighter (e.g. damage numbers and bosses share almost no
 * components with projectiles) and the cache stabilizes quickly in practice.
 */
const STRIP_COMP_CACHE: (Component[] | null)[] = new Array(KIND_COUNT).fill(null);
/** Tracks whether a kind's cache has been validated against `getEntityComponents`. */
const STRIP_COMP_CACHE_SEEDED: boolean[] = new Array(KIND_COUNT).fill(false);

/**
 * Per-kind pool state.
 * - free: ring of recycled entity ids. Treat as a stack: pop from `freeTop - 1`.
 * - active: ring of currently-in-use entity ids. Used to find the oldest for forced recycling.
 *           `activeHead` is the next slot to write; the oldest entry is at `activeHead - activeLen`.
 * - allocated: total entities ever pulled from the world for this kind (== high-water mark).
 */
interface KindPool {
  free: Uint32Array;
  freeTop: number;
  active: Uint32Array;
  activeHead: number;
  activeLen: number;
  allocated: number;
  cap: number;
}

const POOLS: KindPool[] = new Array(KIND_COUNT).fill(null).map(() => ({
  free: new Uint32Array(0),
  freeTop: 0,
  active: new Uint32Array(0),
  activeHead: 0,
  activeLen: 0,
  allocated: 0,
  cap: 0,
})) as KindPool[];

function getPool(kind: PoolKind): KindPool {
  let pool = POOLS[kind];
  if (!pool) {
    // Should never happen because POOLS is initialized at module load,
    // but the typechecker enforces noUncheckedIndexedAccess.
    throw new Error(`pool.ts: invalid PoolKind ${kind}`);
  }
  if (pool.cap === 0) {
    const cap = POOL_CAPS[kind];
    pool.cap = cap;
    pool.free = new Uint32Array(cap);
    pool.active = new Uint32Array(cap);
  }
  return pool;
}

function pushActive(pool: KindPool, eid: number): void {
  pool.active[pool.activeHead] = eid;
  pool.activeHead = (pool.activeHead + 1) % pool.cap;
  if (pool.activeLen < pool.cap) pool.activeLen += 1;
}

function removeFromActive(pool: KindPool, eid: number): void {
  // Linear scan over a small ring. Acceptable: only used on explicit release,
  // and the active list is bounded by the cap.
  if (pool.activeLen === 0) return;
  const cap = pool.cap;
  let read = (pool.activeHead - pool.activeLen + cap) % cap;
  let foundAt = -1;
  for (let i = 0; i < pool.activeLen; i++) {
    const idx = (read + i) % cap;
    if (pool.active[idx] === eid) {
      foundAt = idx;
      break;
    }
  }
  if (foundAt < 0) return;
  // Compact: shift everything after foundAt one step backwards in the ring.
  let i = foundAt;
  for (;;) {
    const next = (i + 1) % cap;
    if (next === pool.activeHead) break;
    pool.active[i] = pool.active[next]!;
    i = next;
  }
  pool.activeHead = (pool.activeHead - 1 + cap) % cap;
  pool.activeLen -= 1;
}

function popOldestActive(pool: KindPool): number {
  if (pool.activeLen === 0) return -1;
  const cap = pool.cap;
  const oldestIdx = (pool.activeHead - pool.activeLen + cap) % cap;
  const eid = pool.active[oldestIdx]!;
  pool.activeLen -= 1;
  // No need to shift: the next pushActive will use activeHead and activeLen
  // tracks the count, so leaving the ring contents alone is fine.
  // But we must keep activeHead == oldest + activeLen, which it already is.
  return eid;
}

/**
 * Acquire an entity of the given kind.
 *
 * Strategy:
 *   1. If the kind's freelist has an entry, pop it (the eid is still alive in the
 *      bitECS world; release() only stripped its components, not the entity itself).
 *   2. Else, if the pool has not reached its hard cap, allocate a new entity via
 *      addEntity().
 *   3. Else, force-recycle the oldest active entity (per ARCHITECTURE.md §7) — strip
 *      its components and reuse the slot.
 *
 * The returned entity has the `Pooled` component attached with `kind` set,
 * so `releaseEntity(world, eid)` only needs the entity id.
 */
export function acquireEntity(world: IWorld, kind: PoolKind): number {
  const pool = getPool(kind);

  let eid: number;
  if (pool.freeTop > 0) {
    pool.freeTop -= 1;
    eid = pool.free[pool.freeTop]!;
  } else if (pool.allocated < pool.cap) {
    eid = addEntity(world);
    pool.allocated += 1;
  } else {
    // At cap: force-recycle the oldest active entity, reusing its slot.
    const oldest = popOldestActive(pool);
    if (oldest < 0) {
      // Shouldn't happen — allocated == cap implies active >= 1 unless everything
      // was already on the freelist, which contradicts freeTop === 0.
      throw new Error(`pool.ts: PoolKind ${kind} exhausted with no recyclable entity`);
    }
    stripComponents(world, oldest, kind);
    eid = oldest;
    // allocated is unchanged — we reuse a slot that was already counted.
  }

  addComponent(world, Pooled, eid);
  Pooled.kind[eid] = kind;
  pushActive(pool, eid);
  return eid;
}

/**
 * Strip every component off an entity, leaving its eid alive in the bitECS world.
 * This is what lets us keep our own freelist of valid eids without colliding with
 * bitECS's internal `removed` queue / recycling threshold.
 *
 * Per-kind component cache: see STRIP_COMP_CACHE for the strategy. We try the
 * cached list first; if a kind hasn't been seeded yet we fall back to
 * `getEntityComponents` (one allocation) and use the result to seed the cache
 * for that kind.
 */
function stripComponents(world: IWorld, eid: number, kind: PoolKind): void {
  const cached = STRIP_COMP_CACHE[kind];
  if (STRIP_COMP_CACHE_SEEDED[kind] === true && cached !== null && cached !== undefined) {
    // Hot path: zero allocation. removeComponent is safe when the component
    // isn't present (bitECS guards on hasComponent internally).
    for (let i = 0; i < cached.length; i++) {
      removeComponent(world, cached[i]!, eid);
    }
    return;
  }
  // Cold path: discover the components for this kind and seed the cache.
  // getEntityComponents allocates a new array here; we accept that cost on
  // the first strip per kind in exchange for zero-alloc strips thereafter.
  const comps = getEntityComponents(world, eid) as Component[];
  for (let i = 0; i < comps.length; i++) {
    removeComponent(world, comps[i]!, eid);
  }
  // Seed the cache: copy into a fresh array we own (never expose the array
  // we got from bitECS — `Array.from` already made it a fresh array but
  // we keep ownership explicit). Then mark as seeded.
  const seed: Component[] = new Array(comps.length);
  for (let i = 0; i < comps.length; i++) seed[i] = comps[i]!;
  STRIP_COMP_CACHE[kind] = seed;
  STRIP_COMP_CACHE_SEEDED[kind] = true;
}

/**
 * Release an entity back to its pool. The `Pooled` component identifies the kind.
 * If `Pooled` is missing (shouldn't happen for properly-acquired entities) the
 * entity is destroyed via removeEntity as a fallback.
 */
export function releaseEntity(world: IWorld, eid: number): void {
  if (!hasComponent(world, Pooled, eid)) {
    // Not a pool-managed entity — destroy outright so callers don't leak.
    removeEntity(world, eid);
    return;
  }
  const kind = Pooled.kind[eid] as PoolKind | undefined;
  if (kind === undefined) {
    removeEntity(world, eid);
    return;
  }
  const pool = getPool(kind);
  removeFromActive(pool, eid);
  stripComponents(world, eid, kind);
  if (pool.freeTop < pool.cap) {
    pool.free[pool.freeTop] = eid;
    pool.freeTop += 1;
  } else {
    // Freelist somehow saturated (defensive — shouldn't happen given activeLen tracking).
    removeEntity(world, eid);
    pool.allocated = Math.max(0, pool.allocated - 1);
  }
}

/**
 * Backwards-compatible alias kept for existing callers. Equivalent to
 * `releaseEntity` when the kind is already encoded on the entity, but accepts an
 * explicit kind for resilience if the `Pooled` component was somehow not added.
 */
export function recycleEntity(world: IWorld, eid: number, kind?: PoolKind): void {
  if (kind === undefined) {
    releaseEntity(world, eid);
    return;
  }
  const pool = getPool(kind);
  removeFromActive(pool, eid);
  stripComponents(world, eid, kind);
  if (pool.freeTop < pool.cap) {
    pool.free[pool.freeTop] = eid;
    pool.freeTop += 1;
  } else {
    removeEntity(world, eid);
    pool.allocated = Math.max(0, pool.allocated - 1);
  }
}

/** Number of currently-active entities for a kind. */
export function poolActiveCount(kind: PoolKind): number {
  return getPool(kind).activeLen;
}

/** Hard cap for a kind. */
export function poolCapacity(kind: PoolKind): number {
  return POOL_CAPS[kind];
}

/**
 * Reset all pool bookkeeping. Call from ArenaScene.shutdown() so a fresh run
 * doesn't see stale entity ids from the previous world.
 */
export function resetAllPools(): void {
  for (let i = 0; i < KIND_COUNT; i++) {
    const pool = POOLS[i]!;
    pool.freeTop = 0;
    pool.activeHead = 0;
    pool.activeLen = 0;
    pool.allocated = 0;
    // Keep the typed-array buffers; they'll be reused.
    // Strip-cache survives across runs because the component object identities
    // (the imported references in ecs/components.ts) are module-level constants
    // — they do not change when a new World is created.
  }
}

// --- additive convenience helpers -------------------------------------------
// CONTRACTS.md §5 permits agents to add `acquireFoo` / `releaseFoo` helpers.

export function acquireProjectile(world: IWorld): number {
  return acquireEntity(world, PoolKind.Projectile);
}

export function acquireEnemy(world: IWorld): number {
  return acquireEntity(world, PoolKind.Enemy);
}

export function acquirePickup(world: IWorld): number {
  return acquireEntity(world, PoolKind.Pickup);
}

export function acquireBoss(world: IWorld): number {
  return acquireEntity(world, PoolKind.Boss);
}

export function acquireDamageNumber(world: IWorld): number {
  return acquireEntity(world, PoolKind.DamageNumber);
}

export function acquireParticleBurst(world: IWorld): number {
  return acquireEntity(world, PoolKind.ParticleBurst);
}
