// Main gameplay scene. Owns the bitECS world for one run.
// Owner: Agent C1.
//
// Tick order (per ARCHITECTURE.md §3 / CONTRACTS.md §6):
//   inputSystem -> flowfieldSystem -> movementSystem -> spawnDirectorSystem ->
//   autoAttackSystem -> projectileSystem -> collisionSystem -> damageSystem ->
//   pickupSystem -> xpSystem -> lifetimeSystem -> cameraSystem -> renderSystem
//
// Currently only input/movement/camera are wired; the rest are no-op stubs
// owned by other agents (C2/C3/C4). Their ordering is preserved so the
// pipeline lights up without further scene changes.
import Phaser from 'phaser';
import { addComponent, addEntity } from 'bitecs';
import { eventBus } from '../core/eventBus';
import { ARENA_SIZE_PX } from '../core/flowfield';
import {
  Health,
  Hitbox,
  PlayerInput,
  PlayerTag,
  Position,
  Stats,
  Velocity,
} from '../ecs/components';
import { createGameWorld, destroyGameWorld } from '../ecs/world';
import type { World } from '../ecs/world';
import { bindInput, inputSystem, unbindInput } from '../ecs/systems/input';
import { flowfieldSystem } from '../ecs/systems/flowfield';
import { movementSystem } from '../ecs/systems/movement';
import { spawnDirectorSystem } from '../ecs/systems/spawnDirector';
import { autoAttackSystem } from '../ecs/systems/autoAttack';
import { projectileSystem } from '../ecs/systems/projectile';
import { collisionSystem } from '../ecs/systems/collision';
import { damageSystem } from '../ecs/systems/damage';
import { pickupSystem } from '../ecs/systems/pickup';
import { xpSystem } from '../ecs/systems/xp';
import { lifetimeSystem } from '../ecs/systems/lifetime';
import { bindCamera, cameraSystem, unbindCamera } from '../ecs/systems/camera';
import { renderSystem } from '../ecs/systems/render';
import { bargainSystem } from '../ecs/systems/bargain';
import { hollowMechanicsSystem } from '../ecs/systems/hollowMechanics';
import { HOLLOWS } from '../content/hollows';
import { useRunStore } from '../stores/runStore';
import type { RunPhase } from '../stores/runStore';
import { useMetaStore } from '../stores/metaStore';

/** Player spawn position (arena center). */
const PLAYER_SPAWN_X = ARENA_SIZE_PX / 2;
const PLAYER_SPAWN_Y = ARENA_SIZE_PX / 2;

/** Player visual placeholder size in pixels (square). */
const PLAYER_PLACEHOLDER_SIZE = 32;
/** Player tint for the placeholder rectangle. */
const PLAYER_PLACEHOLDER_COLOR = 0xe8d4a8;
/** Player hitbox radius. Halfway across the placeholder square. */
const PLAYER_HITBOX_RADIUS = 16;

/** Default player health. Mirrors runStore's INITIAL_PLAYER. */
const PLAYER_HP = 100;

