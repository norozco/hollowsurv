// Devil's-Bargain overlay.
// Owner: Integration agent (Devil's Bargain).
//
// Subscribes to runStore.pendingBargain. When non-null, renders a glowing
// stone tablet near the bottom-center of the screen showing the offer + a
// 10-second countdown bar. E accepts, Escape/Space passes. Auto-dismisses
// when pendingBargain becomes null.
//
// Always mounted — the component manages its own visibility based on
// pendingBargain. Z-order sits below the level-up modal (zIndex 15) so a
// concurrent level-up still takes priority.
//
// Visual notes: the stone tablet is rendered as a CSS gradient block with a
// red/gold border-glow that pulses. The countdown bar drains linearly via a
// requestAnimationFrame loop reading bargainTimeRemainingMs (the system tick
// is the source of truth for the actual auto-pass).

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useRunStore } from '../../stores/runStore';
import {
  BARGAIN_OFFER_DURATION_MS_EXPORT,
  bargainTimeRemainingMs,
} from '../../ecs/systems/bargain';

const RARITY_BORDER: Record<'common' | 'rare' | 'epic', string> = {
  common: 'rgba(200, 180, 120, 0.85)',
  rare: 'rgba(220, 100, 100, 0.9)',
  epic: 'rgba(255, 80, 80, 1)',
};

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 32,
  display: 'flex',
  justifyContent: 'center',
  pointerEvents: 'none',
  zIndex: 15,
  fontFamily: 'system-ui, sans-serif',
};

const TABLET_STYLE: CSSProperties = {
  width: 460,
  background:
    'linear-gradient(180deg, rgba(36, 22, 22, 0.95) 0%, rgba(28, 16, 16, 0.95) 50%, rgba(20, 10, 10, 0.95) 100%)',
  color: '#f4e8d0',
  padding: '18px 22px 14px 22px',
  borderRadius: 10,
  pointerEvents: 'auto',
  boxShadow:
    '0 0 24px rgba(255, 80, 80, 0.45), 0 0 60px rgba(255, 160, 60, 0.25), inset 0 0 18px rgba(120, 40, 40, 0.55)',
  animation: 'bargainPulse 2200ms ease-in-out infinite',
  position: 'relative',
};

const TITLE_STYLE: CSSProperties = {
  fontSize: 22,
  fontWeight: 800,
  letterSpacing: 2,
  color: '#ffd28a',
  textShadow: '0 0 8px rgba(255, 120, 60, 0.7), 0 1px 2px rgba(0, 0, 0, 0.9)',
  textTransform: 'uppercase',
  marginBottom: 8,
};

const DESC_STYLE: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  marginBottom: 14,
  opacity: 0.95,
};

const HINT_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 12,
  letterSpacing: 1,
  marginBottom: 8,
  opacity: 0.9,
};

const KEY_STYLE: CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  marginRight: 6,
  border: '1px solid rgba(255, 220, 160, 0.7)',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 700,
};

const COUNTDOWN_TRACK_STYLE: CSSProperties = {
  width: '100%',
  height: 6,
  background: 'rgba(0, 0, 0, 0.55)',
  borderRadius: 3,
  overflow: 'hidden',
  border: '1px solid rgba(80, 30, 30, 0.7)',
};

function countdownFillStyle(fraction: number, color: string): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(1, fraction)) * 100}%`,
    height: '100%',
    background: color,
    boxShadow: `0 0 8px ${color}`,
    transition: 'width 80ms linear',
  };
}

const KEYFRAMES_CSS = `
@keyframes bargainPulse {
  0%   { transform: translateY(0)   scale(1.00); filter: brightness(1.00); }
  50%  { transform: translateY(-2px) scale(1.01); filter: brightness(1.12); }
  100% { transform: translateY(0)   scale(1.00); filter: brightness(1.00); }
}
`;

export function BargainOverlay(): ReactElement | null {
  const pendingBargain = useRunStore((s) => s.pendingBargain);
  const acceptBargain = useRunStore((s) => s.acceptBargain);
  const passBargain = useRunStore((s) => s.passBargain);
  const [remainingMs, setRemainingMs] = useState<number>(BARGAIN_OFFER_DURATION_MS_EXPORT);
  const rafRef = useRef<number | null>(null);

  // Drain the countdown via RAF while an offer is active. Stop when cleared.
  useEffect(() => {
    if (!pendingBargain) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setRemainingMs(BARGAIN_OFFER_DURATION_MS_EXPORT);
      return;
    }
    let alive = true;
    const tick = (): void => {
      if (!alive) return;
      setRemainingMs(bargainTimeRemainingMs());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [pendingBargain]);

  // Keyboard: E accepts, Escape/Space pass. Capture-phase so the modal can
  // beat scene-level handlers (e.g. main.tsx Escape -> pause).
  useEffect(() => {
    if (!pendingBargain) return;
    function onKey(ev: KeyboardEvent): void {
      // ignore when something else is consumed (e.g. text input — none here, but defensive).
      if (ev.defaultPrevented) return;
      if (ev.key === 'e' || ev.key === 'E') {
        ev.preventDefault();
        ev.stopPropagation();
        acceptBargain();
      } else if (ev.key === 'Escape' || ev.key === ' ' || ev.code === 'Space') {
        ev.preventDefault();
        ev.stopPropagation();
        passBargain();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pendingBargain, acceptBargain, passBargain]);

  if (!pendingBargain) return null;

  const fraction = remainingMs / BARGAIN_OFFER_DURATION_MS_EXPORT;
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const borderColor = RARITY_BORDER[pendingBargain.rarity];

  return (
    <>
      <style>{KEYFRAMES_CSS}</style>
      <div style={ROOT_STYLE}>
        <div
          style={{
            ...TABLET_STYLE,
            border: `2px solid ${borderColor}`,
          }}
          role="dialog"
          aria-label="Devil's Bargain"
        >
          <div style={TITLE_STYLE}>{pendingBargain.title}</div>
          <div style={DESC_STYLE}>{pendingBargain.description}</div>
          <div style={HINT_STYLE}>
            <span>
              <span style={KEY_STYLE}>E</span> Accept
            </span>
            <span>
              <span style={KEY_STYLE}>Esc</span> Pass
            </span>
            <span style={{ opacity: 0.85 }}>{seconds}s</span>
          </div>
          <div style={COUNTDOWN_TRACK_STYLE}>
            <div style={countdownFillStyle(fraction, borderColor)} />
          </div>
        </div>
      </div>
    </>
  );
}
