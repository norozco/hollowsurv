// Batched procedural renderer. Single Phaser Graphics object redrawn each
// tick — no per-entity GameObjects for enemies / projectiles / pickups.
//
// Rationale (audit): allocating a Rectangle/Arc per visible entity exploded the
// Phaser display list and dirty-flag overhead at 500+ active entities. A single
// Graphics that we clear() and re-draw per frame batches everything into one
// draw call's worth of state changes per shape type. fillStyle / lineStyle
// calls flush state; we order draws so each style is set once per shape kind.
//
// Visual contract:
//   - Enemies      — filled square sized to Hitbox.radius * 2, Sprite.tint fill,
//                    1px dark outline. Bosses get a diamond + 3px outline +
//                    inner highlight. Skirmishers get a small inner highlight
//                    dot. Brutes get a darker inner square for depth. Read the
//                    archetype id via `getEnemyNameForEid` (cached by spawn
//                    director). When hit-flash is active (side-channel set by
//                    `flashEnemyVisual`), draw white instead of tint.
//   - Projectiles  — filled circle at hitbox radius, Sprite.tint fill, plus a
//                    larger semi-transparent outer glow circle. White 1px
//                    outline keeps small projectiles legible on dark bg.
//   - Pickups      — filled circle, hitbox-radius scaled. XP orbs are green
//                    (Sprite.tint), heal packs are pink + thicker outline.
//   - Auras / damage numbers / weapon flourish tweens stay as their own
//                    GameObjects (autoAttack.ts owns those — leave alone).
//
// Draw budget per entity (steady state):
//   - Enemy (grunt/skirmisher/brute): 1 fillStyle + 1 lineStyle + 1 fillRect +
//     1 strokeRect = 4 ops. Inner highlight (skirmisher/brute) adds 1 more
//     fillStyle + 1 fillRect.
//   - Boss: 1 fillStyle + 1 lineStyle + 2 fillTriangle + 1 strokePath + small
//     inner-highlight fill. ~6 ops.
//   - Projectile: 1 fillStyle (outer glow) + 1 fillCircle + 1 fillStyle +
//     1 fillCircle + 1 lineStyle + 1 strokeCircle = 6 ops.
//   - Pickup: 1 fillStyle + 1 fillCircle + 1 lineStyle + 1 strokeCircle = 4
//     ops. Heal packs add a small cross overlay.
//
// Compare to the old path: every visible entity carried its own GameObject
// (Container transform, dirty flags, display-list slot). A Graphics object
// reuses GL state per state-change and the per-shape ops are cheap loops in
// Phaser's renderer.
//
// Shutdown: ArenaScene.handleShutdown() calls `unbindBatchedRender()`. The
// Graphics object is destroyed via Phaser's normal GameObject teardown.

import Phaser from 'phaser';
import { defineQuery, hasComponent } from 'bitecs';

import { BossTag, Dead, EnemyTag, Hitbox, Pickup, Position, ProjectileTag, Sprite } from '../components';
import type { World } from '../world';
import { getEnemyArchetypeId, isEnemyFlashing } from './spawnDirector';

// --- bound scene state ------------------------------------------------------

let _graphics: Phaser.GameObjects.Graphics | null = null;

/**
 * Bind the renderer to a scene. Creates the single Graphics object that every
 * tick draws into.
 *
 * Depth 1: above the background fill + grid (depth 0) and below the layered
 * flourishes. Concretely:
 *   - background fill + grid:   depth 0
 *   - batched draws (us):       depth 1
 *   - hollow patches/tide ring: depth 2-3
 *   - aura rings:               depth 5
 *   - frost burst / mortar:     depth 6-8
 *   - player:                   depth 100
 *   - lightning / damage nums:  depth 50 / 900
 *   - announcement:             depth 1000
 *
 * This matches the prior visuals (which created GameObjects at default depth
 * 0 but the grid was a depth-0 Graphics drawn FIRST in display-list order so
 * enemy rectangles rendered on top of the grid). Drawing at depth 1 keeps the
 * grid visible underneath and ensures auras/flourishes overlay enemy bodies
 * (matches the original aura-shadow look).
 */
