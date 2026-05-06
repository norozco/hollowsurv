# Hollowsurv — Contracts

> **Binding API for parallel implementation agents.** Every type, event, store shape, and file partition listed here is a hard contract.
> Violating a contract = breaking another agent's code. If a contract is wrong, change this file in a focused PR; do not work around it.

---

## 1. bitECS components

All components live in **`src/ecs/components.ts`**. Single file, single source of truth. Adding a component = editing this file = contract change.

```ts
import { defineComponent, Types } from 'bitecs';

// --- spatial ----------------------------------------------------------------

// World coordinates in pixels. (0,0) = top-left of arena. Arena is 4096x4096.
export const Position = defineComponent({ x: Types.f32, y: Types.f32 });

// Pixels per second. Movement system applies dt scaling.
export const Velocity = defineComponent({ vx: Types.f32, vy: Types.f32 });

// Radius for circle-circle collision (no rotation). In pixels.
export const Hitbox = defineComponent({ radius: Types.f32 });

// --- combat -----------------------------------------------------------------

export const Health = defineComponent({ hp: Types.f32, maxHp: Types.f32 });

// Flat damage on contact / on hit. Mitigation later.
export const Damage = defineComponent({ amount: Types.f32 });

// Movement / attack speed multipliers (1.0 = baseline). Multiplied per tick.
export const Stats = defineComponent({
  moveSpeedMul: Types.f32,
  attackSpeedMul: Types.f32,
  damageMul: Types.f32,
  pickupRadiusMul: Types.f32,
});

// --- lifecycle --------------------------------------------------------------

// Time-to-live in milliseconds. lifetimeSystem decrements; recycles at <= 0.
export const Lifetime = defineComponent({ remainingMs: Types.f32 });

// Tag set by damageSystem when hp <= 0. lifetimeSystem recycles at end of tick.
export const Dead = defineComponent();

// Tracks which pool kind this entity came from. Used by recycleEntity().
// Values come from PoolKind enum in src/core/pool.ts.
export const Pooled = defineComponent({ kind: Types.ui8 });

// --- rendering --------------------------------------------------------------

// Index into the SpriteGPULayer sprite atlas. Owned by render.ts.
export const Sprite = defineComponent({
  textureIndex: Types.ui16,  // which atlas frame
  tint: Types.ui32,           // 0xRRGGBB; 0xFFFFFF = no tint
  scale: Types.f32,           // 1.0 = native size
  rotation: Types.f32,        // radians; 0 = facing right
});

// --- player / weapons -------------------------------------------------------

export const PlayerTag = defineComponent();

// Player input snapshot, written by inputSystem each tick.
// dirX/dirY are -1 / 0 / 1 (WASD); aimX/aimY are normalized (-1..1) for manual aim.
// manualAim: 1 = on (C toggled), 0 = off (auto-aim nearest).
export const PlayerInput = defineComponent({
  dirX: Types.i8, dirY: Types.i8,
  aimX: Types.f32, aimY: Types.f32,
  manualAim: Types.ui8,
});

// One slot per equipped weapon. Up to 6 slots. Index into content/weapons.ts by weaponId.
// weaponId is a ui16 mapped to string at content load (avoids string storage in ECS).
export const WeaponSlot = defineComponent({
  weaponId: Types.ui16,
  level: Types.ui8,
  cooldownMs: Types.f32,        // remaining ms until next fire
  evolved: Types.ui8,           // 0 / 1
});

// --- enemies / projectiles --------------------------------------------------

export const EnemyTag = defineComponent();
export const BossTag = defineComponent();
export const ProjectileTag = defineComponent();

// Projectile-specific behavior data.
// pierce: how many enemies it can hit before recycling. -1 = infinite.
// ownerEid: who fired it (for kill credit + on_kill events).
// homing: 0 / 1; if 1, projectileSystem nudges velocity toward nearest enemy.
export const Projectile = defineComponent({
  pierce: Types.i8,
  ownerEid: Types.ui32,
  homing: Types.ui8,
});

// XP / pickup orbs.
// kind: 0 = xp, 1 = gold, 2 = heal (matches GameEvent.pickup_collected.kind).
// value: xp amount or gold amount or hp restored.
// magnetized: 0 / 1; if 1, pickupSystem accelerates toward player ignoring physics.
export const Pickup = defineComponent({
  kind: Types.ui8,
  value: Types.f32,
  magnetized: Types.ui8,
});

export const XPValue = defineComponent({ amount: Types.f32 });
```

