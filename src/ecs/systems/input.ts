// Reads Phaser input, writes to PlayerInput component.
// Owner: Agent C1.
//
// Wiring model:
//   ArenaScene.create() calls bindInput(scene, playerEid) once. That captures
//   the Phaser keyboard keys + scene reference into module-local state.
//   inputSystem() then runs every tick, reads them, and writes into the
//   PlayerInput component arrays for the bound player eid.
//
// Sources, in priority order (highest wins for any non-zero axis):
//   1. Touch joystick (virtual on-screen, mobile only)
//   2. Gamepad left stick (when connected, axes past deadzone)
//   3. Keyboard WASD / arrows
//
// PlayerInput.dirX/dirY are i8 (-128..127). Keyboard writes -1/0/1 directly.
// Touch + gamepad scale their [-1, 1] floats to roughly [-100, 100] so the
// magnitude survives the cast — movementSystem only uses direction (it
// normalizes via Math.hypot()), so any non-zero magnitude is fine.
//
// No allocations per tick. No event emissions, except: gamepad Start (button 9)
// emits pause/resume_requested on the rising edge.
import Phaser from 'phaser';
import { PlayerInput, Position } from '../components';
import { useRunStore } from '../../stores/runStore';
import { eventBus } from '../../core/eventBus';
import {
  consumeToggleAim,
  getAim as getTouchAim,
  getMove as getTouchMove,
  isAimActive as isTouchAimActive,
  resetTouchInput,
} from '../../core/touchInput';
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

// --- Gamepad edge-detection state ---------------------------------------------
// We poll navigator.getGamepads() each tick and detect rising edges (button
// transitions from up to down) for Start (pause) and A (accept bargain). The
// previous-state arrays are sparse — index = button id.
const prevButtonDown: boolean[] = [];

/** Stick deadzone — analog drift under this is treated as zero. */
const GAMEPAD_DEADZONE = 0.15;
/** Integer scale applied to analog joystick floats before writing to i8. */
const ANALOG_TO_I8_SCALE = 100;

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
  // Wipe prev-button cache so a held button doesn't fire a phantom edge on
  // scene restart.
  prevButtonDown.length = 0;
}

/** Drop the binding (called on scene shutdown). */
export function unbindInput(): void {
  binding = null;
  prevButtonDown.length = 0;
  // Clear any latched touch state so a held thumb doesn't carry across scene
  // restarts (e.g. after death + restart).
  resetTouchInput();
}

/**
 * Apply deadzone to a single analog axis. Values inside [-d, d] map to 0; values
 * outside re-map to a linear ramp from 0 to ±1 so the cardinals stay smooth.
 */
function applyDeadzone(v: number, dead: number): number {
  if (v > dead) return (v - dead) / (1 - dead);
  if (v < -dead) return (v + dead) / (1 - dead);
  return 0;
}

/**
 * Read the first connected gamepad. Returns null if none. We don't cache the
 * Gamepad object across ticks because some browsers (Firefox) hand out a
 * snapshot each call — the only reliable polling pattern is fresh every tick.
 */
function getActiveGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected) return p;
  }
  return null;
}

/**
 * Tick the input system. Called first in the tick order.
 * Must not allocate, must not emit events (the gamepad Start-button pause is
 * the one exception — it's a rising-edge event, not per-tick).
 *
 * Skipped while the run is not in the 'playing' phase. ArenaScene already
 * skips the entire system tick in that case; this is a defensive guard so
 * the system is safe to call from anywhere.
 */
