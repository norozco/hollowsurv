# Hollowsurv — Resume Note

Status snapshot for picking up after a reboot or new Claude session.

## TL;DR

✅ **Vertical slice runs end-to-end.** Player auto-attacks, enemies spawn and chase, XP collection levels you up, level-up picker offers weapons + augments, boss spawns at 10:00, win/lose loop works.
✅ **Live on GitHub Pages**: https://norozco.github.io/hollowsurv/
✅ **Auto-deploy** on `git push origin main` via GitHub Actions
- **Repo**: https://github.com/norozco/hollowsurv (public)
- **Local dev**: `cd "C:\Users\Lrgz0\Code claude\hollowsurv" && npm run dev`

## Stack

Vite 8 + Phaser 4.1.0 + bitECS 0.3.40 + React 19 + Zustand 5 + TypeScript strict.
Deployed to GitHub Pages via `.github/workflows/deploy.yml`.

## Content shipped

### Weapons (9 total)
| ID | Archetype | Notes |
|---|---|---|
| `auto-pistol` | auto_projectile | Default. 12 dmg, 600ms cd. |
| `aura` | aura | Damage field, slows enemies. 80px radius L1. |
| `piercer` | auto_projectile | 14 dmg, 1000ms cd, pierces 5. |
| `frost-nova` | frost_nova | Burst damage + 60% slow for 1.2s. 8 dmg, 3s cd. |
| `lightning` | chain | Chains 3-7 enemies with 30% falloff. 7 dmg, 1.1s cd. |
| `boomerang` | boomerang | Out + back, pierces 6 (10 at L5). 8 dmg, 950ms cd. |
| `sawblade` | orbiter | 1-5 blades orbit player. 6 dmg per blade. |
| `mortar` | mortar | Slow shells, explode in 90px AoE. 22 dmg. |
| `shotgun` | shotgun | 3-7 pellets in cone. 7 dmg each. Short range. |

### Augments (11 total)
- `aug-damage` (+10% damage), `aug-speed` (+10% move speed), `aug-pickup` (+15% pickup radius)
- `aug-attackspeed` (+10% attack speed), `aug-maxhp` (+20 max HP, also heals)
- `aug-lifesteal` (+1 HP per kill, epic)
- `aug-crit` (+25% crit chance), `aug-splash` (30% splash dmg in 70px), `aug-thorns` (+20% reflect)
- `aug-knockback` (+12px push on hit), `aug-berserker` (+40% dmg below 30% HP), `aug-steelskin` (-10% damage taken)

### Enemies (3 + 1 boss)
- `grunt` — baseline melee (30 hp, 10 dmg, 130 px/s)
- `skirmisher` — fast harasser (18 hp, 6 dmg, 220 px/s)
- `brute` — slow tank (280 hp, 22 dmg, 70 px/s)
- `boss-prime` — 10:00 spawn (5000 hp, 25 dmg, 60 px/s, 80px hitbox)

### Pickups
- XP orbs (green) — drop on every kill
- Heal packs (pink) — 8% chance per kill, restores 20 HP

## Critical bugs fixed (in case they regress)

1. **`growIdBuffer` 0×2=0 infinite loop** (`src/core/scratch.ts`) — when scratchIdBuffer.length is 0 after queryRadius, the doubling loop never progresses. Floor at 1 with `Math.max(1, scratchIdBuffer.length)`.
2. **Boss invisible to collision** (`src/ecs/systems/spawnDirector.ts`) — boss had only `BossTag`, but `enemyQuery` requires `EnemyTag`. Fix: spawn director adds BOTH tags to bosses.
3. **HMR-induced ghost hangs** — accumulated stuck Chrome tabs from many edits left state pollution. Always test in a fresh tab after multiple HMR reloads.
4. **Augment effects didn't apply** — `pickUpgrade` originally just cleared the modal. Now it applies `maxHpDelta`/`lifestealPerKill`/`crit`/`splash`/`thorns`/`knockback`/`berserker`/`steelskin` to runStore + emits `upgrade_chosen` for autoAttack to apply ECS Stat multipliers.
5. **`bestRunTimeMs` only recorded on wins** — changed to track longest survival on any outcome.

## Tuning baseline (current)

