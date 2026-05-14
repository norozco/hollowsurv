// Devil's-Bargain system tick.
// Owner: Integration agent (Devil's Bargain).
//
// Every BARGAIN_INTERVAL_MS of run-time, if no offer is currently pending and
// the run is in the 'playing' phase, pick a random offer from BARGAIN_LIST and
// publish it via runStore.setState({ pendingBargain }). The React BargainOverlay
// subscribes to that field and surfaces the UI.
//
// The offer auto-passes after BARGAIN_OFFER_DURATION_MS. We track that timer
// here in module-level state because the system tick is the only consumer.
// The React side accepts/passes by calling the runStore actions directly so
// keyboard handling sits in one obvious place.
//
// The system is keyed off runStore.elapsedMs rather than dtMs accumulation so
// it stays synchronized with the visible HUD timer even if ArenaScene briefly
// pauses or HMR re-creates the scene.
//
// Module state lifecycle: lastOfferAtMs and offerExpiresAtMs reset whenever we
// detect a fresh runStartedAtMs (the run restarted). pendingBargain transitions
// from non-null -> null (accept/pass/external clear) reset the expiry timer.

import { useRunStore } from '../../stores/runStore';
import { BARGAIN_LIST, type BargainDefinition } from '../../content/bargains';
import { eventBus } from '../../core/eventBus';
import type { World } from '../world';

/** Time between successive bargain offers, in ms of run-time. */
const BARGAIN_INTERVAL_MS = 90_000;
/** How long the player has to press E. After this, auto-pass. */
const BARGAIN_OFFER_DURATION_MS = 10_000;
/** Skip offers in the first few seconds of a run so it doesn't fire instantly. */
const BARGAIN_FIRST_OFFER_MIN_ELAPSED_MS = 30_000;

// --- module state ---------------------------------------------------------

/** runStartedAtMs of the run we are currently tracking. Detect restart on change. */
let trackedRunStartedAtMs = 0;
/** performance.now() ms at which the active offer auto-expires. 0 = no active offer. */
let offerExpiresAtPerfMs = 0;
/** Most recent run-time at which we presented an offer. Reset on run restart. */
let lastOfferAtElapsedMs = 0;

function resetForNewRun(runStartedAtMs: number): void {
  trackedRunStartedAtMs = runStartedAtMs;
  offerExpiresAtPerfMs = 0;
  lastOfferAtElapsedMs = 0;
}

/**
 * Pick a random eligible bargain from the pool. Eligibility filter applies
 * each bargain's canOffer() (e.g. "+atk speed at cost of weapon slot" needs
 * 2+ weapons). Returns null if no bargain is eligible (extremely unlikely).
 */
function pickBargain(): BargainDefinition | null {
  const eligible = BARGAIN_LIST.filter((b) => !b.canOffer || b.canOffer());
  if (eligible.length === 0) return null;
  const idx = Math.floor(Math.random() * eligible.length);
  return eligible[idx] ?? null;
}

/**
 * Tick the bargain system. Called from ArenaScene.update() once per frame.
 * dtMs is unused — we drive everything from runStore.elapsedMs and
 * performance.now() so the system stays synchronized with the visible timer.
 */
export function bargainSystem(_world: World, _dtMs: number): void {
  const state = useRunStore.getState();
  if (state.phase !== 'playing') return;

  // Detect run-restart and reset module state.
  if (state.runStartedAtMs !== trackedRunStartedAtMs) {
    resetForNewRun(state.runStartedAtMs);
  }

  // 1. Auto-pass expired offer.
  if (state.pendingBargain && offerExpiresAtPerfMs > 0) {
    if (performance.now() >= offerExpiresAtPerfMs) {
      offerExpiresAtPerfMs = 0;
      // passBargain emits 'bargain_passed' and clears pendingBargain.
      state.passBargain();
      return;
    }
  } else if (!state.pendingBargain && offerExpiresAtPerfMs > 0) {
    // The offer was cleared externally (accept/pass via UI). Reset timer.
    offerExpiresAtPerfMs = 0;
  }

  // 2. Don't fire another offer while one is pending.
  if (state.pendingBargain) return;

  // 3. Gate: respect the first-offer minimum elapsed time, then the interval.
  const elapsed = state.elapsedMs;
  if (elapsed < BARGAIN_FIRST_OFFER_MIN_ELAPSED_MS) return;

  const sinceLast = elapsed - lastOfferAtElapsedMs;
  // First offer fires once elapsed reaches BARGAIN_INTERVAL_MS; subsequent
  // every BARGAIN_INTERVAL_MS after.
  if (lastOfferAtElapsedMs === 0) {
    if (elapsed < BARGAIN_INTERVAL_MS) return;
  } else if (sinceLast < BARGAIN_INTERVAL_MS) {
    return;
  }

  // 4. Pick + present.
  const bargain = pickBargain();
  if (!bargain) return;

  lastOfferAtElapsedMs = elapsed;
  offerExpiresAtPerfMs = performance.now() + BARGAIN_OFFER_DURATION_MS;
  useRunStore.setState({ pendingBargain: bargain });
  eventBus.emit({ type: 'bargain_offered', bargainId: bargain.id, title: bargain.title });
}

/** Test/dev hook: expose remaining ms for UI countdowns. 0 if no active offer. */
export function bargainTimeRemainingMs(): number {
  if (offerExpiresAtPerfMs <= 0) return 0;
  return Math.max(0, offerExpiresAtPerfMs - performance.now());
}

/** Total offer duration in ms — exported so the UI can compute progress %. */
export const BARGAIN_OFFER_DURATION_MS_EXPORT = BARGAIN_OFFER_DURATION_MS;
