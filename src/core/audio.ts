// Hollowsurv audio layer.
//
// Loads voice clips (the "Hollow Speaks" pack) once at module init and plays
// them on event-bus triggers. HTMLAudioElement based — simpler than Phaser's
// SoundManager for one-shot voice cues. Volume from useMetaStore.settings.sfxVolume.
//
// Voice ducking: most clips are 1–2 seconds; some longer phrases run 3-4s. We
// use one <audio> element per clip, cloned on play, so overlapping triggers
// don't cut each other off.

import { eventBus } from './eventBus';
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

/** Cached HTMLAudioElement masters (preloaded). Cloned on play. */
const masters: Map<string, HTMLAudioElement> = new Map();

function ensureLoaded(key: string): HTMLAudioElement | null {
  let master = masters.get(key);
  if (master) return master;
  const src = VOICE_CLIPS[key];
  if (!src) return null;
  master = new Audio(src);
  master.preload = 'auto';
  master.volume = 0.8;
  masters.set(key, master);
  return master;
}

/** Preload every clip. Call once on startup so first-play has no lag. */
export function preloadVoice(): void {
  for (const key of Object.keys(VOICE_CLIPS)) ensureLoaded(key);
}

/**
 * Play a clip by trigger key. Clones the master element so overlapping plays
 * don't interrupt each other. Volume scales by metaStore.settings.sfxVolume.
 */
export function playVoice(key: string): void {
  const master = ensureLoaded(key);
  if (!master) return;
  const volume = useMetaStore.getState().settings.sfxVolume ?? 0.8;
  if (volume <= 0) return;
  const clip = master.cloneNode(true) as HTMLAudioElement;
  clip.volume = Math.max(0, Math.min(1, volume * 0.8));
  // Browsers throw if play() runs before user interaction. We swallow silently —
  // the next event (after the player clicks Start Run) will succeed.
  clip.play().catch(() => {});
}

// --- run-state tracking for one-shot triggers -----------------------------

let firstKillFired = false;
let lowHpFired = false;

function resetRunTriggers(): void {
  firstKillFired = false;
  lowHpFired = false;
}

/**
 * Subscribe to game events and play the matching voice clips. Idempotent —
 * safe to call from a HMR re-init.
 */
let subscribed = false;
export function subscribeVoice(): void {
  if (subscribed) return;
  subscribed = true;
  preloadVoice();

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
    setTimeout(() => playVoice('big_laugh'), 1200);
  });

  eventBus.on('run_lost', () => playVoice('death'));
  eventBus.on('run_won', () => playVoice('victory'));

  // Bargain hooks — wired alongside the Devil's Bargain system.
  eventBus.on('bargain_offered', () => playVoice('bargain_offer'));
  eventBus.on('bargain_accepted', () => playVoice('bargain_accept'));

  // Hollow choice — fires when the 5:00 mark presents the portal screen.
  eventBus.on('hollow_choice_offered', () => playVoice('hollow_choice'));
}
