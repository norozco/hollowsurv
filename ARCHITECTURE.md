# Hollowsurv — Architecture

> Bullet-heaven / survivors-like vertical slice. Phaser 4 + bitECS + Zustand + React 19 + Vite + TS strict.
> This document is the high-level design. For binding API contracts, see `CONTRACTS.md`.

---

## 1. High-level overview

Five subsystems, one direction of data flow per frame.

```
                ┌─────────────────────────────────────────────┐
                │              React 19 (DOM)                 │
                │  HUD · LevelUpPicker · RunSummary · MainMenu │
                └──────▲──────────────────────────────┬───────┘
                       │ subscribes (selectors)        │ dispatches
                       │                               ▼
                ┌──────┴───────────────────────────────────────┐
                │   Zustand stores: runStore + metaStore       │
                │   (single source of truth for UI state)      │
                └──────▲──────────────────────────────┬───────┘
                       │ writes (mutators)             │ reads
                       │                               ▼
                ┌──────┴───────────────────────────────────────┐
                │              EventBus (typed)                 │
                │   enemy_killed · damage_dealt · level_up …    │
                └──────▲──────────────────────────────┬───────┘
                       │ emits                         │ subscribed by
                       │                               ▼
                ┌──────┴───────────────────────────────────────┐
                │   bitECS world (combat entities)              │
                │   Systems: input · movement · flowfield ·     │
                │   spawn · autoAttack · projectile · collision │
                │   · damage · pickup · xp · lifetime · render  │
                └──────▲───────────────────────────────────────┘
                       │ rendered by
                       ▼
                ┌──────────────────────────────────────────────┐
                │  Phaser 4 ArenaScene (SpriteGPULayer)         │
                │  Camera · tilemap bg · sprite layer · FX      │
                └──────────────────────────────────────────────┘
```

**Rules of the flow:**
- ECS systems never read Zustand directly. They emit events.
- React never reads ECS directly. It subscribes to Zustand selectors.
- The EventBus is the only seam between the simulation and the UI/store layer.
- Phaser owns rendering and input. React owns DOM UI. They do not overlap.

---

## 2. Phaser ↔ React boundary

| Concern | Phaser | React |
|---|---|---|
| Player sprite, enemies, projectiles, FX | Yes | No |
| Camera, parallax, particles, screen shake | Yes | No |
| Tilemap arena | Yes | No |
| HUD (HP bar, XP bar, timer, kill count) | No | Yes |
| Level-up picker (3 cards) | No | Yes |
| Pause menu, run summary, main menu | No | Yes |
| Keybind capture (WASD, C, Esc) | Yes (input plugin) | No |

**Rendering layers (z-order, bottom to top):**
1. Phaser canvas (fills viewport, `position: fixed; inset: 0; z-index: 0`)
2. React HUD overlay (`pointer-events: none`, `z-index: 10`)
3. React modal layer (level-up, summary — `pointer-events: auto`, `z-index: 20`, dims canvas with backdrop)

**Pause model:**
- `runStore.phase: 'playing' | 'levelup' | 'paused' | 'won' | 'lost' | 'menu'`
- ArenaScene reads `phase` once per frame from a phaser-side mirror. When `phase !== 'playing'`, the scene calls `scene.scene.pause()` on itself, which freezes systems and tweens. React modals render on top.
- Resume = store transition to `playing`, scene receives the mirror update on next RAF, calls `scene.scene.resume()`.
- The mirror is updated by a single `runStore.subscribe` registered in `main.tsx`. ECS code never reads Zustand.

---

## 3. ECS design (bitECS)

**One world, one tick.** The world is created once per run in `ArenaScene.create()` and destroyed in `shutdown()`.

**Tick order (fixed, see `CONTRACTS.md` for the canonical list):**
1. `inputSystem` — reads Phaser input, writes to PlayerInput component
2. `flowfieldSystem` — recomputes if player crossed a cell boundary
3. `movementSystem` — applies Velocity to Position; enemies sample flowfield
4. `spawnDirectorSystem` — pulls from wave schedule, spawns enemies off-screen
5. `autoAttackSystem` — weapons tick cooldowns, fire when ready
6. `projectileSystem` — projectile-specific behaviors (homing, pierce counter)
7. `collisionSystem` — spatial-hash queries; emits `damage_dealt`
8. `damageSystem` — applies queued damage; emits `enemy_killed` / `player_hit`
9. `pickupSystem` — magnetism, pickup detection; emits `pickup_collected`
10. `xpSystem` — drains pickup events into runStore; emits `level_up` at threshold
11. `lifetimeSystem` — decrements Lifetime, returns dead entities to their pool
12. `renderSystem` — writes Position/Sprite to the SpriteGPULayer

