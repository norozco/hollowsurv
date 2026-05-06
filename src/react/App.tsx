// Top-level React app. Routes between menu, in-run HUD, level-up modal, and run summary.
// Owner: Agent C5.
//
// Layering (per ARCHITECTURE.md §2):
//   z=0   Phaser canvas (#phaser-root, position: fixed, inset: 0)
//   z=10  HUD overlay (pointer-events: none on root, auto on interactive bits)
//   z=20  Modal layer (LevelUpPicker, MainMenu, RunSummary)
//
// The HUD is mounted whenever a run is active or the picker is up so that
// timer/HP keep ticking visibly behind the picker dim.
import type { ReactElement } from 'react';
import { useRunStore } from '../stores/runStore';
import { HUD } from './screens/HUD';
import { LevelUpPicker } from './screens/LevelUpPicker';
import { RunSummary } from './screens/RunSummary';
import { MainMenu } from './screens/MainMenu';

export function App(): ReactElement {
  const phase = useRunStore((s) => s.phase);

  return (
    <>
      {/* In-run overlay (HP, timer, level, weapons). Visible during play, pause, and over the picker. */}
      {(phase === 'playing' || phase === 'paused' || phase === 'levelup') && <HUD />}

      {/* Modals (mutually exclusive with each other) */}
      {phase === 'menu' && <MainMenu />}
      {phase === 'levelup' && <LevelUpPicker />}
      {(phase === 'won' || phase === 'lost') && <RunSummary />}
    </>
  );
}
