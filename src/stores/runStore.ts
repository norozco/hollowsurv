// In-run mutable state. Owner: Agent C5.
// Resets on every run start. Drives HUD and level-up modal.
//
// Implements RunState per CONTRACTS.md §3.1. The eventBus -> runStore wiring
// lives in main.tsx (C1) and forwards each GameEvent to _applyEvent. We never
// import the bus here so React can be unit-tested without it.
//
// Phase mirror discipline (per ARCHITECTURE.md §2): all phase transitions go
// through a store action (startRun/endRun/setPhase/pickUpgrade/_applyEvent).
// ArenaScene reads `phase` via runStore.subscribe; never the other way.
import { create } from 'zustand';
import { UPGRADES } from '../content/upgrades';
import { WEAPONS } from '../content/weapons';
import { CHARACTERS, DEFAULT_CHARACTER_ID, getCharacter } from '../content/characters';
import { pickRandomEpithet } from '../content/epithets';
import { useMetaStore } from './metaStore';
import { eventBus } from '../core/eventBus';
import type { GameEvent } from '../core/eventBus';
import type { BuildSnapshot } from '../core/buildCodes';
import type { BargainDefinition } from '../content/bargains';
import { rng, setRngSeed, todaysSeed } from '../core/rng';
import { DEFAULT_HOLLOW_ID, HOLLOWS, type HollowId } from '../content/hollows';

export type RunPhase = 'menu' | 'playing' | 'levelup' | 'hollow_select' | 'paused' | 'won' | 'lost';

export interface UpgradeChoice {
  id: string; // unique per choice instance
  kind: 'new_weapon' | 'level_weapon' | 'augment';
  title: string;
  description: string;
  weaponId?: string; // present when kind != 'augment'
  rarity: 'common' | 'rare' | 'epic';
  /** Augment effect (when kind === 'augment'). Applied by pickUpgrade. */
  augment?: import('../content/upgrades').AugmentEffect;
  /**
   * Evolution choice. When set, pickUpgrade removes the base weapon
   * (`choice.weaponId`) and adds the evolved weapon (`choice.evolvesToId`)
   * at level 1 with the evolved flag set. Reuses the `level_weapon` kind so
   * downstream consumers don't need a new union case.
   */
  evolvesToId?: string;
}

export interface RunPlayerSlot {
  id: string;
  level: number;
  evolved: boolean;
}

/**
 * Cumulative Devil's-Bargain boosts. Bargain.apply() writes here so that
 * read-side systems (spawnDirector, xp, collision, etc.) can consume the
 * effects without bargain.ts needing to know about each system. Most reads
 * are NOT wired yet — see RESUME.md follow-up list. Default values must be
 * the identity (no effect) so an un-bargained run behaves exactly as before.
 */
export interface BargainBoosts {
  /** Stored revive tokens. When player would die, decrement and restore HP. */
  reviveTokens: number;
  /** Enemy spawn-rate multiplier (>1 = more enemies). Active until spawnRateUntilMs. */
  spawnRateMul: number;
  /** performance.now() ms timestamp after which spawnRateMul resets. */
  spawnRateUntilMs: number;
  /** Negative shifts boss spawn earlier; positive shifts later. */
  bossSpawnOffsetMs: number;
  /** XP-gain multiplier (1 = no change). */
  xpMul: number;
  /** Damage multiplier applied on top of player stats. */
  damageMul: number;
  /** Incoming-damage multiplier. >1 = take more damage. */
  damageTakenMul: number;
  /** Attack-speed multiplier (stacks with player Stats.attackSpeedMul). */
  attackSpeedMul: number;
  /** Move-speed multiplier. */
  moveSpeedMul: number;
  /** Pickup-radius multiplier. */
  pickupRadiusMul: number;
  /** performance.now() ms timestamp; player ignores damage while now < this. */
  invulnUntilMs: number;
}

const INITIAL_BARGAIN_BOOSTS: BargainBoosts = {
  reviveTokens: 0,
  spawnRateMul: 1,
  spawnRateUntilMs: 0,
  bossSpawnOffsetMs: 0,
  xpMul: 1,
  damageMul: 1,
  damageTakenMul: 1,
  attackSpeedMul: 1,
  moveSpeedMul: 1,
  pickupRadiusMul: 1,
  invulnUntilMs: 0,
};

export interface RunState {
  // phase / lifecycle
  phase: RunPhase;
  runStartedAtMs: number; // performance.now() at start
  elapsedMs: number; // updated each tick by ArenaScene

  // player
  player: {
    eid: number; // ECS entity id, or -1 if not spawned
    hp: number;
    maxHp: number;
    level: number;
    xp: number;
    xpToNext: number;
    weapons: RunPlayerSlot[];
    /** HP healed per enemy kill (sum of lifesteal augments). 0 by default. */
    lifestealPerKill: number;
    /** Crit chance 0..1 (additive, capped at 1). */
    critChance: number;
    /** Splash damage radius in px (max). 0 = no splash. */
    splashRadius: number;
    /** Thorns reflect fraction 0..1. */
    thornsReflect: number;
    /** Knockback distance applied to enemies on hit (px). 0 = no knockback. */
    knockbackPx: number;
    /** Berserker damage multiplier (additive); applied when HP <= 30% maxHp. */
    berserkerMul: number;
    /** Incoming damage reduction (0..1, capped). */
    damageReduction: number;
    /** IDs of augments picked during this run, in order. Used by build codes. */
    pickedAugmentIds: string[];
  };

