// Branching Hollows — at 5:00 the player picks one of three portals. The rest
// of the run is themed by that Hollow: a unique mechanic, a recolored palette,
// and a custom final boss replacing `boss-prime`.
//
// Pure data, no Phaser/React/ECS imports. The mechanic itself lives in
// `src/ecs/systems/hollowMechanics.ts`; this file just declares the metadata
// the choice UI and spawnDirector consume.

export type HollowId = 'bone' | 'ember' | 'tide';

export interface HollowDefinition {
  id: HollowId;
  /** Display name shown on the portal card and in HUD callouts. */
  name: string;
  /** One-line flavor / mechanic preview for the choice screen. */
  description: string;
  /**
   * Hex tint applied to the arena background rectangle when the Hollow is
   * selected. We tint the background (not the camera) so it can be reverted
   * cheaply if the Hollow flow ever changes mid-run.
   */
  paletteTint: number;
  /** ENEMIES key spawned in place of `boss-prime` at BOSS_SPAWN_MS. */
  bossEnemyId: string;
  /** Short mechanic blurb (1-2 sentences) shown beneath the name. */
  mechanicSummary: string;
}

export const HOLLOWS: Record<HollowId, HollowDefinition> = {
  bone: {
    id: 'bone',
    name: 'Bone Hollow',
    description: 'The dead do not lie still. Walk the marrow road.',
    paletteTint: 0xeeeeee,
    bossEnemyId: 'marrowking',
    mechanicSummary: 'Killed enemies have a 10% chance to rise as a brittle skeleton that fights for you... briefly.',
  },
  ember: {
    id: 'ember',
    name: 'Ember Hollow',
    description: 'Every kill leaves a coal. Stand in the fire.',
    paletteTint: 0xff6a3c,
    bossEnemyId: 'effigy',
    mechanicSummary: 'Enemies leave burning ground on death. Stand on fire to deal +50% damage.',
  },
  tide: {
    id: 'tide',
    name: 'Tide Hollow',
    description: 'The deep breathes. It does not forget you.',
    paletteTint: 0x2a5a9a,
    bossEnemyId: 'hollow-deep',
    mechanicSummary: 'Every 30 seconds a great wave drags every enemy toward the center of the arena.',
  },
};

/** Convenience: ordered list for the choice screen (Bone, Ember, Tide). */
export const HOLLOW_ORDER: readonly HollowId[] = ['bone', 'ember', 'tide'];

/** Default Hollow auto-picked if the player times out on the choice screen. */
export const DEFAULT_HOLLOW_ID: HollowId = 'bone';

/** elapsedMs at which the Hollow choice modal is offered. 5:00. */
export const HOLLOW_CHOICE_OFFER_MS = 5 * 60 * 1000;

/** Milliseconds the player has to choose before Bone is auto-picked. */
export const HOLLOW_CHOICE_TIMEOUT_MS = 30 * 1000;
