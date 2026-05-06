// Projectile-specific behaviors.
// Owner: Agent C3.
//
// Responsibilities:
//   - Decrement Lifetime.remainingMs for each projectile. When the timer
//     reaches zero or below, mark the projectile Dead so lifetimeSystem
//     recycles it at the end of the tick.
//   - Throwaway placeholder rendering: a small Phaser circle per projectile,
//     synced from ECS Position. Replaced when SpriteGPULayer ships.
//   - (Future) homing nudge — reserved boolean.
//
// Note: Velocity -> Position integration happens in C1's movementSystem
// upstream of us in the tick order. We must not duplicate the integration.

import { addComponent, defineQuery, hasComponent } from 'bitecs';
import Phaser from 'phaser';

import { Dead, Hitbox, Lifetime, Position, ProjectileTag, Sprite, Velocity } from '../components';
import { consumeBoomerangFlip, isOrbiter } from './autoAttack';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

const projectileQuery = defineQuery([ProjectileTag, Lifetime, Position]);

/** Placeholder visual map: projectile eid -> Phaser circle. */
const PROJECTILE_VISUALS: Map<number, Phaser.GameObjects.Arc> = new Map();

function findArenaScene(): Phaser.Scene | null {
  const game = (globalThis as { __game?: Phaser.Game }).__game;
  if (!game) return null;
  const scene = game.scene.getScene('ArenaScene');
  if (!scene) return null;
  if (!game.scene.isActive('ArenaScene')) return null;
  return scene;
}

export function projectileSystem(world: World, dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;

  const scene = findArenaScene();
  const projectiles = projectileQuery(world);

  for (let i = 0; i < projectiles.length; i++) {
    const eid = projectiles[i];
    if (eid === undefined) continue;

    // Lifetime decrement. Skip for orbiters (they live as long as the weapon is equipped).
    if (!hasComponent(world, Dead, eid) && !isOrbiter(eid)) {
      let remaining = Lifetime.remainingMs[eid] ?? 0;
      remaining -= dtMs;
      if (remaining <= 0) {
        Lifetime.remainingMs[eid] = 0;
        addComponent(world, Dead, eid);
      } else {
        Lifetime.remainingMs[eid] = remaining;
      }

      // Boomerang flip: at midpoint, reverse velocity so it returns.
      if (consumeBoomerangFlip(eid)) {
        Velocity.vx[eid] = -(Velocity.vx[eid] ?? 0);
        Velocity.vy[eid] = -(Velocity.vy[eid] ?? 0);
      }
    }

    // Placeholder rendering: create on first sight, sync each tick, destroy when Dead.
    if (hasComponent(world, Dead, eid)) {
      const arc = PROJECTILE_VISUALS.get(eid);
      if (arc) {
        arc.destroy();
        PROJECTILE_VISUALS.delete(eid);
      }
      continue;
    }

    if (scene) {
      let arc = PROJECTILE_VISUALS.get(eid);
      const r = Math.max(3, Hitbox.radius[eid] ?? 4);
      const tint = Sprite.tint[eid] ?? 0xffe680;
      if (!arc) {
        arc = scene.add.circle(Position.x[eid] ?? 0, Position.y[eid] ?? 0, r, tint);
        arc.setStrokeStyle(1, 0xffffff, 0.7);
        PROJECTILE_VISUALS.set(eid, arc);
      } else {
        arc.x = Position.x[eid] ?? arc.x;
        arc.y = Position.y[eid] ?? arc.y;
      }
    }
  }

  // Garbage-collect visuals whose ECS entity is gone (eid stripped + recycled).
  if (PROJECTILE_VISUALS.size > 0) {
    for (const [eid, arc] of PROJECTILE_VISUALS) {
      if (!hasComponent(world, ProjectileTag, eid)) {
        arc.destroy();
        PROJECTILE_VISUALS.delete(eid);
      }
    }
  }
}
