// Boot scene. Loads atlas/audio (none yet), then transitions to ArenaScene.
// Owner: Agent C1.
import Phaser from 'phaser';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  preload(): void {
    // TODO(agentC1): load sprite atlas, weapon icons, sfx.
  }

  create(): void {
    // Brief delay to simulate asset boot, then start ArenaScene.
    this.time.delayedCall(200, () => {
      this.scene.start('ArenaScene');
    });
  }
}
