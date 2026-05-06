// End-of-run summary screen.
// Owner: Agent C5.
//
// Shows result (Victory/Defeated), time survived, kills, level reached,
// weapons collected. Offers "Restart" (calls startRun) and "Back to Menu"
// (sets phase to 'menu' so MainMenu remounts).
//
// `endRun` already persisted the run via metaStore.recordRunCompletion when
// the run ended; this screen is read-only with respect to meta.
import type { CSSProperties, ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRunStore } from '../../stores/runStore';

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
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
  gap: 20,
  fontFamily: 'system-ui, sans-serif',
};

const STAT_ROW: CSSProperties = {
  display: 'flex',
  gap: 24,
  fontSize: 16,
  fontVariantNumeric: 'tabular-nums',
};

const BUTTON_STYLE: CSSProperties = {
  padding: '12px 24px',
  background: '#2a2a3a',
  color: '#eee',
  border: '1px solid #555',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'inherit',
};

export function RunSummary(): ReactElement {
  const phase = useRunStore((s) => s.phase);
  const kills = useRunStore((s) => s.kills);
  const elapsedMs = useRunStore((s) => s.elapsedMs);
  const level = useRunStore((s) => s.player.level);
  const weapons = useRunStore(useShallow((s) => s.player.weapons));
  const startRun = useRunStore((s) => s.startRun);
  const setPhase = useRunStore((s) => s.setPhase);

  const won = phase === 'won';

  return (
    <div style={ROOT_STYLE}>
      <h1 style={{ margin: 0, fontSize: 56, color: won ? '#7d8' : '#d77' }}>
        {won ? 'Victory' : 'Defeated'}
      </h1>
      <div style={STAT_ROW}>
        <div>Time: {formatTime(elapsedMs)}</div>
        <div>Level: {level}</div>
        <div>Kills: {kills}</div>
      </div>
      {weapons.length > 0 && (
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Weapons:{' '}
          {weapons.map((w) => `${w.id} Lv${w.level}`).join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <button onClick={() => startRun()} style={BUTTON_STYLE}>
          Restart
        </button>
        <button onClick={() => setPhase('menu')} style={BUTTON_STYLE}>
          Back to Menu
        </button>
      </div>
    </div>
  );
}
