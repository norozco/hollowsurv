// Pause menu — opens when phase === 'paused'.
// ESC toggles in/out of paused via the global keydown listener in main.tsx.
//
// Contents:
//   - Resume
//   - Volume sliders (music + SFX) → metaStore.settings
//   - Screen shake toggle → metaStore.settings.screenShake
//   - Controls reference
//   - Current run snapshot (character, epithet, kills, time, weapons, hollow)
//   - Build code + Copy button (share mid-run)
//   - End Run (forfeits the run, transitions to phase 'lost')

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useRunStore } from '../../stores/runStore';
import { useMetaStore } from '../../stores/metaStore';
import { WEAPONS } from '../../content/weapons';
import { CHARACTERS } from '../../content/characters';
import { HOLLOWS } from '../../content/hollows';
import { t } from '../../content/strings';
import { buildShareUrl, snapshotFromRunStore } from '../../core/buildCodes';

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
  background: 'rgba(0, 0, 0, 0.82)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  paddingTop: '6vh',
  paddingBottom: '6vh',
  zIndex: 30,
  color: '#eee',
  fontFamily: 'system-ui, sans-serif',
  overflowY: 'auto',
};

const PANEL_STYLE: CSSProperties = {
  width: 'min(560px, 90vw)',
  background: '#14141d',
  border: '1px solid #2a2a3a',
  borderRadius: 8,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 36,
  letterSpacing: 8,
  textAlign: 'center',
};

const PRIMARY_BUTTON: CSSProperties = {
  padding: '12px 24px',
  fontSize: 18,
  background: '#2a4a3a',
  color: '#eee',
  border: '1px solid #4a7a5a',
  borderRadius: 4,
  cursor: 'pointer',
  letterSpacing: 1,
  fontFamily: 'inherit',
  width: '100%',
};

const DANGER_BUTTON: CSSProperties = {
  padding: '10px 20px',
  fontSize: 14,
  background: '#3a1a1a',
  color: '#eaa',
  border: '1px solid #6a2a2a',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
  width: '100%',
};

const SECONDARY_BUTTON: CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  background: 'transparent',
  color: '#bbb',
  border: '1px solid #444',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 11,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: '#888',
  borderBottom: '1px solid #2a2a3a',
  paddingBottom: 4,
};

const SLIDER_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr 50px',
  alignItems: 'center',
  gap: 10,
  fontSize: 14,
};

const KEYBIND_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr',
  fontSize: 13,
  gap: 8,
  paddingBottom: 2,
};

const KEY_CAP: CSSProperties = {
  background: '#222230',
  border: '1px solid #3a3a4a',
  borderRadius: 3,
  padding: '2px 8px',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  display: 'inline-block',
  textAlign: 'center',
  color: '#cfd',
};

const STAT_ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '120px 1fr',
  fontSize: 13,
  gap: 8,
  color: '#cdd',
};

