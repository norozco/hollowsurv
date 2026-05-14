// Game-feel visuals: floating damage numbers + enemy death puff.
//
// Both helpers are pure Phaser (no ECS allocation) — they rely on Phaser's
// scene tweens for animation and clean up after themselves. Scene discovery
// goes through the `gameContext` singleton so we don't have to thread a Scene
// reference through every call site.
//
// Pool reuse: damage-number Text objects are kept in a tiny ring so we don't
// thrash the GC. When the ring is full we recycle the oldest entry. Death
// puffs are short-lived enough that we just `add.circle` and destroy via the
// tween's onComplete (~250ms each, low frequency in the kill stream).

import type Phaser from 'phaser';

import { getArenaScene } from '../../core/gameContext';

/** Scene cache. Resolved lazily; cleared when the scene goes away. */
let cachedScene: Phaser.Scene | null = null;

function getActiveScene(): Phaser.Scene | null {
  if (cachedScene && cachedScene.scene && cachedScene.scene.isActive()) {
    return cachedScene;
  }
  cachedScene = null;
  const scene = getArenaScene();
  if (!scene) return null;
  cachedScene = scene;
  return scene;
}

// --- damage numbers -------------------------------------------------------

/** Max pooled damage-number text entries. Roughly matches POOL_CAPS.DamageNumber. */
const DAMAGE_NUMBER_POOL_CAP = 40;

/** Lifetime of a damage number in ms. After this it returns to the pool. */
const DAMAGE_NUMBER_LIFETIME_MS = 600;

interface DamageNumberEntry {
  text: Phaser.GameObjects.Text;
  busyUntil: number;
}

const damagePool: DamageNumberEntry[] = [];
/** Index of the oldest entry — used when the pool is full and we must recycle. */
let damagePoolHead = 0;

/**
 * Pull a Text object from the pool, allocating one if the pool isn't yet full.
 * When the pool is full we recycle the oldest entry (assumed expired or about
 * to be). Returns null if no scene is active.
 */
function acquireDamageText(scene: Phaser.Scene): Phaser.GameObjects.Text | null {
  const now = performance.now();

  // Try to find an idle entry first.
  for (let i = 0; i < damagePool.length; i++) {
    const entry = damagePool[i];
    if (!entry) continue;
    if (now >= entry.busyUntil) {
      entry.busyUntil = now + DAMAGE_NUMBER_LIFETIME_MS;
      // Cancel any in-flight tweens against the recycled text (shouldn't be
      // any if busyUntil already elapsed, but defensive).
      scene.tweens.killTweensOf(entry.text);
      entry.text.setActive(true).setVisible(true);
      return entry.text;
    }
  }

  // Grow the pool if we haven't hit the cap.
  if (damagePool.length < DAMAGE_NUMBER_POOL_CAP) {
    const text = scene.add.text(0, 0, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
    });
    text.setOrigin(0.5);
    text.setDepth(900);
    damagePool.push({ text, busyUntil: now + DAMAGE_NUMBER_LIFETIME_MS });
    return text;
  }

  // Pool is full — recycle the oldest entry (ring-style).
  const entry = damagePool[damagePoolHead];
  damagePoolHead = (damagePoolHead + 1) % damagePool.length;
  if (!entry) return null;
  scene.tweens.killTweensOf(entry.text);
  entry.busyUntil = now + DAMAGE_NUMBER_LIFETIME_MS;
  entry.text.setActive(true).setVisible(true);
  return entry.text;
}

/**
 * Spawn a floating damage number at the given world position. Rises ~30px and
 * fades out over 600ms. Crit hits use a larger gold variant.
 *
 * Safe to call from any system: no-op if the scene isn't active. Numbers are
 * rounded; tiny (<1) hits are skipped so chain/aura ticks don't spam the
 * screen with `0`s.
 */
