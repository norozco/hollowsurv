// Applies Velocity to Position. Player reads PlayerInput; enemies sample the
// flowfield via flowfieldSystem (writes Velocity before this system runs).
// Owner: Agent C1.
//
// Tick order: input -> flowfield -> movement. Movement is the integrator.
import { defineQuery } from 'bitecs';
import { PlayerInput, PlayerTag, Position, Stats, Velocity } from '../components';
import { ARENA_SIZE_PX } from '../../core/flowfield';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

/** Player base movement speed in pixels per second. Multiplied by Stats.moveSpeedMul.
 *  Tuning ref: VS auto-walk ~100, Brotato ~150-200, HoT ~250-300, LoL Swarm ~400. */
const PLAYER_BASE_SPEED_PX_PER_SEC = 400;

/** Arena bounds. Player position is clamped to [0, ARENA_SIZE_PX] inclusive. */
const ARENA_MIN = 0;
const ARENA_MAX = ARENA_SIZE_PX;

// Two queries:
//  1. Player(s) — derive Velocity from PlayerInput, then integrate.
//  2. Everything else with Position+Velocity — pure integration. Enemies'
//     Velocity has already been written by flowfieldSystem this tick.
const playerQuery = defineQuery([PlayerTag, PlayerInput, Position, Velocity, Stats]);
const movableQuery = defineQuery([Position, Velocity]);

/**
 * Tick the movement system. dt is in seconds (delta / 1000).
 *
 * - Player: read input direction, normalize, multiply by base * Stats.moveSpeedMul,
 *   write Velocity, integrate, clamp to arena.
 * - Other movables (enemies, projectiles, pickups): integrate Velocity into
 *   Position. No clamp — projectiles fly off-arena and are reaped by lifetime.
 */
export function movementSystem(world: World, dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;
  const dt = dtMs / 1000;

  // --- player(s) -- derive velocity from input then integrate ---
  const players = playerQuery(world);
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid === undefined) continue;
    const dx = PlayerInput.dirX[eid] ?? 0;
    const dy = PlayerInput.dirY[eid] ?? 0;
    const speedMul = Stats.moveSpeedMul[eid] ?? 1;
    const speed = PLAYER_BASE_SPEED_PX_PER_SEC * speedMul;

    if (dx === 0 && dy === 0) {
      Velocity.vx[eid] = 0;
      Velocity.vy[eid] = 0;
    } else {
      // Normalize so diagonals are not faster than cardinals.
      const len = Math.hypot(dx, dy);
      const inv = 1 / len;
      Velocity.vx[eid] = dx * inv * speed;
      Velocity.vy[eid] = dy * inv * speed;
    }
  }

  // --- integrate everything that has Position + Velocity ---
  // Player(s) get integrated here too; the loop above only writes Velocity.
  const movables = movableQuery(world);
  for (let i = 0; i < movables.length; i++) {
    const eid = movables[i];
    if (eid === undefined) continue;
    const vx = Velocity.vx[eid] ?? 0;
    const vy = Velocity.vy[eid] ?? 0;
    if (vx === 0 && vy === 0) continue;
    const nx = (Position.x[eid] ?? 0) + vx * dt;
    const ny = (Position.y[eid] ?? 0) + vy * dt;
    Position.x[eid] = nx;
    Position.y[eid] = ny;
  }

  // --- clamp player(s) to arena ---
  // Done after integration, only on the player. Enemies/projectiles aren't
  // clamped — projectiles need to fly off-arena to be lifetime-reaped, and
  // enemies are spawned out-of-bounds on purpose (see C2).
  for (let i = 0; i < players.length; i++) {
    const eid = players[i];
    if (eid === undefined) continue;
    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    if (x < ARENA_MIN) Position.x[eid] = ARENA_MIN;
    else if (x > ARENA_MAX) Position.x[eid] = ARENA_MAX;
    if (y < ARENA_MIN) Position.y[eid] = ARENA_MIN;
    else if (y > ARENA_MAX) Position.y[eid] = ARENA_MAX;
  }
}
