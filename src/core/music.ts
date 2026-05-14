// Hollowsurv music layer.
//
// Plays background tracks tied to game state. State machine selects the right
// track based on (phase, selectedHollowId, bossAlive). Crossfades on changes.
//
// Music: "Purgatory Vol 3" by David KBD (CC-BY 4.0).
// Voice trigger isolation: this module is independent from audio.ts. They share
// metaStore.settings volumes but use separate audio elements.

import { eventBus } from './eventBus';
import { useMetaStore } from '../stores/metaStore';
import { useRunStore } from '../stores/runStore';

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

/** Music track keys → file paths (under public/assets/audio/music/). */
const TRACKS: Record<string, string> = {
  menu: `${BASE}assets/audio/music/loop-menu.ogg`,
  early_game: `${BASE}assets/audio/music/02-blood-soaked.ogg`,
  bone_hollow: `${BASE}assets/audio/music/05-bone-grinder.ogg`,
  ember_hollow: `${BASE}assets/audio/music/07-visceral.ogg`,
  tide_hollow: `${BASE}assets/audio/music/04-devoured.ogg`,
  boss_fight: `${BASE}assets/audio/music/08-putrid.ogg`,
  victory: `${BASE}assets/audio/music/loop-victory.ogg`,
  death: `${BASE}assets/audio/music/loop-death.ogg`,
};

const CROSSFADE_MS = 800;

interface ActiveTrack {
  el: HTMLAudioElement;
  key: string;
  targetVolume: number;
}

let current: ActiveTrack | null = null;
let next: ActiveTrack | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let lastBossAlive = false;

function createTrack(key: string, targetVolume: number): ActiveTrack {
  const src = TRACKS[key];
  const el = new Audio(src);
  el.loop = true;
  el.preload = 'auto';
  el.volume = 0;
  // Don't block page load if music fails (e.g. file missing).
  el.play().catch(() => {});
  return { el, key, targetVolume };
}

function stopTrack(track: ActiveTrack): void {
  try {
    track.el.pause();
    track.el.src = '';
  } catch {
    // ignore
  }
}

function clearFade(): void {
  if (fadeTimer !== null) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

/**
 * Crossfade from `current` to a fresh instance of `targetKey`. If the same key
 * is already playing, this is a no-op. Called by subscribeMusic on phase changes.
 */
function transitionTo(targetKey: string): void {
  if (current?.key === targetKey) {
    // already playing the right track — make sure volume tracks setting
    current.targetVolume = readVolume();
    return;
  }
  if (next?.key === targetKey) {
    // Already mid-fade to this — leave it alone.
    return;
  }
  // Start new track at volume 0, fade up. Fade current out.
  const volume = readVolume();
  if (volume <= 0) {
    // Volume off — just swap without fading.
    if (current) stopTrack(current);
    current = null;
    return;
  }
  const incoming = createTrack(targetKey, volume);
  // Browser autoplay policy: play() returns a promise. We catch silently;
  // first user click will unlock it.
  next = incoming;

  clearFade();
  const startMs = performance.now();
  const fromEl = current?.el ?? null;
  const fromStartVol = fromEl?.volume ?? 0;
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (performance.now() - startMs) / CROSSFADE_MS);
    if (fromEl) fromEl.volume = fromStartVol * (1 - t);
    incoming.el.volume = volume * t;
    if (t >= 1) {
      clearFade();
      if (current) stopTrack(current);
      current = incoming;
      next = null;
    }
  }, 30);
}

/** Read the music volume from metaStore, clamped to [0, 1]. */
function readVolume(): number {
  const v = useMetaStore.getState().settings.musicVolume;
  return Math.max(0, Math.min(1, v ?? 0.7));
}

/**
 * Pick the right music track for the current game state. Returns the track key.
 * Boss fight wins over Hollow themes; Hollow themes win over early game; etc.
 */
function pickTrackForState(): string {
  const s = useRunStore.getState();
  const phase = s.phase;
  if (phase === 'menu') return 'menu';
  if (phase === 'won') return 'victory';
  if (phase === 'lost') return 'death';

  // playing / paused / levelup / hollow_select — use gameplay tracks
  if (lastBossAlive) return 'boss_fight';
  switch (s.selectedHollowId) {
    case 'bone': return 'bone_hollow';
    case 'ember': return 'ember_hollow';
    case 'tide': return 'tide_hollow';
    default: return 'early_game';
  }
}

let subscribed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Wire up music. Idempotent. Reacts to phase changes + boss spawn/death. */
export function subscribeMusic(): void {
  if (subscribed) return;
  subscribed = true;

  // Start with menu music. Will be unlocked on first user interaction.
  transitionTo(pickTrackForState());

  // Subscribe to runStore so phase + Hollow changes drive transitions.
  useRunStore.subscribe(() => transitionTo(pickTrackForState()));

  // Boss spawn / death — track explicitly because BossTag isn't in runStore.
  eventBus.on('boss_spawned', () => {
    lastBossAlive = true;
    transitionTo(pickTrackForState());
  });
  eventBus.on('run_won', () => {
    lastBossAlive = false;
    transitionTo(pickTrackForState());
  });
  eventBus.on('run_lost', () => {
    lastBossAlive = false;
    transitionTo(pickTrackForState());
  });

  // Poll musicVolume changes every second so a settings change updates volume
  // live. (Avoids subscribing to metaStore separately for one field.)
  pollTimer = setInterval(() => {
    if (current && !next) {
      current.el.volume = readVolume();
    }
  }, 1000);
}

/** Stop music entirely (e.g. on app teardown). */
export function stopMusic(): void {
  clearFade();
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  if (current) stopTrack(current);
  if (next) stopTrack(next);
  current = null;
  next = null;
}
