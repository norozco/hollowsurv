// Branching Hollows — portal-pick modal that appears at the 5:00 mark.
// Owner: Hollow integration agent.
//
// Reads `hollowChoicePending` from runStore. When true, renders three full-
// height panels colored by each Hollow's palette and dispatches `pickHollow`
// when the player clicks. Keyboard 1/2/3 mirrors clicking the matching panel.
//
// Auto-pick: after HOLLOW_CHOICE_TIMEOUT_MS (30s) without a pick we fire
// `pickHollow(DEFAULT_HOLLOW_ID)` so the run never soft-locks. A small ticking
// countdown in the corner makes the timer visible.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRunStore } from '../../stores/runStore';
import {
  DEFAULT_HOLLOW_ID,
  HOLLOWS,
  HOLLOW_CHOICE_TIMEOUT_MS,
  HOLLOW_ORDER,
  type HollowId,
} from '../../content/hollows';

function colorToCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

/** Darker variant for the panel background, so the lighter palette tint reads as accent. */
function darkenCss(hex: number, factor = 0.25): string {
  const r = Math.floor(((hex >> 16) & 0xff) * factor);
  const g = Math.floor(((hex >> 8) & 0xff) * factor);
  const b = Math.floor((hex & 0xff) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 30,
  pointerEvents: 'auto',
  background: 'rgba(0,0,0,0.85)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'system-ui, sans-serif',
  color: '#eee',
};

const HEADER_STYLE: CSSProperties = {
  textAlign: 'center',
  padding: '36px 0 18px 0',
  fontSize: 36,
  fontWeight: 800,
  letterSpacing: 6,
  textTransform: 'uppercase',
  color: '#f5e6c8',
  textShadow: '0 0 16px rgba(255, 200, 120, 0.5)',
};

const SUBHEADER_STYLE: CSSProperties = {
  textAlign: 'center',
  fontSize: 14,
  letterSpacing: 2,
  opacity: 0.7,
  marginBottom: 14,
};

const PANELS_ROW_STYLE: CSSProperties = {
  flex: 1,
  display: 'flex',
  gap: 0,
};

const PANEL_BASE_STYLE: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px 28px',
  cursor: 'pointer',
  border: 'none',
  color: '#f5e6c8',
  textAlign: 'center',
  fontFamily: 'inherit',
  textTransform: 'none',
  transition: 'filter 120ms ease-in-out, transform 120ms ease-in-out',
};

const PANEL_NUM_STYLE: CSSProperties = {
  fontSize: 12,
  letterSpacing: 4,
  opacity: 0.6,
  marginBottom: 8,
};

const PANEL_NAME_STYLE: CSSProperties = {
  fontSize: 32,
  fontWeight: 800,
  letterSpacing: 3,
  textTransform: 'uppercase',
  marginBottom: 16,
  textShadow: '0 2px 6px rgba(0, 0, 0, 0.9)',
};

const PANEL_DESC_STYLE: CSSProperties = {
  fontSize: 16,
  lineHeight: 1.5,
  maxWidth: 320,
  marginBottom: 24,
  opacity: 0.92,
};

const PANEL_MECH_STYLE: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  maxWidth: 320,
  opacity: 0.78,
  fontStyle: 'italic',
};

const SWATCH_STYLE: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: '50%',
  marginBottom: 18,
  boxShadow: '0 0 16px currentColor, inset 0 0 12px rgba(0, 0, 0, 0.6)',
};

const FOOTER_STYLE: CSSProperties = {
  textAlign: 'center',
  padding: '14px 0 22px 0',
  fontSize: 12,
  letterSpacing: 2,
  opacity: 0.6,
};

const COUNTDOWN_STYLE: CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 24,
  fontSize: 12,
  letterSpacing: 2,
  opacity: 0.7,
};

