// Flowfield: BFS-derived (dx, dy) per grid cell pointing toward player.
// Implementation owner: Agent C2.
//
// See ARCHITECTURE.md §6 for the design.
//   Grid: 64x64 cells over the 4096x4096 arena. 64 px per cell, 4096 cells total.
//   Per cell:
//     - integration cost (uint16) — Manhattan-equivalent distance from goal in cell units.
//     - direction (Int8 dx, Int8 dy) drawn from {-1, 0, 1}, pointing to the lowest-cost
//       neighbour. Diagonal moves are allowed when both axis-aligned neighbours are reachable
//       (avoids zig-zagging when an enemy approaches at 45 degrees).
//
// The recompute is BFS (uniform cost in v1) using a preallocated ring buffer so the hot
// path never allocates. ARCHITECTURE.md §9 budgets <= 2 ms for 4096 cells; in practice the
// loop visits each cell exactly once and reads four neighbours.

export const ARENA_SIZE_PX = 4096;
export const FLOWFIELD_CELL_PX = 64;
export const FLOWFIELD_GRID_DIM = ARENA_SIZE_PX / FLOWFIELD_CELL_PX; // 64
export const FLOWFIELD_CELL_COUNT = FLOWFIELD_GRID_DIM * FLOWFIELD_GRID_DIM; // 4096

/** Sentinel for "unvisited" cells in the cost grid. Picked so that any real cost is smaller. */
const COST_INFINITY = 0xffff;

export interface Flowfield {
  /** Direction X per cell, integer in {-1, 0, 1}. Stored as Int8 for compactness. */
  readonly dx: Int8Array;
  /** Direction Y per cell, integer in {-1, 0, 1}. */
  readonly dy: Int8Array;
  /** Integration cost (cells from goal). 0xffff means unreachable / unvisited. */
  readonly cost: Uint16Array;
  /** Last-computed origin cell index (player cell at last recompute). */
  originCell: number;
  /** performance.now() at last recompute. */
  lastComputeMs: number;
}

/**
 * BFS frontier scratch. Reused across recomputes to keep allocations to zero
 * after the first call. Sized for the worst case: every cell enqueued exactly
 * once (4096 entries).
 *
 * Module-level so a single shared buffer covers all `Flowfield` instances. We
 * only have one active flowfield per scene, so no contention.
 */
const _frontier = new Uint16Array(FLOWFIELD_CELL_COUNT);

export function createFlowfield(): Flowfield {
  return {
    dx: new Int8Array(FLOWFIELD_CELL_COUNT),
    dy: new Int8Array(FLOWFIELD_CELL_COUNT),
    cost: new Uint16Array(FLOWFIELD_CELL_COUNT),
    originCell: -1,
    lastComputeMs: 0,
  };
}

/** Convert world (x,y) to cell index, or -1 if out of bounds. */
export function worldToCell(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= ARENA_SIZE_PX || y >= ARENA_SIZE_PX) return -1;
  const cx = Math.floor(x / FLOWFIELD_CELL_PX);
  const cy = Math.floor(y / FLOWFIELD_CELL_PX);
  return cy * FLOWFIELD_GRID_DIM + cx;
}

/**
 * Recompute the flowfield with BFS originating at the given cell.
 *
 * Algorithm (uniform cost; obstacle support comes later):
 *   1. Reset cost to COST_INFINITY for every cell.
 *   2. Seed frontier with originCell at cost 0.
 *   3. Pop, look at four cardinal neighbours: if their cost > current+1, set and enqueue.
 *   4. Once costs are settled, walk every cell and write (dx, dy) pointing toward the
 *      neighbour with the lowest cost. Diagonals are emitted when both perpendicular
 *      axis-aligned neighbours have lower cost than the cell itself.
 *
 * No allocations in steady state — `_frontier` is reused, `cost` is a typed array on the
 * field itself.
 */
export function recomputeFlowfield(field: Flowfield, originCell: number): void {
  if (originCell < 0 || originCell >= FLOWFIELD_CELL_COUNT) {
    // Invalid origin (player out of grid). Leave the previous field intact;
    // enemies fall back to "head toward player" via the fallback path in the system.
    return;
  }

  const cost = field.cost;
  const dim = FLOWFIELD_GRID_DIM;

  // 1. Wipe costs. Uint16Array.fill is well-optimised in V8.
  cost.fill(COST_INFINITY);

  // 2. Seed BFS.
  cost[originCell] = 0;
  _frontier[0] = originCell;
  let head = 0;
  let tail = 1;

  // 3. Standard 4-connected BFS.
  while (head < tail) {
    const cell = _frontier[head++]!;
    const c = cost[cell]!;
    const next = c + 1;

    const cx = cell % dim;
    const cy = (cell - cx) / dim;

    // North.
    if (cy > 0) {
      const n = cell - dim;
      if (cost[n]! > next) {
        cost[n] = next;
        _frontier[tail++] = n;
      }
    }
    // South.
    if (cy < dim - 1) {
      const s = cell + dim;
      if (cost[s]! > next) {
        cost[s] = next;
        _frontier[tail++] = s;
      }
    }
    // West.
    if (cx > 0) {
      const w = cell - 1;
      if (cost[w]! > next) {
        cost[w] = next;
        _frontier[tail++] = w;
      }
    }
    // East.
    if (cx < dim - 1) {
      const e = cell + 1;
      if (cost[e]! > next) {
        cost[e] = next;
        _frontier[tail++] = e;
      }
    }
  }

  // 4. Derive directions.
  const dx = field.dx;
  const dy = field.dy;
  for (let cell = 0; cell < FLOWFIELD_CELL_COUNT; cell++) {
    const cx = cell % dim;
    const cy = (cell - cx) / dim;
    const c = cost[cell]!;

    if (c === 0) {
      // Goal cell — no direction.
      dx[cell] = 0;
      dy[cell] = 0;
      continue;
    }
    if (c === COST_INFINITY) {
      // Unreachable. In a uniform-cost field this shouldn't happen, but keep
      // the cell pointing nowhere so movement falls through to the fallback.
      dx[cell] = 0;
      dy[cell] = 0;
      continue;
    }

    // Inspect axis-aligned neighbours: pick the one with the lowest cost.
    // Pull both axes independently so diagonals emerge naturally when both
    // perpendicular neighbours have lower cost.
    let bestX = 0;
    let bestY = 0;

    if (cx > 0 && cost[cell - 1]! < c) bestX = -1;
    if (cx < dim - 1) {
      const eCost = cost[cell + 1]!;
      // Prefer the axis-aligned neighbour with the strictly lowest cost. If
      // east beats whatever we picked for west (or beats current), switch.
      if (bestX === 0) {
        if (eCost < c) bestX = 1;
      } else {
        const wCost = cost[cell - 1]!;
        if (eCost < wCost) bestX = 1;
      }
    }

    if (cy > 0 && cost[cell - dim]! < c) bestY = -1;
    if (cy < dim - 1) {
      const sCost = cost[cell + dim]!;
      if (bestY === 0) {
        if (sCost < c) bestY = 1;
      } else {
        const nCost = cost[cell - dim]!;
        if (sCost < nCost) bestY = 1;
      }
    }

    dx[cell] = bestX;
    dy[cell] = bestY;
  }

  field.originCell = originCell;
  field.lastComputeMs = performance.now();
}
