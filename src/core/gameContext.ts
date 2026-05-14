// Game / scene context singleton.
//
// Replaces the historical `globalThis.__game` lookup pattern that several
// systems (autoAttack, spawnDirector, xp, damageNumbers, screenShake,
// hollowMechanics, collision) were using to grab the active Phaser scene.
//
// The previous pattern worked but was brittle hidden coupling: any module
// could read or write `globalThis.__game` and Type tooling couldn't see it.
// This module is the explicit handle: `main.tsx` calls `setGame()` once at
// boot, and any system that needs the scene calls `getArenaScene()`.
//
// `globalThis.__game` is intentionally still written by `main.tsx` so the
// dev-console workflow that pokes at `__game` from devtools continues to
// work. No production code should read it directly anymore.
import type Phaser from 'phaser';

let _game: Phaser.Game | null = null;

export function setGame(game: Phaser.Game): void {
  _game = game;
}

export function getGame(): Phaser.Game | null {
  return _game;
}

/**
 * Resolve the active ArenaScene. Returns null when:
 *   - the game hasn't booted yet (`setGame` hasn't been called),
 *   - ArenaScene isn't registered with the scene manager,
 *   - ArenaScene is registered but not currently active (e.g. we're on the
 *     boot scene or the run hasn't started).
 *
 * Callers should treat null as a no-op signal — most use sites are
 * fire-and-forget visual helpers (damage numbers, aura rings) that simply
 * skip when the scene isn't available.
 */
export function getArenaScene(): Phaser.Scene | null {
  if (!_game) return null;
  const scene = _game.scene.getScene('ArenaScene');
  if (!scene) return null;
  if (!_game.scene.isActive('ArenaScene')) return null;
  return scene;
}