  // run stats
  kills: number;
  bossKilled: boolean;

  /**
   * Survivors-style kill streak. Increments on every enemy_killed event.
   * Resets to 0 after 2 seconds with no kill (see `comboExpiresAtMs`).
   * The HUD/ComboCounter overlay reads this to flash milestones (×10/×25/×50/...).
   */
  comboCount: number;
  /** Highest combo achieved this run. Preserved for the Run Summary. */
  comboPeakThisRun: number;
  /**
   * elapsedMs at which the combo expires if no further kill happens. Set on
   * every enemy_killed event (= elapsedMs + COMBO_WINDOW_MS). ArenaScene's
   * update loop calls `_tickComboDecay(elapsedMs)` each tick to reset the
   * counter once we pass this value.
   */
  comboExpiresAtMs: number;

  /** Total damage the player dealt this run (sum of damage_dealt where source === player.eid). */
  damageDealtTotal: number;
  /** Total damage the player took this run (sum of damage_dealt where target === player.eid). */
  damageTakenTotal: number;
  /**
   * eid of the last entity that damaged the player. Used by the Run Summary to
   * show "Killed by: <enemy>". -1 when unset (no damage taken yet).
   */
  lastKillerEid: number;
  /**
   * Resolved name of the killer (e.g. 'brute', 'boss-prime') for the Run Summary.
   * Empty string when no damage has been taken yet, or when the eid could not
   * be resolved to an enemy archetype. spawnDirector.getEnemyNameForEid() is
   * the lookup source.
   */
  lastKillerName: string;

  /** ID of the character chosen for the current/last run (default 'ranger'). */
  selectedCharacterId: string;

  /** Epithet rolled for the current/last run (e.g. "the Forsaken").
   *  Empty string before the first run. Re-rolls on every startRun. */
  runEpithet: string;

  // level-up modal
  pendingChoices: UpgradeChoice[]; // length 0 or 3

  /**
   * If non-null, the next startRun() will apply this build (weapons + augments)
   * after initializing the base run. Set by main.tsx when the page loaded with
   * a `?b=...` URL parameter. Cleared after consumption.
   */
  pendingBuildSnapshot: BuildSnapshot | null;

  /** Active Devil's-Bargain offer, or null. Cleared on accept/pass/timeout. */
  pendingBargain: BargainDefinition | null;
  /** Accumulated bargain side-effects. See BargainBoosts. */
  bargainBoosts: BargainBoosts;

  /**
   * True if the current/last run was started as a Daily Run. While true, the
   * shared rng (core/rng.ts) is seeded with `dailySeed` so every player today
   * sees the same wave timings, spawn angles, level-up offers, etc.
   */
  isDailyMode: boolean;

  /**
   * The deterministic seed for the current daily run (YYYYMMDD as int, e.g.
   * 20260513). 0 when `isDailyMode` is false. Surfaced in RunSummary so the
   * date is visible.
   */
  dailySeed: number;

  /**
   * Selected Branching Hollow id (one of HOLLOWS keys). Null until the player
   * picks at the 5:00 portal screen. When null at boss-spawn time, spawnDirector
   * uses the wave-defined enemy (`boss-prime`) — i.e. the run never reached
   * the Hollow choice (death before 5:00). When set, spawnDirector substitutes
   * the Hollow's `bossEnemyId` and hollowMechanicsSystem applies the per-Hollow
   * tick logic.
   */
  selectedHollowId: HollowId | null;

  /**
   * True while the Hollow choice modal is up. Goes hand-in-hand with the
   * `hollow_select` phase: when this is true, systems early-return like they
   * do for 'levelup'. Cleared by `pickHollow`.
   */
  hollowChoicePending: boolean;

  // actions
  /**
   * Start a run with the given character.
   * @param characterId Must exist in CHARACTERS or falls back to default.
   * @param opts.daily  When true, seed the shared RNG with today's seed so wave
   *                    timings, formation angles, and level-up offers are
   *                    deterministic for every player on the same local date.
   */
  startRun: (characterId?: string, opts?: { daily?: boolean }) => void;
  endRun: (outcome: 'won' | 'lost') => void;
  setPhase: (phase: RunPhase) => void;
  pickUpgrade: (choiceId: string) => void;
  /**
   * Show the picker with caller-supplied choices. Useful for tests, dev console
   * (see verification step 4 in C5's task), and any future content-driven flow
   * that wants to bypass the auto-generated pool. Sets phase to 'levelup'.
   */
  presentLevelUp: (choices: UpgradeChoice[]) => void;
  /** Player accepted the active bargain. Applies effects, clears, emits event. */
  acceptBargain: () => void;
  /** Player declined or the offer timed out. Clears, emits event. */
  passBargain: () => void;
  /**
   * Player picked a Hollow from the portal screen (or the auto-pick timer fired).
   * Records the id, clears `hollowChoicePending`, sets phase back to 'playing',
   * and emits a `hollow_chosen` event so audio / hollowMechanicsSystem can hook in.
   * No-op when no choice is pending (defensive — protects against double-click).
   */
  pickHollow: (hollowId: HollowId) => void;
  /**
   * Reset the combo counter if `currentMs` has passed `comboExpiresAtMs`.
   * Called from ArenaScene.update() each tick. No-op when combo is already 0.
   */
  _tickComboDecay: (currentMs: number) => void;
  // internal — called by event-bus translator only
  _applyEvent: (event: GameEvent) => void;
}