- Player base speed: 400 px/s
- Wave 0: 4 grunts in `line` formation at 5s (soft start)
- Wave formations: `random` is now a 90° sector (not full ring) so player can flee perpendicular
- Enemy separation: 3px push per tick when overlapping (in collision pass 3)
- Per-enemy speed jitter: 0.85×–1.15× by eid hash (so they don't march in lockstep)
- Aura visual: 3 stacked translucent circles at depth 5; player at depth 100

## Architecture quick reference

- ECS components: `src/ecs/components.ts` (locked contract)
- All systems in `src/ecs/systems/*.ts`
- Tick order in `ArenaScene.update()`: input → flowfield → movement → spawnDirector → autoAttack → projectile → collision → damage → pickup → xp → lifetime → camera → render
- runStore: in-run mutable (HP, weapons, kills, augment stats, phase)
- metaStore: persistent (totalRuns/Wins/bestRunTimeMs, settings, unlocks). Zustand `persist` to localStorage at key `hollowsurv.save.v1`
- eventBus → runStore translator wired in `main.tsx` lines 44–57

## Known issues / what's next

1. **bitECS pinned 0.3.40** (legacy API). 0.4.x has different API; would require rewrite of all system files.
2. **SpriteGPULayer not wired** — `render.ts` is a stub. All visuals use Phaser GameObjects (rectangles for enemies, circles for projectiles/orbs, scaled circles for aura). Performance budget assumes the eventual SpriteGPULayer migration.
3. **No real enemy scaling over time** — waves spawn more enemies but they have the same HP/damage. Late game at 7+ minutes might feel less escalating.
4. **No save migration** — schemaVersion mismatch discards the save. Bump SCHEMA_VERSION when changing metaStore shape.
5. **Asset packs identified, not bought**: Pita's RPG monster pack ($12, GameDev Market license) is the recommended fit. Hero pack TBD — needs to match Pita's pixel-art style.
6. **Sprite assets**: when Pita pack is bought, drop PNGs in `public/assets/monsters/`, load in `BootScene.preload()`, define animations in `BootScene.create()`, replace placeholder rectangles in `spawnDirector.spawnEnemyEntity()`.

## Deploy / share

```
cd "C:\Users\Lrgz0\Code claude\hollowsurv"
git add -A
git commit -m "your message"
git push
# GitHub Action rebuilds and redeploys in ~1 minute
```

Live URL stays the same: https://norozco.github.io/hollowsurv/

Auth: `gh auth login` is set up; token has `repo` + `workflow` scopes. If `gh` ever loses auth, repeat with `gh auth refresh -h github.com -s workflow`.

## Files modified outside agent partitions

These were edited by Claude (PM/integration) directly, not the original C1-C5 agents:

- `src/scenes/ArenaScene.ts` — added grid background, removed forced setPhase('playing'), set player sprite depth 100, restored full system tick after bisect
- `src/main.tsx` — removed boot-scaffold autostart
- `src/core/scratch.ts` — growIdBuffer fix
- `src/content/waves.ts` — soft start, sector-based randomness, no rings
- `src/content/upgrades.ts` — added 8 new augments + AugmentEffect fields
- `src/stores/runStore.ts` — augment application, lifesteal heal on kill, eventBus emit on pickUpgrade
- `src/stores/metaStore.ts` — bestRunTimeMs fix
- `src/content/weapons.ts` — 7 new weapons + frost slow side-channel + piercer rebalance
- `src/content/enemies.ts` — added skirmisher, brute
- `src/ecs/systems/autoAttack.ts` — added orbiter/mortar/shotgun/lightning/boomerang/frostnova fire functions, aura visual ring, upgrade_chosen subscriber
- `src/ecs/systems/projectile.ts` — placeholder rendering, boomerang flip handler, orbiter skip-lifetime
- `src/ecs/systems/collision.ts` — crit/splash/knockback/berserker/steelskin/thorns/mortar-detonate hooks, enemy-enemy separation
- `src/ecs/systems/flowfield.ts` — frost slow read, per-eid jitter
- `src/ecs/systems/xp.ts` — heal pack drops
- `src/react/screens/LevelUpPicker.tsx` — bigger fonts, better contrast
- `src/react/screens/MainMenu.tsx` — "Longest" label
- `vite.config.ts` — base path for GitHub Pages
- `.github/workflows/deploy.yml` — CI/CD

## How to resume

Tell Claude:
> "Resume Hollowsurv. Read RESUME.md."

Then the new session has full context.

## Conversation logs

Per-session markdown logs at `~/.claude/conversation-logs/YYYY-MM-DD_<short-id>.md`. Stop hook fires after every assistant turn.
