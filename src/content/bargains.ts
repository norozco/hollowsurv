// Devil's Bargain offers.
// Owner: Integration agent (Devil's Bargain system).
//
// Each bargain is a high-risk / high-reward offer presented to the player every
// 90 seconds of run time. The player has 10 seconds to press E to accept;
// otherwise the offer auto-passes. Bargains mutate runStore directly via the
// `apply()` callback so we don't have to plumb effect schemas like augments
// do — each bargain owns its own logic.
//
// Some bargains write fields under `runStore.bargainBoosts` (e.g. spawnRateMul,
// reviveTokens, bossSpawnOffsetMs, xpMul). The matching reads in spawnDirector,
// xp, collision, etc. are NOT wired yet — flagged for follow-up in the task
// report. Until those systems consume the boosts, they are inactive but stored.
//
// Bargain ids are kebab-case and stable forever; they appear in event payloads
// (`bargain_offered`, `bargain_accepted`, `bargain_passed`) and so must not be
// renamed without a save/telemetry migration.

import { useRunStore } from '../stores/runStore';
import { WEAPONS } from './weapons';

export type BargainRarity = 'common' | 'rare' | 'epic';

export interface BargainDefinition {
  id: string;
  title: string;
  description: string;
  rarity: BargainRarity;
  /**
   * Filter: return false to hide this bargain from the offer roll for the
   * current state (e.g. "+atk speed at cost of a weapon slot" needs 2+ weapons).
   * Optional — omit if always offerable.
   */
  canOffer?: () => boolean;
  /**
   * Apply the bargain. Called when the player accepts. Mutates runStore via
   * setState. MUST NOT touch other systems (audio, ECS) directly — that's the
   * bargain.ts system tick's job (it emits the event).
   */
  apply: () => void;
}

const MAX_HP_FLOOR = 10;

// --- bargain pool ---------------------------------------------------------

