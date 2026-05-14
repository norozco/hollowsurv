// Touch input bridge — a small singleton that lets the React-rendered virtual
// joystick communicate movement + aim vectors to the ECS input system without
// either side knowing about the other.
//
// Why a singleton: TouchControls.tsx lives in React land and is mounted by
// App.tsx. inputSystem() lives in ECS land and runs every Phaser tick. The two
// sides don't share a store (touch state would thrash any Zustand store with
// per-frame updates), so we use a tiny mutable module-level state object.
//
// Contract:
//   - TouchControls calls setMove(dx, dy) on touchmove (values in [-1, 1])
//   - TouchControls calls setMove(0, 0) on touchend / cancel
//   - TouchControls calls setManualAim(active, aimX, aimY) for the right-side
//     aim circle. active=true while a long touch is held; aimX/aimY are
//     normalized direction vectors. tapToggleAim() flips the "C" toggle for a
//     short tap (the input system reads consumeToggleAim() once per tick).
//   - inputSystem calls getMove() / getAim() / isAimActive() / consumeToggleAim()
//     each tick and applies them with priority over keyboard if non-zero.
//
// No allocations per tick — the singleton holds the same scalar fields,
// inputSystem reads them by value.

export interface TouchVector {
  dx: number;
  dy: number;
}

interface TouchInputState {
  // Movement (left joystick).
  moveX: number; // normalized [-1, 1]
  moveY: number; // normalized [-1, 1]
  // Aim (right touch area).
  aimActive: boolean; // true while a long-touch aim is being held
  aimX: number; // normalized [-1, 1]
  aimY: number; // normalized [-1, 1]
  // One-shot "toggle manual aim" pulse (consumed once per tick).
  toggleAimPending: boolean;
}

const state: TouchInputState = {
  moveX: 0,
  moveY: 0,
  aimActive: false,
  aimX: 0,
  aimY: 0,
  toggleAimPending: false,
};

/**
 * Feature detect: are we on a device that exposes touch events at all?
 * Used by TouchControls.tsx to decide whether to mount the overlay, and by
 * inputSystem to short-circuit gracefully on non-touch devices.
 */
export function hasTouch(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0)
  );
}

/** Called by TouchControls each touchmove. Values must be pre-clamped to [-1, 1]. */
export function setMove(dx: number, dy: number): void {
  state.moveX = dx;
  state.moveY = dy;
}

/** Called by TouchControls when the left-joystick touch ends. */
export function clearMove(): void {
  state.moveX = 0;
  state.moveY = 0;
}

/** Returns the current move vector. Read by inputSystem each tick. */
export function getMove(): TouchVector {
  return { dx: state.moveX, dy: state.moveY };
}

/**
 * Push the right-side long-touch aim vector. dirX/dirY should be pre-normalized
 * direction (unit length) — TouchControls computes this from the touch offset.
 * Pass active=false to deactivate (touchend on the right side, or short tap).
 */
export function setAim(active: boolean, dirX: number, dirY: number): void {
  state.aimActive = active;
  state.aimX = dirX;
  state.aimY = dirY;
}

/** Returns the current aim vector (only meaningful while isAimActive() is true). */
export function getAim(): TouchVector {
  return { dx: state.aimX, dy: state.aimY };
}

/** True if a long-touch aim is being held. */
export function isAimActive(): boolean {
  return state.aimActive;
}

/**
 * Flag a one-shot manual-aim toggle (equivalent to pressing C). Consumed by
 * inputSystem on the next tick via consumeToggleAim().
 */
export function tapToggleAim(): void {
  state.toggleAimPending = true;
}

/**
 * Reads + clears the pending manual-aim toggle. Returns true if a tap was
 * registered since the last call. inputSystem calls this once per tick.
 */
export function consumeToggleAim(): boolean {
  if (state.toggleAimPending) {
    state.toggleAimPending = false;
    return true;
  }
  return false;
}

/** Reset everything — used on scene shutdown / page unload defensively. */
export function resetTouchInput(): void {
  state.moveX = 0;
  state.moveY = 0;
  state.aimActive = false;
  state.aimX = 0;
  state.aimY = 0;
  state.toggleAimPending = false;
}