export function bindBatchedRender(scene: Phaser.Scene): void {
  if (_graphics) {
    // Defensive: re-bind without leaking. Phaser will destroy the prior object.
    _graphics.destroy();
    _graphics = null;
  }
  _graphics = scene.add.graphics();
  _graphics.setDepth(1);
}

/** Tear down. Called from ArenaScene.handleShutdown(). */
export function unbindBatchedRender(): void {
  if (_graphics) {
    _graphics.destroy();
    _graphics = null;
  }
}

// --- queries ----------------------------------------------------------------

// Enemies — anything with EnemyTag + visual components. Bosses share EnemyTag
// (per ARCHITECTURE: bosses get BOTH tags) so we don't need a separate boss
// query.
const enemyQ = defineQuery([EnemyTag, Position, Sprite, Hitbox]);
const projectileQ = defineQuery([ProjectileTag, Position, Sprite, Hitbox]);
const pickupQ = defineQuery([Pickup, Position, Sprite, Hitbox]);

// Tints used by the side-channels.
const FLASH_TINT = 0xffffff;
const OUTLINE_DARK = 0x000000;
const OUTLINE_DARK_ALPHA = 0.6;
const PROJECTILE_OUTLINE = 0xffffff;
const PROJECTILE_OUTLINE_ALPHA = 0.7;
const HEAL_TINT = 0xff5577;

/**
 * Tick the batched renderer. Clears the Graphics and re-draws every visible
 * enemy, projectile, and pickup.
 *
 * Skipped when the scene isn't bound (e.g. between scene start + bind). Reads
 * but does not write ECS components.
 */
