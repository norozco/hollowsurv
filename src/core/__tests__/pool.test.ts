// Pool freelist tests for src/core/pool.ts.
//
// The pool keeps eids alive across acquire/release cycles so we never blow up
// bitECS's internal recycling threshold. A regression here (e.g. fresh eid on
// every acquire) would silently cause memory growth + sprite churn in long
// runs. This test pins the most important invariant: released eids come back
// from the freelist on the next acquire.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PoolKind,
  acquireEntity,
  releaseEntity,
  poolActiveCount,
  poolCapacity,
  resetAllPools,
} from '../pool';
import { createGameWorld, destroyGameWorld } from '../../ecs/world';
import type { World } from '../../ecs/world';
import { Pooled } from '../../ecs/components';

describe('pool', () => {
  let world: World;

  beforeEach(() => {
    resetAllPools();
    world = createGameWorld();
  });

  it('recycles eids via the freelist after release', () => {
    // Acquire 10 enemies and remember their eids.
    const acquired: number[] = [];
    for (let i = 0; i < 10; i++) {
      acquired.push(acquireEntity(world, PoolKind.Enemy));
    }
    expect(poolActiveCount(PoolKind.Enemy)).toBe(10);

    // Release them all.
    for (const eid of acquired) {
      releaseEntity(world, eid);
    }
    expect(poolActiveCount(PoolKind.Enemy)).toBe(0);

    // Re-acquire 10 — every eid should already be one we saw before
    // (freelist reuses slots; the test would fail if we allocated fresh eids).
    const reAcquired: number[] = [];
    for (let i = 0; i < 10; i++) {
      reAcquired.push(acquireEntity(world, PoolKind.Enemy));
    }
    const originalSet = new Set(acquired);
    for (const eid of reAcquired) {
      expect(originalSet.has(eid)).toBe(true);
    }
    expect(poolActiveCount(PoolKind.Enemy)).toBe(10);

    destroyGameWorld(world);
  });

  it('tags acquired entity with Pooled.kind', () => {
    const eid = acquireEntity(world, PoolKind.Projectile);
    expect(Pooled.kind[eid]).toBe(PoolKind.Projectile);

    const eid2 = acquireEntity(world, PoolKind.Enemy);
    expect(Pooled.kind[eid2]).toBe(PoolKind.Enemy);

    destroyGameWorld(world);
  });

  it('caps activeLen at pool capacity (force-recycle stress)', () => {
    // Acquire more than the projectile cap to trigger force-recycling.
    const cap = poolCapacity(PoolKind.Projectile);
    // Test at scale: 2500 projectiles vs. cap=2000 forces ~500 recycles.
    const ACQUIRE_COUNT = cap + 500;
    for (let i = 0; i < ACQUIRE_COUNT; i++) {
      const eid = acquireEntity(world, PoolKind.Projectile);
      expect(Pooled.kind[eid]).toBe(PoolKind.Projectile);
    }
    // Active count must never exceed the hard cap.
    expect(poolActiveCount(PoolKind.Projectile)).toBe(cap);

    destroyGameWorld(world);
  });

  it('resetAllPools clears bookkeeping but keeps buffers usable', () => {
    acquireEntity(world, PoolKind.Enemy);
    acquireEntity(world, PoolKind.Enemy);
    expect(poolActiveCount(PoolKind.Enemy)).toBe(2);

    resetAllPools();
    expect(poolActiveCount(PoolKind.Enemy)).toBe(0);

    // Fresh world; can still acquire.
    destroyGameWorld(world);
    world = createGameWorld();
    const eid = acquireEntity(world, PoolKind.Enemy);
    expect(Pooled.kind[eid]).toBe(PoolKind.Enemy);
    destroyGameWorld(world);
  });
});