**Naming rules:**
- Component name: `PascalCase`, singular noun.
- Tag components (no fields): suffix `Tag` (e.g. `EnemyTag`).
- Field name: `camelCase`. No abbreviations except standard math (`vx`, `dx`, `hp`).

**Forbidden:**
- No string fields in components (bitECS doesn't support them; map at the boundary).
- No reference fields. If you need a "pointer" to another entity, store its `eid` as `Types.ui32`.
- No nested components. Flatten or split.

---

## 2. Event bus

Single typed pub/sub in **`src/core/eventBus.ts`**. Synchronous, allocation-free.

```ts
export type GameEvent =
  | { type: 'enemy_killed'; enemy: number; killer: number; position: { x: number; y: number } }
  | { type: 'damage_dealt'; target: number; source: number; amount: number; isCrit: boolean }
  | { type: 'player_hit'; amount: number; sourceEid: number }
  | { type: 'level_up'; newLevel: number }
  | { type: 'pickup_collected'; entity: number; kind: 'xp' | 'gold' | 'heal'; value: number }
  | { type: 'weapon_fired'; weaponId: string; source: number; targetEid: number }
  | { type: 'projectile_spawned'; projectile: number; weaponId: string }
  | { type: 'wave_started'; waveIndex: number; timeMs: number }
  | { type: 'boss_spawned'; boss: number }
  | { type: 'run_won'; timeMs: number; level: number; kills: number }
  | { type: 'run_lost'; timeMs: number; level: number; kills: number }
  | { type: 'upgrade_chosen'; choiceId: string }
  | { type: 'pause_requested' }
  | { type: 'resume_requested' };

export interface EventBus {
  emit<T extends GameEvent>(event: T): void;
  on<K extends GameEvent['type']>(
    type: K,
    handler: (event: Extract<GameEvent, { type: K }>) => void
  ): () => void;  // returns unsubscribe
  off(type: GameEvent['type'], handler: (e: GameEvent) => void): void;
  clear(): void;  // called on scene shutdown
}
```

**Handler rules:**
- Handlers are synchronous. No `await` inside.
- Handlers must not emit recursively for the same event type (no loops). Cross-type emission is fine.
- Event payloads are pooled and reused. **Read fields, do not retain the event reference.**

**Naming rule:** event type strings are `snake_case` past tense (`enemy_killed`, not `killEnemy`). Verbs: `_killed`, `_hit`, `_spawned`, `_collected`, `_fired`, `_chosen`, `_started`, `_requested`.

---

## 3. Zustand store shapes

### 3.1 `runStore` — `src/stores/runStore.ts`

```ts
export type RunPhase = 'menu' | 'playing' | 'levelup' | 'paused' | 'won' | 'lost';

export interface UpgradeChoice {
  id: string;                   // unique per choice instance
  kind: 'new_weapon' | 'level_weapon' | 'augment';
  title: string;
  description: string;
  weaponId?: string;            // present when kind != 'augment'
  rarity: 'common' | 'rare' | 'epic';
}

export interface RunState {
  // phase / lifecycle
  phase: RunPhase;
  runStartedAtMs: number;       // performance.now() at start
  elapsedMs: number;            // updated each tick by ArenaScene

  // player
  player: {
    eid: number;                // ECS entity id, or -1 if not spawned
    hp: number;
    maxHp: number;
    level: number;
    xp: number;
    xpToNext: number;
    weapons: { id: string; level: number; evolved: boolean }[];
  };

  // run stats
  kills: number;
  bossKilled: boolean;

  // level-up modal
  pendingChoices: UpgradeChoice[];   // length 0 or 3

  // actions
  startRun: () => void;
  endRun: (outcome: 'won' | 'lost') => void;
  setPhase: (phase: RunPhase) => void;
  pickUpgrade: (choiceId: string) => void;
  // internal — called by event-bus translator only
  _applyEvent: (event: GameEvent) => void;
}
```

### 3.2 `metaStore` — `src/stores/metaStore.ts`

```ts
export interface MetaState {
  schemaVersion: 1;
  totalRuns: number;
  totalWins: number;
  bestRunTimeMs: number | null;

  settings: {
    musicVolume: number;        // 0..1
    sfxVolume: number;          // 0..1
    screenShake: boolean;
  };

  unlocks: {
    weapons: string[];          // weaponIds always available; in v1 holds all weapons
  };

  // actions
  recordRunCompletion: (outcome: 'won' | 'lost', timeMs: number) => void;
  setMusicVolume: (v: number) => void;
  setSfxVolume: (v: number) => void;
  setScreenShake: (b: boolean) => void;
  resetAll: () => void;
}
```

**Selector rule:** every component selects with a stable function and `shallow` equality where the slice is an object. Never `useStore(s => s)`.

---

## 4. Weapon data schema

**File:** `src/content/weapons.ts`. Pure data, no Phaser/React imports. Behavior functions are pure given world + dt.

```ts
import type { IWorld } from 'bitecs';

export type WeaponArchetype = 'auto_projectile' | 'aura';

export interface WeaponLevelEffect {
  level: number;                // 1..8
  damage: number;
  cooldownMs: number;
  projectileSpeed?: number;     // archetype: auto_projectile
  projectileCount?: number;
  pierce?: number;              // -1 = infinite
  homing?: boolean;
  radius?: number;              // archetype: aura
  tickRateMs?: number;          // aura damage tick interval
  description: string;
}

export interface WeaponDefinition {
  id: string;                   // kebab-case, unique
  name: string;
  archetype: WeaponArchetype;
  baseDamage: number;
  baseCooldownMs: number;
  levels: WeaponLevelEffect[];  // length 8

  // Evolution (Vampire Survivors style). Optional.
  evolvesTo?: string;           // weaponId of the evolved form
  evolveRequires?: {
    weaponMaxLevel: true;       // base weapon must be level 8
    pairedAugmentId: string;    // augment id that must be owned
    minRunTimeMs?: number;      // commonly 600000 (10 min)
  };

  // Behavior. Called by autoAttackSystem when cooldown reaches 0.
  // Must return number of ms until next allowed fire (typically baseCooldownMs * speedMul).
  // MUST NOT allocate. Spawn projectiles via pool.acquireProjectile().
  behavior: (
    world: IWorld,
    ownerEid: number,
    levelIndex: number,
    deltaMs: number
  ) => number;
}

export const WEAPONS: Record<string, WeaponDefinition> = {
  // populated by content agent; vertical slice ships 'pistol' + 'ember_aura'.
};
```

**Augments and upgrades** live in `src/content/upgrades.ts` with the matching shape — defined by Agent C5 as part of the level-up flow.

---

## 5. File ownership / agent partitions

**Strict.** If your task touches a file outside your partition, raise it as a blocker — do not edit.

| Agent | Owns (full write) | Reads only | Forbidden |
|---|---|---|---|
| **C1 — Movement & Camera** | `src/ecs/systems/input.ts`, `src/ecs/systems/movement.ts`, `src/ecs/systems/camera.ts`, `src/scenes/ArenaScene.ts`, `src/scenes/BootScene.ts`, `src/main.tsx` (Phaser boot only) | `src/ecs/components.ts`, `src/core/*`, `src/stores/runStore.ts` (phase mirror) | flowfield, combat, content, react/* (except mounting) |
| **C2 — Flowfield & Spawn** | `src/ecs/systems/flowfield.ts`, `src/ecs/systems/spawnDirector.ts`, `src/core/flowfield.ts`, `src/content/waves.ts`, `src/content/enemies.ts` | `src/ecs/components.ts`, `src/core/pool.ts`, `src/core/spatialHash.ts` | player, combat systems, weapons, projectiles, react/* |
| **C3 — Combat** | `src/ecs/systems/autoAttack.ts`, `src/ecs/systems/projectile.ts`, `src/ecs/systems/collision.ts`, `src/ecs/systems/damage.ts`, `src/ecs/systems/lifetime.ts`, `src/content/weapons.ts`, `src/core/spatialHash.ts` | `src/ecs/components.ts`, `src/core/pool.ts`, `src/core/eventBus.ts` | player input, flowfield, pickups, xp, react/* |
| **C4 — Pickups & XP** | `src/ecs/systems/pickup.ts`, `src/ecs/systems/xp.ts` | `src/ecs/components.ts`, `src/core/eventBus.ts`, `src/stores/runStore.ts` (read action signatures only) | combat systems, weapons, content/waves, react/* |
| **C5 — Level-up flow & UI** | `src/react/App.tsx`, `src/react/screens/HUD.tsx`, `src/react/screens/LevelUpPicker.tsx`, `src/react/screens/RunSummary.tsx`, `src/react/screens/MainMenu.tsx`, `src/stores/runStore.ts`, `src/stores/metaStore.ts`, `src/content/upgrades.ts` | event bus types, weapon definitions | every file under `src/ecs/`, `src/scenes/`, `src/core/` (except types) |

**Shared but reserved files** (any agent may read; only listed owner may write):
- `src/ecs/components.ts` — coordinated edit only. If you need a new component, post the diff and pause.
- `src/core/eventBus.ts` — types live here. If you need a new event, edit this file with a one-line diff and notify others.
- `src/core/pool.ts` — Agent C3 owns the implementation. C1/C2/C4 may add `acquireFoo` / `releaseFoo` helpers via additive PRs; no rewrites.
- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` — touched only at scaffold time; locked thereafter.

**Coordination protocol when an edit crosses partitions:**
1. Open a one-paragraph rationale in the PR description.
2. Tag the owning agent.
3. Do not merge until owner ACKs.

---

## 6. Scene lifecycle

**`BootScene`** runs once at app start. Loads atlas, weapon icons, audio. Transitions to `MainMenu` (React) by setting `runStore.phase = 'menu'`.

**`ArenaScene`** is created when `runStore.phase` transitions `menu → playing`.

```
ArenaScene.create():
  - create bitECS world
  - register single eventBus → runStore translator
  - register one runStore subscriber that mirrors `phase` to a local boolean
  - spawn player entity (PlayerTag, Position at arena center, Health, default WeaponSlot[0] = 'pistol')
  - initialize flowfield (recompute at player cell)
  - prime spawn director with content/waves.ts schedule
  - call scene.scene.run() — first tick begins

ArenaScene.update(time, delta):
  - if mirrored phase !== 'playing': return early (scene paused but kept in memory)
  - run system tick order (see ARCHITECTURE.md §3)

ArenaScene.shutdown():  // called on phase transition out of playing/levelup/paused into menu
  - eventBus.clear()
  - destroy bitECS world (release pools)
  - unsubscribe runStore mirror
```

**Pause:**
- React-driven (Esc key handled by global listener that emits `pause_requested`; runStore translator sets `phase = 'paused'`).
- Level-up modal sets `phase = 'levelup'` (xp system emits `level_up` → translator switches phase).
- ArenaScene checks the phase mirror at the top of `update()`. While not `'playing'`, the entire system tick is skipped.
- Resume: store transitions back to `'playing'`; next RAF the mirror updates and the tick resumes.

---

## 7. Naming conventions

| Kind | Convention | Example |
|---|---|---|
| ECS system file | `camelCase.ts` | `autoAttack.ts` |
| ECS system function | `camelCaseSystem` | `autoAttackSystem` |
| ECS component | `PascalCase` | `Position`, `EnemyTag` |
| ECS component field | `camelCase` | `vx`, `cooldownMs`, `maxHp` |
| Event type string | `snake_case past_tense` | `enemy_killed`, `weapon_fired` |
| React component file | `PascalCase.tsx` | `LevelUpPicker.tsx` |
| Zustand store file | `camelCaseStore.ts` | `runStore.ts` |
| Content data file | `camelCase.ts`, kebab-case ids | `weapons.ts` with `id: 'ember-aura'` |
| Phaser scene class | `PascalCase` ending in `Scene` | `ArenaScene` |
| Constant export | `SCREAMING_SNAKE_CASE` | `ARENA_SIZE_PX = 4096` |

**ID conventions:**
- Weapon ids, enemy ids, upgrade ids: `kebab-case`. Stable forever — they appear in saves.
- Internal numeric ids (e.g. `weaponId: ui16` in WeaponSlot) are derived at content-load time via a `Map<string, number>`. Never persisted.

**Import order in every file:**
1. Node / external packages (phaser, bitecs, zustand, react)
2. Internal `src/core/*`
3. Internal `src/ecs/*`
4. Internal `src/content/*`
5. Internal `src/stores/*`
6. Type-only imports last, prefixed with `import type`.

---

## 8. Quick reference — what to import where

| If you're writing | Import from |
|---|---|
| An ECS system | `bitecs`, `src/ecs/components.ts`, `src/core/eventBus.ts`, `src/core/pool.ts` |
| A weapon definition | `src/ecs/components.ts` (types only), `src/core/pool.ts` (acquire helpers) |
| A React screen | `src/stores/runStore.ts`, `src/stores/metaStore.ts`, `react`, `zustand/shallow` |
| A scene | `phaser`, every system module, `src/ecs/world.ts`, `src/stores/runStore.ts` (subscribe only) |
| An event handler outside React | `src/core/eventBus.ts`, types from same |

**Forbidden imports:**
- React from any file under `src/ecs/`, `src/scenes/`, `src/core/`.
- Phaser from any file under `src/react/`, `src/stores/`, `src/content/`.
- Zustand from any file under `src/ecs/`, `src/core/`. (Stores are read by `ArenaScene` only via a single subscriber.)
