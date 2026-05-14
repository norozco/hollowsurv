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
import { SynergyToast } from './screens/SynergyToast';
import { BargainOverlay } from './screens/BargainOverlay';
import { HollowChoiceScreen } from './screens/HollowChoiceScreen';
import { PauseMenu } from './screens/PauseMenu';
import { FpsOverlay } from './screens/FpsOverlay';
import { ComboCounter } from './screens/ComboCounter';
import { OnboardingHints } from './screens/OnboardingHints';
import { TouchControls } from './screens/TouchControls';

export function App(): ReactElement {
  const phase = useRunStore((s) => s.phase);

  return (
    <>
      {/* In-run overlay (HP, timer, level, weapons). Visible during play, pause, and over the picker. */}
      {(phase === 'playing' ||
        phase === 'paused' ||
        phase === 'levelup' ||
        phase === 'hollow_select') && <HUD />}

      {/* Hidden-synergy toast. Always mounted so it surfaces in any phase
          (a synergy can complete via runStore mutation outside 'playing' too). */}
      <SynergyToast />

      {/* Devil's Bargain offer. Always mounted; the component reads
          runStore.pendingBargain and manages its own visibility. */}
      <BargainOverlay />

      {/* Survivors-style combo counter + milestone flashes. Manages its own
          visibility (returns null when combo < 2 and no flash is active). */}
      <ComboCounter />

      {/* First-time onboarding hints. Renders nothing once tutorialSeen is true. */}
      <OnboardingHints />

      {/* Virtual joystick + aim circle for touch devices. Self-gated: renders
          nothing on non-touch devices or outside 'playing' phase. */}
      <TouchControls />

      {/* FPS / debug overlay. Always mounted but hidden by default; F3 toggles. */}
      <FpsOverlay />

      {/* Modals (mutually exclusive with each other) */}
      {phase === 'menu' && <MainMenu />}
      {phase === 'paused' && <PauseMenu />}
      {phase === 'levelup' && <LevelUpPicker />}
      {phase === 'hollow_select' && <HollowChoiceScreen />}
      {(phase === 'won' || phase === 'lost') && <RunSummary />}
    </>
  );
}