**Entity lifecycle:**

```
spawn  →  acquireFromPool()  →  addEntity(world)  →  attach components  →  active
                                                                              │
                                                                              ▼
despawn ← removeEntity(world) ← clearComponents() ← returnToPool() ← lifetimeSystem / damageSystem
```

- **Acquire**: pool returns a free entity ID; if pool empty, allocate (with a hard cap per entity kind).
- **Spawn**: caller adds components and seeds initial values. Never `new Object()` per spawn — components are flat typed arrays in bitECS.
- **Despawn**: a single helper `recycleEntity(eid, kind)` strips all components, returns ID to the kind's pool.
- **Death is a tag**, not a removal. `damageSystem` adds a `Dead` tag; `lifetimeSystem` recycles tagged entities at the end of the tick to keep iteration safe.

---

## 4. Event bus

A typed pub/sub. Single instance, lives in `src/core/eventBus.ts`. Synchronous dispatch.

**Why an event bus and not direct ECS-to-store calls?**
- **Brotato-style item scaling.** Items subscribe to `on_kill`, `on_hit`, etc. Adding a new item is a new subscriber file — no edits to combat systems.
- **Test seams.** Systems can be unit-tested by inspecting emitted events.
- **UI decoupling.** runStore subscribes once and translates events into state mutations. UI systems never read ECS internals.

**Emit/subscribe rules:**
- Only systems emit. Subscribers are: `runStore` (one master subscriber), item modifiers (per-item file), audio dispatcher (later).
- Events are dispatched immediately and synchronously. No queue. If a handler is slow, that's a bug.
- Event payloads are plain objects but allocated from a per-event-type pool to keep update-loop allocations at zero. The bus reuses the same object across emissions of the same type within a tick — handlers must read fields immediately, not retain the reference.

See `CONTRACTS.md` §2 for the complete `GameEvent` discriminated union.

---

## 5. Zustand stores

Two stores. They never talk to each other. Selectors are stable references.

### 5.1 `runStore` — in-run mutable state

Resets on every run start. Drives HUD and level-up modal. Updated by:
- One master `eventBus` subscriber registered in `ArenaScene.create()` that translates events to mutations.
- React components dispatch via exposed actions (e.g. `pickUpgrade(choice)`).

**Phases:** `'menu' | 'playing' | 'levelup' | 'paused' | 'won' | 'lost'`. Phase transitions are the only way scene/UI coordinate.

### 5.2 `metaStore` — persistent across runs

Backed by `localStorage` under key `hollowsurv.save.v1`. Schema version checked on load; incompatible saves discarded with a console warning, not silently migrated (vertical slice; migrations come later).

**Persistent fields:** total runs, total wins, best run time, weapons unlocked (always all in v1), settings (volume, screen shake on/off), and `schemaVersion: 1`.

**Selector pattern:** components subscribe with stable selectors and shallow compare. Example: `useRunStore(s => s.player.hp)` — never `useRunStore(s => s)`.

See `CONTRACTS.md` §3 for exact `RunState` and `MetaState` interfaces.

---

## 6. Pathfinding (flowfield)

**Arena:** 4096×4096 px. **Grid:** 64×64 cells (cell size = 64 px). Total = 4096 cells.

**Why flowfield not A*:** 500–1000 enemies all targeting one player. A* would mean 1000 path queries; flowfield computes once and every enemy reads its cell's vector in O(1).

**Recompute trigger:**
- Player crosses into a new grid cell (compare `Math.floor(player.x / 64)` to last computed origin).
- Or after 250 ms have elapsed since last compute (catches edge cases like teleport later).

**Algorithm:** BFS from the player cell across the cost grid (uniform cost in v1; obstacles get high cost later). Output: integer `(dx, dy)` direction per cell. Stored as two `Int8Array(4096)`s.

**Movement system reads:**
```
cell = floor(enemy.y / 64) * 64 + floor(enemy.x / 64);
vx = flowfield.dx[cell];   vy = flowfield.dy[cell];
enemy.vx = vx * speed;     enemy.vy = vy * speed;
```

**Fallback:** if `cell` is out of bounds (enemy spawned off-grid), enemy moves toward the player using a normalized direct vector. This also covers the first frame before flowfield is initialized.

---

## 7. Object pools

**Pooled entity kinds:** projectiles (cap 2000), enemies (cap 1500), pickups (cap 1000), damage numbers (cap 200), particle bursts (cap 500).

