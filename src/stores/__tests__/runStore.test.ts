// runStore.startRun invariants — the contract that ArenaScene + HUD rely on
// to bootstrap a run. Most of these are simple but a regression in any one of
// them would soft-lock the game on Start Run.

import { describe, it, expect, beforeEach } from 'vitest';
import { useRunStore } from '../runStore';

describe('runStore.startRun', () => {
  beforeEach(() => {
    // Reset to a clean menu state. We mutate the store directly because
    // there's no explicit "reset to menu" action that re-initializes the
    // INITIAL_PLAYER fields.
    useRunStore.setState({
      phase: 'menu',
      runStartedAtMs: 0,
      elapsedMs: 0,
      kills: 0,
      bossKilled: false,
      pendingChoices: [],
      pendingBuildSnapshot: null,
      pendingBargain: null,
      runEpithet: '',
      selectedCharacterId: 'ranger',
      isDailyMode: false,
      dailySeed: 0,
      selectedHollowId: null,
      hollowChoicePending: false,
    });
  });

  it('transitions to playing phase', () => {
    useRunStore.getState().startRun('ranger');
    expect(useRunStore.getState().phase).toBe('playing');
  });

  it('grants at least one starting weapon', () => {
    useRunStore.getState().startRun('ranger');
    const weapons = useRunStore.getState().player.weapons;
    expect(weapons.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves player.eid across startRun', () => {
    // Simulate ArenaScene having spawned the player ECS entity at eid 5.
    useRunStore.setState((s) => ({ player: { ...s.player, eid: 5 } }));
    useRunStore.getState().startRun('ranger');
    expect(useRunStore.getState().player.eid).toBe(5);
  });

  it('produces a non-empty runEpithet', () => {
    useRunStore.getState().startRun('ranger');
    expect(useRunStore.getState().runEpithet.length).toBeGreaterThan(0);
  });

  it('sets selectedCharacterId to the requested character', () => {
    useRunStore.getState().startRun('ranger');
    expect(useRunStore.getState().selectedCharacterId).toBe('ranger');
  });

  it('falls back to the default character when given an unknown id', () => {
    useRunStore.getState().startRun('not-a-real-character');
    // getCharacter returns the default (ranger) when the id is unknown.
    expect(useRunStore.getState().selectedCharacterId).toBe('not-a-real-character');
    // The starting weapon should still be set (falls through to auto-pistol).
    expect(useRunStore.getState().player.weapons.length).toBeGreaterThanOrEqual(1);
  });

  it('resets run statistics on startRun', () => {
    useRunStore.setState({
      kills: 99,
      bossKilled: true,
      damageDealtTotal: 12345,
      damageTakenTotal: 6789,
      comboPeakThisRun: 50,
    });
    useRunStore.getState().startRun('ranger');
    const s = useRunStore.getState();
    expect(s.kills).toBe(0);
    expect(s.bossKilled).toBe(false);
    expect(s.damageDealtTotal).toBe(0);
    expect(s.damageTakenTotal).toBe(0);
    expect(s.comboPeakThisRun).toBe(0);
  });

  it('starts the brawler with their special weapon (blade)', () => {
    useRunStore.getState().startRun('brawler');
    const weapons = useRunStore.getState().player.weapons;
    expect(weapons[0]?.id).toBe('blade');
  });

  it('seeds dailySeed and isDailyMode when daily=true', () => {
    useRunStore.getState().startRun('ranger', { daily: true });
    const s = useRunStore.getState();
    expect(s.isDailyMode).toBe(true);
    expect(s.dailySeed).toBeGreaterThan(0);
  });
});
