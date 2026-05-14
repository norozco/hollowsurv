// Level-up choice modal — three cards.
// Owner: Agent C5.
//
// Reads `pendingChoices` from the store and dispatches `pickUpgrade(choiceId)`
// per CONTRACTS.md §3.1. Keyboard 1/2/3 maps to the visible cards.
//
// The modal pointer-events are 'auto' so cards are clickable. The HUD behind
// us stays mounted (App.tsx routing) so HP/timer remain visible while paused.
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRunStore } from '../../stores/runStore';
import type { UpgradeChoice } from '../../stores/runStore';
import { buildShareUrl, snapshotFromRunStore } from '../../core/buildCodes';

const RARITY_BORDER: Record<UpgradeChoice['rarity'], string> = {
  common: '#666',
  rare: '#5af',
  epic: '#c8a',
};

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'auto',
  background: 'rgba(0,0,0,0.65)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 24,
  zIndex: 20,
  fontFamily: 'system-ui, sans-serif',
  color: '#eee',
};

const CARDS_ROW: CSSProperties = {
  display: 'flex',
  gap: 16,
};

const CARD_BASE: CSSProperties = {
  width: 220,
  height: 280,
  background: '#1a1a26',
  color: '#eee',
  borderRadius: 6,
  padding: 16,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  textAlign: 'left',
  fontFamily: 'inherit',
};

const COPY_BUTTON_STYLE: CSSProperties = {
  marginTop: 4,
  padding: '6px 14px',
  background: 'transparent',
  color: '#bbb',
  border: '1px solid #444',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'inherit',
};

export function LevelUpPicker(): ReactElement {
  const pendingChoices = useRunStore(useShallow((s) => s.pendingChoices));
  const pickUpgrade = useRunStore((s) => s.pickUpgrade);
  const [copyMsg, setCopyMsg] = useState<string>('');

  // Keyboard 1/2/3 picks the matching card.
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      const idx = ['1', '2', '3'].indexOf(ev.key);
      if (idx === -1) return;
      const c = pendingChoices[idx];
      if (c) {
        ev.preventDefault();
        pickUpgrade(c.id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingChoices, pickUpgrade]);

  function onCopyBuild(): void {
    const snapshot = snapshotFromRunStore();
    const url = buildShareUrl(snapshot);
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(url).then(
        () => {
          setCopyMsg('Copied!');
          window.setTimeout(() => setCopyMsg(''), 1500);
        },
        () => {
          setCopyMsg('Copy failed');
          window.setTimeout(() => setCopyMsg(''), 1500);
        }
      );
    } else {
      setCopyMsg('Clipboard unavailable');
      window.setTimeout(() => setCopyMsg(''), 1500);
    }
  }

  return (
    <div style={ROOT_STYLE}>
      <div style={{ fontSize: 32, letterSpacing: 4, fontWeight: 700 }}>LEVEL UP</div>
      <div style={CARDS_ROW}>
        {pendingChoices.map((c, idx) => (
          <button
            key={c.id}
            onClick={() => pickUpgrade(c.id)}
            style={{
              ...CARD_BASE,
              border: `2px solid ${RARITY_BORDER[c.rarity]}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, opacity: 0.7 }}>
              <span>[{idx + 1}]</span>
              <span style={{ textTransform: 'uppercase' }}>{c.rarity}</span>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 12, lineHeight: 1.2 }}>{c.title}</div>
            <div style={{ marginTop: 14, fontSize: 14, opacity: 0.95, flex: 1, lineHeight: 1.4 }}>{c.description}</div>
            <div style={{ marginTop: 8, fontSize: 10, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 1 }}>
              {c.kind.replace('_', ' ')}
            </div>
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, opacity: 0.5 }}>Press 1, 2, or 3 to pick</div>
      <button onClick={onCopyBuild} style={COPY_BUTTON_STYLE}>
        {copyMsg || 'Copy Build Code'}
      </button>
    </div>
  );
}
