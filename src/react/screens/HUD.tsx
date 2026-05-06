// In-game HUD: timer (top), HP + level (bottom-left), XP bar (bottom-center),
// weapon slots (bottom-right). Pointer-events: none on the root so the canvas
// receives input through the overlay. No interactive elements live here yet.
//
// Selector discipline: each slice is its own narrow selector to keep React
// from re-rendering the whole tree on unrelated mutations (e.g. kills count
// shouldn't repaint the HP bar).
//
// Owner: Agent C5.
import type { CSSProperties, ReactElement } from 'react';
import { useRunStore } from '../../stores/runStore';
import { useShallow } from 'zustand/react/shallow';

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const ROOT_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  fontFamily: 'system-ui, sans-serif',
  color: '#eee',
  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
  zIndex: 10,
};

const TIMER_STYLE: CSSProperties = {
  position: 'absolute',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  fontSize: 28,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: 2,
};

const HP_BLOCK_STYLE: CSSProperties = {
  position: 'absolute',
  left: 16,
  bottom: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const HP_BAR_OUTER: CSSProperties = {
  position: 'relative',
  width: 240,
  height: 18,
  background: 'rgba(0,0,0,0.55)',
  border: '1px solid #444',
  borderRadius: 3,
  overflow: 'hidden',
};

const XP_BLOCK_STYLE: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 16,
  transform: 'translateX(-50%)',
  width: 360,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  alignItems: 'center',
};

const XP_BAR_OUTER: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: 8,
  background: 'rgba(0,0,0,0.55)',
  border: '1px solid #444',
  borderRadius: 2,
  overflow: 'hidden',
};

const WEAPONS_BLOCK_STYLE: CSSProperties = {
  position: 'absolute',
  right: 16,
  bottom: 16,
  display: 'flex',
  gap: 8,
};

const WEAPON_SLOT_STYLE: CSSProperties = {
  width: 44,
  height: 44,
  background: 'rgba(0,0,0,0.55)',
  border: '1px solid #555',
  borderRadius: 4,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  lineHeight: 1.2,
};

export function HUD(): ReactElement {
  // Narrow selectors — one slice per visual region.
  const elapsedMs = useRunStore((s) => s.elapsedMs);
  const hp = useRunStore((s) => s.player.hp);
  const maxHp = useRunStore((s) => s.player.maxHp);
  const level = useRunStore((s) => s.player.level);
  const xp = useRunStore((s) => s.player.xp);
  const xpToNext = useRunStore((s) => s.player.xpToNext);
  // Weapons is an array; use shallow equality so mutating a single slot
  // doesn't tear down sibling components.
  const weapons = useRunStore(useShallow((s) => s.player.weapons));
  const phase = useRunStore((s) => s.phase);

  const hpFrac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  const xpFrac = xpToNext > 0 ? Math.max(0, Math.min(1, xp / xpToNext)) : 0;

  return (
    <div style={ROOT_STYLE}>
      <div style={TIMER_STYLE}>{formatTime(elapsedMs)}</div>

      {/* Bottom-left: HP bar + level */}
      <div style={HP_BLOCK_STYLE}>
        <div style={{ fontSize: 13, opacity: 0.9 }}>Lv {level}</div>
        <div style={HP_BAR_OUTER}>
          <div
            style={{
              width: `${(hpFrac * 100).toFixed(1)}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #b34, #e55)',
              transition: 'width 120ms ease-out',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {Math.round(hp)} / {Math.round(maxHp)}
          </div>
        </div>
      </div>

      {/* Bottom-center: XP bar */}
      <div style={XP_BLOCK_STYLE}>
        <div style={XP_BAR_OUTER}>
          <div
            style={{
              width: `${(xpFrac * 100).toFixed(1)}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #4af, #6df)',
              transition: 'width 120ms linear',
            }}
          />
        </div>
        <div style={{ fontSize: 11, opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(xp)} / {Math.round(xpToNext)} XP
        </div>
      </div>

      {/* Bottom-right: weapon slots */}
      <div style={WEAPONS_BLOCK_STYLE}>
        {weapons.length === 0 ? (
          <div style={{ ...WEAPON_SLOT_STYLE, opacity: 0.5 }}>
            <span style={{ fontSize: 10 }}>(none)</span>
          </div>
        ) : (
          weapons.map((w) => (
            <div key={w.id} style={WEAPON_SLOT_STYLE}>
              <span style={{ fontSize: 9, textAlign: 'center', padding: '0 2px' }}>
                {w.id}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600 }}>
                Lv{w.level}
                {w.evolved ? '*' : ''}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Pause overlay (passive — input handled by global Esc listener) */}
      {phase === 'paused' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            letterSpacing: 4,
          }}
        >
          PAUSED
        </div>
      )}
    </div>
  );
}