export class ArenaScene extends Phaser.Scene {
  private world: World | null = null;
  /** Phase mirror updated by a single runStore.subscribe registered in create(). */
  private phaseMirror: RunPhase = 'playing';
  private unsubscribePhase: (() => void) | null = null;
  /** Placeholder visual for the player. Real sprite arrives later. */
  private playerSprite: Phaser.GameObjects.Rectangle | null = null;
  private playerEid: number = -1;
  /** runStartedAtMs of the run we last announced; prevents double-firing on
   *  HMR / phase wobble (e.g. playing -> levelup -> playing). */
  private lastAnnouncedRunStartedAtMs: number = 0;
  /** Background fill rectangle. We tint this when a Hollow is picked so the
   *  arena palette shifts without touching the global camera tint. */
  private backgroundFill: Phaser.GameObjects.Rectangle | null = null;
  /** Default background tint (so we can restore on next run start). */
  private readonly backgroundDefaultTint = 0x0a0a12;
  /** Last selectedHollowId we applied a tint for; null = default tint active. */
  private lastAppliedHollowId: string | null = null;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create(): void {
    // 1. Create the ECS world for this run.
    const world = createGameWorld();
    this.world = world;

    // 2. Background — dark fill the size of the arena. Kept on the scene so
    //    the Hollow palette tinting code can recolor it when the player picks.
    this.backgroundFill = this.add
      .rectangle(
        ARENA_SIZE_PX / 2,
        ARENA_SIZE_PX / 2,
        ARENA_SIZE_PX,
        ARENA_SIZE_PX,
        this.backgroundDefaultTint
      )
      .setStrokeStyle(2, 0x222233);

    // 2b. Grid overlay so player can perceive motion (placeholder; replaced by tilemap later).
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x1a1a2a, 1);
    const GRID_STEP = 128;
    for (let x = 0; x <= ARENA_SIZE_PX; x += GRID_STEP) {
      grid.lineBetween(x, 0, x, ARENA_SIZE_PX);
    }
    for (let y = 0; y <= ARENA_SIZE_PX; y += GRID_STEP) {
      grid.lineBetween(0, y, ARENA_SIZE_PX, y);
    }
    // Heavier lines every 512px for orientation.
    grid.lineStyle(2, 0x2a2a3f, 1);
    for (let x = 0; x <= ARENA_SIZE_PX; x += 512) {
      grid.lineBetween(x, 0, x, ARENA_SIZE_PX);
    }
    for (let y = 0; y <= ARENA_SIZE_PX; y += 512) {
      grid.lineBetween(0, y, ARENA_SIZE_PX, y);
    }

    // 3. Camera background (outside arena bounds).
    this.cameras.main.setBackgroundColor(0x05050a);

    // 4. Spawn the player ECS entity.
    const eid = addEntity(world);
    addComponent(world, PlayerTag, eid);
    addComponent(world, PlayerInput, eid);
    addComponent(world, Position, eid);
    addComponent(world, Velocity, eid);
    addComponent(world, Stats, eid);
    addComponent(world, Health, eid);
    addComponent(world, Hitbox, eid);

    Position.x[eid] = PLAYER_SPAWN_X;
    Position.y[eid] = PLAYER_SPAWN_Y;
    Velocity.vx[eid] = 0;
    Velocity.vy[eid] = 0;
    Stats.moveSpeedMul[eid] = 1.0;
    Stats.attackSpeedMul[eid] = 1.0;
    Stats.damageMul[eid] = 1.0;
    Stats.pickupRadiusMul[eid] = 1.0;
    Health.hp[eid] = PLAYER_HP;
    Health.maxHp[eid] = PLAYER_HP;
    Hitbox.radius[eid] = PLAYER_HITBOX_RADIUS;
    PlayerInput.dirX[eid] = 0;
    PlayerInput.dirY[eid] = 0;
    PlayerInput.aimX[eid] = 0;
    PlayerInput.aimY[eid] = 0;
    PlayerInput.manualAim[eid] = 0;

    this.playerEid = eid;

    // Publish the eid back to the run store so the HUD can reference it.
    useRunStore.setState((s) => ({ player: { ...s.player, eid } }));

    // 5. Render placeholder for the player. Depth 100 keeps player on top of
    //    auras (depth 5), enemies/projectiles/pickups (default 0). Color from
    //    selected character (defaults to the tan Ranger color).
    this.playerSprite = this.add.rectangle(
      PLAYER_SPAWN_X,
      PLAYER_SPAWN_Y,
      PLAYER_PLACEHOLDER_SIZE,
      PLAYER_PLACEHOLDER_SIZE,
      PLAYER_PLACEHOLDER_COLOR
    );
    this.playerSprite.setDepth(100);

