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
import { useMetaStore } from './metaStore';
import { eventBus } from '../core/eventBus';
import type { GameEvent } from '../core/eventBus';

export type RunPhase = 'menu' | 'playing' | 'levelup' | 'paused' | 'won' | 'lost';

export interface UpgradeChoice {
  id: string; // unique per choice instance
  kind: 'new_weapon' | 'level_weapon' | 'augment';
  title: string;
  description: string;
  weaponId?: string; // present when kind != 'augment'
  rarity: 'common' | 'rare' | 'epic';
  /** Augment effect (when kind === 'augment'). Applied by pickUpgrade. */
  augment?: import('../content/upgrades').AugmentEffect;
}

export interface RunPlayerSlot {
  id: string;
  level: number;
  evolved: boolean;
}

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
  };

  // run stats
  kills: number;
  bossKilled: boolean;

  // level-up modal
  pendingChoices: UpgradeChoice[]; // length 0 or 3

  // actions
  startRun: () => void;
  endRun: (outcome: 'won' | 'lost') => void;
  setPhase: (phase: RunPhase) => void;
  pickUpgrade: (choiceId: string) => void;
  /**
   * Show the picker with caller-supplied choices. Useful for tests, dev console
   * (see verification step 4 in C5's task), and any future content-driven flow
   * that wants to bypass the auto-generated pool. Sets phase to 'levelup'.
   */
  presentLevelUp: (choices: UpgradeChoice[]) => void;
  // internal — called by event-bus translator only
  _applyEvent: (event: GameEvent) => void;
}

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
};

/** XP threshold curve. Start at 5, +5 per level (vertical-slice tuning). */
function xpToNextForLevel(level: number): number {
  return 5 + Math.max(0, level - 1) * 5;
}

/** Pick `n` distinct elements from `arr` using Math.random. */
function pickN<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const removed = pool.splice(idx, 1)[0];
    if (removed === undefined) break;
    out.push(removed);
  }
  return out;
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
function generateOffers(player: RunState['player']): UpgradeChoice[] {
  const ownedIds = new Set(player.weapons.map((w) => w.id));
  const weaponNames = new Map<string, string>();

  // Prefer real WEAPONS data if populated, else placeholder pool.
  const weaponPool = Object.keys(WEAPONS).length > 0
    ? Object.values(WEAPONS).map((w) => ({ id: w.id, name: w.name, description: w.description }))
    : PLACEHOLDER_WEAPON_POOL.map((w) => ({ id: w.id, name: w.name, description: '' }));
  for (const w of weaponPool) weaponNames.set(w.id, w.name);

  // --- candidates: new weapons (only if we have room) ---
  const newWeaponCandidates: UpgradeChoice[] =
    player.weapons.length < MAX_WEAPON_SLOTS
      ? weaponPool
          .filter((w) => !ownedIds.has(w.id))
          .map<UpgradeChoice>((w) => ({
            id: `new-${w.id}-${Math.random().toString(36).slice(2, 7)}`,
            kind: 'new_weapon',
            title: `New: ${w.name}`,
            description: w.description || `Add ${w.name} to your arsenal.`,
            weaponId: w.id,
            rarity: 'rare',
          }))
      : [];

  // --- candidates: level up an existing weapon (skip if already maxed) ---
  const levelWeaponCandidates: UpgradeChoice[] = player.weapons
    .filter((w) => w.level < MAX_WEAPON_LEVEL)
    .map<UpgradeChoice>((w) => {
      const name = weaponNames.get(w.id) ?? w.id;
      return {
        id: `lvl-${w.id}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'level_weapon',
        title: `${name} Lv ${w.level + 1}`,
        description: `+20% damage, faster fire rate.`,
        weaponId: w.id,
        rarity: 'common',
      };
    });

  // --- candidates: augments ---
  const realAugments = Object.values(UPGRADES).filter((u) => u.kind === 'augment');
  const augmentCandidates: UpgradeChoice[] =
    realAugments.length > 0
      ? realAugments.map<UpgradeChoice>((u) => ({
          id: `aug-${u.id}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'augment',
          title: u.title,
          description: u.description,
          rarity: u.rarity,
          ...(u.augment ? { augment: u.augment } : {}),
        }))
      : PLACEHOLDER_AUGMENTS.map<UpgradeChoice>((a) => ({
          id: `${a.id}-${Math.random().toString(36).slice(2, 7)}`,
          kind: 'augment',
          title: a.title,
          description: a.description,
          rarity: 'common',
        }));

  // Combine candidate buckets and pick 3 distinct entries.
  // Bias: each bucket contributes once if non-empty; remaining slots filled from augments.
  const offers: UpgradeChoice[] = [];
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
  pendingChoices: [],

  startRun: () => {
    // Preserve `eid` if ArenaScene has already spawned the player and written
    // it back. Resetting eid mid-run would orphan the ECS entity from the HUD.
    const cur = get();
    set({
      phase: 'playing',
      runStartedAtMs: performance.now(),
      elapsedMs: 0,
      player: { ...INITIAL_PLAYER, eid: cur.player.eid, weapons: [] },
      kills: 0,
      bossKilled: false,
      pendingChoices: [],
    });
  },

  endRun: (outcome) => {
    const cur = get();
    // Hand off to metaStore for persistent stats.
    useMetaStore.getState().recordRunCompletion(outcome, cur.elapsedMs);
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
      const aug = choice.augment;
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
        // Splash takes the larger of existing vs incoming (additive feels OP otherwise).
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
        // Multiplicative-friendly stack: 0.1 + 0.1 = ~0.19 (1 - 0.9*0.9)
        player.damageReduction = 1 - (1 - player.damageReduction) * (1 - aug.damageReductionDelta);
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

  _applyEvent: (event) => {
    const cur = get();

    switch (event.type) {
      case 'damage_dealt': {
        // Update HP only when the player is the target. Other agents' damage
        // events don't affect runStore.
        if (event.target === cur.player.eid) {
          const hp = Math.max(0, cur.player.hp - event.amount);
          set({ player: { ...cur.player, hp } });
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
          let xp = cur.player.xp + event.value;
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
            const offers = generateOffers(nextPlayer);
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
          const offers = generateOffers(cur.player);
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
        if (lifesteal > 0 && cur.player.hp < cur.player.maxHp) {
          const hp = Math.min(cur.player.maxHp, cur.player.hp + lifesteal);
          set({ kills: cur.kills + 1, player: { ...cur.player, hp } });
        } else {
          set({ kills: cur.kills + 1 });
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
