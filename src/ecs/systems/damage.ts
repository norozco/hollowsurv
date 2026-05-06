// Applies queued damage from collision events; tags Dead when hp <= 0.
// Owner: Agent C3.
//
// **Direct-call architecture** (see CONTRACTS-coordinator notes in
// collision.ts and CONTRACTS.md §1):
//   In v1 the collisionSystem and autoAttackSystem apply damage directly to
//   Health components, mark the Dead tag, and emit the canonical
//   `damage_dealt` / `enemy_killed` / `run_lost` events themselves. That
//   keeps event ordering tight (a kill emits its enemy_killed in the same
//   call site that decremented HP).
//
//   This system is therefore a **safety net pass** that catches any entity
//   whose Health.hp <= 0 but isn't yet tagged Dead — for example, if a
//   future weapon writes Health from an event handler instead of through
//   the in-system path. It also serves as the canonical place to bolt on
//   per-tick damage-over-time effects later (poison, burn) without having
//   to also re-emit kill events from those subscribers.
//
// Tick order: ... collision -> damage -> ... -> lifetime. Running between
// collision and lifetime guarantees the Dead tag we add here is honored on
// the same tick.

import { addComponent, defineQuery, hasComponent } from 'bitecs';

import { eventBus } from '../../core/eventBus';
import { BossTag, Dead, EnemyTag, Health, PlayerTag, Position } from '../components';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

const enemyHealthQuery = defineQuery([EnemyTag, Health]);
const playerHealthQuery = defineQuery([PlayerTag, Health]);

export function damageSystem(world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  // Enemy safety net: tag Dead and emit enemy_killed for any enemy whose
  // hp dropped to zero without already being tagged.
  const enemies = enemyHealthQuery(world);
  for (let i = 0; i < enemies.length; i++) {
    const eid = enemies[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;
    const hp = Health.hp[eid] ?? 0;
    if (hp > 0) continue;

    addComponent(world, Dead, eid);
    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    eventBus.emit({
      type: 'enemy_killed',
      enemy: eid,
      killer: 0,
      position: { x, y },
    });
    if (hasComponent(world, BossTag, eid)) {
      const store = useRunStore.getState();
      eventBus.emit({
        type: 'run_won',
        timeMs: store.elapsedMs,
        level: store.player.level,
        kills: store.kills + 1,
      });
    }
  }

  // Player safety net: same idea.
  const players = playerHealthQuery(world);
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid === undefined) continue;
    const hp = Health.hp[eid] ?? 0;
    if (hp > 0) continue;
    if (useRunStore.getState().phase !== 'playing') continue;
    const store = useRunStore.getState();
    eventBus.emit({
      type: 'run_lost',
      timeMs: store.elapsedMs,
      level: store.player.level,
      kills: store.kills,
    });
  }
}