    // Sync player color to selected character when it changes (or first paint).
    const applyTint = (id: string): void => {
      // Lazy import via globalThis to avoid pulling content/characters into the
      // scene module. Falls back to the default color if not yet loaded.
      const sprite = this.playerSprite;
      if (!sprite) return;
      // Dynamic require (Vite handles ESM):
      void import('../content/characters').then(({ getCharacter }) => {
        sprite.fillColor = getCharacter(id).tint;
      });
    };
    applyTint(useRunStore.getState().selectedCharacterId);
    useRunStore.subscribe((s) => applyTint(s.selectedCharacterId));

    // 6. Wire input + camera (one-shot binds; systems read these each tick).
    bindInput(this, eid);
    bindCamera(this, this.playerSprite, eid);

    // 7. Phase mirror — read once now, subscribe for updates.
    //    Also detect run-start transitions to show the announcement overlay.
    this.phaseMirror = useRunStore.getState().phase;
    this.unsubscribePhase = useRunStore.subscribe((s) => {
      const prev = this.phaseMirror;
      this.phaseMirror = s.phase;
      // Announcement fires on entering 'playing' with a fresh runStartedAtMs.
      // Comparing against lastAnnouncedRunStartedAtMs prevents double-firing
      // when phase wobbles (playing -> levelup -> playing) within one run.
      if (
        s.phase === 'playing' &&
        prev !== 'playing' &&
        s.runStartedAtMs > 0 &&
        s.runStartedAtMs !== this.lastAnnouncedRunStartedAtMs
      ) {
        this.lastAnnouncedRunStartedAtMs = s.runStartedAtMs;
        this.showRunAnnouncement();
      }
      // Hollow palette: re-tint the background rectangle whenever the selected
      // Hollow changes (including transitions away from a Hollow on a new run).
      if (s.selectedHollowId !== this.lastAppliedHollowId) {
        this.applyHollowPalette(s.selectedHollowId);
      }
    });
    // If we entered the scene already in 'playing' (e.g. dev autostart), still
    // honor the contract.
    if (this.phaseMirror === 'playing') {
      const s = useRunStore.getState();
      if (s.runStartedAtMs > 0 && s.runStartedAtMs !== this.lastAnnouncedRunStartedAtMs) {
        this.lastAnnouncedRunStartedAtMs = s.runStartedAtMs;
        this.showRunAnnouncement();
      }
    }

    // 8. C5 menu wired — do NOT force 'playing'. Wait for Start Run button.

