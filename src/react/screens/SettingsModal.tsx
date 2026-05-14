// Settings modal — opens from the title screen. The PauseMenu has its own
// inline settings section for in-run access; this modal is the menu-only path.
//
// Contents (all backed by metaStore):
//   - Music volume slider (0..1 → displayed as 0..100%)
//   - Sounds volume slider (0..1 → displayed as 0..100%)
//   - Screen shake toggle
//   - Danger zone: "Reset all stats" with an inline two-step confirm
//   - Close button
//
// Open/close state is owned by MainMenu (a boolean `showSettings`). This file
// only renders the overlay; it calls `onClose` when the player dismisses it.
//
// Style mirrors PauseMenu so the two screens feel like the same menu chrome.
import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { useMetaStore } from '../../stores/metaStore';

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'auto',
  background: 'rgba(0, 0, 0, 0.82)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'flex-start',
  paddingTop: '8vh',
  paddingBottom: '6vh',
  zIndex: 25,
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
  fontSize: 32,
  letterSpacing: 6,
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

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps): ReactElement {
  const musicVolume = useMetaStore((s) => s.settings.musicVolume);
  const sfxVolume = useMetaStore((s) => s.settings.sfxVolume);
  const screenShake = useMetaStore((s) => s.settings.screenShake);
  const setMusicVolume = useMetaStore((s) => s.setMusicVolume);
  const setSfxVolume = useMetaStore((s) => s.setSfxVolume);
  const setScreenShake = useMetaStore((s) => s.setScreenShake);
  const resetAll = useMetaStore((s) => s.resetAll);

  // Two-step confirm for the danger button. Toggles a local "armed" state;
  // a second click within the same modal session triggers the wipe.
  const [resetArmed, setResetArmed] = useState<boolean>(false);

  const onResetClick = (): void => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    resetAll();
    setResetArmed(false);
    onClose();
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={PANEL_STYLE}>
        <h2 style={TITLE_STYLE}>SETTINGS</h2>

        {/* --- Audio + Display --- */}
        <div>
          <div style={SECTION_LABEL}>Audio &amp; Display</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div style={SLIDER_ROW}>
              <span>Music</span>
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
              <span>Sounds</span>
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
              Screen shake
            </label>
          </div>
        </div>

        {/* --- Danger zone --- */}
        <div>
          <div style={SECTION_LABEL}>Danger Zone</div>
          <div
            style={{
              fontSize: 12,
              opacity: 0.7,
              marginTop: 8,
              lineHeight: 1.4,
            }}
          >
            Wipes total runs, wins, longest survival, unlocked characters, daily
            best times, and your name. Cannot be undone.
          </div>
          <button
            onClick={onResetClick}
            style={{ ...DANGER_BUTTON, marginTop: 10 }}
          >
            {resetArmed ? 'Click again to confirm — wipe all stats' : 'Reset all stats'}
          </button>
          {resetArmed ? (
            <button
              onClick={() => setResetArmed(false)}
              style={{
                background: 'transparent',
                color: '#bbb',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                marginTop: 6,
                padding: 0,
                width: '100%',
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>

        {/* --- Close --- */}
        <button onClick={onClose} style={PRIMARY_BUTTON}>
          Close
        </button>
      </div>
    </div>
  );
}
