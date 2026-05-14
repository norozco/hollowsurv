// Hollowsurv audio layer.
//
// Loads voice clips (the "Hollow Speaks" pack) once at module init and plays
// them on event-bus triggers. HTMLAudioElement based — simpler than Phaser's
// SoundManager for one-shot voice cues. Volume from useMetaStore.settings.sfxVolume.
//
// Voice pooling: most clips are 1–2 seconds; some longer phrases run 3-4s. We
// preallocate POOL_SIZE <audio> elements per clip and round-robin through them
// so overlapping triggers don't cut each other off, without the cloneNode
// allocation we used to do every play.
//
// Voice ducking: each playVoice() also tells music.ts to drop the music to
// ~35% for the clip's duration (with smooth attack/release) so the line is
// audible without yanking the music away.

import { eventBus } from './eventBus';
import { duckMusicFor } from './music';
import { useMetaStore } from '../stores/metaStore';
import { useRunStore } from '../stores/runStore';

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

/** Map trigger key -> WAV path under public/assets/audio/voice/. */
const VOICE_CLIPS: Record<string, string> = {
  welcome: `${BASE}assets/audio/voice/welcome.wav`,
  first_kill: `${BASE}assets/audio/voice/first_kill.wav`,
  level_up: `${BASE}assets/audio/voice/level_up.wav`,
  low_hp: `${BASE}assets/audio/voice/low_hp.wav`,
  heal_pack: `${BASE}assets/audio/voice/heal_pack.wav`,
  boss_spawn: `${BASE}assets/audio/voice/boss_spawn.wav`,
  big_laugh: `${BASE}assets/audio/voice/big_laugh.wav`,
  bargain_offer: `${BASE}assets/audio/voice/bargain_offer.wav`,
  bargain_accept: `${BASE}assets/audio/voice/bargain_accept.wav`,
  death: `${BASE}assets/audio/voice/death.wav`,
  victory: `${BASE}assets/audio/voice/victory.wav`,
  hollow_choice: `${BASE}assets/audio/voice/hollow_choice.wav`,
  boss_attack: `${BASE}assets/audio/voice/boss_attack.wav`,
};

/**
 * Voice clip pool. For each clip key we keep up to POOL_SIZE pre-created
 * <audio> elements. playVoice picks the first one that's idle (paused or
 * ended); if all are mid-play, it restarts the oldest (index 0) — which is a
 * cheap "override the longest-running" policy. This replaces the previous
 * cloneNode-per-play approach, which created garbage every fire and made
 * GC-driven jitter audible on rapid triggers (level_up, low_hp, first_kill).
 */
const POOL_SIZE = 3;
const pools: Map<string, HTMLAudioElement[]> = new Map();
/** Master used only to read `duration` once it's known. */
const masters: Map<string, HTMLAudioElement> = new Map();

function ensurePool(key: string): HTMLAudioElement[] | null {
  let pool = pools.get(key);
  if (pool) return pool;
  const src = VOICE_CLIPS[key];
  if (!src) return null;
  pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const el = new Audio(src);
    el.preload = 'auto';
    el.volume = 0.8;
    pool.push(el);
  }
  pools.set(key, pool);
  // The first entry doubles as the "master" we read duration from.
  masters.set(key, pool[0]!);
  return pool;
}

/** Preload every clip's pool. Call once on startup so first-play has no lag. */
export function preloadVoice(): void {
  for (const key of Object.keys(VOICE_CLIPS)) ensurePool(key);
}

/**
 * Pick a free entry from the pool. If every entry is mid-play, we restart
 * index 0 — by convention the oldest still-playing instance. (We always
 * rotate so the next non-idle pick still hits the longest-running one.)
 */
function acquirePoolEntry(pool: HTMLAudioElement[]): HTMLAudioElement {
  for (let i = 0; i < pool.length; i++) {
    const el = pool[i]!;
    if (el.paused || el.ended) return el;
  }
  // All busy — override index 0 (oldest), then rotate it to the back so the
  // *next* override picks what was previously index 1.
  const el = pool[0]!;
  pool.shift();
  pool.push(el);
  try { el.pause(); el.currentTime = 0; } catch { /* ignore */ }
  return el;
}

/**
 * Play a clip by trigger key. Uses a pre-allocated pool of 3 elements per
 * clip (rather than cloneNode-per-play) to avoid GC pressure. Volume scales
 * by metaStore.settings.sfxVolume. Also signals music.ts to duck the music
 * for the clip's duration so the voice line is audible.
 */
export function playVoice(key: string): void {
  const pool = ensurePool(key);
  if (!pool) return;
  const volume = useMetaStore.getState().settings.sfxVolume ?? 0.8;
  if (volume <= 0) return;
  const clip = acquirePoolEntry(pool);
  clip.volume = Math.max(0, Math.min(1, volume * 0.8));
  try { clip.currentTime = 0; } catch { /* some browsers throw if not yet loaded */ }
  // Browsers throw if play() runs before user interaction. We swallow silently —
  // the next event (after the player clicks Start Run) will succeed.
  clip.play().catch(() => {});

  // Tell music.ts to duck under us. Use the master's duration when known
  // (HTMLAudioElement.duration is in seconds); fall back to 2000ms before
  // metadata loads. Most demon-lord clips are 1–2s; longer phrases will keep
  // ducking through their full length once metadata arrives on subsequent plays.
  const master = masters.get(key);
  const durSec = master?.duration ?? 0;
  const durMs = Number.isFinite(durSec) && durSec > 0 ? durSec * 1000 : 2000;
  duckMusicFor(durMs);
}

