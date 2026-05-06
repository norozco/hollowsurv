// Recycles Dead-tagged entities at end of tick.
//
// Owner: Agent C3.
//
// Tick order: ... -> damage -> pickup -> xp -> lifetime -> camera -> render.
// We run after every damage / pickup hook so anything that flagged Dead
// during this tick gets recycled before render reads positions.
//
// Lifetime decrement is **not** done here — projectileSystem owns it for
// projectiles, and other transient kinds (damage numbers, particle bursts)
// can add their own decrement when they ship. Doing it here would
// double-decrement for any entity already ticked elsewhere.
//
// Recycling strategy:
//   - For pool-managed entities (Pooled component), call releaseEntity which
//     strips components and pushes the slot back on the freelist.
//   - For non-pool entities (e.g. one-off weapon entities), no-op — those
//     live until the world is destroyed. We don't recycle them mid-run.

import { defineQuery, hasComponent } from 'bitecs';

import { releaseEntity } from '../../core/pool';
import { Dead, Pooled } from '../components';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

const deadQuery = defineQuery([Dead]);

export function lifetimeSystem(world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  const dead = deadQuery(world);
  for (let i = 0; i < dead.length; i++) {
    const eid = dead[i];
    if (eid === undefined) continue;
    if (!hasComponent(world, Pooled, eid)) continue;
    releaseEntity(world, eid);
  }
}
