// Game-feel: camera shake on boss spawn and on player hit.
//
// Subscribes to `boss_spawned` and `damage_dealt` (where the target is the
// player). Respects `metaStore.settings.screenShake` — when the player toggles
// shake off in the settings, BOTH the player-hit shake and the boss-spawn
// shake are suppressed. (A small concession: the boss-spawn shake is a one-off
// punchline, but the toggle wins so motion-sensitive players have a single
// off switch.)
//
// Scene discovery goes through the `gameContext` singleton.

import type Phaser from 'phaser';

import { eventBus } from '../../core/eventBus';
import { getArenaScene } from '../../core/gameContext';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';

/** Camera-shake parameters per event. */
const SHAKE_BOSS_DURATION_MS = 300;
const SHAKE_BOSS_INTENSITY = 0.012;
const SHAKE_HIT_DURATION_MS = 150;
const SHAKE_HIT_INTENSITY = 0.006;

let cachedScene: Phaser.Scene | null = null;
let unsubscribeBoss: (() => void) | null = null;
let unsubscribeDamage: (() => void) | null = null;

function getActiveScene(): Phaser.Scene | null {
  if (cachedScene && cachedScene.scene && cachedScene.scene.isActive()) {
    return cachedScene;
  }
  cachedScene = null;
  const scene = getArenaScene();
  if (!scene) return null;
  cachedScene = scene;
  return scene;
}

function isShakeEnabled(): boolean {
  return useMetaStore.getState().settings.screenShake;
}

function shakeCamera(durationMs: number, intensity: number): void {
  const scene = getActiveScene();
  if (!scene) return;
  scene.cameras.main.shake(durationMs, intensity);
}

/**
 * Install event subscriptions. Idempotent — calling twice will replace the
 * existing handlers so HMR doesn't end up with duplicate listeners.
 */
export function bindScreenShake(): void {
  unbindScreenShake();
  unsubscribeBoss = eventBus.on('boss_spawned', () => {
    if (!isShakeEnabled()) return;
    shakeCamera(SHAKE_BOSS_DURATION_MS, SHAKE_BOSS_INTENSITY);
  });
  unsubscribeDamage = eventBus.on('damage_dealt', (e) => {
    if (!isShakeEnabled()) return;
    // Only shake when the player is the one taking damage.
    const playerEid = useRunStore.getState().player.eid;
    if (e.target !== playerEid) return;
    shakeCamera(SHAKE_HIT_DURATION_MS, SHAKE_HIT_INTENSITY);
  });
}

/** Tear down subscriptions. Called from scene shutdown. */
export function unbindScreenShake(): void {
  if (unsubscribeBoss) {
    unsubscribeBoss();
    unsubscribeBoss = null;
  }
  if (unsubscribeDamage) {
    unsubscribeDamage();
    unsubscribeDamage = null;
  }
  cachedScene = null;
}
