// Entry point. Mounts React + boots Phaser.
// Owner: Agent C1 (Phaser boot only); React mount is shared with Agent C5.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Phaser from 'phaser';
import { eventBus } from './core/eventBus';
import { subscribeVoice } from './core/audio';
import { subscribeMusic } from './core/music';
import { useRunStore } from './stores/runStore';
import { BootScene } from './scenes/BootScene';
import { ArenaScene } from './scenes/ArenaScene';
import { App } from './react/App';
import { readBuildFromUrl } from './core/buildCodes';

// 1. Mount React HUD.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('main: #root element missing');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// 2. Boot Phaser.
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
// Expose for dev console only.
(globalThis as { __game?: Phaser.Game }).__game = game;

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
