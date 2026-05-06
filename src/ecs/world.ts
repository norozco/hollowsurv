// bitECS world creation/destruction.
// Owned by Agent C1 (scene boot lifecycle).
import { createWorld, deleteWorld } from 'bitecs';
import type { IWorld } from 'bitecs';

export type World = IWorld;

/** Create a fresh ECS world for a run. Called from ArenaScene.create(). */
export function createGameWorld(): World {
  return createWorld();
}

/** Destroy the world and release any associated structures. */
export function destroyGameWorld(world: World): void {
  deleteWorld(world);
}
