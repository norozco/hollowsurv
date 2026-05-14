# Hollowsurv — Resume Note

Status snapshot for picking up after a reboot or new Claude session.

## TL;DR

A feature-complete bullet-heaven survivors-like, post-CTO-audit hardened.
- **Live**: https://norozco.github.io/hollowsurv/
- **Repo**: https://github.com/norozco/hollowsurv
- **Auto-deploys** on `git push origin main` via GitHub Actions (~1 min)
- **Local dev**: `cd "C:\Desktop\Code claude\hollowsurv" && npm run dev` → http://localhost:5173/hollowsurv/
- **Tests**: `npm test` → 27 passing across rng/buildCodes/pool/runStore/metaStore

## Stack

Vite 8 + Phaser 4.1 + bitECS 0.3.40 + React 19 + Zustand 5 + TypeScript strict.

## Feature inventory

### Run flow
1. **Title screen** — HOLLOWSURV + Start Run + Daily Run + Edit Name + lifetime stats
2. **Name entry** (asked once, persisted) — input becomes "Lucas, you are the Forsaken"
3. **Character select** — 5 characters (2 starters + 3 locked with conditions)
4. **Arena** — WASD, auto-attack, level-ups, Devil's Bargain offers, Hollow choice at 5:00, boss at 10:00
5. **Run summary** — full title, stats, shareable build code, restart

### Characters (5 total)
| ID | Tint | Starter | Bonus | Unlock |
|---|---|---|---|---|
| ranger | tan | auto-pistol | — | starter |
| brawler | orange | blade | +30 HP, +10% speed | starter |
| witch | purple | tome (orbiter) | +30% pickup, -10 HP | Survive 5:00 as Brawler |
| sniper | steel | longshot (high-dmg slow rifle) | +20% damage | Survive 8:00 as Ranger |
| cursed-one | wine | hollow-curse (tight aura) | +100% damage, -70 HP | Beat the boss |

### Weapons (13 total)
| ID | Archetype | Restricted to | Notes |
|---|---|---|---|
| auto-pistol | auto_projectile | ranger | 12 dmg, 600ms |
| aura | aura | — | 8 dmg/tick |
| piercer | auto_projectile | — | 14 dmg, pierces 5 |
| frost-nova | frost_nova | — | 8 dmg + 60% slow |
| lightning | chain | — | 6 dmg, chains 3-7 enemies |
| boomerang | boomerang | — | 8 dmg, returns, pierces 4 |
| sawblade | orbiter | — | 5 dmg/blade, 1-5 blades |
| mortar | mortar | — | 22 dmg + 90px AoE |
| shotgun | shotgun | — | 7 dmg × 3-7 pellets |
| blade | melee | brawler | 12 dmg, 80px radius, on-proximity |
| tome | orbiter | witch | 6 dmg/tome, arcane purple |
| longshot | auto_projectile | sniper | 30 dmg, 1500ms cd, pierces 1 |
| hollow-curse | aura | cursed-one | 14 dmg, 50px radius L1 |

### Augments (12 total)
+10% damage / move speed / attack speed; +15% pickup; +20 max HP; lifesteal +1/kill; +25% crit; splash (70px, 30% dmg); +20% thorns; +12px knockback; berserker (+40% dmg below 30% HP); -10% damage taken.

### Devil's Bargain (10 offers, every 90s)
Press `E` to accept (10s timer). Examples: Blood for Power (+1 weapon level, -25 maxHP), Glass Cannon (+25% dmg, +25% dmg taken), Greed (+50% pickup, -25% XP), Second Wind (1 revive, boss spawns 2 min earlier).

### Hidden Synergies (4, no tooltips — discover via play)
- **Frostbite** (Blade + Frost Nova): Blade does 3× to slowed enemies
- **Hollowfield** (Aura + Thorns): taking damage triggers a free aura tick
- **Chainstrike** (Lightning + Crit): crits double the chain count
- **Last Stand** (Shotgun + Berserker): below 30% HP, shotgun fires 360°

### Enemies (3 + 4 bosses)
- grunt (30hp, 10dmg, 130 speed)
- skirmisher (18hp, 6dmg, 220 speed)
- brute (280hp, 22dmg, 70 speed, 32px hitbox)
- **HP scales +10% per minute elapsed** (2× at 10:00)
- boss-prime — default 10:00 boss (3500 HP)
- marrowking — Bone Hollow boss (4000 HP)
- effigy — Ember Hollow boss (4000 HP)
- hollow-deep — Tide Hollow boss (5000 HP)

### Branching Hollows (5:00 mark)
Game freezes, three portals appear. 30s auto-pick = Bone.
- **Bone Hollow** — 10% of kills rise as white skeletons (skirmisher reskin). Boss: Marrowking.
- **Ember Hollow** — kills leave 3s fire patches. Standing on fire = +50% damage. Boss: Effigy.
- **Tide Hollow** — every 30s all enemies pulled toward center. Boss: Hollow-of-the-Deep.
- Background palette tints per Hollow.

