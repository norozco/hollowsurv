// Shareable build codes — encode/decode the current character + weapons + augments
// to a short, URL-safe string so players can copy a build, paste a link, and load
// the same starting setup.
//
// Format: `<CHAR>-<WEAPONS>_<AUGMENTS>`
//   - CHAR: 2-letter character code (RG = ranger, BR = brawler)
//   - WEAPONS: dot-separated `<wpn><level>` entries, e.g. `bld5.aur3`
//   - AUGMENTS: dot-separated augment codes, e.g. `crit.spl.life`
//
// Examples:
//   RG-pst1                       Ranger, Auto-Pistol L1, no augments
//   RG-pst1.aur3                  Ranger, Auto-Pistol L1 + Aura L3
//   BR-bld5.frn3.lit2_crit.spl    Brawler, three weapons, crit + splash
//
// Used by:
//   - LevelUpPicker / RunSummary "Copy Build" buttons (encode from runStore)
//   - main.tsx URL-parse on load (decode -> runStore.pendingBuildSnapshot)
//   - runStore.startRun consumes pendingBuildSnapshot to populate the run

import { useRunStore } from '../stores/runStore';
import { CHARACTERS } from '../content/characters';
import { WEAPONS } from '../content/weapons';
import { UPGRADES } from '../content/upgrades';

export interface BuildSnapshot {
  characterId: string;
  weapons: Array<{ id: string; level: number }>;
  augments: string[]; // upgrade ids (e.g. 'aug-crit')
}

// --- character <-> 2-char code ---------------------------------------------

const CHAR_ID_TO_CODE: Record<string, string> = {
  ranger: 'RG',
  brawler: 'BR',
};
const CHAR_CODE_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(CHAR_ID_TO_CODE).map(([id, code]) => [code, id])
);

// --- weapon <-> 3-char code ------------------------------------------------

const WEAPON_ID_TO_CODE: Record<string, string> = {
  'auto-pistol': 'pst',
  'aura': 'aur',
  'piercer': 'prc',
  'frost-nova': 'frn',
  'lightning': 'lit',
  'boomerang': 'bmr',
  'sawblade': 'saw',
  'mortar': 'mrt',
  'shotgun': 'sht',
  'blade': 'bld',
};
const WEAPON_CODE_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(WEAPON_ID_TO_CODE).map(([id, code]) => [code, id])
);

// --- augment id <-> 3-5 char code -----------------------------------------

const AUGMENT_ID_TO_CODE: Record<string, string> = {
  'aug-damage': 'dmg',
  'aug-speed': 'spd',
  'aug-pickup': 'pck',
  'aug-attackspeed': 'atk',
  'aug-maxhp': 'mhp',
  'aug-lifesteal': 'life',
  'aug-crit': 'crit',
  'aug-splash': 'spl',
  'aug-thorns': 'tho',
  'aug-knockback': 'knk',
  'aug-berserker': 'brk',
  'aug-steelskin': 'stl',
};
const AUGMENT_CODE_TO_ID: Record<string, string> = Object.fromEntries(
  Object.entries(AUGMENT_ID_TO_CODE).map(([id, code]) => [code, id])
);

// --- encode ----------------------------------------------------------------

/** Encode a build snapshot to a short URL-safe code. Unknown ids are skipped. */
export function encodeBuild(snapshot: BuildSnapshot): string {
  const charCode = CHAR_ID_TO_CODE[snapshot.characterId] ?? CHAR_ID_TO_CODE['ranger']!;

  const weaponParts: string[] = [];
  for (const w of snapshot.weapons) {
    const wCode = WEAPON_ID_TO_CODE[w.id];
    if (!wCode) continue; // skip unknown weapons
    const level = Math.max(1, Math.min(9, Math.floor(w.level)));
    weaponParts.push(`${wCode}${level}`);
  }

  const augParts: string[] = [];
  for (const augId of snapshot.augments) {
    const aCode = AUGMENT_ID_TO_CODE[augId];
    if (!aCode) continue;
    augParts.push(aCode);
  }

  const weaponsStr = weaponParts.join('.');
  const augStr = augParts.join('.');

  // Always include the dash after character even when no weapons (parser expects it).
  let out = `${charCode}-${weaponsStr}`;
  if (augStr.length > 0) {
    out += `_${augStr}`;
  }
  return out;
}

// --- decode ----------------------------------------------------------------

/**
 * Decode a build code string back to a snapshot. Returns null on parse error.
 * Unknown weapon / augment codes are silently dropped (forward-compat: a future
 * build code from a newer client should still load a partial build rather than
 * fail entirely).
 */
export function decodeBuild(code: string): BuildSnapshot | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;

  // Split into char vs. rest.
  const dashIdx = trimmed.indexOf('-');
  if (dashIdx === -1) return null;
  const charCode = trimmed.slice(0, dashIdx);
  const rest = trimmed.slice(dashIdx + 1);

  const characterId = CHAR_CODE_TO_ID[charCode];
  if (!characterId) return null;
  if (!CHARACTERS[characterId]) return null;

  // Split rest into weapons vs. augments by underscore.
  const underscoreIdx = rest.indexOf('_');
  const weaponsStr = underscoreIdx === -1 ? rest : rest.slice(0, underscoreIdx);
  const augStr = underscoreIdx === -1 ? '' : rest.slice(underscoreIdx + 1);

  const weapons: Array<{ id: string; level: number }> = [];
  if (weaponsStr.length > 0) {
    for (const part of weaponsStr.split('.')) {
      if (part.length === 0) continue;
      // Trailing digit(s) are the level.
      const match = /^([a-z]+)(\d+)$/i.exec(part);
      if (!match) continue;
      const wCode = match[1]!;
      const levelStr = match[2]!;
      const level = parseInt(levelStr, 10);
      if (!Number.isFinite(level) || level < 1) continue;
      const wId = WEAPON_CODE_TO_ID[wCode];
      if (!wId) continue;
      if (!WEAPONS[wId]) continue;
      // Cap at the weapon's actual max level so we don't construct an
      // over-leveled slot that the UI/sim won't honor.
      const def = WEAPONS[wId]!;
      const maxLevel = def.levels.length > 0 ? def.levels.length : 1;
      weapons.push({ id: wId, level: Math.min(level, maxLevel) });
    }
  }

  const augments: string[] = [];
  if (augStr.length > 0) {
    for (const part of augStr.split('.')) {
      if (part.length === 0) continue;
      const augId = AUGMENT_CODE_TO_ID[part];
      if (!augId) continue;
      if (!UPGRADES[augId]) continue;
      augments.push(augId);
    }
  }

  return { characterId, weapons, augments };
}

// --- snapshot from store ---------------------------------------------------

/** Build a snapshot of the current run state. Safe to call in any phase. */
export function snapshotFromRunStore(): BuildSnapshot {
  const s = useRunStore.getState();
  return {
    characterId: s.selectedCharacterId,
    weapons: s.player.weapons.map((w) => ({ id: w.id, level: w.level })),
    augments: [...s.player.pickedAugmentIds],
  };
}

// --- URL parsing -----------------------------------------------------------

/** Read `?b=...` from the current URL. Returns null if missing or invalid. */
export function readBuildFromUrl(): BuildSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('b');
    if (!raw) return null;
    return decodeBuild(raw);
  } catch {
    return null;
  }
}

/** Build the full shareable URL for the current build snapshot. */
export function buildShareUrl(snapshot: BuildSnapshot): string {
  const code = encodeBuild(snapshot);
  if (typeof window === 'undefined') return `?b=${code}`;
  return `${window.location.origin}${window.location.pathname}?b=${code}`;
}
