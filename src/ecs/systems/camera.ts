// Camera follows the player.
// Owner: Agent C1.
//
// Wiring model:
//   ArenaScene.create() spawns the player rectangle (a Phaser GameObject) and
//   the player ECS entity, then calls bindCamera(scene, playerSprite, playerEid).
//   That sets camera bounds + lerp + startFollow(playerSprite). Each tick,
//   cameraSystem syncs the sprite's transform from the ECS Position so Phaser's
//   built-in follow logic works against the canonical ECS position.
//
// Note on lerp:
//   Phaser's startFollow with lerp 0.15 produces the "smooth-follow" feel the
//   spec calls for. The camera tracks the sprite, the sprite tracks the ECS
//   Position. That gives one frame of latency between sim and screen, which
//   is fine and lets the sim run independent of render.
import Phaser from 'phaser';
import { Position } from '../components';
import { ARENA_SIZE_PX } from '../../core/flowfield';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

/** Camera lerp factor. 0..1, lower = lazier follow. */
const CAMERA_LERP = 0.15;

interface CameraBinding {
  scene: Phaser.Scene;
  playerSprite: Phaser.GameObjects.Components.Transform;
  playerEid: number;
}

let binding: CameraBinding | null = null;

/**
 * Wire the camera to follow the player sprite. Called once from ArenaScene.create().
 * Sets bounds to the arena, configures lerp, and centers the camera on the player.
 */
export function bindCamera(
  scene: Phaser.Scene,
  playerSprite: Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Transform,
  playerEid: number
): void {
  const cam = scene.cameras.main;
  cam.setBounds(0, 0, ARENA_SIZE_PX, ARENA_SIZE_PX);
  cam.setLerp(CAMERA_LERP, CAMERA_LERP);
  cam.startFollow(playerSprite, true, CAMERA_LERP, CAMERA_LERP);
  // Center the camera on the player initially so the first frame doesn't pan.
  const px = Position.x[playerEid] ?? ARENA_SIZE_PX / 2;
  const py = Position.y[playerEid] ?? ARENA_SIZE_PX / 2;
  cam.centerOn(px, py);
  binding = { scene, playerSprite, playerEid };
}

/** Drop the binding (called on scene shutdown). */
export function unbindCamera(): void {
  binding = null;
}

/**
 * Tick the camera system. Syncs the player sprite position from the ECS
 * Position component. Phaser's camera follows the sprite each frame
 * automatically; we just have to keep the sprite honest.
 *
 * Skipped while the run is not in the 'playing' phase.
 *
 * Arena edge handling: camera bounds are set in `bindCamera` via
 * `cam.setBounds(0, 0, ARENA_SIZE_PX, ARENA_SIZE_PX)`. Phaser clamps the
 * viewport to those bounds automatically — so as the player approaches the
 * arena edge the camera stops scrolling and the player visually moves toward
 * the screen edge. The player's ECS Position is independently clamped to
 * `[0, ARENA_SIZE_PX]` in movementSystem so the player itself can never
 * leave the arena. Both clamps are required and present.
 */
export function cameraSystem(_world: World, _dtMs: number): void {
  if (useRunStore.getState().phase !== 'playing') return;
  const b = binding;
  if (!b) return;
  const eid = b.playerEid;
  b.playerSprite.x = Position.x[eid] ?? 0;
  b.playerSprite.y = Position.y[eid] ?? 0;
}
