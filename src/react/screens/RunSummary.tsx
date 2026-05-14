// End-of-run summary screen.
// Owner: Agent C5.
//
// Shows the player's full title ("Lucas the Forsaken"), result (Victory /
// "Sleep well..."), time survived, kills, level reached, and weapons. Offers
// "Restart" (re-rolls epithet via startRun) and "Back to Menu".
//
// Daily Run differences:
//   - Shows "Daily Seed: YYYY-MM-DD" near the top.
//   - Shows "Today's Best: MM:SS" (reads metaStore after endRun's update).
//   - Restart button reads "Restart Daily" and re-enters daily mode.
//
// `endRun` already persisted the run via metaStore.recordRunCompletion when
// the run ended; this screen is read-only with respect to meta.
import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';
import { todaysKey } from '../../core/rng';
import { buildShareUrl, encodeBuild, snapshotFromRunStore } from '../../core/buildCodes';

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

const SHARE_BUTTON_STYLE: CSSProperties = {
  padding: '10px 18px',
  background: '#1f2434',
  color: '#cfd6ff',
  border: '1px solid #5a6688',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'inherit',
};

const BUILD_CODE_STYLE: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  opacity: 0.75,
  letterSpacing: 0.5,
  background: 'rgba(255,255,255,0.04)',
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid rgba(255,255,255,0.1)',
};

export function RunSummary(): ReactElement {
  const phase = useRunStore((s) => s.phase);
  const kills = useRunStore((s) => s.kills);
  const elapsedMs = useRunStore((s) => s.elapsedMs);
  const level = useRunStore((s) => s.player.level);
  const weapons = useRunStore(useShallow((s) => s.player.weapons));
  const runEpithet = useRunStore((s) => s.runEpithet);
  const startRun = useRunStore((s) => s.startRun);
  const setPhase = useRunStore((s) => s.setPhase);
  const isDailyMode = useRunStore((s) => s.isDailyMode);
  const selectedCharacterId = useRunStore((s) => s.selectedCharacterId);

  const playerName = useMetaStore((s) => s.playerName) || 'Stranger';
  const dailyBestTimeMs = useMetaStore((s) => s.dailyBestTimeMs);

  const won = phase === 'won';

  // Daily best read AFTER endRun has updated metaStore (endRun runs before
  // phase becomes 'won'/'lost', so by the time this summary renders the value
  // is current). Use today's key — same date the seed was computed from.
  const dailyKey = todaysKey();
  const todaysBestMs = isDailyMode ? dailyBestTimeMs[dailyKey] ?? null : null;

  const fullTitle = runEpithet ? `${playerName} ${runEpithet}` : playerName;
  const flavor = won
    ? `${fullTitle} stands above the Hollow.`
    : `Sleep well, ${fullTitle}.`;

  // In daily mode the restart re-enters the daily seed. In normal mode it
  // re-rolls the run with the same character.
  const onRestart = (): void => {
    if (isDailyMode) {
      startRun(selectedCharacterId, { daily: true });
    } else {
      startRun(selectedCharacterId);
    }
  };

  // Build-code share. Snapshot the final loadout (character + weapons +
  // augments) and copy a shareable URL to the clipboard.
  const buildCode = encodeBuild(snapshotFromRunStore());
  const [shareMsg, setShareMsg] = useState<string>('');
  const onShareBuild = (): void => {
    const url = buildShareUrl(snapshotFromRunStore());
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(url).then(
        () => {
          setShareMsg('Copied!');
          window.setTimeout(() => setShareMsg(''), 1500);
        },
        () => {
          setShareMsg('Copy failed');
          window.setTimeout(() => setShareMsg(''), 1500);
        }
      );
    } else {
      setShareMsg('Clipboard unavailable');
      window.setTimeout(() => setShareMsg(''), 1500);
    }
  };

  return (
    <div style={ROOT_STYLE}>
      {isDailyMode ? (
        <div style={{ fontSize: 14, opacity: 0.9, color: '#a9d8b1', letterSpacing: 2, marginBottom: -8 }}>
          DAILY SEED: {dailyKey}
        </div>
      ) : null}
      <div style={{ fontSize: 28, letterSpacing: 4, opacity: 0.9, textAlign: 'center' }}>
        {fullTitle.toUpperCase()}
      </div>
      <h1 style={{ margin: 0, fontSize: 56, color: won ? '#7d8' : '#d77' }}>
        {won ? 'Victory' : 'Defeated'}
      </h1>
      <div style={{ fontSize: 18, fontStyle: 'italic', opacity: 0.85, textAlign: 'center', maxWidth: 640 }}>
        {flavor}
      </div>
      <div style={STAT_ROW}>
        <div>Time: {formatTime(elapsedMs)}</div>
        <div>Level: {level}</div>
        <div>Kills: {kills}</div>
      </div>
      {isDailyMode ? (
        <div style={{ fontSize: 14, opacity: 0.85, fontVariantNumeric: 'tabular-nums', color: '#a9d8b1' }}>
          Today's Best: {todaysBestMs === null ? '—' : formatTime(todaysBestMs)}
        </div>
      ) : null}
      {weapons.length > 0 && (
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Weapons:{' '}
          {weapons.map((w) => `${w.id} Lv${w.level}`).join(', ')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <button onClick={onRestart} style={BUTTON_STYLE}>
          {isDailyMode ? 'Restart Daily' : 'Restart'}
        </button>
        <button onClick={() => setPhase('menu')} style={BUTTON_STYLE}>
          Back to Menu
        </button>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          marginTop: 16,
        }}
      >
        <div style={BUILD_CODE_STYLE}>{buildCode}</div>
        <button onClick={onShareBuild} style={SHARE_BUTTON_STYLE}>
          {shareMsg || 'Share This Build'}
        </button>
      </div>
    </div>
  );
}
