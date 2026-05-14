// Main menu — title screen, optional name entry, then character selection.
// Owner: Agent C5.
//
// Flow:
//   1. 'title' view — HOLLOWSURV + Start Run / Daily Run + lifetime stats
//   2. Click Start Run or Daily Run:
//        - Daily Run sets the "isDailySelect" local flag.
//        - If metaStore.playerName is empty → go to 'name'
//        - Else → go straight to 'characters'
//      (You can also reach 'name' explicitly via the "Edit name (X)" button.)
//   3. 'name' view — type name → setPlayerName → 'characters'
//   4. 'characters' → pick → runStore.startRun(id, { daily: isDailySelect }) → arena
//
// Character grid renders ALL CHARACTERS — unlocked first, then locked. Locked
// cards show a 🔒 plus the unlock condition; the button is disabled.
//
// View state is local to this component (resets if MainMenu unmounts/remounts).
// We don't add new RunPhases because all views are still phase='menu'.
import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useMetaStore } from '../../stores/metaStore';
import { useRunStore } from '../../stores/runStore';
import {
  CHARACTERS,
  isCharacterUnlocked,
  type CharacterDefinition,
} from '../../content/characters';
import { WEAPONS } from '../../content/weapons';
import { todaysKey } from '../../core/rng';
import { NameEntryScreen } from './NameEntryScreen';

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

const LOCKED_CARD_STYLE: CSSProperties = {
  ...CARD_STYLE,
  cursor: 'not-allowed',
  opacity: 0.5,
  background: '#15151e',
  border: '2px dashed #555',
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

function LockedCharacterCard({ char }: { char: CharacterDefinition }): ReactElement {
  const condition = char.unlockCondition ?? 'Locked';
  return (
    <button
      style={LOCKED_CARD_STYLE}
      disabled
      aria-label={`${char.name} — locked. ${condition}`}
    >
      <div
        style={{
          width: 40,
          height: 40,
          background: '#2a2a2a',
          borderRadius: 4,
          border: '1px solid rgba(255,255,255,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          color: '#888',
        }}
      >
        {/* Lock glyph — escaped, no emoji dependencies. */}
        {'\u{1F512}'}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1, color: '#888' }}>
        ???
      </div>
      <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.4, color: '#bbb' }}>
        {condition}
      </div>
      <div style={{ marginTop: 'auto', fontSize: 12, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>
        Locked
      </div>
    </button>
  );
}

type View = 'title' | 'name' | 'characters';

const DAILY_BUTTON: CSSProperties = {
  ...PRIMARY_BUTTON,
  background: '#2a3a2e',
  border: '1px solid #4d6b54',
  letterSpacing: 1,
};

const BUTTON_ROW: CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  justifyContent: 'center',
  alignItems: 'center',
};

export function MainMenu(): ReactElement {
  const startRun = useRunStore((s) => s.startRun);
  const totalRuns = useMetaStore((s) => s.totalRuns);
  const totalWins = useMetaStore((s) => s.totalWins);
  const bestRunTimeMs = useMetaStore((s) => s.bestRunTimeMs);
  const playerName = useMetaStore((s) => s.playerName);
  const unlockedCharacterIds = useMetaStore((s) => s.unlockedCharacterIds);
  const dailyBestTimeMs = useMetaStore((s) => s.dailyBestTimeMs);

  // Today's best is read once at render time. Re-reading on every render is
  // fine: this menu is a static screen and `todaysKey()` is cheap.
  const todayKey = todaysKey();
  const todaysBestMs = dailyBestTimeMs[todayKey] ?? null;

  const [view, setView] = useState<View>('title');
  // True if the player is on a daily-run flow through character select.
  // Reset to false whenever they bail back to the title.
  const [isDailySelect, setIsDailySelect] = useState<boolean>(false);

  // ---------- name entry ----------
  if (view === 'name') {
    return (
      <NameEntryScreen
        onContinue={() => setView('characters')}
        onBack={() => {
          setIsDailySelect(false);
          setView('title');
        }}
      />
    );
  }

  // ---------- character select ----------
  if (view === 'characters') {
    // Split into unlocked / locked, then render unlocked first.
    const allCharacters = Object.values(CHARACTERS);
    const unlocked: CharacterDefinition[] = [];
    const locked: CharacterDefinition[] = [];
    for (const c of allCharacters) {
      if (isCharacterUnlocked(c.id, unlockedCharacterIds)) {
        unlocked.push(c);
      } else {
        locked.push(c);
      }
    }

    return (
      <div style={ROOT_STYLE}>
        <h2 style={{ margin: 0, fontSize: 36, letterSpacing: 4 }}>CHOOSE YOUR CHARACTER</h2>
        {isDailySelect ? (
          <div style={{ fontSize: 14, opacity: 0.85, marginTop: -8, color: '#a9d8b1' }}>
            Daily Run — {todayKey}
          </div>
        ) : null}
        {playerName ? (
          <div style={{ fontSize: 14, opacity: 0.75, marginTop: -8 }}>
            Choosing for <span style={{ color: '#b9d4ff' }}>{playerName}</span>
          </div>
        ) : null}
        <div style={GRID_STYLE}>
          {unlocked.map((c) => (
            <CharacterCard
              key={c.id}
              char={c}
              onPick={() => startRun(c.id, { daily: isDailySelect })}
            />
          ))}
          {locked.map((c) => (
            <LockedCharacterCard key={c.id} char={c} />
          ))}
        </div>
        <button
          onClick={() => {
            setIsDailySelect(false);
            setView('title');
          }}
          style={SECONDARY_BUTTON}
        >
          Back
        </button>
      </div>
    );
  }

  // ---------- title (default) ----------
  // Start Run / Daily Run: if no name set, route through name entry first.
  // `daily` flag is held in `isDailySelect` so the eventual character pick
  // knows which mode to start.
  const onStartRun = (): void => {
    setIsDailySelect(false);
    if (!playerName) {
      setView('name');
    } else {
      setView('characters');
    }
  };

  const onDailyRun = (): void => {
    setIsDailySelect(true);
    if (!playerName) {
      setView('name');
    } else {
      setView('characters');
    }
  };

  return (
    <div style={ROOT_STYLE}>
      <h1 style={{ margin: 0, fontSize: 72, letterSpacing: 6 }}>HOLLOWSURV</h1>
      <div style={BUTTON_ROW}>
        <button onClick={onStartRun} style={PRIMARY_BUTTON}>
          Start Run
        </button>
        <button onClick={onDailyRun} style={DAILY_BUTTON} title={`Daily seed ${todayKey} — same run for everyone today.`}>
          Daily Run
        </button>
      </div>
      <div style={{ fontSize: 13, opacity: 0.8, fontVariantNumeric: 'tabular-nums', marginTop: -10 }}>
        Today ({todayKey}): {formatBestTime(todaysBestMs)}
      </div>
      <button onClick={() => setView('name')} style={SECONDARY_BUTTON}>
        {playerName ? `Edit name (${playerName})` : 'Set name'}
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
