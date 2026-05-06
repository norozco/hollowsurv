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
import { useRunStore } from '../stores/runStore';
import type { RunPhase } from '../stores/runStore';

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

  constructor() {
    super({ key: 'ArenaScene' });
  }

  create(): void {
    // 1. Create the ECS world for this run.
    const world = createGameWorld();
    this.world = world;

    // 2. Background — dark fill the size of the arena.
    this.add
      .rectangle(ARENA_SIZE_PX / 2, ARENA_SIZE_PX / 2, ARENA_SIZE_PX, ARENA_SIZE_PX, 0x0a0a12)
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
    //    auras (depth 5), enemies/projectiles/pickups (default 0).
    this.playerSprite = this.add.rectangle(
      PLAYER_SPAWN_X,
      PLAYER_SPAWN_Y,
      PLAYER_PLACEHOLDER_SIZE,
      PLAYER_PLACEHOLDER_SIZE,
      PLAYER_PLACEHOLDER_COLOR
    );
    this.playerSprite.setDepth(100);

    // 6. Wire input + camera (one-shot binds; systems read these each tick).
    bindInput(this, eid);
    bindCamera(this, this.playerSprite, eid);

    // 7. Phase mirror — read once now, subscribe for updates.
    this.phaseMirror = useRunStore.getState().phase;
    this.unsubscribePhase = useRunStore.subscribe((s) => {
      this.phaseMirror = s.phase;
    });

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
    pickupSystem(w, delta); // C4
    xpSystem(w, delta); // C4
    lifetimeSystem(w, delta); // C3
    cameraSystem(w, delta);
    renderSystem(w, delta); // C3 (later — SpriteGPULayer)
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
  }
}
