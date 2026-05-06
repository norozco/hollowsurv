// Temporary smoke test for src/core infrastructure.
// Run with: `npx tsx src/core/_smoke.ts` (after `npm i -D tsx`),
// or via `node --import tsx/esm src/core/_smoke.ts`.
// Safe to delete once C2/C3/C4 land their own tests.

import { createWorld, hasComponent } from 'bitecs';

import {
  acquireEntity,
  PoolKind,
  poolActiveCount,
  poolCapacity,
  releaseEntity,
  resetAllPools,
} from './pool';
import { SpatialHash } from './spatialHash';
import { Pooled } from '../ecs/components';

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    throw new Error(`smoke failure: ${msg}`);
  }
  console.log(`  ok  ${msg}`);
}

function smokePool(): void {
  console.log('[pool] smoke test');
  resetAllPools();

  const world = createWorld();

  // 1. Acquire 100 enemies.
  const first: number[] = [];
  for (let i = 0; i < 100; i++) first.push(acquireEntity(world, PoolKind.Enemy));
  assert(poolActiveCount(PoolKind.Enemy) === 100, 'active count after 100 acquires');
  assert(
    new Set(first).size === 100,
    'all 100 acquired ids are unique',
  );
  assert(
    first.every((eid) => hasComponent(world, Pooled, eid)),
    'every acquired entity has the Pooled component',
  );
  assert(
    first.every((eid) => Pooled.kind[eid] === PoolKind.Enemy),
    'every acquired entity has Pooled.kind == Enemy',
  );

  // 2. Release them all.
  for (const eid of first) releaseEntity(world, eid);
  assert(poolActiveCount(PoolKind.Enemy) === 0, 'active count after 100 releases');

  // 3. Re-acquire — freelist should hand back the same slots.
  const second: number[] = [];
  for (let i = 0; i < 100; i++) second.push(acquireEntity(world, PoolKind.Enemy));
  assert(poolActiveCount(PoolKind.Enemy) === 100, 'active count after re-acquire');

  const firstSet = new Set(first);
  const reused = second.filter((e) => firstSet.has(e)).length;
  assert(reused === 100, `freelist returned all 100 prior ids (got ${reused})`);

  // 4. Cap behavior: fill to cap, next acquire should force-recycle.
  const capacity = poolCapacity(PoolKind.Enemy);
  // Already have 100 active; push to cap.
  while (poolActiveCount(PoolKind.Enemy) < capacity) {
    acquireEntity(world, PoolKind.Enemy);
  }
  assert(poolActiveCount(PoolKind.Enemy) === capacity, 'pool at cap');
  // Next acquire forces recycle, so count stays at cap.
  acquireEntity(world, PoolKind.Enemy);
  assert(poolActiveCount(PoolKind.Enemy) === capacity, 'pool stays at cap after force-recycle');

  resetAllPools();
}

function smokeSpatialHash(): void {
  console.log('[spatialHash] smoke test');
  const hash = new SpatialHash(128);

  // Insert 100 entities in a 1000x1000 region around (500, 500).
  const positions: Array<[number, number]> = [];
  for (let i = 0; i < 100; i++) {
    const x = (i * 37) % 1000;
    const y = (i * 91) % 1000;
    positions.push([x, y]);
    hash.insert(i + 1, x, y);
  }

  // Query a generous radius around the centroid — must return non-zero results.
  const out: number[] = [];
  hash.queryRadius(500, 500, 750, out);
  assert(out.length > 0, `queryRadius returned ${out.length} results (>0)`);
  // Query an empty area far from any insertion.
  hash.queryRadius(100_000, 100_000, 10, out);
  assert(out.length === 0, 'queryRadius returns 0 for empty area');

  // Nearest within a wide radius should find one of our entities.
  const near = hash.nearest(500, 500, 10_000);
  assert(near > 0, `nearest returned a positive eid (got ${near})`);
  // Nearest with a tiny radius around an empty area should return -1.
  const none = hash.nearest(100_000, 100_000, 1);
  assert(none === -1, `nearest returns -1 when nothing in range (got ${none})`);

  // clear() should empty out queries.
  hash.clear();
  hash.queryRadius(500, 500, 750, out);
  assert(out.length === 0, 'queryRadius returns 0 after clear()');
}

smokePool();
smokeSpatialHash();
console.log('all smoke checks passed');
