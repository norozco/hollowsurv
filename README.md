# Hollowsurv

Bullet-heaven / survivors-like vertical slice. Phaser 4 + bitECS + Zustand + React 19 + Vite + TypeScript (strict).

This is the foundation scaffold: the boot path is wired (Vite -> React mount -> Phaser game -> BootScene -> ArenaScene with WASD-movable player square), all file-ownership stubs from `CONTRACTS.md` are in place, and parallel implementation agents can start filling in their partitions without import errors.

## Run

```
npm install
npm run dev        # vite dev server (HMR)
npm run typecheck  # tsc --noEmit, strict
npm run build      # typecheck + bundle to dist/
npm run preview    # serve dist/
```

## Notes for parallel agents

- See `ARCHITECTURE.md` for high-level design and `CONTRACTS.md` for hard partitions.
- All system files in `src/ecs/systems/` are stubs with the correct signatures; implement them per `CONTRACTS.md` §5.
- `ArenaScene` ships with a temporary direct WASD movement hack on the player sprite to prove the input/render path. **Remove that hack** when Agent C1 wires up `inputSystem` + `movementSystem` for real.
- Phaser 4 stable (4.1.0) is on npm; `SpriteGPULayer` is the rendering target. The render system stub in `src/ecs/systems/render.ts` falls back to ordinary `Phaser.GameObjects.Sprite` for the boot scaffold; Agent C1/C3 should swap in `SpriteGPULayer` once they confirm the API surface in this version.
