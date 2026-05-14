// Survivors-style kill-streak overlay. Pure read-side: subscribes to
// runStore.comboCount and renders "×N COMBO" near the timer when combo > 1.
// Flashes/tints on milestones (×10, ×25, ×50, ×100, ×200). Fades as the combo
// expiry approaches so the bar visually "ticks down" toward reset.
//
// Always mounted in App.tsx so any state-change (including a milestone that
// fires inside 'levelup' / 'hollow_select' phase) still surfaces. The component
// returns null when there's nothing to show, mirroring SynergyToast.
//
// Owner: Combo + Onboarding feature.
import type { CSSProperties, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useRunStore } from '../../stores/runStore';

/** Milestone breakpoints. Hitting each one triggers a brief flash overlay. */
const MILESTONES = [10, 25, 50, 100, 200] as const;

/** Window after a kill before the combo expires. Mirrors COMBO_WINDOW_MS in
 *  runStore (kept in sync by hand — both small constants, both touched
 *  together when re-balancing). Used here only for the fade-out animation. */
const COMBO_WINDOW_MS = 2000;

/** Combo counter container — fixed to the top-center under the timer. */
const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  top: 52,
  left: '50%',
  transform: 'translateX(-50%)',
  pointerEvents: 'none',
  zIndex: 11,
  fontFamily: 'system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
};

/** Base text style — overridden by tier-tinted variants below. */
const TEXT_STYLE: CSSProperties = {
  fontWeight: 800,
  letterSpacing: 3,
  textShadow:
    '0 0 14px rgba(255, 200, 90, 0.85), 0 2px 6px rgba(0, 0, 0, 0.9), 0 0 2px rgba(255, 255, 255, 0.6)',
};

/** Milestone flash overlay. Sits over the whole screen at high z-index for ~600ms. */
const FLASH_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 72,
  fontWeight: 900,
  letterSpacing: 8,
  fontFamily: 'system-ui, sans-serif',
  textShadow:
    '0 0 30px rgba(255, 80, 80, 0.95), 0 0 10px rgba(255, 255, 255, 0.8)',
  animation: 'comboFlash 750ms ease-out forwards',
};

const KEYFRAMES_CSS = `
@keyframes comboFlash {
  0%   { opacity: 0; transform: scale(0.6); }
  20%  { opacity: 1; transform: scale(1.15); }
  60%  { opacity: 1; transform: scale(1.00); }
  100% { opacity: 0; transform: scale(0.95); }
}
`;

/**
 * Pick a font-size + color for the current combo size. Bigger combos read more
 * prominently (gold for early streaks, red for high-tier).
 */
function styleForCombo(combo: number): CSSProperties {
  if (combo >= 100) {
    return { fontSize: 36, color: '#ff5a5a' };
  }
  if (combo >= 50) {
    return { fontSize: 30, color: '#ff9a3c' };
  }
  if (combo >= 25) {
    return { fontSize: 26, color: '#ffd24a' };
  }
  if (combo >= 10) {
    return { fontSize: 22, color: '#ffe16a' };
  }
  return { fontSize: 18, color: '#dddddd' };
}

interface FlashState {
  /** React key so back-to-back milestones don't reuse the same animation. */
  key: number;
  combo: number;
}

export function ComboCounter(): ReactElement | null {
  const combo = useRunStore((s) => s.comboCount);
  const expiresAtMs = useRunStore((s) => s.comboExpiresAtMs);
  const elapsedMs = useRunStore((s) => s.elapsedMs);

  // Milestone tracking. `lastSeenComboRef` lets us detect *increments past*
  // a milestone (not a re-render at the same combo) so the flash only fires
  // once per crossing. We also reset to 0 when the combo drops to 0 — that's
  // how a new run / decay-reset arms the next set of milestones.
  const lastSeenComboRef = useRef(0);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const flashKeyRef = useRef(1);

  useEffect(() => {
    const prev = lastSeenComboRef.current;
    lastSeenComboRef.current = combo;
    if (combo === 0) return;
    if (combo <= prev) return;
    // Did we cross any milestone between (prev, combo]?
    for (const m of MILESTONES) {
      if (prev < m && combo >= m) {
        const key = flashKeyRef.current++;
        setFlash({ key, combo: m });
        window.setTimeout(() => {
          setFlash((cur) => (cur && cur.key === key ? null : cur));
        }, 800);
        break; // one flash per render, even if multiple were crossed
      }
    }
  }, [combo]);

  if (combo < 2) {
    // Hide entirely below 2 — a "x1 COMBO" is misleading on the first kill.
    return flash ? (
      <>
        <style>{KEYFRAMES_CSS}</style>
        <div style={FLASH_STYLE} key={flash.key}>
          ×{flash.combo} COMBO!
        </div>
      </>
    ) : null;
  }

  // Fade as expiry approaches. We compute a 0..1 opacity based on remaining
  // window; when there's 600ms or less left, we start drooping.
  const remaining = Math.max(0, expiresAtMs - elapsedMs);
  const fadeStartMs = 600;
  const opacity = remaining >= fadeStartMs ? 1 : Math.max(0.3, remaining / fadeStartMs);
  const remainingFrac = Math.max(0, Math.min(1, remaining / COMBO_WINDOW_MS));
  const tierStyle = styleForCombo(combo);

  return (
    <>
      <style>{KEYFRAMES_CSS}</style>
      <div style={{ ...ROOT_STYLE, opacity }}>
        <div style={{ ...TEXT_STYLE, ...tierStyle }}>×{combo} COMBO</div>
        {/* Slim drain bar showing how much of the window is left. */}
        <div
          style={{
            width: 60,
            height: 2,
            background: 'rgba(0, 0, 0, 0.5)',
            borderRadius: 1,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${remainingFrac * 100}%`,
              height: '100%',
              background: tierStyle.color ?? '#fff',
              transition: 'width 80ms linear',
            }}
          />
        </div>
      </div>
      {flash ? (
        <div style={FLASH_STYLE} key={flash.key}>
          ×{flash.combo} COMBO!
        </div>
      ) : null}
    </>
  );
}
