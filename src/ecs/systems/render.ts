// Writes Position/Sprite to the SpriteGPULayer (or fallback Sprite GameObjects).
// Owner: split — render binding lives here, but sprite atlas + GPU layer setup is C1's call.
// TODO(agentC1/C3): when SpriteGPULayer API is confirmed for installed Phaser version,
// swap out the standard Phaser.GameObjects.Sprite fallback for a single batched draw.
import type { World } from '../world';

/**
 * Tick the render system. Reads Position + Sprite; writes to GPU layer.
 * Last system in the tick order.
 */
export function renderSystem(_world: World, _dt: number): void {
  // Stub. Implementation pending — see TODO above.
}