export function PauseMenu(): ReactElement {
  // Live-subscribed slices.
  const setPhase = useRunStore((s) => s.setPhase);
  const endRun = useRunStore((s) => s.endRun);
  const elapsedMs = useRunStore((s) => s.elapsedMs);
  const kills = useRunStore((s) => s.kills);
  const playerLevel = useRunStore((s) => s.player.level);
  const playerHp = useRunStore((s) => s.player.hp);
  const playerMaxHp = useRunStore((s) => s.player.maxHp);
  const characterId = useRunStore((s) => s.selectedCharacterId);
  const epithet = useRunStore((s) => s.runEpithet);
  const hollowId = useRunStore((s) => s.selectedHollowId);
  const weapons = useRunStore(useShallow((s) => s.player.weapons));

  const playerName = useMetaStore((s) => s.playerName);
  const musicVolume = useMetaStore((s) => s.settings.musicVolume);
  const sfxVolume = useMetaStore((s) => s.settings.sfxVolume);
  const screenShake = useMetaStore((s) => s.settings.screenShake);
  const setMusicVolume = useMetaStore((s) => s.setMusicVolume);
  const setSfxVolume = useMetaStore((s) => s.setSfxVolume);
  const setScreenShake = useMetaStore((s) => s.setScreenShake);

  const [copyMsg, setCopyMsg] = useState<string>('');

  const character = CHARACTERS[characterId];
  const hollow = hollowId ? HOLLOWS[hollowId] : null;

  function resume(): void {
    setPhase('playing');
  }

  function quit(): void {
    endRun('lost');
  }

  function copyBuild(): void {
    const url = buildShareUrl(snapshotFromRunStore());
    const cb = navigator.clipboard;
    if (cb && typeof cb.writeText === 'function') {
      cb.writeText(url).then(
        () => {
          setCopyMsg(t('copied'));
          window.setTimeout(() => setCopyMsg(''), 1500);
        },
        () => {
          setCopyMsg(t('copyFailed'));
          window.setTimeout(() => setCopyMsg(''), 1500);
        }
      );
    } else {
      setCopyMsg(t('clipboardUnavailable'));
      window.setTimeout(() => setCopyMsg(''), 1500);
    }
  }

  // Resume on Enter / Space inside the menu (in addition to global ESC).
  useEffect(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        resume();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={ROOT_STYLE}>
      <div style={PANEL_STYLE}>
        <h2 style={TITLE_STYLE}>{t('paused')}</h2>

        {playerName ? (
          <div style={{ textAlign: 'center', fontSize: 14, opacity: 0.8 }}>
            <span style={{ color: '#b9d4ff' }}>{playerName}</span>
            {epithet ? `, ${epithet}` : ''}
          </div>
        ) : null}

        <button onClick={resume} style={PRIMARY_BUTTON}>
          {t('resume')}
        </button>

        {/* --- Settings --- */}
        <div>
          <div style={SECTION_LABEL}>{t('sectionSettings')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div style={SLIDER_ROW}>
              <span>{t('ctlMusic')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={musicVolume}
                onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(musicVolume * 100)}%
              </span>
            </div>
            <div style={SLIDER_ROW}>
              <span>{t('ctlSounds')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={sfxVolume}
                onChange={(e) => setSfxVolume(parseFloat(e.target.value))}
                style={{ width: '100%' }}
              />
              <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(sfxVolume * 100)}%
              </span>
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={screenShake}
                onChange={(e) => setScreenShake(e.target.checked)}
              />
              {t('ctlScreenShake')}
            </label>
          </div>
        </div>

        {/* --- Controls --- */}
        <div>
          <div style={SECTION_LABEL}>{t('sectionControls')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
            <div style={KEYBIND_ROW}>
              <span style={KEY_CAP}>WASD</span>
              <span>{t('keyMove')}</span>
            </div>
            <div style={KEYBIND_ROW}>
              <span style={KEY_CAP}>C</span>
              <span>{t('keyManualAim')}</span>
            </div>
            <div style={KEYBIND_ROW}>
              <span style={KEY_CAP}>E</span>
              <span>{t('keyAcceptBargain')}</span>
            </div>
            <div style={KEYBIND_ROW}>
              <span style={KEY_CAP}>1 / 2 / 3</span>
              <span>{t('keyPickLevelup')}</span>
            </div>
            <div style={KEYBIND_ROW}>
              <span style={KEY_CAP}>Esc</span>
              <span>{t('keyPause')}</span>
            </div>
            <div
              style={{
                fontSize: 11,
                opacity: 0.65,
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              {t('controlsFootnote')}
            </div>
          </div>
        </div>

        {/* --- Current Run --- */}
        <div>
          <div style={SECTION_LABEL}>{t('sectionCurrentRun')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelCharacter')}</span>
              <span>{character?.name ?? characterId}</span>
            </div>
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelTime')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTime(elapsedMs)}</span>
            </div>
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelKills')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{kills}</span>
            </div>
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelLevel')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{playerLevel}</span>
            </div>
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelHp')}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(playerHp)} / {Math.round(playerMaxHp)}
              </span>
            </div>
            {hollow ? (
              <div style={STAT_ROW}>
                <span style={{ opacity: 0.6 }}>{t('labelHollow')}</span>
                <span>{hollow.name}</span>
              </div>
            ) : null}
            <div style={STAT_ROW}>
              <span style={{ opacity: 0.6 }}>{t('labelWeapons')}</span>
              <span>
                {weapons.length === 0
                  ? t('weaponsNone')
                  : weapons
                      .map((w) => `${WEAPONS[w.id]?.name ?? w.id} L${w.level}`)
                      .join(', ')}
              </span>
            </div>
          </div>
        </div>

        {/* --- Share Build --- */}
        <div>
          <div style={SECTION_LABEL}>{t('sectionShareThisRun')}</div>
          <button
            onClick={copyBuild}
            style={{ ...SECONDARY_BUTTON, width: '100%', marginTop: 10 }}
          >
            {copyMsg || t('copyBuildCodeUrl')}
          </button>
        </div>

        {/* --- End Run --- */}
        <div style={{ marginTop: 4 }}>
          <button onClick={quit} style={DANGER_BUTTON}>
            {t('endRunDanger')}
          </button>
        </div>
      </div>
    </div>
  );
}
