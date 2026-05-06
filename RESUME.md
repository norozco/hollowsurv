# Hollowsurv — Resume Note

Status snapshot for picking up after a reboot or new Claude session.

## Latest status (2026-05-05 ~00:10)

### ✅ Built and working (verified by user)
- **Architecture docs:** `ARCHITECTURE.md` (297 lines), `CONTRACTS.md` (408 lines)
- **Scaffold:** Vite + Phaser 4.1.0 + bitECS 0.3.40 + React 19 + Zustand 5 + TS strict. `npm run dev/build/typecheck` all clean.
- **Shared infra:** `src/core/pool.ts`, `spatialHash.ts`, `eventBus.ts`, `_smoke.ts`.
- **C1 movement/camera/input:** WASD works, camera follows, `C` toggles manual aim. Visible motion via grid background.
- **C5 UI:** MainMenu shows "HOLLOWSURV" + Start Run + lifetime stats. HUD shows timer, HP bar, XP bar, weapon slot. Persisted via Zustand persist.

### 🟢 Verified by bisection (advanced timer; gameplay visible)
- **C2 flowfield + spawnDirector** with C1 — enemies spawn off-screen and chase the player.
- **C3 autoAttack alone** with above — fires projectiles toward nearest enemy. Auto-pistol Lv1 in HUD.
- **C3 projectile system** with above — projectile lifetimes tick.

### 🔴 BUG: collision body causes hang
- With **collision body restored** (any of the rest of C3 + C4 systems), Start Run freezes. Page stops advancing the timer.
- Earlier bisect with damage application disabled in collision STILL hung — so the bug is in collision's body somewhere outside the `applyDamageTo*` calls.
- Confirmed not HMR pollution: clean browser restart + collision body = hang. NO-OP collision works.

### Current ArenaScene state (mid-bisection)
File: `src/scenes/ArenaScene.ts` — update() has these enabled:
```
inputSystem, flowfieldSystem, movementSystem, spawnDirectorSystem,
autoAttackSystem, projectileSystem, collisionSystem (FULL BODY),
cameraSystem, renderSystem
```
Disabled (commented out): `damageSystem, pickupSystem, xpSystem, lifetimeSystem`

Wave 0 count was reduced 10 → 1 to test if it's just slow vs truly hung.

### How to resume the bisection

1. Restart dev server: `cd "C:\Users\Lrgz0\Code claude\hollowsurv" && npm run dev`
2. **Close all stuck browser tabs** before testing
3. Open ONE fresh tab → http://localhost:5173/, click Start Run
4. Two outcomes:
   - **Timer advances:** the bug isn't in collision. Re-enable damage/pickup/xp/lifetime one at a time in ArenaScene update().
   - **Frozen at 00:00:** collision body has a real bug. Suspects:
     - `rebuildEnemyHash` (but autoAttack uses it too and works alone — unlikely)
     - Pass 1 inner loop: `queryRadius`, narrow-phase, pierce/markDead
     - Pass 2 (player vs enemy): same pattern
     - `applyDamageToEnemy` / `applyDamageToPlayer` (already ruled out)
     - The `markDead → addComponent(Dead, eid)` could cascade

### Diagnostic strategies that worked
- Bisecting by enabling systems one at a time in ArenaScene update()
- console.log gating: `if (tickCount <= 5 || tickCount % 60 === 0)`
- Wave 0 count = 1 to minimize concurrent entities while debugging

### Diagnostic strategies that failed
- Testing through Chrome MCP: tabs accumulate stuck Phaser instances, gives false readings
- Disabling `applyDamage*` calls: hang persists, so they're not the cause

## How to resume

Tell Claude:
> "Resume Hollowsurv. Read RESUME.md. The collision system body causes a hang we haven't located yet. Continue the bisection — try disabling collision pass 1 (projectile vs enemy) but keeping pass 2 (enemy vs player), or vice versa."

## Permissions note

`~/.claude/settings.json` grants project access via `additionalDirectories` + allow rules. Foreground subagents work cleanly; background subagents fail on permission prompts they can't service.

## Known issues / quirks to watch

1. **bitECS pinned 0.3.40** (legacy API). 0.4.x has a different API.
2. **SpriteGPULayer not yet wired.** `render.ts` is a stub. Standard Phaser GameObjects used as placeholder visuals.
3. **EventBus payload pooling deferred.** `// TODO(perf):` in eventBus.ts.
4. **`pool.ts` exposes both `releaseEntity` and `recycleEntity`** — both work.
5. **HMR pollution risk:** repeated edits to ECS files leave stale subscriptions/state in stuck Chrome tabs. Always test in a fresh tab after multiple HMR reloads.
6. **C2 and C4 use globalThis.__game lookup** to access Phaser scene because they don't own ArenaScene. Fragile — may need explicit binding later.
7. **Player movement speed:** raised from 250 → 400 px/sec to feel right (LoL Swarm ballpark).
8. **Grid background:** added in `ArenaScene.create()` lines 81-99 (128px minor lines, 512px major). Placeholder until tilemap.

## Files modified in current bisection (revert if abandoning)
- `src/scenes/ArenaScene.ts` — has half-disabled systems list
- `src/content/waves.ts` — wave 0 count reduced to 1 (was 10)
- `src/ecs/systems/movement.ts` — base speed 400 (was 250)

## Conversation logs

Per-session markdown logs at `~/.claude/conversation-logs/YYYY-MM-DD_<short-id>.md`. Stop hook fires after every assistant turn.

## Full timeline so far

1. Architecture agent → wrote ARCHITECTURE.md, CONTRACTS.md
2. Scaffold agent → 38 files, deps installed, typecheck/build/dev pass
3. Round 1 attempt 1 (background): infra + C1 + C5 dispatched in parallel — **all 3 failed** on permission denials in background agents
4. Settings updated with `additionalDirectories` + allow rules
5. Round 1 attempt 2 (foreground): infra + C1 succeeded
6. Round 1 C5 (foreground): UI partition succeeded
7. Round 2: C2 + C3 + C4 dispatched in parallel — all 3 succeeded
8. Integration: typecheck + build + dev all pass
9. Browser test: hang on Start Run discovered
10. Bisection through bisection through bisection — narrowed to collision body
11. **Currently:** collision body bug not yet located
