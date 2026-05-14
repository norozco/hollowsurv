// Name entry screen — asked once, persisted via metaStore.playerName.
// Owner: Agent C5 (integration).
//
// Used inside MainMenu's view-state machine ('title' -> 'name' -> 'characters').
// Not a top-level RunPhase: still phase='menu'. MainMenu owns the routing.
import { useState } from 'react';
import type { CSSProperties, FormEvent, ReactElement } from 'react';
import { useMetaStore } from '../../stores/metaStore';

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

const INPUT_STYLE: CSSProperties = {
  padding: '14px 18px',
  fontSize: 22,
  background: '#1a1a26',
  color: '#eee',
  border: '1px solid #555',
  borderRadius: 4,
  width: 320,
  textAlign: 'center',
  letterSpacing: 1,
  fontFamily: 'inherit',
  outline: 'none',
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

const MAX_NAME_LENGTH = 24;

export interface NameEntryScreenProps {
  /** Called with the cleaned name after Continue is pressed. */
  onContinue: (name: string) => void;
  /** Called when Back is pressed (returns to title). */
  onBack: () => void;
}

export function NameEntryScreen({ onContinue, onBack }: NameEntryScreenProps): ReactElement {
  const currentName = useMetaStore((s) => s.playerName);
  const setPlayerName = useMetaStore((s) => s.setPlayerName);

  const [value, setValue] = useState<string>(currentName);

  const trimmed = value.trim();
  const canContinue = trimmed.length > 0;

  const submit = (e?: FormEvent): void => {
    if (e) e.preventDefault();
    if (!canContinue) return;
    // Defensive cap matches metaStore.setPlayerName's slice(0, 24).
    const cleaned = trimmed.slice(0, MAX_NAME_LENGTH);
    setPlayerName(cleaned);
    onContinue(cleaned);
  };

  return (
    <div style={ROOT_STYLE}>
      <h2 style={{ margin: 0, fontSize: 36, letterSpacing: 4, textAlign: 'center' }}>
        What name do they whisper?
      </h2>
      <form
        onSubmit={submit}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          spellCheck={false}
          placeholder="Stranger"
          style={INPUT_STYLE}
        />
        <div style={{ fontSize: 12, opacity: 0.6, fontVariantNumeric: 'tabular-nums' }}>
          {value.length}/{MAX_NAME_LENGTH}
        </div>
        <button
          type="submit"
          disabled={!canContinue}
          style={{
            ...PRIMARY_BUTTON,
            opacity: canContinue ? 1 : 0.5,
            cursor: canContinue ? 'pointer' : 'not-allowed',
          }}
        >
          Continue
        </button>
      </form>
      <button onClick={onBack} style={SECONDARY_BUTTON}>
        Back
      </button>
    </div>
  );
}