export function HollowChoiceScreen(): ReactElement | null {
  // Subscribe with shallow equality so re-renders only happen when these specific
  // fields change. The picker mounts/unmounts based on hollowChoicePending.
  const { hollowChoicePending, pickHollow } = useRunStore(
    useShallow((s) => ({
      hollowChoicePending: s.hollowChoicePending,
      pickHollow: s.pickHollow,
    }))
  );

  const [secondsLeft, setSecondsLeft] = useState(
    Math.ceil(HOLLOW_CHOICE_TIMEOUT_MS / 1000)
  );
  const expireAtRef = useRef<number | null>(null);
  const autoPickFiredRef = useRef(false);

  // Reset the countdown when the picker opens.
  useEffect(() => {
    if (!hollowChoicePending) {
      expireAtRef.current = null;
      autoPickFiredRef.current = false;
      setSecondsLeft(Math.ceil(HOLLOW_CHOICE_TIMEOUT_MS / 1000));
      return;
    }

    expireAtRef.current = performance.now() + HOLLOW_CHOICE_TIMEOUT_MS;
    autoPickFiredRef.current = false;

    let rafId = 0;
    const tick = (): void => {
      const exp = expireAtRef.current;
      if (exp === null) return;
      const remainingMs = exp - performance.now();
      if (remainingMs <= 0) {
        if (!autoPickFiredRef.current) {
          autoPickFiredRef.current = true;
          pickHollow(DEFAULT_HOLLOW_ID);
        }
        return;
      }
      setSecondsLeft(Math.ceil(remainingMs / 1000));
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [hollowChoicePending, pickHollow]);

  // Keyboard 1/2/3 mirrors panel order.
  useEffect(() => {
    if (!hollowChoicePending) return;
    function onKey(ev: KeyboardEvent): void {
      const idx = ['1', '2', '3'].indexOf(ev.key);
      if (idx === -1) return;
      const id = HOLLOW_ORDER[idx];
      if (id) {
        ev.preventDefault();
        ev.stopPropagation();
        pickHollow(id);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hollowChoicePending, pickHollow]);

  if (!hollowChoicePending) return null;

  return (
    <div style={ROOT_STYLE} role="dialog" aria-label="Choose a Hollow">
      <div style={COUNTDOWN_STYLE}>auto: {secondsLeft}s</div>
      <div style={HEADER_STYLE}>Choose a Hollow</div>
      <div style={SUBHEADER_STYLE}>The path you take cannot be untaken.</div>
      <div style={PANELS_ROW_STYLE}>
        {HOLLOW_ORDER.map((id, idx) => (
          <HollowPanel
            key={id}
            idx={idx}
            id={id}
            onPick={() => pickHollow(id)}
          />
        ))}
      </div>
      <div style={FOOTER_STYLE}>Press 1, 2, or 3 to pick</div>
    </div>
  );
}

interface HollowPanelProps {
  idx: number;
  id: HollowId;
  onPick: () => void;
}

function HollowPanel({ idx, id, onPick }: HollowPanelProps): ReactElement {
  const def = HOLLOWS[id];
  const [hovered, setHovered] = useState(false);

  const accent = colorToCss(def.paletteTint);
  const background = darkenCss(def.paletteTint, 0.18);
  const backgroundHover = darkenCss(def.paletteTint, 0.28);

  const style: CSSProperties = {
    ...PANEL_BASE_STYLE,
    background: hovered ? backgroundHover : background,
    borderRight: idx < HOLLOW_ORDER.length - 1 ? '1px solid rgba(255, 255, 255, 0.06)' : undefined,
    filter: hovered ? 'brightness(1.1)' : 'brightness(1)',
    transform: hovered ? 'translateY(-4px)' : 'translateY(0)',
  };

  return (
    <button
      type="button"
      style={style}
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Pick ${def.name}`}
    >
      <div style={PANEL_NUM_STYLE}>[{idx + 1}]</div>
      <div style={{ ...SWATCH_STYLE, background: accent, color: accent }} />
      <div style={PANEL_NAME_STYLE}>{def.name}</div>
      <div style={PANEL_DESC_STYLE}>{def.description}</div>
      <div style={PANEL_MECH_STYLE}>{def.mechanicSummary}</div>
    </button>
  );
}