// --- pending-voice queue (pause-aware delayed plays) ----------------------
//
// Naive setTimeout fires through pause — a queued big_laugh would scream
// while the player is reading the pause menu, and stale delays leak between
// runs. We track pending plays here with a remaining game-time budget and
// only tick that budget down while phase === 'playing'.

interface PendingVoice {
  key: string;
  remainingGameMs: number;
}

const pending: PendingVoice[] = [];
let _lastTick = performance.now();
let _pumpIntervalId: ReturnType<typeof setInterval> | null = null;

function pumpPending(): void {
  const now = performance.now();
  const dt = now - _lastTick;
  _lastTick = now;
  const phase = useRunStore.getState().phase;
  // Freeze on pause / levelup / hollow_select / menu / won / lost. Only
  // 'playing' advances the game clock for delayed voice cues.
  if (phase !== 'playing') return;
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i];
    if (!p) continue;
    p.remainingGameMs -= dt;
    if (p.remainingGameMs <= 0) {
      playVoice(p.key);
      pending.splice(i, 1);
    }
  }
}

function ensurePumpRunning(): void {
  if (_pumpIntervalId !== null) return;
  _lastTick = performance.now();
  _pumpIntervalId = setInterval(pumpPending, 80);
}

/**
 * Queue a voice clip to play `delayMs` of GAME time from now. The delay only
 * counts down while phase === 'playing'; pausing freezes the queue. Use this
 * instead of setTimeout for any voice cue that follows a gameplay event.
 */
function scheduleVoice(key: string, delayMs: number): void {
  pending.push({ key, remainingGameMs: delayMs });
}

// --- run-state tracking for one-shot triggers -----------------------------

let firstKillFired = false;
let lowHpFired = false;

function resetRunTriggers(): void {
  firstKillFired = false;
  lowHpFired = false;
  // Clear any voice still queued from a previous run — otherwise a queued
  // big_laugh from a prior boss spawn could leak into the next run.
  pending.length = 0;
  _lastTick = performance.now();
}

/**
 * Subscribe to game events and play the matching voice clips. Idempotent —
 * safe to call from a HMR re-init.
 *
 * Bundle/network optimisation: we no longer eagerly call preloadVoice() here.
 * Doing so kicked off ~6.5 MB of WAV downloads on every page load before the
 * user had even clicked anything, blocking the title screen behind audio
 * fetches. Instead we wait for the first user pointer/key interaction and
 * preload then — browsers also block <audio>.play() until that point anyway,
 * so there is no perceptible delay on the first cue.
 */
let subscribed = false;
export function subscribeVoice(): void {
  if (subscribed) return;
  subscribed = true;
  ensurePumpRunning();

  // First-interaction preload: registers a one-shot listener that fires when
  // the user clicks/touches/keys anywhere. Whichever event lands first wins;
  // each option uses { once: true } so we don't double-preload.
  const onFirstInteraction = () => preloadVoice();
  window.addEventListener('pointerdown', onFirstInteraction, { once: true });
  window.addEventListener('keydown', onFirstInteraction, { once: true });
  window.addEventListener('touchstart', onFirstInteraction, { once: true, passive: true });

  eventBus.on('character_selected', () => {
    resetRunTriggers();
    playVoice('welcome');
  });

  eventBus.on('enemy_killed', () => {
    if (!firstKillFired) {
      firstKillFired = true;
      playVoice('first_kill');
    }
  });

  eventBus.on('level_up', () => playVoice('level_up'));

  // Low-HP warning: fires once when HP drops below 30%.
  eventBus.on('damage_dealt', (e) => {
    const player = useRunStore.getState().player;
    if (e.target !== player.eid) return;
    if (player.maxHp <= 0) return;
    const frac = player.hp / player.maxHp;
    if (!lowHpFired && frac > 0 && frac <= 0.3) {
      lowHpFired = true;
      playVoice('low_hp');
    } else if (lowHpFired && frac > 0.5) {
      // Reset so the warning fires again if the player heals and dips low again.
      lowHpFired = false;
    }
  });

  eventBus.on('pickup_collected', (e) => {
    if (e.kind === 'heal') playVoice('heal_pack');
  });

  eventBus.on('boss_spawned', () => {
    playVoice('boss_spawn');
    // Pause-aware: only ticks down during phase === 'playing'. If the player
    // pauses immediately after the boss spawns the laugh waits for resume.
    scheduleVoice('big_laugh', 1200);
  });

  eventBus.on('run_lost', () => playVoice('death'));
  eventBus.on('run_won', () => playVoice('victory'));

  // Bargain hooks — wired alongside the Devil's Bargain system.
  eventBus.on('bargain_offered', () => playVoice('bargain_offer'));
  eventBus.on('bargain_accepted', () => playVoice('bargain_accept'));

  // Hollow choice — fires when the 5:00 mark presents the portal screen.
  eventBus.on('hollow_choice_offered', () => playVoice('hollow_choice'));
}