/** How long after a kill the combo persists with no further kills. 2s feels best
 *  to me — long enough that a 3-second weapon cooldown doesn't break combo
 *  mid-flow, short enough that walking away from the action lets it reset. */
const COMBO_WINDOW_MS = 2000;

/**
 * Vertical-slice placeholder weapon ids used when content/weapons.ts is empty.
 * Replace with real ids (e.g. 'pistol', 'ember-aura') once Agent C3 ships
 * WEAPONS data. The level-up generator falls back to this list.
 */
const PLACEHOLDER_WEAPON_POOL = [
  { id: 'auto-pistol', name: 'Auto Pistol' },
  { id: 'aura', name: 'Aura' },
  { id: 'sawblade', name: 'Sawblade' },
  { id: 'lightning', name: 'Lightning' },
  { id: 'fireball', name: 'Fireball' },
  { id: 'frostnova', name: 'Frost Nova' },
] as const;

/**
 * Vertical-slice fallback augments mirroring the brief (`+10% damage`,
 * `+10% move speed`, `+15% pickup radius`). Used when content/upgrades.ts is
 * empty. Replace with ids from UPGRADES once that file is populated.
 */
const PLACEHOLDER_AUGMENTS = [
  { id: 'aug-damage', title: '+10% Damage', description: 'Your weapons hit harder.' },
  { id: 'aug-speed', title: '+10% Move Speed', description: 'Outpace the swarm.' },
  { id: 'aug-pickup', title: '+15% Pickup Radius', description: 'Magnetize loot from afar.' },
  { id: 'aug-attackspeed', title: '+10% Attack Speed', description: 'Fire more often.' },
  { id: 'aug-maxhp', title: '+20 Max HP', description: 'Tougher hide.' },
] as const;

const MAX_WEAPON_LEVEL = 8;
const MAX_WEAPON_SLOTS = 6;

const INITIAL_PLAYER: RunState['player'] = {
  eid: -1,
  hp: 100,
  maxHp: 100,
  level: 1,
  xp: 0,
  xpToNext: 5,
  weapons: [],
  lifestealPerKill: 0,
  critChance: 0,
  splashRadius: 0,
  thornsReflect: 0,
  knockbackPx: 0,
  berserkerMul: 0,
  damageReduction: 0,
  pickedAugmentIds: [],
};

/**
 * Apply a raw `AugmentEffect` to a mutable player object. The shared core of
 * the two augment-application paths: `applyAugmentToPlayer` (looks up an
 * UPGRADES id, then calls this) and `pickUpgrade`'s inline fallback (which
 * doesn't have a stable id but still has the effect inline on the choice).
 *
 * Pure mutation — does NOT touch `pickedAugmentIds`. The caller decides
 * whether to record the id for build-code encoding.
 */
function applyAugmentEffectToPlayer(
  player: RunState['player'],
  aug: import('../content/upgrades').AugmentEffect,
): void {
  if (aug.maxHpDelta) {
    player.maxHp += aug.maxHpDelta;
    player.hp = Math.min(player.maxHp, player.hp + aug.maxHpDelta);
  }
  if (aug.lifestealPerKill) {
    player.lifestealPerKill += aug.lifestealPerKill;
  }
  if (aug.critChanceDelta) {
    player.critChance = Math.min(1, player.critChance + aug.critChanceDelta);
  }
  if (aug.splashRadiusDelta) {
    player.splashRadius = Math.max(player.splashRadius, aug.splashRadiusDelta);
  }
  if (aug.thornsReflectDelta) {
    player.thornsReflect = Math.min(1, player.thornsReflect + aug.thornsReflectDelta);
  }
  if (aug.knockbackPxDelta) {
    player.knockbackPx += aug.knockbackPxDelta;
  }
  if (aug.berserkerMulDelta) {
    player.berserkerMul += aug.berserkerMulDelta;
  }
  if (aug.damageReductionDelta) {
    player.damageReduction = 1 - (1 - player.damageReduction) * (1 - aug.damageReductionDelta);
  }
}

/**
 * Apply an augment's effects to a mutable player object by UPGRADES id. Used
 * by `pickUpgrade` (when the player picks an augment from the level-up modal)
 * and by `startRun` (when a pending build snapshot is being hydrated). Pushes
 * the augment id onto `player.pickedAugmentIds` so build-code encoding sees it.
 *
 * NOTE: this only mutates the runStore-side player. ECS Stats updates happen
 * via the `upgrade_chosen` event which autoAttack listens to. For startRun
 * hydration we emit the same event so weapons fire with the augmented stats.
 */
function applyAugmentToPlayer(player: RunState['player'], augmentId: string): void {
  const def = UPGRADES[augmentId];
  if (!def || def.kind !== 'augment' || !def.augment) return;
  applyAugmentEffectToPlayer(player, def.augment);
  player.pickedAugmentIds.push(augmentId);
}

/**
 * Recover the UPGRADES key that backs a level-up choice. generateOffers
 * generates ids as `aug-${u.id}-${suffix}` where u.id already starts with
 * `aug-`, so e.g. `aug-aug-damage-x9q1z`. We strip the leading `aug-` and the
 * trailing `-suffix` and check if the result is in UPGRADES. If that fails we
 * scan UPGRADES looking for a matching `augment` object reference (the choice
 * is built by spreading the same AugmentEffect, so identity match is enough).
 * Returns null if neither strategy finds a match.
 */