export function inputSystem(_world: World, _dt: number): void {
  // Phase-gating: most input is only meaningful during 'playing', but the
  // gamepad Start button must still toggle pause from a paused state.
  const phase = useRunStore.getState().phase;
  const b = binding;
  if (!b) return;
  const eid = b.playerEid;
  const k = b.keys;

  // --- gamepad poll (runs in all phases so Start can resume) -----------------
  const pad = getActiveGamepad();
  if (pad) {
    // Start button (index 9 on standard mapping) → toggle pause.
    const startBtn = pad.buttons[9];
    const startDown = !!(startBtn && startBtn.pressed);
    const startWasDown = prevButtonDown[9] === true;
    if (startDown && !startWasDown) {
      if (phase === 'playing') eventBus.emit({ type: 'pause_requested' });
      else if (phase === 'paused') eventBus.emit({ type: 'resume_requested' });
    }
    prevButtonDown[9] = startDown;
  } else {
    // Clear gamepad button cache when no pad is present so a freshly-attached
    // pad with a held button doesn't fire a phantom edge.
    prevButtonDown.length = 0;
  }

  // Now gate the rest on 'playing' — movement/aim are only relevant in-run.
  if (phase !== 'playing') return;

  // --- 1. Keyboard direction (baseline) ------------------------------------
  // WASD or arrow keys, treated additively. Cardinal directions only here;
  // diagonal normalization happens in movementSystem.
  const right = k.D.isDown || k.Right.isDown ? 1 : 0;
  const left = k.A.isDown || k.Left.isDown ? 1 : 0;
  const down = k.S.isDown || k.Down.isDown ? 1 : 0;
  const up = k.W.isDown || k.Up.isDown ? 1 : 0;
  let dirX = right - left;
  let dirY = down - up;

  // --- 2. Gamepad left stick (overrides keyboard if non-zero) --------------
  // Standard mapping: axis 0 = left stick X, axis 1 = left stick Y.
  if (pad) {
    const gx = applyDeadzone(pad.axes[0] ?? 0, GAMEPAD_DEADZONE);
    const gy = applyDeadzone(pad.axes[1] ?? 0, GAMEPAD_DEADZONE);
    if (gx !== 0 || gy !== 0) {
      // Scale [-1, 1] → roughly [-100, 100] so the i8 cast preserves direction.
      dirX = Math.round(gx * ANALOG_TO_I8_SCALE);
      dirY = Math.round(gy * ANALOG_TO_I8_SCALE);
    }

    // Accept-bargain on A (button 0) rising edge — synthesize an 'e' keydown
    // so BargainOverlay's existing handler picks it up without duplication.
    const aBtn = pad.buttons[0];
    const aDown = !!(aBtn && aBtn.pressed);
    const aWasDown = prevButtonDown[0] === true;
    if (aDown && !aWasDown) {
      // Dispatch a synthetic keyboard event 'e' so BargainOverlay reacts.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e' }));
      }
    }
    prevButtonDown[0] = aDown;

    // Y button (index 3) toggles manual aim, mirroring the C key.
    const yBtn = pad.buttons[3];
    const yDown = !!(yBtn && yBtn.pressed);
    const yWasDown = prevButtonDown[3] === true;
    if (yDown && !yWasDown) {
      PlayerInput.manualAim[eid] = PlayerInput.manualAim[eid] === 1 ? 0 : 1;
    }
    prevButtonDown[3] = yDown;
  }

  // --- 3. Touch joystick (highest priority — overrides everything) ---------
  const touchMove = getTouchMove();
  if (touchMove.dx !== 0 || touchMove.dy !== 0) {
    dirX = Math.round(touchMove.dx * ANALOG_TO_I8_SCALE);
    dirY = Math.round(touchMove.dy * ANALOG_TO_I8_SCALE);
  }

  PlayerInput.dirX[eid] = dirX;
  PlayerInput.dirY[eid] = dirY;

  // --- manual-aim toggle ---------------------------------------------------
  // Three sources: keyboard C edge, touch tap pulse, gamepad Y (handled above).
  if (Phaser.Input.Keyboard.JustDown(k.C)) {
    PlayerInput.manualAim[eid] = PlayerInput.manualAim[eid] === 1 ? 0 : 1;
  }
  if (consumeToggleAim()) {
    PlayerInput.manualAim[eid] = PlayerInput.manualAim[eid] === 1 ? 0 : 1;
  }

  // --- aim vector ----------------------------------------------------------
  // Priority for aim direction: touch long-press > gamepad right stick >
  // mouse (only while manual-aim is toggled on). Touch + gamepad write the
  // aim directly (and force manualAim=1 implicitly via the system reading
  // them); the mouse path only runs when manualAim is already toggled on.

  let aimWritten = false;

  // 3a. Touch long-press aim — when the user is holding the right-side circle,
  //     drive aim directly and force manual-aim on so weapons fire that way.
  if (isTouchAimActive()) {
    const a = getTouchAim();
    const len = Math.hypot(a.dx, a.dy);
    if (len > 0.0001) {
      const inv = 1 / len;
      PlayerInput.aimX[eid] = a.dx * inv;
      PlayerInput.aimY[eid] = a.dy * inv;
      PlayerInput.manualAim[eid] = 1;
      aimWritten = true;
    }
  }

  // 3b. Gamepad right stick (axes 2, 3) — if any deflection past deadzone,
  //     write aim and force manualAim on.
  if (!aimWritten && pad) {
    const rx = applyDeadzone(pad.axes[2] ?? 0, GAMEPAD_DEADZONE);
    const ry = applyDeadzone(pad.axes[3] ?? 0, GAMEPAD_DEADZONE);
    if (rx !== 0 || ry !== 0) {
      const len = Math.hypot(rx, ry);
      if (len > 0.0001) {
        const inv = 1 / len;
        PlayerInput.aimX[eid] = rx * inv;
        PlayerInput.aimY[eid] = ry * inv;
        PlayerInput.manualAim[eid] = 1;
        aimWritten = true;
      }
    }
  }

  // 3c. Mouse (only relevant when manualAim is toggled on AND nothing else
  //     wrote aim this tick).
  if (!aimWritten && PlayerInput.manualAim[eid] === 1) {
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
