// Legacy render system entry point.
//
// Hollowsurv now uses `batchedRender.ts` (single Phaser.Graphics redrawn each
// tick) wired directly into `ArenaScene.update()`. This file is kept as a
// no-op stub so any out-of-tree imports (tests, dev tools, prior commits)
// don't break while the migration settles. Safe to delete in a follow-up.
import type { World } from '../world';

/**
 * No-op. The active renderer is `batchedRenderSystem` in
 * `src/ecs/systems/batchedRender.ts`. ArenaScene.update calls that one.
 */
export function renderSystem(_world: World, _dt: number): void {
  /* batchedRender owns the draw pass — see src/ecs/systems/batchedRender.ts */
}
