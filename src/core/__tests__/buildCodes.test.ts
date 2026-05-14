// Round-trip tests for src/core/buildCodes.ts.
//
// Build codes are user-shared URLs (`?b=BR-bld5.frn3.lit2_crit.spl.tho`).
// A regression here means a player's shared link silently drops weapons or
// augments, so we pin the round-trip behaviour and reject obvious garbage.

import { describe, it, expect } from 'vitest';
import { encodeBuild, decodeBuild } from '../buildCodes';
import type { BuildSnapshot } from '../buildCodes';

describe('buildCodes', () => {
  it('roundtrips a basic Ranger build', () => {
    const snapshot: BuildSnapshot = {
      characterId: 'ranger',
      weapons: [{ id: 'auto-pistol', level: 1 }],
      augments: [],
    };
    const code = encodeBuild(snapshot);
    const decoded = decodeBuild(code);
    expect(decoded).toEqual(snapshot);
  });

  it('roundtrips a Brawler build with multiple weapons + augments', () => {
    const snapshot: BuildSnapshot = {
      characterId: 'brawler',
      weapons: [
        { id: 'blade', level: 5 },
        { id: 'frost-nova', level: 3 },
      ],
      augments: ['aug-crit', 'aug-splash', 'aug-thorns'],
    };
    const code = encodeBuild(snapshot);
    expect(decodeBuild(code)).toEqual(snapshot);
  });

  it('returns null for empty / malformed codes', () => {
    expect(decodeBuild('')).toBeNull();
    expect(decodeBuild('garbage')).toBeNull(); // no dash
    expect(decodeBuild('XX-')).toBeNull(); // unknown char code
  });

  it('drops unknown weapon ids silently (forward-compat)', () => {
    // 'unknown-weapon' is not in WEAPON_ID_TO_CODE; encode skips it.
    const snapshot: BuildSnapshot = {
      characterId: 'ranger',
      weapons: [
        { id: 'auto-pistol', level: 2 },
        { id: 'unknown-weapon', level: 1 },
      ],
      augments: [],
    };
    const code = encodeBuild(snapshot);
    const decoded = decodeBuild(code);
    expect(decoded).not.toBeNull();
    expect(decoded?.weapons).toEqual([{ id: 'auto-pistol', level: 2 }]);
  });

  it('encodes character with no weapons (still produces a valid code)', () => {
    const snapshot: BuildSnapshot = {
      characterId: 'ranger',
      weapons: [],
      augments: [],
    };
    const code = encodeBuild(snapshot);
    // Should at least contain RG- and decode without error.
    const decoded = decodeBuild(code);
    expect(decoded).not.toBeNull();
    expect(decoded?.characterId).toBe('ranger');
    expect(decoded?.weapons).toEqual([]);
    expect(decoded?.augments).toEqual([]);
  });
});
