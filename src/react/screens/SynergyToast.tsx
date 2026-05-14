// One-shot "FROSTBITE!" toast that fires the first time each hidden synergy
// becomes active in a run. Subscribes to the `synergy_activated` event via
// eventBus and renders a brief fade-in/out floater near the top of the screen.
//
// Also handles `weapon_evolved`: when a player picks an evolution from the
// level-up modal, the toast shows "EVOLUTION: Phantom Shot" with a slightly
// different style so the moment lands. Reusing the same component (rather
// than spinning up a second one) keeps the visual layer thin and the toasts
// stack/order in the same column.
//
// Owner: Integration agent. Mounted in App.tsx — placed AFTER HUD so it stays
// on top regardless of phase. Hidden synergies are part of the discovery loop,
// so the toast is the only acknowledgement; there is no tab listing them.
import type { CSSProperties, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { eventBus } from '../../core/eventBus';

interface Toast {
  /** Unique id so React's keyed reconciliation doesn't get confused if two synergies fire back-to-back. */
  key: number;
  /** Headline text rendered in the toast. */
  text: string;
  /** Visual variant — synergies are gold, evolutions are violet-gold. */
  variant: 'synergy' | 'evolution';
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  pointerEvents: 'none',
  zIndex: 40,
  fontFamily: 'system-ui, sans-serif',
};

const TOAST_BASE_STYLE: CSSProperties = {
  marginTop: 80,
  padding: '14px 28px',
  fontSize: 36,
  fontWeight: 800,
  letterSpacing: 6,
  background: 'linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0.25))',
  borderRadius: 6,
  animation: 'synergyToastFade 1500ms ease-out forwards',
};

const SYNERGY_TOAST_STYLE: CSSProperties = {
  ...TOAST_BASE_STYLE,
  color: '#ffe16a',
  textShadow:
    '0 0 14px rgba(255, 224, 90, 0.85), 0 2px 6px rgba(0, 0, 0, 0.9), 0 0 2px rgba(255, 255, 255, 0.6)',
  border: '1px solid rgba(255, 224, 90, 0.55)',
};

// Evolutions get a violet-tinged variant so the moment reads differently from
// the synergy toast. Same animation; only the colour palette shifts.
const EVOLUTION_TOAST_STYLE: CSSProperties = {
  ...TOAST_BASE_STYLE,
  color: '#f7d8ff',
  textShadow:
    '0 0 16px rgba(196, 136, 255, 0.95), 0 2px 8px rgba(0, 0, 0, 0.95), 0 0 2px rgba(255, 255, 255, 0.7)',
  border: '1px solid rgba(196, 136, 255, 0.6)',
  letterSpacing: 4,
};

/** Total visible lifespan of a single toast (ms). Match the CSS animation duration. */
const TOAST_LIFESPAN_MS = 1500;

export function SynergyToast(): ReactElement | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextKey = useRef(1);

  useEffect(() => {
    /** Push a toast into the list and schedule its DOM removal. */
    function pushToast(text: string, variant: Toast['variant']): void {
      const key = nextKey.current++;
      setToasts((cur) => [...cur, { key, text, variant }]);
      // Schedule removal once the fade-out animation finishes. Slightly longer
      // than the animation so the visual fully clears before DOM removal.
      window.setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.key !== key));
      }, TOAST_LIFESPAN_MS + 50);
    }
    const offSynergy = eventBus.on('synergy_activated', (e) => {
      pushToast(`${e.name}!`, 'synergy');
    });
    const offEvolved = eventBus.on('weapon_evolved', (e) => {
      pushToast(`EVOLUTION: ${e.evolvedName}`, 'evolution');
    });
    return () => {
      offSynergy();
      offEvolved();
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <>
      <style>{KEYFRAMES_CSS}</style>
      <div style={ROOT_STYLE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          {toasts.map((t) => (
            <div
              key={t.key}
              style={t.variant === 'evolution' ? EVOLUTION_TOAST_STYLE : SYNERGY_TOAST_STYLE}
            >
              {t.text}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Keyframes are injected once with the first toast render. Trivial DOM cost,
// and avoids needing a global stylesheet edit for this isolated feature.
const KEYFRAMES_CSS = `
@keyframes synergyToastFade {
  0%   { opacity: 0; transform: translateY(-12px) scale(0.92); }
  18%  { opacity: 1; transform: translateY(0)     scale(1.02); }
  30%  { opacity: 1; transform: translateY(0)     scale(1.00); }
  80%  { opacity: 1; transform: translateY(0)     scale(1.00); }
  100% { opacity: 0; transform: translateY(-4px)  scale(0.98); }
}
`;
