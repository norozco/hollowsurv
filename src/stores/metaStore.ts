// Persistent across-run state. Backed by localStorage under key 'hollowsurv.save.v1'.
// Owner: Agent C5.
//
// Persistence model (per ARCHITECTURE.md §8 / CONTRACTS.md §3.2):
//   - Zustand `persist` middleware writes JSON to localStorage on every mutation.
//   - Stored shape includes `schemaVersion`. On load, mismatched versions are
//     migrated when possible; otherwise discarded with a console.warn.
//   - `version` is also passed to persist's own version system; we use the
//     explicit field check to keep our own contract stable and to log clearly.
//
// Schema versions:
//   v1 — initial shape (totalRuns/totalWins/bestRunTimeMs/settings/unlocks).
//   v2 — added `playerName: string` for the epithet system. Migration from v1
//        is graceful: keep all v1 fields, add `playerName: ''`. Empty name
//        triggers the name-entry screen on next Start Run.
//   v3 — added `unlockedCharacterIds: string[]` for the character unlock chain.
//        v2 -> v3 seeds it with the starter characters ['ranger', 'brawler'].
//   v4 — added `dailyBestTimeMs: Record<string, number>` for Daily Run mode.
//        v3 -> v4 seeds it with an empty object. Each entry is keyed by
//        `YYYY-MM-DD` (local date) and holds the best survival ms for that
//        day's seeded run.
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const SAVE_KEY = 'hollowsurv.save.v1';
const SCHEMA_VERSION = 4 as const;

/** Default starter characters — unlocked on a fresh save. */
const STARTER_CHARACTER_IDS: readonly string[] = ['ranger', 'brawler'];

export interface MetaState {
  schemaVersion: typeof SCHEMA_VERSION;
  totalRuns: number;
  totalWins: number;
  bestRunTimeMs: number | null;

  /** Player display name shown in announcement + RunSummary.
   *  Empty string = unset; MainMenu asks for it on next Start Run. */
  playerName: string;

  settings: {
    musicVolume: number; // 0..1
    sfxVolume: number; // 0..1
    screenShake: boolean;
  };

  unlocks: {
    weapons: string[]; // weaponIds always available; in v1 holds all weapons
  };

  /** Character ids the player has unlocked. Seeded with starters on first run. */
  unlockedCharacterIds: string[];

  /** Best survival time per daily seed. Key is `todaysKey()` from core/rng
   *  (e.g. '2026-05-07'); value is best survival ms for that date.
   *  Populated only when a daily-mode run completes. */
  dailyBestTimeMs: Record<string, number>;

  // actions
  /**
   * Persist a finished run.
   * @param outcome     Whether the player beat the boss or died.
   * @param timeMs      Run duration in ms (used for best-time + survival unlocks).
   * @param characterId Which character the player used (used for character-specific unlocks).
   * @param daily       True if this was a Daily Run (updates `dailyBestTimeMs`).
   */
  recordRunCompletion: (
    outcome: 'won' | 'lost',
    timeMs: number,
    characterId: string,
    daily?: boolean,
  ) => void;
  setPlayerName: (name: string) => void;
  setMusicVolume: (v: number) => void;
  setSfxVolume: (v: number) => void;
  setScreenShake: (b: boolean) => void;
  resetAll: () => void;
}

type PersistedShape = Pick<
  MetaState,
  | 'schemaVersion'
  | 'totalRuns'
  | 'totalWins'
  | 'bestRunTimeMs'
  | 'playerName'
  | 'settings'
  | 'unlocks'
  | 'unlockedCharacterIds'
  | 'dailyBestTimeMs'
>;

const DEFAULT_PERSISTED: PersistedShape = {
  schemaVersion: SCHEMA_VERSION,
  totalRuns: 0,
  totalWins: 0,
  bestRunTimeMs: null,
  playerName: '',
  settings: { musicVolume: 0.7, sfxVolume: 0.8, screenShake: true },
  unlocks: { weapons: [] },
  unlockedCharacterIds: [...STARTER_CHARACTER_IDS],
  dailyBestTimeMs: {},
};

/**
 * Given the run's outcome and a current unlock list, return the new list with
 * any newly-earned character ids appended (deduped). Pure: easy to unit test.
 *
 * Unlock rules:
 *   - 'witch'      — survived >= 5:00 as Brawler (won OR lost)
 *   - 'sniper'     — survived >= 8:00 as Ranger (won OR lost)
 *   - 'cursed-one' — any run won (boss beaten)
 */
function computeCharacterUnlocks(
  outcome: 'won' | 'lost',
  timeMs: number,
  characterId: string,
  current: readonly string[]
): string[] {
  const earned: string[] = [];
  if (characterId === 'brawler' && timeMs >= 300_000) earned.push('witch');
  if (characterId === 'ranger' && timeMs >= 480_000) earned.push('sniper');
  if (outcome === 'won') earned.push('cursed-one');

  if (earned.length === 0) return [...current];
  const set = new Set(current);
  for (const id of earned) set.add(id);
  return [...set];
}

/**
 * Local-date key used for the dailyBestTimeMs map. Inlined here rather than
 * imported from core/rng to keep the import graph one-way (runStore -> metaStore
 * is fine; core/rng -> metaStore would not be).
 */
function getTodaysKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export const useMetaStore = create<MetaState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PERSISTED,

      recordRunCompletion: (outcome, timeMs, characterId, daily) => {
        const cur = get();
        const totalRuns = cur.totalRuns + 1;
        const totalWins = cur.totalWins + (outcome === 'won' ? 1 : 0);
        // Best = longest survival, regardless of win/lose. For a survivors-like,
        // "how far did you get" is the headline metric — fastest-boss-kill is
        // less interesting because the boss spawns at a fixed 10:00.
        const bestRunTimeMs =
          cur.bestRunTimeMs === null
            ? timeMs
            : Math.max(cur.bestRunTimeMs, timeMs);
        const unlockedCharacterIds = computeCharacterUnlocks(
          outcome,
          timeMs,
          characterId,
          cur.unlockedCharacterIds
        );

        // Daily best tracking: only mutate when the run was a daily seed run.
        // Snapshot today's key at the moment of completion — if a run starts
        // before midnight and ends after midnight, it records to the NEW day
        // (defensible: the player finished it today).
        let dailyBestTimeMs = cur.dailyBestTimeMs;
        if (daily === true) {
          const key = getTodaysKey();
          const prev = dailyBestTimeMs[key];
          if (prev === undefined || timeMs > prev) {
            dailyBestTimeMs = { ...dailyBestTimeMs, [key]: timeMs };
          }
        }

        set({
          totalRuns,
          totalWins,
          bestRunTimeMs,
          unlockedCharacterIds,
          dailyBestTimeMs,
        });
      },

      setPlayerName: (name) => {
        // Trim + cap length defensively here so callers can't bypass the UI cap.
        const cleaned = name.trim().slice(0, 24);
        set({ playerName: cleaned });
      },

      setMusicVolume: (v) => set((s) => ({ settings: { ...s.settings, musicVolume: v } })),
      setSfxVolume: (v) => set((s) => ({ settings: { ...s.settings, sfxVolume: v } })),
      setScreenShake: (b) => set((s) => ({ settings: { ...s.settings, screenShake: b } })),

      resetAll: () => set({ ...DEFAULT_PERSISTED }),
    }),
    {
      name: SAVE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: SCHEMA_VERSION,
      // Only persist data fields, never function refs (defensive — Zustand
      // already strips them, but partialize makes the contract explicit).
      partialize: (state): PersistedShape => ({
        schemaVersion: state.schemaVersion,
        totalRuns: state.totalRuns,
        totalWins: state.totalWins,
        bestRunTimeMs: state.bestRunTimeMs,
        playerName: state.playerName,
        settings: state.settings,
        unlocks: state.unlocks,
        unlockedCharacterIds: state.unlockedCharacterIds,
        dailyBestTimeMs: state.dailyBestTimeMs,
      }),
      // On hydration, validate schemaVersion.
      //   v1 -> v2: add `playerName: ''`.
      //   v2 -> v3: seed `unlockedCharacterIds` with the starters.
      //   v3 -> v4: seed `dailyBestTimeMs` with empty object.
      // Migrations chain through if multiple versions out of date.
      // Discard anything older/newer we don't recognize.
      merge: (persisted, current) => {
        if (!persisted || typeof persisted !== 'object') {
          return { ...current, ...DEFAULT_PERSISTED };
        }
        const v = (persisted as { schemaVersion?: unknown }).schemaVersion;

        if (v === SCHEMA_VERSION) {
          // Current shape — accept as-is.
          return { ...current, ...(persisted as Partial<MetaState>) };
        }

        if (v === 1) {
          // v1 -> v2 -> v3 -> v4: add playerName, seed unlockedCharacterIds,
          // initialize dailyBestTimeMs.
          console.info('[meta] migrating save v1 -> v4 (added playerName, unlockedCharacterIds, dailyBestTimeMs)');
          const migrated: Partial<MetaState> = {
            ...(persisted as Partial<MetaState>),
            playerName: '',
            unlockedCharacterIds: [...STARTER_CHARACTER_IDS],
            dailyBestTimeMs: {},
            schemaVersion: SCHEMA_VERSION,
          };
          return { ...current, ...migrated };
        }

        if (v === 2) {
          // v2 -> v3 -> v4: seed unlockedCharacterIds + dailyBestTimeMs.
          console.info('[meta] migrating save v2 -> v4 (added unlockedCharacterIds, dailyBestTimeMs)');
          const migrated: Partial<MetaState> = {
            ...(persisted as Partial<MetaState>),
            unlockedCharacterIds: [...STARTER_CHARACTER_IDS],
            dailyBestTimeMs: {},
            schemaVersion: SCHEMA_VERSION,
          };
          return { ...current, ...migrated };
        }

        if (v === 3) {
          // v3 -> v4: initialize dailyBestTimeMs.
          console.info('[meta] migrating save v3 -> v4 (added dailyBestTimeMs)');
          const migrated: Partial<MetaState> = {
            ...(persisted as Partial<MetaState>),
            dailyBestTimeMs: {},
            schemaVersion: SCHEMA_VERSION,
          };
          return { ...current, ...migrated };
        }

        // Unknown version — fall back to defaults.
        console.warn(
          `[meta] discarding save with schemaVersion=${String(v)}; expected ${SCHEMA_VERSION}`
        );
        return { ...current, ...DEFAULT_PERSISTED };
      },
    }
  )
);
