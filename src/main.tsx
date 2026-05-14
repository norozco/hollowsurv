// Entry point. Mounts React + boots Phaser.
// Owner: Agent C1 (Phaser boot only); React mount is shared with Agent C5.
//
// Bundle-size optimisation: Phaser (~1.2 MB) and the scene modules that drag
// it in are loaded via dynamic import() *after* React's first paint, so the
// title-screen experience starts as soon as the React + vendor chunks land.
// The Phaser canvas pops in shortly after; the menu doesn't need it.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { eventBus } from './core/eventBus';
import { subscribeVoice } from './core/audio';
import { subscribeMusic } from './core/music';
import { useRunStore } from './stores/runStore';
import { App } from './react/App';
import { ErrorBoundary } from './react/components/ErrorBoundary';
import { readBuildFromUrl } from './core/buildCodes';
import { setGame } from './core/gameContext';

// 1. Mount React HUD. ErrorBoundary catches any thrown error inside the React
// tree and shows a friendly fallback panel instead of a blank page.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('main: #root element missing');
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

// 2. Boot Phaser asynchronously so the React menu can paint without waiting
//    for the ~1.2 MB Phaser bundle. The three import()s run in parallel and
//    end up in their own chunks (phaser vendor + BootScene + ArenaScene).
async function bootPhaser(): Promise<void> {
  const [phaserMod, bootMod, arenaMod] = await Promise.all([
    import('phaser'),
    import('./scenes/BootScene'),
    import('./scenes/ArenaScene'),
  ]);
  const Phaser = phaserMod.default;
  const { BootScene } = bootMod;
  const { ArenaScene } = arenaMod;

  const phaserParent = document.getElementById('phaser-root');
  const phaserConfig: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent: phaserParent ?? 'phaser-root',
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#05050a',
    pixelArt: false,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, ArenaScene],
    // physics not used — we run our own ECS sim on top of Phaser scenes.
  };

  const game = new Phaser.Game(phaserConfig);
  // Register with the typed gameContext singleton (the canonical way for
  // systems to resolve the scene).
  setGame(game);
  // Also expose on globalThis for the dev console workflow. Production code
  // should NOT read this — use `getArenaScene()` from `core/gameContext`.
  (globalThis as { __game?: Phaser.Game }).__game = game;
}
void bootPhaser();

// 3. Wire eventBus -> runStore translator (single subscriber).
//    This is the one place ECS events become UI state.
eventBus.on('enemy_killed', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('player_hit', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('damage_dealt', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('level_up', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('pickup_collected', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('boss_spawned', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('run_won', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('run_lost', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('upgrade_chosen', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('pause_requested', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('resume_requested', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('weapon_fired', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('projectile_spawned', (e) => useRunStore.getState()._applyEvent(e));
eventBus.on('wave_started', (e) => useRunStore.getState()._applyEvent(e));

// 4. Esc -> pause request (boot scaffold; later hooked to a proper input plugin).
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    const phase = useRunStore.getState().phase;
    if (phase === 'playing') eventBus.emit({ type: 'pause_requested' });
    else if (phase === 'paused') eventBus.emit({ type: 'resume_requested' });
  }
});

// 5. Subscribe the voice + music layers to game events.
subscribeVoice();
subscribeMusic();

// 6. C5 menu is wired — runStore starts in 'menu' phase. Start Run button transitions to 'playing'.

// 7. Shareable build code: if the page was loaded with `?b=...`, decode the
//    snapshot and stash it on the run store. The next startRun() will consume
//    it (matching by character id, with the snapshot's character id winning if
//    the caller doesn't pass one).
const initialBuild = readBuildFromUrl();
if (initialBuild) {
  useRunStore.setState({ pendingBuildSnapshot: initialBuild });
}