function extractUpgradeIdFromChoiceId(
  choiceId: string,
  augment: import('../content/upgrades').AugmentEffect
): string | null {
  if (choiceId.startsWith('aug-')) {
    const lastDash = choiceId.lastIndexOf('-');
    if (lastDash > 4) {
      const candidate = choiceId.slice(4, lastDash);
      if (UPGRADES[candidate]) return candidate;
    }
  }
  for (const [id, def] of Object.entries(UPGRADES)) {
    if (def.kind === 'augment' && def.augment === augment) return id;
  }
  return null;
}

/** XP threshold curve. Start at 5, +5 per level (vertical-slice tuning). */
function xpToNextForLevel(level: number): number {
  return 5 + Math.max(0, level - 1) * 5;
}

/**
 * Pick `n` distinct elements from `arr` using the shared `rng`. In daily mode
 * `rng()` is seeded so the same offers appear for every player at the same
 * level-up moment. In normal mode `rng()` falls through to Math.random.
 */
function pickN<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng() * pool.length);
    const removed = pool.splice(idx, 1)[0];
    if (removed === undefined) break;
    out.push(removed);
  }
  return out;
}

/** Short random suffix used to disambiguate UpgradeChoice ids. Uses `rng()` so
 *  daily mode stays deterministic (each level-up still gets a unique id, but
 *  the same one for every player). */
function rngSuffix(): string {
  return rng().toString(36).slice(2, 7);
}

/**
 * Generate three level-up offers for the current player state.
 * Logic per the C5 brief:
 *   - If owned weapons < 6: chance of "+1 weapon: <random unowned>"
 *   - If owned weapons exist (and not all maxed): chance of "Level up <random owned>"
 *   - Stat augments: pulled from UPGRADES (or placeholder list if empty)
 *
 * Always returns 3 entries when possible. Falls back to augment-only when no
 * weapon offers are available.
 */
function generateOffers(player: RunState['player'], characterId: string): UpgradeChoice[] {
  const ownedIds = new Set(player.weapons.map((w) => w.id));
  const weaponNames = new Map<string, string>();

  // Build the set of evolved-weapon ids so we can exclude them from the
  // "new weapon" pool — evolutions are only obtainable via the evolution
  // gate (max level + paired augment), never as a fresh weapon pick.
  const evolvedWeaponIds = new Set<string>();
  for (const def of Object.values(WEAPONS)) {
    if (def.evolvesTo) evolvedWeaponIds.add(def.evolvesTo);
  }

  // Prefer real WEAPONS data if populated, else placeholder pool. Filter out
  // weapons restricted to OTHER characters so a Brawler never sees the Auto
  // Pistol (Ranger-only) and a Ranger never sees the Blade (Brawler-only).
  const weaponPool = Object.keys(WEAPONS).length > 0
    ? Object.values(WEAPONS)
        .filter((w) => !w.restrictedToCharacter || w.restrictedToCharacter === characterId)
        .filter((w) => !evolvedWeaponIds.has(w.id))
        .map((w) => ({ id: w.id, name: w.name, description: w.description }))
    : PLACEHOLDER_WEAPON_POOL.map((w) => ({ id: w.id, name: w.name, description: '' }));
  for (const w of weaponPool) weaponNames.set(w.id, w.name);
  // Make sure evolved-weapon display names are still resolvable for level-up
  // cards (these can be in player.weapons after an evolution pick).
  for (const def of Object.values(WEAPONS)) {
    if (!weaponNames.has(def.id)) weaponNames.set(def.id, def.name);
  }

  // --- candidates: new weapons (only if we have room) ---
  const newWeaponCandidates: UpgradeChoice[] =
    player.weapons.length < MAX_WEAPON_SLOTS
      ? weaponPool
          .filter((w) => !ownedIds.has(w.id))
          .map<UpgradeChoice>((w) => ({
            id: `new-${w.id}-${rngSuffix()}`,
            kind: 'new_weapon',
            title: `New: ${w.name}`,
            description: w.description || `Add ${w.name} to your arsenal.`,
            weaponId: w.id,
            rarity: 'rare',
          }))
      : [];

  // --- candidates: level up an existing weapon (skip if already maxed) ---
  // "Maxed" means the slot has reached the highest entry in its definition's
  // levels table (typically 5). The hard MAX_WEAPON_LEVEL cap (8) is a
  // schema-level guard; the per-weapon level table is the real ceiling.
  const levelWeaponCandidates: UpgradeChoice[] = player.weapons
    .filter((w) => {
      if (w.level >= MAX_WEAPON_LEVEL) return false;
      const def = WEAPONS[w.id];
      if (def && w.level >= def.levels.length) return false;
      return true;
    })
    .map<UpgradeChoice>((w) => {
      const name = weaponNames.get(w.id) ?? w.id;
      return {
        id: `lvl-${w.id}-${rngSuffix()}`,
        kind: 'level_weapon',
        title: `${name} Lv ${w.level + 1}`,
        description: `+20% damage, faster fire rate.`,
        weaponId: w.id,
        rarity: 'common',
      };
    });

  // --- candidates: evolutions ------------------------------------------------
  // A weapon can evolve when:
  //   1. its definition has `evolvesTo` + `evolveRequires` set,
  //   2. the equipped slot has reached the max level entry on its level table
  //      (vertical slice: 5),
  //   3. the paired augment id is present in `player.pickedAugmentIds`,
  //   4. (optional) the evolved weapon definition exists in WEAPONS,
  //   5. the slot is not already an evolution (`evolved === false`).
  //
  // An evolution offer reuses the `level_weapon` kind so existing consumers
  // (HUD card rendering, etc.) treat it like any other level-up card; the
  // `evolvesToId` field is the only signal that pickUpgrade must do a
  // weapon-swap instead of a level bump.
  const evolutionCandidates: UpgradeChoice[] = [];
  for (const slot of player.weapons) {
    if (slot.evolved) continue;
    const baseDef = WEAPONS[slot.id];
    if (!baseDef || !baseDef.evolvesTo || !baseDef.evolveRequires) continue;
    const maxLevel = baseDef.levels.length;
    if (slot.level < maxLevel) continue;
    const reqs = baseDef.evolveRequires;
    if (!player.pickedAugmentIds.includes(reqs.pairedAugmentId)) continue;
    const evolvedDef = WEAPONS[baseDef.evolvesTo];
    if (!evolvedDef) continue;
    // Honour evolved weapon's character restriction (e.g. Phantom Shot ranger-only).
    if (evolvedDef.restrictedToCharacter && evolvedDef.restrictedToCharacter !== characterId) continue;
    evolutionCandidates.push({
      id: `evo-${baseDef.id}-${rngSuffix()}`,
      kind: 'level_weapon',
      title: `EVOLVE: ${evolvedDef.name}`,
      description: evolvedDef.description,
      weaponId: baseDef.id,
      evolvesToId: evolvedDef.id,
      rarity: 'epic',
    });
  }

  // --- candidates: augments ---
  const realAugments = Object.values(UPGRADES).filter((u) => u.kind === 'augment');
  const augmentCandidates: UpgradeChoice[] =
    realAugments.length > 0
      ? realAugments.map<UpgradeChoice>((u) => ({
          id: `aug-${u.id}-${rngSuffix()}`,
          kind: 'augment',
          title: u.title,
          description: u.description,
          rarity: u.rarity,
          ...(u.augment ? { augment: u.augment } : {}),
        }))
      : PLACEHOLDER_AUGMENTS.map<UpgradeChoice>((a) => ({
          id: `${a.id}-${rngSuffix()}`,
          kind: 'augment',
          title: a.title,
          description: a.description,
          rarity: 'common',
        }));

  // Combine candidate buckets and pick 3 distinct entries.
  // Bias:
  //  - if an evolution is available, it always claims the first slot (this is
  //    the genre-defining moment; surfacing it reliably matters more than
  //    rotation diversity),
  //  - then each remaining bucket contributes once if non-empty,
  //  - remaining slots filled from augments.
  const offers: UpgradeChoice[] = [];
  if (evolutionCandidates.length > 0) {
    offers.push(...pickN(evolutionCandidates, 1));
  }
  if (newWeaponCandidates.length > 0) {
    offers.push(...pickN(newWeaponCandidates, 1));
  }
  if (levelWeaponCandidates.length > 0) {
    offers.push(...pickN(levelWeaponCandidates, 1));
  }
  while (offers.length < 3 && augmentCandidates.length > 0) {
    const remaining = augmentCandidates.filter((a) => !offers.some((o) => o.id === a.id));
    if (remaining.length === 0) break;
    offers.push(...pickN(remaining, 1));
  }

  // Final safety net: dedupe by id and trim to 3.
  const seen = new Set<string>();
  const out: UpgradeChoice[] = [];
  for (const o of offers) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
    if (out.length === 3) break;
  }
  return out;
}

