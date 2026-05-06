// Reads Phaser input, writes to PlayerInput component.
// Owner: Agent C1.
//
// Wiring model:
//   ArenaScene.create() calls bindInput(scene, playerEid) once. That captures
//   the Phaser keyboard keys + scene reference into module-local state.
//   inputSystem() then runs every tick, reads them, and writes into the
//   PlayerInput component arrays for the bound player eid.
//
// No allocations per tick. No event emissions.
import Phaser from 'phaser';
import { PlayerInput, Position } from '../components';
import { useRunStore } from '../../stores/runStore';
import type { World } from '../world';

interface InputBinding {
  scene: Phaser.Scene;
  playerEid: number;
  keys: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    Up: Phaser.Input.Keyboard.Key;
    Down: Phaser.Input.Keyboard.Key;
    Left: Phaser.Input.Keyboard.Key;
    Right: Phaser.Input.Keyboard.Key;
    C: Phaser.Input.Keyboard.Key;
  };
}

let binding: InputBinding | null = null;

/**
 * Bind Phaser input to the player entity. Called once from ArenaScene.create().
 * Re-binding (e.g. on scene restart) replaces the previous binding cleanly.
 */
export function bindInput(scene: Phaser.Scene, playerEid: number): void {
  const kbd = scene.input.keyboard;
  if (!kbd) {
    binding = null;
    return;
  }
  binding = {
    scene,
    playerEid,
    keys: {
      W: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      Up: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      Down: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      Left: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      Right: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      C: kbd.addKey(Phaser.Input.Keyboard.KeyCodes.C),
    },
  };
  // Default: auto-aim on, manual aim off.
  PlayerInput.manualAim[playerEid] = 0;
  PlayerInput.dirX[playerEid] = 0;
  PlayerInput.dirY[playerEid] = 0;
  PlayerInput.aimX[playerEid] = 0;
  PlayerInput.aimY[playerEid] = 0;
}

/** Drop the binding (called on scene shutdown). */
export function unbindInput(): void {
  binding = null;
}

/**
 * Tick the input system. Called first in the tick order.
 * Must not allocate, must not emit events.
 *
 * Skipped while the run is not in the 'playing' phase. ArenaScene already
 * skips the entire system tick in that case; this is a defensive guard so
 * the system is safe to call from anywhere.
 */
export function inputSystem(_world: World, _dt: number): void {
  if (useRunStore.getState().phase !== 'playing') return;
  const b = binding;
  if (!b) return;
  const eid = b.playerEid;
  const k = b.keys;

  // --- direction ---------------------------------------------------------
  // WASD or arrow keys, treated additively. Cardinal directions only here;
  // diagonal normalization happens in movementSystem.
  const right = k.D.isDown || k.Right.isDown ? 1 : 0;
  const left = k.A.isDown || k.Left.isDown ? 1 : 0;
  const down = k.S.isDown || k.Down.isDown ? 1 : 0;
  const up = k.W.isDown || k.Up.isDown ? 1 : 0;
  PlayerInput.dirX[eid] = (right - left) as -1 | 0 | 1;
  PlayerInput.dirY[eid] = (down - up) as -1 | 0 | 1;

  // --- manual-aim toggle -------------------------------------------------
  // Phaser's JustDown detects the rising edge of the C key; flips the bit.
  if (Phaser.Input.Keyboard.JustDown(k.C)) {
    PlayerInput.manualAim[eid] = PlayerInput.manualAim[eid] === 1 ? 0 : 1;
  }

  // --- aim vector --------------------------------------------------------
  // Only update aim while manual-aim is on. When off, leave the last value
  // alone — autoAttack will pick its own target. Aim is normalized so
  // weapons can multiply by speed cleanly.
  if (PlayerInput.manualAim[eid] === 1) {
    const pointer = b.scene.input.activePointer;
    pointer.updateWorldPoint(b.scene.cameras.main);
    const px = Position.x[eid] ?? 0;
    const py = Position.y[eid] ?? 0;
    const dx = pointer.worldX - px;
    const dy = pointer.worldY - py;
    const len = Math.hypot(dx, dy);
    if (len > 0.0001) {
      const inv = 1 / len;
      PlayerInput.aimX[eid] = dx * inv;
      PlayerInput.aimY[eid] = dy * inv;
    }
    // If the cursor is exactly on the player, leave aimX/aimY unchanged.
  }
}
