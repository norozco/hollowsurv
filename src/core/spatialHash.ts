// Uniform-grid spatial hash for broad-phase queries.
// See ARCHITECTURE.md §9 (1ms rebuild budget per tick) and §3 (collisionSystem).
//
// Design:
//   - Entities live in cells keyed by `cellY * MAX_X + cellX` where MAX_X is large
//     enough that cell ids never collide for arena positions in the supported range.
//   - `clear()` truncates each bucket array (`length = 0`) — cheaper than reallocating.
//   - Bucket arrays are reused tick-to-tick; allocation only happens when a previously
//     untouched cell is first populated.
//   - `queryRadius` writes ids to a caller-provided array (also truncated then filled)
//     so the hot path doesn't allocate.
//   - `nearest` reuses the same scan to find the closest entity within maxDist.
//
// We need entity x,y stored alongside ids for the radius/distance check. Two
// parallel buckets per cell (ids[] and a single positions Float32Array keyed by eid)
// would be one option, but we must support entities being inserted multiple times
// and avoid retaining state across clear(). Simplest: store {eid, x, y} tuples
// flat in three parallel arrays per cell — keeps allocation amortized to zero.

const DEFAULT_CELL_PX = 128;

// Pick a MAX_X large enough that a cellX of up to ~32k can't collide with cellY * MAX_X.
// Arena is 4096x4096 px; cell size 128 -> 32 cells per axis. We give plenty of headroom
// in case caps grow (e.g. a 16k arena would still fit comfortably).
const MAX_X = 65_536;

interface Bucket {
  ids: number[];
  xs: number[];
  ys: number[];
}

function newBucket(): Bucket {
  return { ids: [], xs: [], ys: [] };
}

export class SpatialHash {
  readonly cellPx: number;
  private readonly invCellPx: number;
  private readonly cells: Map<number, Bucket> = new Map();
  /**
   * Touched cell keys this tick. We walk this on `clear()` to truncate buckets
   * without rebuilding the Map. The Map's bucket objects are kept alive between
   * clears so their backing arrays grow to a steady state.
   */
  private readonly touched: number[] = [];

  constructor(cellPx: number = DEFAULT_CELL_PX) {
    this.cellPx = cellPx;
    this.invCellPx = 1 / cellPx;
  }

  /** Wipe all cells. O(touched). Bucket arrays are reused. */
  clear(): void {
    const cells = this.cells;
    const touched = this.touched;
    for (let i = 0; i < touched.length; i++) {
      const key = touched[i]!;
      const bucket = cells.get(key);
      if (bucket) {
        bucket.ids.length = 0;
        bucket.xs.length = 0;
        bucket.ys.length = 0;
      }
    }
    touched.length = 0;
  }

  /** Add an entity to the cell containing (x, y). */
  insert(eid: number, x: number, y: number): void {
    const cx = Math.floor(x * this.invCellPx);
    const cy = Math.floor(y * this.invCellPx);
    const key = cy * MAX_X + cx;
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = newBucket();
      this.cells.set(key, bucket);
      this.touched.push(key);
    } else if (bucket.ids.length === 0) {
      // Existing bucket but empty since last clear — re-mark as touched.
      this.touched.push(key);
    }
    bucket.ids.push(eid);
    bucket.xs.push(x);
    bucket.ys.push(y);
  }

  /**
   * Fill `out` with entity ids whose stored position is within `r` of (x, y).
   * `out` is truncated first; caller pre-allocates.
   */
  queryRadius(x: number, y: number, r: number, out: number[]): void {
    out.length = 0;
    const cellPx = this.cellPx;
    const minCx = Math.floor((x - r) * this.invCellPx);
    const maxCx = Math.floor((x + r) * this.invCellPx);
    const minCy = Math.floor((y - r) * this.invCellPx);
    const maxCy = Math.floor((y + r) * this.invCellPx);
    const r2 = r * r;
    const cells = this.cells;
    for (let cy = minCy; cy <= maxCy; cy++) {
      const row = cy * MAX_X;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = cells.get(row + cx);
        if (!bucket) continue;
        const ids = bucket.ids;
        const xs = bucket.xs;
        const ys = bucket.ys;
        const n = ids.length;
        for (let i = 0; i < n; i++) {
          const dx = xs[i]! - x;
          const dy = ys[i]! - y;
          if (dx * dx + dy * dy <= r2) out.push(ids[i]!);
        }
      }
    }
    // cellPx is referenced for clarity in derivations above; suppress unused-var noise.
    void cellPx;
  }

  /**
   * Closest entity id within `maxDist` of (x, y), or -1 if none.
   * Searches expanding rings only as far as needed.
   */
  nearest(x: number, y: number, maxDist: number): number {
    const minCx = Math.floor((x - maxDist) * this.invCellPx);
    const maxCx = Math.floor((x + maxDist) * this.invCellPx);
    const minCy = Math.floor((y - maxDist) * this.invCellPx);
    const maxCy = Math.floor((y + maxDist) * this.invCellPx);
    const cells = this.cells;
    let bestEid = -1;
    let bestD2 = maxDist * maxDist;
    for (let cy = minCy; cy <= maxCy; cy++) {
      const row = cy * MAX_X;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = cells.get(row + cx);
        if (!bucket) continue;
        const ids = bucket.ids;
        const xs = bucket.xs;
        const ys = bucket.ys;
        const n = ids.length;
        for (let i = 0; i < n; i++) {
          const dx = xs[i]! - x;
          const dy = ys[i]! - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestEid = ids[i]!;
          }
        }
      }
    }
    return bestEid;
  }

  // --- Back-compat shim for the original factory-shaped interface. ----------
  // Existing callers expected `query(x, y, r, out): number` returning the count.
  /** Back-compat: same as queryRadius but returns the number of ids written. */
  query(x: number, y: number, r: number, out: number[]): number {
    this.queryRadius(x, y, r, out);
    return out.length;
  }
}

// Factory + interface kept for back-compat with the scaffold. The factory now
// returns the class instance (which structurally satisfies the old interface).
export interface SpatialHashLike {
  clear(): void;
  insert(eid: number, x: number, y: number, radius?: number): void;
  query(x: number, y: number, radius: number, out: number[]): number;
  queryRadius(x: number, y: number, r: number, out: number[]): void;
  nearest(x: number, y: number, maxDist: number): number;
}

export function createSpatialHash(cellPx: number = DEFAULT_CELL_PX): SpatialHashLike {
  const hash = new SpatialHash(cellPx);
  return {
    clear: () => hash.clear(),
    // The scaffold's original signature accepted a radius arg. The radius is unused
    // by the spatial hash itself (only the point matters); we accept and ignore it.
    insert: (eid: number, x: number, y: number, _radius?: number) => hash.insert(eid, x, y),
    query: (x: number, y: number, r: number, out: number[]) => hash.query(x, y, r, out),
    queryRadius: (x: number, y: number, r: number, out: number[]) => hash.queryRadius(x, y, r, out),
    nearest: (x: number, y: number, maxDist: number) => hash.nearest(x, y, maxDist),
  };
}

export const SPATIAL_CELL_PX = DEFAULT_CELL_PX;
