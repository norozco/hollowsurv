// Typed pub/sub. Single instance, synchronous dispatch, allocation-free in steady state.
// Owned by all agents at the type level (additive event additions only).
// Implementation owner: scaffold (do not rewrite without coordination).
//
// TODO(perf): ARCHITECTURE.md §4 calls for per-event-type payload pooling so the
// bus reuses the same object across emissions of the same type within a tick.
// Handlers would still read fields immediately and never retain refs. Deferred
// to post-vertical-slice — basic on/emit is sufficient for now.

export type GameEvent =
  | { type: 'enemy_killed'; enemy: number; killer: number; position: { x: number; y: number } }
  | { type: 'damage_dealt'; target: number; source: number; amount: number; isCrit: boolean }
  | { type: 'player_hit'; amount: number; sourceEid: number }
  | { type: 'level_up'; newLevel: number }
  | { type: 'pickup_collected'; entity: number; kind: 'xp' | 'gold' | 'heal'; value: number }
  | { type: 'weapon_fired'; weaponId: string; source: number; targetEid: number }
  | { type: 'projectile_spawned'; projectile: number; weaponId: string }
  | { type: 'wave_started'; waveIndex: number; timeMs: number }
  | { type: 'boss_spawned'; boss: number }
  | { type: 'run_won'; timeMs: number; level: number; kills: number }
  | { type: 'run_lost'; timeMs: number; level: number; kills: number }
  | { type: 'upgrade_chosen'; choiceId: string }
  | { type: 'character_selected'; characterId: string }
  | { type: 'pause_requested' }
  | { type: 'resume_requested' };

export type GameEventType = GameEvent['type'];

export type GameEventOf<K extends GameEventType> = Extract<GameEvent, { type: K }>;

type AnyHandler = (event: GameEvent) => void;

export interface EventBus {
  emit<T extends GameEvent>(event: T): void;
  on<K extends GameEventType>(
    type: K,
    handler: (event: GameEventOf<K>) => void
  ): () => void;
  off(type: GameEventType, handler: (e: GameEvent) => void): void;
  clear(): void;
}

function createEventBus(): EventBus {
  const handlers = new Map<GameEventType, Set<AnyHandler>>();

  function getBucket(type: GameEventType): Set<AnyHandler> {
    let bucket = handlers.get(type);
    if (!bucket) {
      bucket = new Set<AnyHandler>();
      handlers.set(type, bucket);
    }
    return bucket;
  }

  return {
    emit<T extends GameEvent>(event: T): void {
      const bucket = handlers.get(event.type);
      if (!bucket) return;
      // Synchronous dispatch. Handlers must read fields immediately and not retain refs.
      for (const h of bucket) h(event);
    },
    on<K extends GameEventType>(
      type: K,
      handler: (event: GameEventOf<K>) => void
    ): () => void {
      const bucket = getBucket(type);
      bucket.add(handler as AnyHandler);
      return () => {
        bucket.delete(handler as AnyHandler);
      };
    },
    off(type: GameEventType, handler: (e: GameEvent) => void): void {
      const bucket = handlers.get(type);
      if (bucket) bucket.delete(handler as AnyHandler);
    },
    clear(): void {
      handlers.clear();
    },
  };
}

// Single shared instance.
export const eventBus: EventBus = createEventBus();
