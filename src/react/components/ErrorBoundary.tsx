// Top-level React error boundary. Catches any thrown error inside the React
// subtree and renders a friendly fallback panel instead of leaving the user
// staring at a blank screen.
//
// Wrapping: applied in main.tsx around <App /> inside the StrictMode block.
// Phaser lives outside the React tree so it is NOT inside the boundary — that's
// intentional. Phaser errors are reported in the dev console as before.
//
// On error we log to console.error (preserving the stack for debugging) and
// show a panel styled like the other modals: dark backdrop, panel, "Reload"
// button that calls window.location.reload(). No retry logic — the state is
// likely poisoned and a hard reload is the safest recovery path for a small
// solo-dev game.

import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactElement, ReactNode } from 'react';
import { t } from '../../content/strings';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'auto',
  background: 'rgba(0, 0, 0, 0.92)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  color: '#eee',
  fontFamily: 'system-ui, sans-serif',
  padding: 24,
};

const PANEL_STYLE: CSSProperties = {
  width: 'min(560px, 90vw)',
  background: '#14141d',
  border: '1px solid #6a2a2a',
  borderRadius: 8,
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 32,
  letterSpacing: 6,
  textAlign: 'center',
  color: '#eaa',
};

const MESSAGE_STYLE: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: '#cdd',
  fontFamily: 'ui-monospace, monospace',
  background: '#0c0c14',
  border: '1px solid #2a2a3a',
  borderRadius: 4,
  padding: 12,
  maxHeight: '40vh',
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const RELOAD_BUTTON: CSSProperties = {
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

const HINT_STYLE: CSSProperties = {
  fontSize: 12,
  opacity: 0.65,
  textAlign: 'center',
  marginTop: -4,
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Preserve the React component stack for debugging — getDerivedStateFromError
    // only sees the raw Error.
    console.error('[ErrorBoundary] caught error:', error);
    console.error('[ErrorBoundary] component stack:', info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const message = this.state.error?.message ?? t('errorUnknown');
    const stack = this.state.error?.stack ?? '';

    return (
      <div style={ROOT_STYLE}>
        <div style={PANEL_STYLE}>
          <h2 style={TITLE_STYLE}>{t('errorTitle')}</h2>
          <div style={HINT_STYLE}>
            {t('errorHint')}
          </div>
          <div style={MESSAGE_STYLE}>
            <div style={{ color: '#eaa', marginBottom: 6 }}>{message}</div>
            {stack ? <div style={{ opacity: 0.6, fontSize: 11 }}>{stack}</div> : null}
          </div>
          <button onClick={this.reload} style={RELOAD_BUTTON}>
            {t('errorReload')}
          </button>
        </div>
      </div>
    );
  }
}
