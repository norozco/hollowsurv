// First-time onboarding overlay. Three contextual hints during the player's
// first run, gated by `metaStore.tutorialSeen`.
//
//   1. Run start (T+~1s):        "WASD to move — your weapon fires automatically"
//   2. First level-up:           "Press 1, 2, or 3 to pick" (highlighted, near cards)
//   3. First Devil's Bargain:    Pulsing "E to accept" prompt above the offer
//
// At end-of-first-run (any outcome — won OR lost OR back-to-menu), we call
// metaStore.setTutorialSeen(true) so the hints never appear again.
//
// Always mounted in App.tsx. Renders null when `tutorialSeen` is true, so the
// total cost for returning players is one selector subscription.
//
// Owner: Combo + Onboarding feature.
import type { CSSProperties, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';

/** Delay before showing the first hint after a run starts. Lets the run
 *  announcement ("Lucas, you are the Forsaken.") finish its fade. */
const HINT_1_DELAY_MS = 1200;
/** How long Hint 1 (WASD prompt) stays visible. */
const HINT_1_LIFESPAN_MS = 5000;

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 25,
  fontFamily: 'system-ui, sans-serif',
};

const WASD_HINT_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 96,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '12px 20px',
  background: 'rgba(0, 0, 0, 0.7)',
  color: '#f4e8d0',
  border: '1px solid rgba(255, 220, 160, 0.55)',
  borderRadius: 6,
  fontSize: 15,
  letterSpacing: 1,
  textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)',
  boxShadow: '0 0 18px rgba(255, 200, 120, 0.25)',
  animation: 'onboardFade 5000ms ease-out forwards',
};

const LEVELUP_HINT_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 120,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '10px 18px',
  background: 'rgba(20, 30, 60, 0.85)',
  color: '#cfd6ff',
  border: '1px solid rgba(180, 200, 255, 0.7)',
  borderRadius: 6,
  fontSize: 16,
  fontWeight: 700,
  letterSpacing: 2,
  textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)',
  boxShadow: '0 0 22px rgba(120, 160, 255, 0.45)',
  animation: 'onboardPulse 1400ms ease-in-out infinite',
};

const BARGAIN_HINT_STYLE: CSSProperties = {
  position: 'absolute',
  bottom: 240, // sits above the BargainOverlay tablet (bottom: 32 + ~200 height)
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '12px 26px',
  background: 'linear-gradient(180deg, rgba(60, 20, 20, 0.92), rgba(40, 10, 10, 0.92))',
  color: '#ffd28a',
  border: '2px solid rgba(255, 120, 60, 0.85)',
  borderRadius: 8,
  fontSize: 22,
  fontWeight: 800,
  letterSpacing: 3,
  textShadow: '0 0 10px rgba(255, 120, 60, 0.85), 0 2px 4px rgba(0, 0, 0, 0.95)',
  boxShadow: '0 0 22px rgba(255, 120, 60, 0.6)',
  animation: 'onboardPulse 1200ms ease-in-out infinite',
};

const KEYFRAMES_CSS = `
@keyframes onboardFade {
  0%   { opacity: 0; transform: translate(-50%, 8px); }
  10%  { opacity: 1; transform: translate(-50%, 0); }
  85%  { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, -4px); }
}
@keyframes onboardPulse {
  0%   { transform: translate(-50%, 0)   scale(1.00); filter: brightness(1.00); }
  50%  { transform: translate(-50%, -3px) scale(1.04); filter: brightness(1.18); }
  100% { transform: translate(-50%, 0)   scale(1.00); filter: brightness(1.00); }
}
`;