    // 9. Lifecycle hooks.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.handleShutdown, this);
  }

  override update(_time: number, delta: number): void {
    // While paused / level-up / menu / won / lost, skip the entire tick.
    if (this.phaseMirror !== 'playing') return;

    // Update elapsed time on the run store for the HUD.
    const store = useRunStore.getState();
    if (store.runStartedAtMs > 0) {
      useRunStore.setState({ elapsedMs: performance.now() - store.runStartedAtMs });
    }

    const w = this.world;
    if (!w) return;

    // All systems live. Canonical tick order.
    inputSystem(w, delta);
    flowfieldSystem(w, delta); // C2
    movementSystem(w, delta);
    spawnDirectorSystem(w, delta); // C2
    autoAttackSystem(w, delta); // C3
    projectileSystem(w, delta); // C3
    collisionSystem(w, delta); // C3
    damageSystem(w, delta); // C3
    hollowMechanicsSystem(w, delta); // Branching Hollows — per-Hollow per-tick logic.
    pickupSystem(w, delta); // C4
    xpSystem(w, delta); // C4
    lifetimeSystem(w, delta); // C3
    bargainSystem(w, delta); // Devil's Bargain — offer timer + auto-pass.
    cameraSystem(w, delta);
    renderSystem(w, delta); // C3 (later — SpriteGPULayer)
  }

  /**
   * Show the centered "{name}, you are {epithet}." overlay for ~2 seconds.
   * Fades 0 -> 1 -> 0 (alpha tween in two stages) and self-destroys.
   *
   * Anchored to the camera (scrollFactor 0) so it stays centered even though
   * the camera follows the player. Depth 1000 keeps it above everything.
   */
  private showRunAnnouncement(): void {
    const name = useMetaStore.getState().playerName || 'Stranger';
    const epithet = useRunStore.getState().runEpithet || 'the Hollow';
    const message = `${name}, you are ${epithet}.`;

    const cam = this.cameras.main;
    const cx = cam.width / 2;
    const cy = cam.height / 2;

    const text = this.add.text(cx, cy, message, {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '32px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4,
      align: 'center',
      shadow: {
        offsetX: 0,
        offsetY: 0,
        color: '#ffffff',
        blur: 8,
        stroke: false,
        fill: true,
      },
    });
    text.setOrigin(0.5);
    text.setScrollFactor(0); // anchor to camera, not world
    text.setDepth(1000);
    text.setAlpha(0);

    // Two-stage tween: fade in 400ms, hold ~1200ms, fade out 400ms, destroy.
    this.tweens.add({
      targets: text,
      alpha: 1,
      duration: 400,
      ease: 'Sine.Out',
      onComplete: () => {
        this.tweens.add({
          targets: text,
          alpha: 0,
          delay: 1200,
          duration: 400,
          ease: 'Sine.In',
          onComplete: () => {
            text.destroy();
          },
        });
      },
    });
  }

  /**
   * Recolor the arena background to match the picked Hollow's palette. We tint
   * the BACKGROUND RECTANGLE (not the camera) — camera tints affect every
   * GameObject and cost more to revert. When `hollowId` is null the default
   * dark tint is restored so a fresh run starts neutral.
   *
   * Subtle wash: we blend the palette toward the default dark fill so combat
   * silhouettes stay readable (a full-saturation tint would white-out the
   * Bone Hollow).
   */
  private applyHollowPalette(hollowId: string | null): void {
    this.lastAppliedHollowId = hollowId;
    const bg = this.backgroundFill;
    if (!bg) return;
    if (hollowId === null) {
      bg.fillColor = this.backgroundDefaultTint;
      return;
    }
    // Look up the palette tint. Fall back to the default if the id isn't in
    // HOLLOWS (defensive — pickHollow already validates).
    const palette = HOLLOWS[hollowId as keyof typeof HOLLOWS]?.paletteTint;
    if (palette === undefined) {
      bg.fillColor = this.backgroundDefaultTint;
      return;
    }
    // Blend palette toward the dark default at ~25% palette weight so the
    // scene reads as "tinted dark" rather than a solid wash.
    const PAL_WEIGHT = 0.25;
    const dr = ((this.backgroundDefaultTint >> 16) & 0xff) * (1 - PAL_WEIGHT);
    const dg = ((this.backgroundDefaultTint >> 8) & 0xff) * (1 - PAL_WEIGHT);
    const db = (this.backgroundDefaultTint & 0xff) * (1 - PAL_WEIGHT);
    const pr = ((palette >> 16) & 0xff) * PAL_WEIGHT;
    const pg = ((palette >> 8) & 0xff) * PAL_WEIGHT;
    const pb = (palette & 0xff) * PAL_WEIGHT;
    const r = Math.min(255, Math.floor(dr + pr));
    const g = Math.min(255, Math.floor(dg + pg));
    const b = Math.min(255, Math.floor(db + pb));
    bg.fillColor = (r << 16) | (g << 8) | b;
  }

  private handleShutdown(): void {
    if (this.unsubscribePhase) {
      this.unsubscribePhase();
      this.unsubscribePhase = null;
    }
    unbindInput();
    unbindCamera();
    if (this.world) {
      destroyGameWorld(this.world);
      this.world = null;
    }
    eventBus.clear();
    this.playerSprite = null;
    this.playerEid = -1;
    this.backgroundFill = null;
    this.lastAppliedHollowId = null;
  }
}