export const useRunStore = create<RunState>((set, get) => ({
  phase: 'menu',
  runStartedAtMs: 0,
  elapsedMs: 0,
  player: INITIAL_PLAYER,
  kills: 0,
  bossKilled: false,
  comboCount: 0,
  comboPeakThisRun: 0,
  comboExpiresAtMs: 0,
  damageDealtTotal: 0,
  damageTakenTotal: 0,
  lastKillerEid: -1,
  lastKillerName: '',
  pendingChoices: [],
  selectedCharacterId: DEFAULT_CHARACTER_ID,
  runEpithet: '',
  pendingBuildSnapshot: null,
  pendingBargain: null,
  bargainBoosts: { ...INITIAL_BARGAIN_BOOSTS },
  isDailyMode: false,
  dailySeed: 0,
  selectedHollowId: null,
  hollowChoicePending: false,

  startRun: (characterIdRaw, opts) => {
    const cur = get();
    // If a shared build snapshot is pending, prefer its character id (so
    // loading ?b=BR-... starts as the Brawler even if the caller passed
    // nothing). An explicit characterIdRaw still wins.
    const pendingBuild = cur.pendingBuildSnapshot;
    const characterId =
      characterIdRaw ?? pendingBuild?.characterId ?? DEFAULT_CHARACTER_ID;
    const character = getCharacter(characterId);
    const startingWeaponId = WEAPONS[character.startingWeaponId]
      ? character.startingWeaponId
      : 'auto-pistol';

    // Set up determinism BEFORE rolling anything random (epithet, offers, etc.).
    // In daily mode every player today shares the same seed; in normal mode we
    // clear it so rng() falls back to Math.random.
    const isDailyMode = opts?.daily === true;
    const dailySeed = isDailyMode ? todaysSeed() : 0;
    setRngSeed(isDailyMode ? dailySeed : null);

    const baseMaxHp = INITIAL_PLAYER.maxHp + (character.bonuses.maxHpDelta ?? 0);
    // Epithet roll uses the seeded rng in daily mode so the title matches for
    // every player. In normal mode this falls back to Math.random.
    const runEpithet = pickRandomEpithet(rng);

    // Build the fresh player. Default: just the character's starting weapon.
    // If a pending build snapshot matches this character, swap in its weapons
    // and apply its augments.
    const freshPlayer: RunState['player'] = {
      ...INITIAL_PLAYER,
      eid: cur.player.eid,
      weapons: [{ id: startingWeaponId, level: 1, evolved: false }],
      hp: baseMaxHp,
      maxHp: baseMaxHp,
      pickedAugmentIds: [],
    };

    const applyBuild =
      pendingBuild !== null && pendingBuild.characterId === characterId;
    if (applyBuild && pendingBuild) {
      // Replace starting weapon list with the snapshot's, deduped + capped.
      const snapshotWeapons: RunPlayerSlot[] = [];
      const seenWeaponIds = new Set<string>();
      for (const w of pendingBuild.weapons) {
        if (seenWeaponIds.has(w.id)) continue;
        if (snapshotWeapons.length >= MAX_WEAPON_SLOTS) break;
        // Skip weapons restricted to a different character.
        const def = WEAPONS[w.id];
        if (!def) continue;
        if (def.restrictedToCharacter && def.restrictedToCharacter !== characterId) continue;
        const maxLv = def.levels.length > 0 ? def.levels.length : 1;
        const level = Math.max(1, Math.min(MAX_WEAPON_LEVEL, Math.min(maxLv, w.level)));
        snapshotWeapons.push({ id: w.id, level, evolved: false });
        seenWeaponIds.add(w.id);
      }
      // If the snapshot included weapons, use them; otherwise keep the
      // character's default starting weapon so the run isn't broken.
      if (snapshotWeapons.length > 0) {
        freshPlayer.weapons = snapshotWeapons;
      }
      // Apply each augment effect (also pushes to pickedAugmentIds).
      const seenAugIds = new Set<string>();
      for (const augId of pendingBuild.augments) {
        if (seenAugIds.has(augId)) continue;
        seenAugIds.add(augId);
        applyAugmentToPlayer(freshPlayer, augId);
      }
    }

    set({
      phase: 'playing',
      runStartedAtMs: performance.now(),
      elapsedMs: 0,
      player: freshPlayer,
      kills: 0,
      bossKilled: false,
      comboCount: 0,
      comboPeakThisRun: 0,
      comboExpiresAtMs: 0,
      damageDealtTotal: 0,
      damageTakenTotal: 0,
      lastKillerEid: -1,
      lastKillerName: '',
      pendingChoices: [],
      pendingBuildSnapshot: null,
      selectedCharacterId: characterId,
      runEpithet,
      pendingBargain: null,
      bargainBoosts: { ...INITIAL_BARGAIN_BOOSTS },
      isDailyMode,
      dailySeed,
      // Hollows reset per-run; the choice resurfaces at every 5:00 mark.
      selectedHollowId: null,
      hollowChoicePending: false,
    });

    // Let ECS systems apply the character's stat bonuses to the player Stats component.
    eventBus.emit({ type: 'character_selected', characterId });

    // If we hydrated augments from a pending build, fire one upgrade_chosen
    // event per augment so the autoAttack subscriber applies Stat multipliers
    // to the ECS player. We pass the bare augment id; the subscriber treats
    // any registered UPGRADES id as a valid choice.
    if (applyBuild) {
      for (const augId of freshPlayer.pickedAugmentIds) {
        eventBus.emit({ type: 'upgrade_chosen', choiceId: augId });
      }
    }
  },

  endRun: (outcome) => {
    const cur = get();
    // Hand off to metaStore for persistent stats. Pass the character id so
    // metaStore can check character-specific unlock conditions; pass the
    // daily flag so it can update dailyBestTimeMs.
    useMetaStore
      .getState()
      .recordRunCompletion(outcome, cur.elapsedMs, cur.selectedCharacterId, cur.isDailyMode);
    // Clear the seed so any post-run UI / sub-Phaser code uses Math.random again.
    setRngSeed(null);
    set({ phase: outcome });
  },

  setPhase: (phase) => set({ phase }),

  pickUpgrade: (choiceId) => {
    const cur = get();
    const choice = cur.pendingChoices.find((c) => c.id === choiceId);
    if (!choice) {
      // Unknown id: clear modal and resume to avoid soft-lock.
      set({ pendingChoices: [], phase: cur.phase === 'levelup' ? 'playing' : cur.phase });
      return;
    }

    const player = { ...cur.player, weapons: [...cur.player.weapons] };

    // Evolution short-circuit: handled before the regular level_weapon path so
    // a single `evolvesToId` flag is enough to swap the slot. The augment that
    // gated the evolution stays owned (does NOT get consumed). We emit a
    // `weapon_evolved` event so the toast / audio / future telemetry can hook in.
    if (choice.evolvesToId && choice.weaponId) {
      const ownedIdx = player.weapons.findIndex((w) => w.id === choice.weaponId);
      const evolvedDef = WEAPONS[choice.evolvesToId];
      if (ownedIdx !== -1 && evolvedDef) {
        player.weapons[ownedIdx] = {
          id: choice.evolvesToId,
          level: 1,
          evolved: true,
        };
        set({
          player,
          pendingChoices: [],
          phase: 'playing',
        });
        eventBus.emit({ type: 'upgrade_chosen', choiceId });
        eventBus.emit({
          type: 'weapon_evolved',
          baseWeaponId: choice.weaponId,
          evolvedWeaponId: choice.evolvesToId,
          evolvedName: evolvedDef.name,
        });
        return;
      }
      // Fall through to a generic level-up if the evolution couldn't be
      // resolved (unknown evolvedDef, slot vanished, etc.) so the picker
      // never soft-locks.
    }

    if (choice.kind === 'new_weapon' && choice.weaponId) {
      // Add weapon at level 1 if not already owned and we have room.
      const ownedIdx = player.weapons.findIndex((w) => w.id === choice.weaponId);
      if (ownedIdx === -1 && player.weapons.length < MAX_WEAPON_SLOTS) {
        player.weapons.push({ id: choice.weaponId, level: 1, evolved: false });
      } else if (ownedIdx !== -1) {
        // Defensive: contract said new_weapon but we already own it; treat as level-up.
        const slot = player.weapons[ownedIdx];
        if (slot && slot.level < MAX_WEAPON_LEVEL) {
          player.weapons[ownedIdx] = { ...slot, level: slot.level + 1 };
        }
      }
    } else if (choice.kind === 'level_weapon' && choice.weaponId) {
      const ownedIdx = player.weapons.findIndex((w) => w.id === choice.weaponId);
      if (ownedIdx !== -1) {
        const slot = player.weapons[ownedIdx];
        if (slot && slot.level < MAX_WEAPON_LEVEL) {
          player.weapons[ownedIdx] = { ...slot, level: slot.level + 1 };
        }
      }
    } else if (choice.kind === 'augment' && choice.augment) {
      // Apply augment to UI-side player state. ECS Stats are updated by an
      // upgrade_chosen event listener in autoAttack (which has world access).
      //
      // To track the picked augment id (for build-code encoding), we recover
      // the UPGRADES key from the choice id. generateOffers builds the id as
      // `aug-${u.id}-${suffix}` where u.id is itself like 'aug-damage' — so
      // the full choice id is e.g. `aug-aug-damage-abc12`. We strip the leading
      // `aug-` and the trailing `-suffix` to recover `aug-damage`.
      //
      // Fall back: walk UPGRADES and look for one whose `augment` reference
      // matches the inline choice.augment object (this is the same instance
      // because generateOffers spreads UPGRADES[id].augment directly).
      //
      // Both branches route through `applyAugmentEffectToPlayer` so the
      // mutation logic lives in exactly one place. The id-resolved branch also
      // pushes the id onto `pickedAugmentIds`; the inline-fallback branch
      // skips that step (build codes can't replay a choice without an id).
      const upgradeId = extractUpgradeIdFromChoiceId(choice.id, choice.augment);
      if (upgradeId !== null) {
        applyAugmentToPlayer(player, upgradeId);
      } else {
        // Fallback: apply the inline effect without recording an id (so build
        // codes won't include it, but the augment still works in-run).
        applyAugmentEffectToPlayer(player, choice.augment);
      }
    }

    set({
      player,
      pendingChoices: [],
      phase: 'playing',
    });

    // Emit upgrade_chosen so ECS systems can apply Stat multipliers.
    eventBus.emit({ type: 'upgrade_chosen', choiceId });
  },

  presentLevelUp: (choices) => {
    set({ pendingChoices: choices.slice(0, 3), phase: 'levelup' });
  },

  acceptBargain: () => {
    const cur = get();
    const bargain = cur.pendingBargain;
    if (!bargain) return;
    // Clear first so apply()'s setState reads see no pending offer (and
    // dependent UI updates immediately).
    set({ pendingBargain: null });
    try {
      bargain.apply();
    } catch (err) {
      // Bargain effects are best-effort; never let a bad apply() crash the run.
      // eslint-disable-next-line no-console
      console.error('[bargain] apply() failed for', bargain.id, err);
    }
    eventBus.emit({ type: 'bargain_accepted', bargainId: bargain.id });
  },

  passBargain: () => {
    const cur = get();
    const bargain = cur.pendingBargain;
    if (!bargain) return;
    set({ pendingBargain: null });
    eventBus.emit({ type: 'bargain_passed', bargainId: bargain.id });
  },

  pickHollow: (hollowId) => {
    const cur = get();
    // Defensive: ignore stale clicks once the modal has been dismissed.
    if (!cur.hollowChoicePending) return;
    // Unknown id (shouldn't happen via the UI, but a future content drop or
    // a dev-console call could pass garbage). Fall back to the default so the
    // run never soft-locks.
    const validHollow = HOLLOWS[hollowId] ? hollowId : DEFAULT_HOLLOW_ID;
    set({
      selectedHollowId: validHollow,
      hollowChoicePending: false,
      // Resume gameplay. Other systems gated on phase === 'playing' wake up.
      phase: 'playing',
    });
    eventBus.emit({ type: 'hollow_chosen', hollowId: validHollow });
  },

  _tickComboDecay: (currentMs) => {
    const cur = get();
    // Fast path: nothing to reset.
    if (cur.comboCount === 0) return;
    if (currentMs <= cur.comboExpiresAtMs) return;
    set({ comboCount: 0 });
  },

  _applyEvent: (event) => {
    const cur = get();

    switch (event.type) {
      case 'damage_dealt': {
        const playerEid = cur.player.eid;
        // Player took damage: update HP + tracking. Some sources legitimately
        // emit `damage_dealt` AND `player_hit` so the totals here mirror what
        // the HP update does (same event flows through both branches in main.tsx).
        if (event.target === playerEid) {
          const hp = Math.max(0, cur.player.hp - event.amount);
          // Resolve killer name via spawnDirector's eid -> name map. The lookup
          // tolerates eid = -1 (returns undefined) so non-enemy damage sources
          // (e.g. environmental) leave lastKillerName untouched.
          let lastKillerName = cur.lastKillerName;
          const killerEid = event.source;
          if (killerEid !== undefined && killerEid >= 0) {
            // Inline require to avoid a circular import at module load.
            // spawnDirector imports runStore (for elapsedMs); requiring it back
            // here at call time is safe — both modules are already loaded.
            const lookup =
              (globalThis as { __getEnemyNameForEid?: (eid: number) => string | undefined })
                .__getEnemyNameForEid;
            const name = lookup ? lookup(killerEid) : undefined;
            if (name !== undefined) lastKillerName = name;
          }
          set({
            player: { ...cur.player, hp },
            damageTakenTotal: cur.damageTakenTotal + event.amount,
            lastKillerEid: killerEid ?? cur.lastKillerEid,
            lastKillerName,
          });
          return;
        }
        // Player dealt damage: accumulate toward "Damage dealt: N" stat.
        if (event.source === playerEid && playerEid >= 0) {
          set({ damageDealtTotal: cur.damageDealtTotal + event.amount });
        }
        return;
      }

      case 'player_hit': {
        // Redundant with damage_dealt -> player, but also handle this explicit
        // event. Use whichever the simulation emits.
        const hp = Math.max(0, cur.player.hp - event.amount);
        set({ player: { ...cur.player, hp } });
        return;
      }

      case 'pickup_collected': {
        if (event.kind === 'xp') {
          // Devil's Bargain: xpMul scales the value of each XP orb collected.
          // Default identity (1) means un-bargained runs see no change. The
          // multiplier compounds with future xp-altering bargains via the
          // standard `xpMul *= delta` pattern in bargains.apply().
          const xpMul = cur.bargainBoosts.xpMul;
          let xp = cur.player.xp + event.value * xpMul;
          let level = cur.player.level;
          let xpToNext = cur.player.xpToNext;

          // Multi-level handling: a single big pickup could push past N levels.
          while (xp >= xpToNext) {
            xp -= xpToNext;
            level += 1;
            xpToNext = xpToNextForLevel(level);
          }

          const leveledUp = level > cur.player.level;
          const nextPlayer = {
            ...cur.player,
            xp,
            level,
            xpToNext,
          };

          if (leveledUp) {
            const offers = generateOffers(nextPlayer, cur.selectedCharacterId);
            set({
              player: nextPlayer,
              pendingChoices: offers,
              phase: 'levelup',
            });
          } else {
            set({ player: nextPlayer });
          }
        } else if (event.kind === 'heal') {
          const hp = Math.min(cur.player.maxHp, cur.player.hp + event.value);
          set({ player: { ...cur.player, hp } });
        }
        // 'gold' currently has no in-run effect (vertical slice). When meta
        // gold lands, increment via metaStore here.
        return;
      }

      case 'level_up': {
        // Authoritative level-up event from xpSystem. Generate offers if we
        // don't already have pending choices for this level.
        if (cur.pendingChoices.length === 0) {
          const offers = generateOffers(cur.player, cur.selectedCharacterId);
          set({
            player: { ...cur.player, level: event.newLevel },
            pendingChoices: offers,
            phase: 'levelup',
          });
        } else {
          // Already showing picker; just update level number.
          set({ player: { ...cur.player, level: event.newLevel } });
        }
        return;
      }

      case 'enemy_killed': {
        const lifesteal = cur.player.lifestealPerKill ?? 0;
        // Combo: increment + extend expiry. Peak tracked for the Run Summary.
        const comboCount = cur.comboCount + 1;
        const comboExpiresAtMs = cur.elapsedMs + COMBO_WINDOW_MS;
        const comboPeakThisRun = Math.max(cur.comboPeakThisRun, comboCount);
        if (lifesteal > 0 && cur.player.hp < cur.player.maxHp) {
          const hp = Math.min(cur.player.maxHp, cur.player.hp + lifesteal);
          set({
            kills: cur.kills + 1,
            player: { ...cur.player, hp },
            comboCount,
            comboPeakThisRun,
            comboExpiresAtMs,
          });
        } else {
          set({
            kills: cur.kills + 1,
            comboCount,
            comboPeakThisRun,
            comboExpiresAtMs,
          });
        }
        return;
      }

      case 'boss_spawned': {
        // No bossActive flag in CONTRACTS RunState; record spawn nonetheless.
        // Future: surface in HUD via a boss-banner slot (out of scope for v1).
        return;
      }

      case 'run_won':
      case 'run_lost': {
        // Translate sim event into our action so meta is persisted.
        get().endRun(event.type === 'run_won' ? 'won' : 'lost');
        return;
      }

      case 'pause_requested': {
        if (cur.phase === 'playing') set({ phase: 'paused' });
        return;
      }

      case 'resume_requested': {
        if (cur.phase === 'paused') set({ phase: 'playing' });
        return;
      }

      case 'upgrade_chosen':
      case 'weapon_fired':
      case 'projectile_spawned':
      case 'wave_started':
        // No store mutation needed for these; future hooks (sfx, telemetry)
        // can subscribe directly to the event bus.
        return;
    }
  },
}));