const bargainPool: BargainDefinition[] = [
  {
    id: 'weapon-level-blood',
    title: 'Blood for Power',
    description: '+1 level to a random owned weapon. Cost: -25 max HP.',
    rarity: 'rare',
    apply: () => {
      useRunStore.setState((s) => {
        const weapons = s.player.weapons.map((w) => ({ ...w }));
        // Filter for weapons that can still level up. Cap is hard-coded to 8 in
        // runStore (MAX_WEAPON_LEVEL). We replicate the constant here.
        const upgradable = weapons.filter((w) => w.level < 8);
        if (upgradable.length > 0) {
          const pick = upgradable[Math.floor(Math.random() * upgradable.length)]!;
          const idx = weapons.findIndex((w) => w.id === pick.id);
          if (idx !== -1 && weapons[idx]) {
            weapons[idx] = { ...weapons[idx]!, level: weapons[idx]!.level + 1 };
          }
        }
        const newMaxHp = Math.max(MAX_HP_FLOOR, s.player.maxHp - 25);
        const newHp = Math.min(s.player.hp, newMaxHp);
        return {
          player: {
            ...s.player,
            weapons,
            maxHp: newMaxHp,
            hp: newHp,
          },
        };
      });
    },
  },
  {
    id: 'fervor-attack-speed',
    title: 'Fervor',
    description: '+50% attack speed. Cost: lose your weakest weapon slot.',
    rarity: 'epic',
    canOffer: () => useRunStore.getState().player.weapons.length >= 2,
    apply: () => {
      useRunStore.setState((s) => {
        const weapons = s.player.weapons.map((w) => ({ ...w }));
        if (weapons.length >= 2) {
          // Drop the lowest-level slot (ties go to first found).
          let lowestIdx = 0;
          for (let i = 1; i < weapons.length; i++) {
            if (weapons[i]!.level < weapons[lowestIdx]!.level) lowestIdx = i;
          }
          weapons.splice(lowestIdx, 1);
        }
        return {
          player: {
            ...s.player,
            weapons,
          },
          bargainBoosts: {
            ...s.bargainBoosts,
            attackSpeedMul: s.bargainBoosts.attackSpeedMul * 1.5,
          },
        };
      });
    },
  },
  {
    id: 'cleanse-and-haste',
    title: 'Cleansing Flame',
    description: 'Heal to full + 5s invulnerability. Cost: enemy spawn rate x2 for 30s.',
    rarity: 'rare',
    apply: () => {
      useRunStore.setState((s) => ({
        player: {
          ...s.player,
          hp: s.player.maxHp,
        },
        bargainBoosts: {
          ...s.bargainBoosts,
          invulnUntilMs: performance.now() + 5000,
          spawnRateMul: 2,
          spawnRateUntilMs: performance.now() + 30_000,
        },
      }));
    },
  },
  {
    id: 'revive-token',
    title: 'Second Wind',
    description: 'Revive once on death. Cost: boss arrives 2 min earlier.',
    rarity: 'epic',
    apply: () => {
      useRunStore.setState((s) => ({
        bargainBoosts: {
          ...s.bargainBoosts,
          reviveTokens: s.bargainBoosts.reviveTokens + 1,
          bossSpawnOffsetMs: s.bargainBoosts.bossSpawnOffsetMs - 120_000,
        },
      }));
    },
  },
  {
    id: 'magnet-greed',
    title: 'Greed',
    description: '+50% pickup radius. Cost: -25% XP gain.',
    rarity: 'common',
    apply: () => {
      useRunStore.setState((s) => ({
        bargainBoosts: {
          ...s.bargainBoosts,
          pickupRadiusMul: s.bargainBoosts.pickupRadiusMul * 1.5,
          xpMul: s.bargainBoosts.xpMul * 0.75,
        },
      }));
    },
  },
  {
    id: 'crit-frenzy',
    title: 'Killer Instinct',
    description: '+30% crit chance. Cost: -30 max HP.',
    rarity: 'rare',
    apply: () => {
      useRunStore.setState((s) => {
        const newMaxHp = Math.max(MAX_HP_FLOOR, s.player.maxHp - 30);
        const newHp = Math.min(s.player.hp, newMaxHp);
        return {
          player: {
            ...s.player,
            critChance: Math.min(1, s.player.critChance + 0.3),
            maxHp: newMaxHp,
            hp: newHp,
          },
        };
      });
    },
  },
  {
    id: 'glass-cannon',
    title: 'Glass Cannon',
    description: '+25% damage. Cost: take 25% more damage.',
    rarity: 'rare',
    apply: () => {
      useRunStore.setState((s) => ({
        bargainBoosts: {
          ...s.bargainBoosts,
          damageMul: s.bargainBoosts.damageMul * 1.25,
          // damageTakenMul stacks multiplicatively; +25% means x1.25.
          damageTakenMul: s.bargainBoosts.damageTakenMul * 1.25,
        },
        // Also bump the visible damageReduction down (1 - x) — we keep the
        // existing player.damageReduction additive system intact; the new
        // damageTakenMul lives only in bargainBoosts and is consumed by
        // collision/damage later.
      }));
    },
  },
  {
    id: 'wind-walker',
    title: 'Wind Walker',
    description: '+30% move speed. Cost: -20% damage.',
    rarity: 'common',
    apply: () => {
      useRunStore.setState((s) => ({
        bargainBoosts: {
          ...s.bargainBoosts,
          moveSpeedMul: s.bargainBoosts.moveSpeedMul * 1.3,
          damageMul: s.bargainBoosts.damageMul * 0.8,
        },
      }));
    },
  },
  {
    id: 'bloodrush',
    title: 'Bloodrush',
    description: 'Heal 50 HP. Cost: -10% max HP.',
    rarity: 'common',
    apply: () => {
      useRunStore.setState((s) => {
        const newMaxHp = Math.max(MAX_HP_FLOOR, Math.round(s.player.maxHp * 0.9));
        const newHp = Math.min(newMaxHp, s.player.hp + 50);
        return {
          player: {
            ...s.player,
            maxHp: newMaxHp,
            hp: newHp,
          },
        };
      });
    },
  },
  {
    id: 'steel-skin-bargain',
    title: 'Stone Skin',
    description: '+15% damage reduction. Cost: -15% attack speed.',
    rarity: 'rare',
    apply: () => {
      useRunStore.setState((s) => ({
        player: {
          ...s.player,
          // Multiplicative damage reduction stacking, mirroring upgrades.ts.
          damageReduction: 1 - (1 - s.player.damageReduction) * (1 - 0.15),
        },
        bargainBoosts: {
          ...s.bargainBoosts,
          attackSpeedMul: s.bargainBoosts.attackSpeedMul * 0.85,
        },
      }));
    },
  },
];

/** Indexed pool for O(1) lookups in case the system layer ever needs them. */
export const BARGAINS: Record<string, BargainDefinition> = {};
for (const b of bargainPool) BARGAINS[b.id] = b;

/** Read-only array view for the system tick (offer roll). */
export const BARGAIN_LIST: ReadonlyArray<BargainDefinition> = bargainPool;

/** Suppress unused-symbol warnings for WEAPONS import (kept for future filters). */
void WEAPONS;
