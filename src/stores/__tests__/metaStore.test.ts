// Migration smoke tests for src/stores/metaStore.ts.
//
// The save schema has gone v1 -> v5 over development. A migration regression
// is the worst kind of bug because it silently nukes existing-player saves on
// deploy.
//
// metaStore uses zustand-persist's `merge` function (not the standard
// `migrate` hook) to handle schemaVersion mismatches: the persist version is
// pinned to the current SCHEMA_VERSION so zustand-persist never trips its
// own version check, but the inner `state.schemaVersion` field is what merge
// inspects to decide how to upconvert. The tests below mirror that wiring.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const SAVE_KEY = 'hollowsurv.save.v1';
const CURRENT_PERSIST_VERSION = 5;

/** Wrap a state blob in the zustand/persist envelope. We always pass the
 *  CURRENT persist version so zustand doesn't short-circuit and call migrate;
 *  the inner `schemaVersion` is what `merge` actually examines. */
function asPersistedBlob(state: Record<string, unknown>): string {
  return JSON.stringify({ state, version: CURRENT_PERSIST_VERSION });
}

describe('metaStore migration', () => {
  beforeEach(() => {
    localStorage.clear();
    // Vitest caches modules across tests; resetModules() forces a fresh
    // metaStore import so persist hydration runs against the localStorage we
    // just seeded.
    vi.resetModules();
  });

  it('preserves v1 fields and defaults v2..v5 additions', async () => {
    const v1State = {
      schemaVersion: 1,
      totalRuns: 42,
      totalWins: 7,
      bestRunTimeMs: 123_456,
      settings: { musicVolume: 0.5, sfxVolume: 0.9, screenShake: false },
      unlocks: { weapons: ['x', 'y'] },
    };
    localStorage.setItem(SAVE_KEY, asPersistedBlob(v1State));

    const { useMetaStore } = await import('../metaStore');
    const s = useMetaStore.getState();

    // v1 fields preserved
    expect(s.totalRuns).toBe(42);
    expect(s.totalWins).toBe(7);
    expect(s.bestRunTimeMs).toBe(123_456);
    expect(s.settings.musicVolume).toBe(0.5);
    expect(s.settings.sfxVolume).toBe(0.9);
    expect(s.settings.screenShake).toBe(false);
    expect(s.unlocks.weapons).toEqual(['x', 'y']);

    // v2 additions: playerName defaulted to ''.
    expect(s.playerName).toBe('');

    // v3 additions: unlockedCharacterIds seeded with starters.
    expect(s.unlockedCharacterIds).toContain('ranger');
    expect(s.unlockedCharacterIds).toContain('brawler');

    // v4 additions: dailyBestTimeMs initialized as empty object.
    expect(s.dailyBestTimeMs).toEqual({});

    // v5 additions: tutorialSeen flipped to true for returning players (they
    // already know how to play).
    expect(s.tutorialSeen).toBe(true);
  });

  it('migrates v3 -> v5 (seeds dailyBestTimeMs and tutorialSeen)', async () => {
    const v3State = {
      schemaVersion: 3,
      totalRuns: 10,
      totalWins: 2,
      bestRunTimeMs: 200_000,
      playerName: 'Lucas',
      settings: { musicVolume: 0.7, sfxVolume: 0.8, screenShake: true },
      unlocks: { weapons: [] },
      unlockedCharacterIds: ['ranger', 'brawler', 'witch'],
    };
    localStorage.setItem(SAVE_KEY, asPersistedBlob(v3State));

    const { useMetaStore } = await import('../metaStore');
    const s = useMetaStore.getState();

    // Pre-existing v3 fields preserved.
    expect(s.playerName).toBe('Lucas');
    expect(s.unlockedCharacterIds).toContain('witch');

    // New v4/v5 fields defaulted.
    expect(s.dailyBestTimeMs).toEqual({});
    expect(s.tutorialSeen).toBe(true);
  });

  it('discards an unknown future schemaVersion (falls back to defaults)', async () => {
    const futureState = {
      schemaVersion: 999,
      totalRuns: 9999,
      totalWins: 9999,
      bestRunTimeMs: 99_999,
      settings: { musicVolume: 0.123, sfxVolume: 0.456, screenShake: true },
      unlocks: { weapons: [] },
    };
    localStorage.setItem(SAVE_KEY, asPersistedBlob(futureState));

    const { useMetaStore } = await import('../metaStore');
    const s = useMetaStore.getState();

    // Unknown version -> defaults. The made-up 9999 must NOT be present.
    expect(s.totalRuns).toBe(0);
    expect(s.totalWins).toBe(0);
    expect(s.bestRunTimeMs).toBeNull();
  });

  it('accepts a current-version save as-is', async () => {
    const v5State = {
      schemaVersion: 5,
      totalRuns: 3,
      totalWins: 1,
      bestRunTimeMs: 60_000,
      playerName: 'Test',
      settings: { musicVolume: 0.8, sfxVolume: 0.8, screenShake: true },
      unlocks: { weapons: [] },
      unlockedCharacterIds: ['ranger', 'brawler', 'witch'],
      dailyBestTimeMs: { '2026-05-13': 120_000 },
      tutorialSeen: true,
    };
    localStorage.setItem(SAVE_KEY, asPersistedBlob(v5State));

    const { useMetaStore } = await import('../metaStore');
    const s = useMetaStore.getState();

    expect(s.playerName).toBe('Test');
    expect(s.unlockedCharacterIds).toContain('witch');
    expect(s.dailyBestTimeMs['2026-05-13']).toBe(120_000);
  });
});
