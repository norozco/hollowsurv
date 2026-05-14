// Aura visual rings. Extracted from `autoAttack.ts` so the weapon-fire
// dispatcher stays focused on combat logic.
//
// Three stacked concentric circles per equipped aura weapon = soft gradient.
// Cheaper than a real radial gradient and works in Phaser 4 out of the box.
//
// Each ring tracks its weapon entity eid; when the weapon is unequipped the
// per-eid entry is destroyed. The "breathing" pulse is computed from
// `performance.now()` so all rings stay in sync without bookkeeping.

import type Phaser from 'phaser';
import { defineQuery } from 'bitecs';

import { getArenaScene } from '../../core/gameContext';
import { Position, WeaponSlot } from '../components';
import { weaponDefByNum, weaponLevelEffect } from '../../content/weapons';
import type { World } from '../world';

interface AuraVisual {
  outer: Phaser.GameObjects.Arc;
  mid: Phaser.GameObjects.Arc;
  inner: Phaser.GameObjects.Arc;
}
const AURA_RINGS: Map<number, AuraVisual> = new Map();

const weaponSlotQuery = defineQuery([WeaponSlot]);

/**
 * Refresh aura ring positions, radii, and pulse scale for every equipped
 * aura-archetype weapon. Called from `autoAttackSystem` each tick. No-op when
 * the ArenaScene isn't active (boot, menu, etc.).
 */
export function syncAuraVisuals(world: World, playerEid: number): void {
  const scene = getArenaScene();
  if (!scene) return;
  const px = Position.x[playerEid] ?? 0;
  const py = Position.y[playerEid] ?? 0;

  // Breathing pulse: ±5% scale at ~1 Hz. sin(t * 0.006) hits one full cycle
  // every ≈1047ms (2π / 0.006 ms⁻¹). Multiplied into each ring's scale below
  // so the ring radius logic stays the source of truth.
  const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.05;

  const weaponEntities = weaponSlotQuery(world);
  // Track which weapon eids are aura this tick so we can clean up unequipped ones.
  const stillEquipped = new Set<number>();
  for (let i = 0; i < weaponEntities.length; i++) {
    const eid = weaponEntities[i];
    if (eid === undefined) continue;
    const num = WeaponSlot.weaponId[eid] ?? 0;
    const def = weaponDefByNum(num);
    if (!def || def.archetype !== 'aura') continue;
    stillEquipped.add(eid);
    const level = WeaponSlot.level[eid] ?? 1;
    const lvEffect = weaponLevelEffect(def, level);
    const radius = lvEffect.radius ?? 100;
    let ring = AURA_RINGS.get(eid);
    if (!ring) {
      // 3 stacked circles with decreasing radius and increasing alpha → fake
      // radial gradient. No stroke. Depth 5 keeps it under the player (100).
      const outer = scene.add.circle(px, py, 1, def.tint, 0.06).setScale(radius * pulse).setDepth(5);
      const mid = scene.add.circle(px, py, 1, def.tint, 0.10).setScale(radius * 0.7 * pulse).setDepth(5);
      const inner = scene.add.circle(px, py, 1, def.tint, 0.16).setScale(radius * 0.4 * pulse).setDepth(5);
      ring = { outer, mid, inner };
      AURA_RINGS.set(eid, ring);
    } else {
      ring.outer.x = px; ring.outer.y = py; ring.outer.setScale(radius * pulse);
      ring.mid.x = px; ring.mid.y = py; ring.mid.setScale(radius * 0.7 * pulse);
      ring.inner.x = px; ring.inner.y = py; ring.inner.setScale(radius * 0.4 * pulse);
    }
  }
  // Remove rings whose weapon is no longer equipped (rare but possible).
  for (const [eid, ring] of AURA_RINGS) {
    if (!stillEquipped.has(eid)) {
      ring.outer.destroy();
      ring.mid.destroy();
      ring.inner.destroy();
      AURA_RINGS.delete(eid);
    }
  }
}

/**
 * Destroy every active aura ring. Called from scene shutdown via
 * `resetAutoAttack` (autoAttack re-exports through this module).
 */
export function resetAuraVisuals(): void {
  for (const ring of AURA_RINGS.values()) {
    ring.outer.destroy();
    ring.mid.destroy();
    ring.inner.destroy();
  }
  AURA_RINGS.clear();
}
