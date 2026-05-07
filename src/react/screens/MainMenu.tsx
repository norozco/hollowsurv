// Main menu — title screen first, then character selection.
// Owner: Agent C5.
//
// Flow:
//   1. 'title' view — HOLLOWSURV + Start Run + lifetime stats
//   2. Click Start Run → 'characters' view — pick a character
//   3. Click character → runStore.startRun(id) → arena
//
// View state is local to this component (resets if MainMenu unmounts/remounts).
// We don't add a new RunPhase because both views are still phase='menu'.
import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';
import { CHARACTERS, type CharacterDefinition } from '../../content/characters';
import { WEAPONS } from '../../content/weapons';

function formatBestTime(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function colorToCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'auto',
  background: 'rgba(0,0,0,0.78)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 20,
  color: '#eee',
  gap: 24,
  fontFamily: 'system-ui, sans-serif',
  padding: 24,
};

const PRIMARY_BUTTON: CSSProperties = {
  padding: '14px 40px',
  fontSize: 20,
  background: '#2a2a3a',
  color: '#eee',
  border: '1px solid #555',
  borderRadius: 4,
  cursor: 'pointer',
  letterSpacing: 1,
  fontFamily: 'inherit',
};

const SECONDARY_BUTTON: CSSProperties = {
  padding: '8px 20px',
  fontSize: 13,
  background: 'transparent',
  color: '#bbb',
  border: '1px solid #555',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const GRID_STYLE: CSSProperties = {
  display: 'flex',
  gap: 16,
  flexWrap: 'wrap',
  justifyContent: 'center',
};

const CARD_STYLE: CSSProperties = {
  width: 240,
  minHeight: 220,
  background: '#1a1a26',
  color: '#eee',
  border: '2px solid #444',
  borderRadius: 6,
  padding: 16,
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 10,
  fontFamily: 'inherit',
  textAlign: 'left',
};

function CharacterCard({ char, onPick }: { char: CharacterDefinition; onPick: () => void }): ReactElement {
  const startWeapon = WEAPONS[char.startingWeaponId]?.name ?? char.startingWeaponId;
  return (
    <button onClick={onPick} style={CARD_STYLE}>
      <div
        style={{
          width: 40,
          height: 40,
          background: colorToCss(char.tint),
          borderRadius: 4,
          border: '1px solid rgba(255,255,255,0.2)',
        }}
      />
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>{char.name}</div>
      <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.4 }}>{char.description}</div>
      <div style={{ marginTop: 'auto', fontSize: 12, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
        Starts with: <span style={{ color: '#b9d4ff' }}>{startWeapon}</span>
      </div>
    </button>
  );
}

type View = 'title' | 'characters';

export function MainMenu(): ReactElement {
  const startRun = useRunStore((s) => s.startRun);
  const totalRuns = useMetaStore((s) => s.totalRuns);
  const totalWins = useMetaStore((s) => s.totalWins);
  const bestRunTimeMs = useMetaStore((s) => s.bestRunTimeMs);

  const [view, setView] = useState<View>('title');

  if (view === 'characters') {
    const characters = Object.values(CHARACTERS);
    return (
      <div style={ROOT_STYLE}>
        <h2 style={{ margin: 0, fontSize: 36, letterSpacing: 4 }}>CHOOSE YOUR CHARACTER</h2>
        <div style={GRID_STYLE}>
          {characters.map((c) => (
            <CharacterCard key={c.id} char={c} onPick={() => startRun(c.id)} />
          ))}
        </div>
        <button onClick={() => setView('title')} style={SECONDARY_BUTTON}>
          ← Back
        </button>
      </div>
    );
  }

  // Title view (default)
  return (
    <div style={ROOT_STYLE}>
      <h1 style={{ margin: 0, fontSize: 72, letterSpacing: 6 }}>HOLLOWSURV</h1>
      <button onClick={() => setView('characters')} style={PRIMARY_BUTTON}>
        Start Run
      </button>
      <div
        style={{
          display: 'flex',
          gap: 32,
          marginTop: 8,
          fontSize: 14,
          opacity: 0.85,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>Runs: {totalRuns}</span>
        <span>Wins: {totalWins}</span>
        <span>Longest: {formatBestTime(bestRunTimeMs)}</span>
      </div>
    </div>
  );
}