export function batchedRenderSystem(world: World, _dt: number): void {
  if (!_graphics) return;
  const g = _graphics;
  g.clear();

  // --- enemies -------------------------------------------------------------
  const enemies = enemyQ(world);
  for (let i = 0; i < enemies.length; i++) {
    const eid = enemies[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;

    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    const r = Hitbox.radius[eid] ?? 16;
    const baseTint = Sprite.tint[eid] ?? 0xffffff;
    const scale = Sprite.scale[eid] ?? 1;
    const flashing = isEnemyFlashing(eid);
    const tint = flashing ? FLASH_TINT : baseTint;
    const isBoss = hasComponent(world, BossTag, eid);

    // Scaled extents: spawn director keeps the ECS Hitbox.radius authoritative
    // for collisions, but the visual scale can be tweaked (bone-skeletons are
    // shrunk via scaleSpawnedEnemy). Render at scale*r so the visual hugs the
    // collision footprint at scale=1 and shrinks/grows in lockstep otherwise.
    const visR = r * scale;
    const size = visR * 2;

    if (isBoss) {
      // Diamond outline. Two filled triangles form the diamond body. A
      // thicker outline (3px) signals "boss" without changing tint logic.
      g.fillStyle(tint, 1);
      g.lineStyle(3, OUTLINE_DARK, OUTLINE_DARK_ALPHA);
      g.fillTriangle(x, y - visR, x + visR, y, x, y + visR);
      g.fillTriangle(x, y - visR, x - visR, y, x, y + visR);
      // Stroke the diamond perimeter so the dark outline reads.
      g.strokeTriangle(x, y - visR, x + visR, y, x, y + visR);
      g.strokeTriangle(x, y - visR, x - visR, y, x, y + visR);
      // Inner highlight — a faint smaller diamond hints at a core. Cheap.
      const innerR = visR * 0.35;
      g.fillStyle(0xffffff, 0.18);
      g.fillTriangle(x, y - innerR, x + innerR, y, x, y + innerR);
      g.fillTriangle(x, y - innerR, x - innerR, y, x, y + innerR);
      continue;
    }

    // Non-boss enemy: filled square + outline.
    g.fillStyle(tint, 1);
    g.lineStyle(1, OUTLINE_DARK, OUTLINE_DARK_ALPHA);
    g.fillRect(x - visR, y - visR, size, size);
    g.strokeRect(x - visR, y - visR, size, size);

    // Optional archetype flourish — skip while flashing so the white blip
    // stays a clean read of "I hit it". Cost: one extra fill per non-flashing
    // skirmisher / brute. Grunts get nothing (the plain square IS the grunt).
    if (!flashing) {
      const archetype = getEnemyArchetypeId(eid);
      if (archetype === 'skirmisher' || archetype === 'runner') {
        // Bright inner dot — signals "this is the fast one".
        const innerR = visR * 0.3;
        g.fillStyle(0xffffff, 0.55);
        g.fillRect(x - innerR, y - innerR, innerR * 2, innerR * 2);
      } else if (archetype === 'brute' || archetype === 'tank') {
        // Darker inner square — signals "this one is tougher".
        const innerR = visR * 0.5;
        // Quick darken: blend toward black by 0.4. Cheap branchless approx.
        const r8 = (tint >> 16) & 0xff;
        const g8 = (tint >> 8) & 0xff;
        const b8 = tint & 0xff;
        const dark =
          ((Math.floor(r8 * 0.55) & 0xff) << 16) |
          ((Math.floor(g8 * 0.55) & 0xff) << 8) |
          (Math.floor(b8 * 0.55) & 0xff);
        g.fillStyle(dark, 1);
        g.fillRect(x - innerR, y - innerR, innerR * 2, innerR * 2);
      }
    }
  }

  // --- projectiles ----------------------------------------------------------
  const projectiles = projectileQ(world);
  for (let i = 0; i < projectiles.length; i++) {
    const eid = projectiles[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;

    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    const r = Math.max(3, Hitbox.radius[eid] ?? 4);
    const tint = Sprite.tint[eid] ?? 0xffe680;
    const scale = Sprite.scale[eid] ?? 1;
    const visR = r * scale;

    // Outer glow — bigger, low alpha. Gives projectiles a "this is hot" feel
    // without lighting math. Drawn first so the inner core paints over it.
    g.fillStyle(tint, 0.28);
    g.fillCircle(x, y, visR * 1.9);

    // Core fill + thin white outline.
    g.fillStyle(tint, 1);
    g.fillCircle(x, y, visR);
    g.lineStyle(1, PROJECTILE_OUTLINE, PROJECTILE_OUTLINE_ALPHA);
    g.strokeCircle(x, y, visR);
  }

  // --- pickups --------------------------------------------------------------
  const pickups = pickupQ(world);
  for (let i = 0; i < pickups.length; i++) {
    const eid = pickups[i];
    if (eid === undefined) continue;
    if (hasComponent(world, Dead, eid)) continue;

    const x = Position.x[eid] ?? 0;
    const y = Position.y[eid] ?? 0;
    const r = Math.max(4, Hitbox.radius[eid] ?? 8);
    const tint = Sprite.tint[eid] ?? 0xa6e36c;
    const isHeal = tint === HEAL_TINT;

    // Visual radius is a bit smaller than the hitbox so the orb reads as
    // a coin rather than a giant blob (collection tolerance > visual).
    const visR = isHeal ? r * 0.85 : r * 0.65;

    g.fillStyle(tint, 1);
    g.fillCircle(x, y, visR);
    if (isHeal) {
      // Thicker outline + a small white plus inside the heal pack.
      g.lineStyle(2, 0xffffff, 0.85);
      g.strokeCircle(x, y, visR);
      const crossArm = visR * 0.55;
      const crossThick = Math.max(1.5, visR * 0.22);
      g.fillStyle(0xffffff, 0.95);
      g.fillRect(x - crossArm, y - crossThick / 2, crossArm * 2, crossThick);
      g.fillRect(x - crossThick / 2, y - crossArm, crossThick, crossArm * 2);
    } else {
      g.lineStyle(1, 0xffffff, 0.5);
      g.strokeCircle(x, y, visR);
    }
  }
}