### Audio
- **Voice**: Demon Lord pack by Trockk (CC0-equivalent). 13 clips wired:
  - welcome, first_kill, level_up, low_hp (one-shot), heal_pack, boss_spawn + big_laugh, bargain_offer, bargain_accept, hollow_choice, death, victory
- **Music**: Purgatory Vol 3 by David KBD (CC-BY 4.0, requires credit). 8 tracks + 3 mini-loops, crossfaded by game state:
  - Menu: loop-menu
  - Early gameplay: 02-blood-soaked
  - Bone Hollow: 05-bone-grinder
  - Ember Hollow: 07-visceral
  - Tide Hollow: 04-devoured
  - Boss fight: 08-putrid
  - Victory: loop-victory
  - Death: loop-death

### Sharing
- **Build codes**: `?b=BR-bld5.frn3.lit2_crit.spl.tho` URLs encode character + weapons + augments. "Copy Build" button on level-up + run summary. URL on load = auto-applies on next startRun.
- **Daily Seed**: "Daily Run" button on title screen. Mulberry32 RNG → deterministic spawns + level-up offers + epithet. Personal best stored per-date in localStorage.

### Persistence (metaStore SCHEMA_VERSION = 5)
- `playerName` — set once, persists
- `totalRuns`, `totalWins`, `bestRunTimeMs` (longest survival, any outcome)
- `unlockedCharacterIds` — starts with `['ranger', 'brawler']`
- `dailyBestTimeMs: { 'YYYY-MM-DD': ms }`
- `settings: { musicVolume, sfxVolume, screenShake }`
- `tutorialSeen` — first-run onboarding hints gate
- Auto-migrates from v1/v2/v3/v4 → v5

### Weapon evolutions (5)
Pair a base weapon at L5 with the right augment to evolve:
- **Phantom Shot** (Piercer L5 + Crit) — auto-pistol that crits 100% and pierces forever
- **Hollow Field** (Aura L5 + Thorns) — aura that grows + slows on tick
- **Reapers Edge** (Blade L5 + Berserker) — blade radius doubled, always-on berserker bonus
- **Carpet Bomb** (Mortar L5 + Splash) — mortar drops 3 shells in a wedge
- **Eternal Return** (Boomerang L5 + Attack Speed) — boomerang chains 3 returns per cast

### Critical-fixes sprint (6 phases, all shipped)
Post-CTO-audit hardening pass:
- **1A** — determinism: crit roll, heal drop, bargain pick, Chainstrike crit all use `rng()` not `Math.random`
- **1B** — pause actually pauses: `scene.tweens.pauseAll()` + `scene.time.paused = true` + voice queue gated on phase
- **1C** — `ErrorBoundary` catches React crashes, `FpsOverlay` (F3), `SettingsModal` from main menu
- **2A** — per-PoolKind cached component lists; `damage.ts` system removed (redundant)
- **2B** — floating damage numbers + death puffs (pooled), event-bus screen shake (camera.ts)
- **2C** — `ComboCounter` (kill streaks + milestone flashes), `OnboardingHints` (first-run only)
- **3A** — BossTag added to ALL kill paths (aura/frost/lightning/orbiter/hollow-curse/Hollowfield)
- **3B** — 5 weapon evolutions wired through `synergies.ts`, `weapon_evolved` event + toast
- **3C** — `TouchControls`: virtual joystick + aim circle via `touchInput.ts` bridge
- **4A** — `vite.config.ts` `manualChunks` splits phaser/react/zustand vendor bundles
- **5** — `batchedRender.ts` single Graphics object, per-entity rectangles removed from spawnDirector/projectile/xp
- **6A** — `gameContext.ts` singleton replaces `globalThis.__game`; `auraVisuals.ts` + `orbiter.ts` extracted from autoAttack (1474→1314 lines)
- **6B** — Vitest + jsdom, 27/27 tests; `strings.ts` i18n scaffold (`t()` helper) wired into 4 React screens

## Architecture

### Tick order (in `ArenaScene.update`)
`input → flowfield → movement → spawnDirector → autoAttack → projectile → collision → damage → pickup → xp → lifetime → bargain → hollowMechanics → camera → render`

### Stores
- **runStore** — in-run mutable: phase, player (HP/stats/weapons/augment fields/pickedAugmentIds), elapsedMs, runStartedAtMs, selectedCharacterId, runEpithet, kills, pendingChoices, pendingBargain, bargainBoosts, pendingBuildSnapshot, isDailyMode, dailySeed, selectedHollowId, hollowChoicePending
- **metaStore** — persistent (localStorage `hollowsurv.save.v1`): see schema above

### RunPhase union
`'menu' | 'playing' | 'levelup' | 'paused' | 'won' | 'lost' | 'hollow_select'`