**Pool churn bound:** caps are hard. If a pool is at cap and acquire is called, the oldest active entity in that pool is force-recycled. This is a deliberate design choice — it caps memory and keeps the worst case predictable. Damage numbers and particles are the only kinds where this is observable; gameplay-affecting kinds (enemies, projectiles) are tuned so cap is never reached during normal play.

**Implementation:** each pool is a `Uint32Array` of entity IDs plus a free-list head index. Acquire pops the head; release pushes it back. No `Array.push` / `Array.shift` in the update loop.

**Non-entity pools:** event payloads (one slot per event type, reused), Vector2 scratch buffers (preallocated in `core/scratch.ts`, never allocated mid-tick).

---

## 8. Save format

**Storage:** `localStorage`, single key `hollowsurv.save.v1`, JSON.

**Shape:**
```json
{
  "schemaVersion": 1,
  "totalRuns": 0,
  "totalWins": 0,
  "bestRunTimeMs": null,
  "settings": { "musicVolume": 0.7, "sfxVolume": 0.8, "screenShake": true },
  "unlocks": { "weapons": ["pistol", "ember_aura"] }
}
```

**Backward-compat policy (v1 only):** on load, if `schemaVersion !== 1`, the save is logged and replaced with a fresh default. v2+ will migrate forward but never break v1 fields.

**Write timing:** debounced 500 ms after any `metaStore` mutation; flushed synchronously on `beforeunload`.

---

## 9. Performance budgets (explicit)

| Budget | Target | Notes |
|---|---|---|
| Frame time | 16.6 ms (60 fps) | Hard target; below 20 ms is acceptable |
| Concurrent enemies | 500 typical, 1000 peak | Above 1000, spawn director throttles |
| Concurrent projectiles | 2000 hard cap | Pool capped |
| Update-loop allocations | 0 bytes/tick | Enforced by code review and a dev-mode allocation sniffer |
| Flowfield recompute | ≤ 2 ms | 4096 cells, BFS, runs only on player cell change |
| Spatial hash rebuild | ≤ 1 ms | Rebuilt every tick; cell size 128 px |
| Render | SpriteGPULayer single batch | All enemies/projectiles in one GL draw |
| GC pauses | ≤ 1 per minute, ≤ 5 ms | Verified via Chrome profiler |
| Bundle size (gzip) | ≤ 500 KB | Phaser is the dominant cost |
| Cold load to playable | ≤ 3 s on mid-range laptop | Vite + code splitting where useful |

---

## 10. Build / dev commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Type-check then produce `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run typecheck` | `tsc --noEmit` against the strict config |
| `npm run lint` | ESLint over `src/` |

**TypeScript config:** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any` in checked-in code; use `unknown` and narrow.

---

## 11. Directory layout (canonical)

```
hollowsurv/
├── ARCHITECTURE.md
├── CONTRACTS.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
└── src/
    ├── main.tsx                  # entry: mounts React + boots Phaser
    ├── core/
    │   ├── eventBus.ts           # typed pub/sub
    │   ├── pool.ts               # generic entity pool
    │   ├── spatialHash.ts        # broad-phase queries
    │   ├── flowfield.ts          # grid + BFS
    │   └── scratch.ts            # preallocated math scratch
    ├── ecs/
    │   ├── world.ts              # bitECS world creation
    │   ├── components.ts         # ALL components (single file, see CONTRACTS.md)
    │   └── systems/
    │       ├── input.ts
    │       ├── movement.ts
    │       ├── flowfield.ts
    │       ├── spawnDirector.ts
    │       ├── autoAttack.ts
    │       ├── projectile.ts
    │       ├── collision.ts
    │       ├── damage.ts
    │       ├── pickup.ts
    │       ├── xp.ts
    │       ├── lifetime.ts
    │       ├── camera.ts
    │       └── render.ts
    ├── content/
    │   ├── weapons.ts            # weapon definitions (data)
    │   ├── enemies.ts            # enemy archetype definitions
    │   ├── waves.ts              # 10-minute wave schedule
    │   └── upgrades.ts           # level-up choices
    ├── scenes/
    │   ├── BootScene.ts
    │   └── ArenaScene.ts
    ├── stores/
    │   ├── runStore.ts
    │   └── metaStore.ts
    └── react/
        ├── App.tsx
        └── screens/
            ├── HUD.tsx
            ├── LevelUpPicker.tsx
            ├── RunSummary.tsx
            └── MainMenu.tsx
```

This layout is **the source of truth for file ownership in `CONTRACTS.md` §5.** Adding a top-level folder requires a contract change.
