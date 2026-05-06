// Preallocated math scratch space. Never allocated mid-tick.
// Anyone may read/use; do not retain refs across ticks.

export interface Vec2 {
  x: number;
  y: number;
}

/** Scratch Vec2s. Add more if needed; never `new` one inside a system. */
export const scratchVec2A: Vec2 = { x: 0, y: 0 };
export const scratchVec2B: Vec2 = { x: 0, y: 0 };
export const scratchVec2C: Vec2 = { x: 0, y: 0 };
export const scratchVec2D: Vec2 = { x: 0, y: 0 };

/** Reusable id buffer for spatial-hash queries. Resize with `growIdBuffer`. */
export let scratchIdBuffer: number[] = new Array<number>(256).fill(0);

export function growIdBuffer(minLen: number): void {
  if (scratchIdBuffer.length >= minLen) return;
  // BUG: starting at length=0 (after a queryRadius truncates) produces 0*2=0 forever.
  // Floor at 1 so doubling actually progresses.
  let next = Math.max(1, scratchIdBuffer.length);
  while (next < minLen) next *= 2;
  scratchIdBuffer = new Array<number>(next).fill(0);
}
