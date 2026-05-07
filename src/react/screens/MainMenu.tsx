// Main menu screen — entry point before a run.
// Owner: Agent C5.
//
// Shows title + character grid + persistent stats. Picking a character starts
// the run with that character's loadout (handled by runStore.startRun).
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

export function MainMenu(): ReactElement {
  const startRun = useRunStore((s) => s.startRun);
  const totalRuns = useMetaStore((s) => s.totalRuns);
  const totalWins = useMetaStore((s) => s.totalWins);
  const bestRunTimeMs = useMetaStore((s) => s.bestRunTimeMs);

  const characters = Object.values(CHARACTERS);

  return (
    <div style={ROOT_STYLE}>
      <h1 style={{ margin: 0, fontSize: 56, letterSpacing: 4 }}>HOLLOWSURV</h1>
      <div style={{ fontSize: 14, opacity: 0.75, marginTop: -16 }}>Choose your character</div>

      <div style={GRID_STYLE}>
        {characters.map((c) => (
          <CharacterCard key={c.id} char={c} onPick={() => startRun(c.id)} />
        ))}
      </div>

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
