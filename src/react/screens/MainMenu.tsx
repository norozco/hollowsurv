// Main menu screen — entry point before a run.
// Owner: Agent C5.
//
// Shows title + "Start Run" + lifetime stats from metaStore.
// In v1 the contract has no top-level `gold` field — we surface totalRuns/wins
// + best time as the persistent reward feedback. (Run gold lives in the future
// metaStore; flagged in the C5 report.)
import type { ReactElement } from 'react';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';

function formatBestTime(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function MainMenu(): ReactElement {
  const startRun = useRunStore((s) => s.startRun);
  const totalRuns = useMetaStore((s) => s.totalRuns);
  const totalWins = useMetaStore((s) => s.totalWins);
  const bestRunTimeMs = useMetaStore((s) => s.bestRunTimeMs);

  return (
    <div
      style={{
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
      }}
    >
      <h1 style={{ margin: 0, fontSize: 56, letterSpacing: 4 }}>HOLLOWSURV</h1>
      <button
        onClick={() => startRun()}
        style={{
          padding: '14px 32px',
          fontSize: 18,
          background: '#2a2a3a',
          color: '#eee',
          border: '1px solid #555',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
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
        <span>Best: {formatBestTime(bestRunTimeMs)}</span>
      </div>
    </div>
  );
}