### Event bus
Game events: `enemy_killed`, `damage_dealt`, `player_hit`, `level_up`, `pickup_collected`, `weapon_fired`, `projectile_spawned`, `wave_started`, `boss_spawned`, `run_won`, `run_lost`, `upgrade_chosen`, `character_selected`, `pause_requested`, `resume_requested`, `synergy_activated`, `bargain_offered`, `bargain_accepted`, `bargain_passed`, `hollow_choice_offered`, `hollow_chosen`.

## File map

```
public/assets/audio/
  voice/ (13 clips, DEMON LORD pack)
  music/ (11 OGGs, DAVID KBD Purgatory Vol 3)

src/
  main.tsx — entry. Mounts React + Phaser. Subscribes voice + music. Reads URL build code.
  core/
    audio.ts — voice layer (HTMLAudio pools 3x/clip, ducks music, pause-gated queue)
    music.ts — music layer (crossfade state machine + duckMusicFor)
    buildCodes.ts — encode/decode/snapshot URL build codes
    rng.ts — Mulberry32 seedable RNG for Daily Seed
    eventBus.ts — typed pub/sub
    gameContext.ts — singleton (setGame/getGame/getArenaScene); replaces globalThis.__game
    touchInput.ts — virtual joystick + aim bridge into ECS input
    pool.ts, spatialHash.ts, flowfield.ts, scratch.ts — perf primitives
    __tests__/ — rng / buildCodes / pool vitest specs
  content/
    characters.ts (5)
    weapons.ts (13 base + 5 evolutions)
    enemies.ts (3 + 4 bosses)
    upgrades.ts (12)
    bargains.ts (10)
    hollows.ts (3 + bone/ember/tide mechanic refs)
    epithets.ts (12 strings)
    strings.ts — i18n keys + t() helper (66 entries)
    waves.ts
  ecs/
    components.ts — bitECS components (locked contract)
    world.ts
    systems/ — input, flowfield, movement, spawnDirector, autoAttack, auraVisuals, orbiter,
      projectile, collision, pickup, xp, lifetime, bargain, hollowMechanics, synergies,
      damageNumbers, screenShake, batchedRender, camera, render
  scenes/
    BootScene.ts, ArenaScene.ts
  stores/
    runStore.ts, metaStore.ts
    __tests__/ — runStore / metaStore vitest specs
  react/
    App.tsx — phase router (mounts ErrorBoundary, FpsOverlay, TouchControls, ComboCounter, OnboardingHints)
    components/
      ErrorBoundary.tsx
    screens/ — MainMenu, NameEntryScreen, HUD, LevelUpPicker, RunSummary, PauseMenu,
      SettingsModal, FpsOverlay, ComboCounter, OnboardingHints, TouchControls,
      BargainOverlay, HollowChoiceScreen, SynergyToast
```

## Critical bugs fixed (in case they regress)
1. `growIdBuffer` `0×2=0` infinite loop — fixed in `src/core/scratch.ts` with `Math.max(1, ...)`
2. Boss invisible to collision — bosses now get BOTH `EnemyTag` and `BossTag`
3. HMR state pollution — always test in a fresh tab after multi-edit sessions
4. Augment effects not applied — `pickUpgrade` now applies + emits `upgrade_chosen` for ECS Stats
5. `bestRunTimeMs` only on wins — now records longest survival regardless of outcome

## Known issues / TODO

1. **bitECS pinned 0.3.40** (legacy API). Migration to 0.4.x = full system rewrite. Deferred to dedicated 1-month branch.
2. **Procedural rendering, not sprites** — `batchedRender.ts` draws shapes via a single Graphics object. Pixel art pack (Pita, $12) not yet purchased. When acquired, drop PNGs in `public/assets/monsters/`, load in BootScene, swap shape draws for sprite blits.
3. **Server-backed leaderboard** — daily seed PBs are localStorage-only. Needs Supabase + Discord OAuth (deferred).
4. **`longshot` projectile lifetime** falls through to default (1500ms). Add to `PROJECTILE_LIFETIME_MS_BY_WEAPON` if tighter range cap is needed.
5. **i18n is scaffold-only** — `t()` helper + `strings.ts` exist and are wired into MainMenu/PauseMenu/RunSummary/ErrorBoundary, but only English strings ship. Add second locale + locale switch to fully validate.

## Credits (CC-BY compliance)
- Music: "Purgatory Vol 3" by David KBD — https://davidkbd.itch.io/purgatory-vol-3-extreme-metal-music-pack (CC-BY 4.0)
- Voice: "Demon Lord Voice Over Assets" by Trockk — https://trockk.itch.io/demon-lord-voice-over-assets

## Deploy / share

```
cd "C:\Desktop\Code claude\hollowsurv"
git add -A
git commit -m "your message"
git push
```

GitHub Action rebuilds + redeploys in ~1 min. URL stays the same.

## How to resume

In a new Claude session, paste:
> "Resume Hollowsurv. Read RESUME.md."
