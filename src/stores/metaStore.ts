// Persistent across-run state. Backed by localStorage under key 'hollowsurv.save.v1'.
// Owner: Agent C5.
//
// Persistence model (per ARCHITECTURE.md §8 / CONTRACTS.md §3.2):
//   - Zustand `persist` middleware writes JSON to localStorage on every mutation.
//   - Stored shape includes `schemaVersion: 1`. On load, mismatched versions
//     are discarded with a console.warn — no migration in v1 (decision #5).
//   - `version: 1` is also passed to persist's own version system; bumping it
//     also discards. We use the explicit field check to keep our own contract
//     stable and to log clearly.
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

const SAVE_KEY = 'hollowsurv.save.v1';
const SCHEMA_VERSION = 1 as const;

export interface MetaState {
  schemaVersion: typeof SCHEMA_VERSION;
  totalRuns: number;
  totalWins: number;
  bestRunTimeMs: number | null;

  settings: {
    musicVolume: number; // 0..1
    sfxVolume: number; // 0..1
    screenShake: boolean;
  };

  unlocks: {
    weapons: string[]; // weaponIds always available; in v1 holds all weapons
  };

  // actions
  recordRunCompletion: (outcome: 'won' | 'lost', timeMs: number) => void;
  setMusicVolume: (v: number) => void;
  setSfxVolume: (v: number) => void;
  setScreenShake: (b: boolean) => void;
  resetAll: () => void;
}

type PersistedShape = Pick<
  MetaState,
  'schemaVersion' | 'totalRuns' | 'totalWins' | 'bestRunTimeMs' | 'settings' | 'unlocks'
>;

const DEFAULT_PERSISTED: PersistedShape = {
  schemaVersion: SCHEMA_VERSION,
  totalRuns: 0,
  totalWins: 0,
  bestRunTimeMs: null,
  settings: { musicVolume: 0.7, sfxVolume: 0.8, screenShake: true },
  unlocks: { weapons: [] },
};

export const useMetaStore = create<MetaState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PERSISTED,

      recordRunCompletion: (outcome, timeMs) => {
        const cur = get();
        const totalRuns = cur.totalRuns + 1;
        const totalWins = cur.totalWins + (outcome === 'won' ? 1 : 0);
        const bestRunTimeMs =
          outcome === 'won'
            ? cur.bestRunTimeMs === null
              ? timeMs
              : Math.min(cur.bestRunTimeMs, timeMs)
            : cur.bestRunTimeMs;
        set({ totalRuns, totalWins, bestRunTimeMs });
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
        settings: state.settings,
        unlocks: state.unlocks,
      }),
      // On hydration, validate schemaVersion and reject any mismatch.
      // No migration in v1 (CONTRACTS.md decision #5).
      merge: (persisted, current) => {
        if (
          persisted &&
          typeof persisted === 'object' &&
          (persisted as { schemaVersion?: unknown }).schemaVersion === SCHEMA_VERSION
        ) {
          return { ...current, ...(persisted as Partial<MetaState>) };
        }
        if (persisted) {
          const v = (persisted as { schemaVersion?: unknown }).schemaVersion;
          console.warn(
            `[meta] discarding save with schemaVersion=${String(v)}; expected ${SCHEMA_VERSION}`
          );
        }
        return { ...current, ...DEFAULT_PERSISTED };
      },
    }
  )
);