export function spawnDamageNumber(
  x: number,
  y: number,
  amount: number,
  isCrit: boolean,
): void {
  if (amount < 1) return;
  const scene = getActiveScene();
  if (!scene) return;
  const text = acquireDamageText(scene);
  if (!text) return;

  // Snap the label to an integer for readability.
  const rounded = Math.max(1, Math.round(amount));
  const label = isCrit ? `${rounded} CRIT!` : `${rounded}`;
  const fontSize = isCrit ? '18px' : '14px';
  const color = isCrit ? '#ffd966' : '#ffffff'; // gold for crits, white otherwise
  const rise = isCrit ? 50 : 30;

  // Re-style each call: pool entries are reused across crit/non-crit hits.
  text.setStyle({
    fontFamily: 'system-ui, sans-serif',
    fontSize,
    color,
    stroke: '#000000',
    strokeThickness: 3,
  });
  text.setText(label);
  text.setPosition(x, y);
  text.setAlpha(1);
  text.setScale(1);
  text.setVisible(true);

  // Rise + fade tween. Phaser will clean up the tween itself when it
  // completes; we just hide the text. The pool's busyUntil ensures it
  // won't be re-acquired before the tween finishes.
  scene.tweens.add({
    targets: text,
    y: y - rise,
    alpha: 0,
    duration: DAMAGE_NUMBER_LIFETIME_MS,
    ease: 'Cubic.out',
    onComplete: () => {
      text.setVisible(false);
    },
  });
}

// --- death puff -----------------------------------------------------------

/** Number of particles in a death puff. */
const PUFF_PARTICLE_COUNT = 5;
/** How far each puff particle drifts outward (px). */
const PUFF_RADIUS_PX = 24;
/** Lifetime of a single puff in ms. */
const PUFF_LIFETIME_MS = 250;

/**
 * Spawn a short ash burst at the given position when an enemy dies. The colour
 * blends the enemy's tint with a grey ash tone so the burst reads as "smoke"
 * regardless of which enemy died.
 *
 * Each particle uses its own tween + onComplete destroy. With ~5 particles per
 * death and PUFF_LIFETIME_MS short, even at 100 kills/sec we top out at ~500
 * concurrent circles which Phaser handles comfortably. No pool required.
 */
export function spawnDeathPuff(x: number, y: number, enemyTint: number): void {
  const scene = getActiveScene();
  if (!scene) return;

  // Blend tint toward grey (0x666666) at 50% for an ash look.
  const ASH = 0x666666;
  const r = (((enemyTint >> 16) & 0xff) + ((ASH >> 16) & 0xff)) >> 1;
  const g = (((enemyTint >> 8) & 0xff) + ((ASH >> 8) & 0xff)) >> 1;
  const b = ((enemyTint & 0xff) + (ASH & 0xff)) >> 1;
  const puffTint = (r << 16) | (g << 8) | b;

  for (let i = 0; i < PUFF_PARTICLE_COUNT; i++) {
    const angle = (i / PUFF_PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.4;
    const distance = PUFF_RADIUS_PX * (0.7 + Math.random() * 0.5);
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;
    const startRadius = 4 + Math.random() * 2;
    const circle = scene.add
      .circle(x, y, startRadius, puffTint, 0.8)
      .setDepth(50);
    scene.tweens.add({
      targets: circle,
      x: x + dx,
      y: y + dy,
      alpha: 0,
      scale: 0.4,
      duration: PUFF_LIFETIME_MS,
      ease: 'Quad.out',
      onComplete: () => circle.destroy(),
    });
  }
}

/**
 * Drop all pooled state. Called from scene shutdown so a fresh run doesn't
 * inherit stale Text objects from a destroyed scene.
 */
export function resetDamageNumbers(): void {
  for (const entry of damagePool) {
    if (entry && entry.text) {
      entry.text.destroy();
    }
  }
  damagePool.length = 0;
  damagePoolHead = 0;
  cachedScene = null;
}