export function OnboardingHints(): ReactElement | null {
  const tutorialSeen = useMetaStore((s) => s.tutorialSeen);
  const setTutorialSeen = useMetaStore((s) => s.setTutorialSeen);

  const phase = useRunStore((s) => s.phase);
  const runStartedAtMs = useRunStore((s) => s.runStartedAtMs);
  const pendingBargainId = useRunStore((s) => s.pendingBargain?.id ?? null);

  // Local per-run state for which hints have fired. We don't persist these —
  // a returning player has `tutorialSeen === true` and won't enter this branch.
  const [showWasd, setShowWasd] = useState(false);
  const [hint1Done, setHint1Done] = useState(false);
  const [hint2Done, setHint2Done] = useState(false);
  const [hint3Done, setHint3Done] = useState(false);

  /** Run id we've already armed hint timers for — prevents double-arm on HMR. */
  const armedForRunRef = useRef<number>(0);
  /** Set true once we observe a run start so we can mark tutorialSeen on its end. */
  const sawRunStartRef = useRef<boolean>(false);

  // ---- Hint 1: arm a delayed "WASD" prompt when a run begins ----
  useEffect(() => {
    if (tutorialSeen) return;
    if (phase !== 'playing') return;
    if (runStartedAtMs <= 0) return;
    if (armedForRunRef.current === runStartedAtMs) return; // already armed
    armedForRunRef.current = runStartedAtMs;
    sawRunStartRef.current = true;
    if (hint1Done) return;
    const showTimer = window.setTimeout(() => {
      setShowWasd(true);
    }, HINT_1_DELAY_MS);
    const hideTimer = window.setTimeout(() => {
      setShowWasd(false);
      setHint1Done(true);
    }, HINT_1_DELAY_MS + HINT_1_LIFESPAN_MS);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [tutorialSeen, phase, runStartedAtMs, hint1Done]);

  // ---- Hint 2 + 3: mark each as "seen" once the phase/offer clears ----
  // We watch phase transitions: when phase leaves 'levelup' after we've shown
  // the hint, mark it done. Similarly for pendingBargain becoming null.
  const lastPhaseRef = useRef(phase);
  useEffect(() => {
    if (tutorialSeen) {
      lastPhaseRef.current = phase;
      return;
    }
    const prev = lastPhaseRef.current;
    if (prev === 'levelup' && phase !== 'levelup' && !hint2Done) {
      setHint2Done(true);
    }
    lastPhaseRef.current = phase;
  }, [phase, tutorialSeen, hint2Done]);

  const lastBargainIdRef = useRef(pendingBargainId);
  useEffect(() => {
    if (tutorialSeen) {
      lastBargainIdRef.current = pendingBargainId;
      return;
    }
    const prev = lastBargainIdRef.current;
    if (prev !== null && pendingBargainId === null && !hint3Done) {
      setHint3Done(true);
    }
    lastBargainIdRef.current = pendingBargainId;
  }, [pendingBargainId, tutorialSeen, hint3Done]);

  // ---- End-of-run: flip tutorialSeen so future runs skip the hints ----
  useEffect(() => {
    if (tutorialSeen) return;
    if (!sawRunStartRef.current) return;
    // Run ended (any outcome) OR player backed out to menu mid-run.
    if (phase === 'won' || phase === 'lost' || phase === 'menu') {
      setTutorialSeen(true);
    }
  }, [phase, tutorialSeen, setTutorialSeen]);

  if (tutorialSeen) return null;

  // Determine which (if any) hint to render right now. Mutually exclusive:
  // Bargain > LevelUp > WASD, so a higher-priority hint doesn't get masked.
  const showBargainHint =
    !hint3Done && pendingBargainId !== null;
  const showLevelUpHint =
    !hint2Done && phase === 'levelup' && !showBargainHint;
  const showWasdHint = showWasd && !showLevelUpHint && !showBargainHint;

  if (!showBargainHint && !showLevelUpHint && !showWasdHint) {
    return null;
  }

  return (
    <>
      <style>{KEYFRAMES_CSS}</style>
      <div style={ROOT_STYLE}>
        {showWasdHint ? (
          <div style={WASD_HINT_STYLE} role="status">
            WASD to move — your weapon fires automatically
          </div>
        ) : null}
        {showLevelUpHint ? (
          <div style={LEVELUP_HINT_STYLE} role="status">
            Press 1, 2, or 3 to pick
          </div>
        ) : null}
        {showBargainHint ? (
          <div style={BARGAIN_HINT_STYLE} role="status">
            Press E to accept — or wait to pass
          </div>
        ) : null}
      </div>
    </>
  );
}
