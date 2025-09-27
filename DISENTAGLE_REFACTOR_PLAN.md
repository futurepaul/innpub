# InnPub Solid/Pixi Disentangle Plan

## Goals & Principles
- Decouple Pixi rendering and Solid UI so neither owns cross-cutting state or side effects; both should be thin presenters.
- Centralise all shared data and side effects (Moq, Hang audio, player sync, chat) in a single reactive "game" layer backed by RxJS.
- Maintain the existing features (multiplayer sync, chat, audio controls, room membership) while making it easier to add new slices without cross-component leaks.
- Preserve ongoing nostr/account work by keeping the public surface area for profile lookups intact and isolating nostr concerns behind the game layer.

## Current Coupling Snapshot (for reference)
- `src/App.tsx` initialises Pixi via `initGame`, manages Solid signals, and directly calls `startStream`, `subscribe`, `sendChatMessage`, etc. from `src/multiplayer/stream.ts`.
- `src/game/initGame.ts` receives ad-hoc hooks (`onPlayerPosition`, `onHeadPosition`, `onPlayerRooms`, etc.), pushes data back into Solid signals, and directly calls multiplayer helpers to broadcast local player updates.
- `src/multiplayer/stream.ts` mixes concerns: Moq connection lifecycle, Hang audio control, room tracking, chat, profile subscriptions, Solid-facing subscription helpers, and Pixi callbacks.
- Changes in any of these layers propagate widely (e.g. tweaking chat retention requires updating Solid signals and Pixi hooks).

## Target Architecture Overview
```
+---------------------+        +---------------------+
|  Solid UI renderer  |        |  Pixi game renderer |
| (App + components)  |        |  (initPixiGame)     |
|  subscribes/sends   |        |  subscribes/sends   |
+----------+----------+        +----------+----------+
           |                               |
           v                               v
                  +---------------------+
                  |  Game Service       |
                  |  (RxJS store +     |
                  |   command bus)     |
                  +----------+---------+
                             |
                             v
                  +---------------------+
                  |  Moq/Hang adapters  |
                  |  (network + I/O)    |
                  +---------------------+
```

- **Game Service**: owns authoritative client-side state, exposes read-only Observables for renderers, provides imperative command API for mutations, and orchestrates persistence.
- **Adapters**: translate external systems (Moq connection, Hang audio, nostr profiles, user input) into game events, update the store, and react to outgoing commands.
- **Renderers**: join observables they care about, render view state, and emit UI/gameplay intents via the command API. No direct Moq or Pixi-to-Solid hooks.

## Game Service Design
- Create `src/game/state/gameState.ts` implementing a `GameStore` class that encapsulates:
  - Internal `BehaviorSubject` (or `ReplaySubject` where appropriate) slices: `connection`, `localPlayer`, `players`, `rooms`, `audio`, `chat`, `profiles`, `settings`, `errors`.
  - Read-only exports: functions returning `Observable<T>` (`players$`, `rooms$`, etc.) plus synchronous selectors (`getValue()` for quick reads).
  - Command methods (backed by an internal RxJS `Subject` to keep logging/analytics centralised) such as `login`, `logout`, `setAvatar`, `moveLocalPlayer`, `setRooms`, `sendChat`, `toggleMic`, `toggleSpeaker`, `requestSpawn`, etc.
  - Composed derived streams (e.g. `activeRoom$`, `localPresence$`) using `combineLatest` so both renderers share the same derivations.
  - Clean teardown (`dispose`) that completes all subjects and notifies adapters.

- Provide type definitions in `src/game/state/types.ts` covering `GameStateSnapshot`, `PlayerView`, `AudioState`, `ChatEntry`, `Command` enums, etc., annotated with documentation for future contributors.

## Adapter Responsibilities
- **MoqConnection (`src/multiplayer/moqConnection.ts`)**
  - Keep responsibility for establishing the shared `Moq.Connection`.
  - Surface connection status into `GameStore` via a dedicated adapter (`src/game/adapters/moqConnection.ts`) that subscribes to `onConnection`/`onDisconnect` and pushes `connection$` updates.

- **Player Sync & Rooms (`stream.ts` today)**
  - Extract into `src/game/adapters/playerSync.ts`.
  - Subscribe to Moq state/rooms tracks, parse remote data into `GameStore` updates, and publish local state when `GameStore` emits commands like `setLocalTransform` or `setRooms`.
  - Keep reconciliation logic (stale player trimming, heartbeat timers) here, but expose configuration via the adapter module instead of magic values inside the store.

- **Chat (`stream.ts`)**
  - Move chat-specific logic into `src/game/adapters/chat.ts`, including TTL eviction, `sendChatMessage`, and `resetChatSession`.
  - The adapter listens to `GameStore` chat-related commands and pushes updates to the shared chat observable.

- **Audio Controls (Hang)**
  - Factor out of `stream.ts` into `src/game/adapters/audio.ts`, managing the Hang publish/watch objects based on `GameStore` command stream (`toggleMic`, `toggleSpeaker`, `setActiveRooms`).
  - Update `GameStore` with speaking levels and audio errors.

- **Profiles / Nostr**
  - Keep existing `subscribeProfiles` surface but route through `GameStore`. For components that still need profile lookups, expose them via `gameStore.profiles$` and helper selectors (`getProfile(npub)`).
  - Avoid touching new `nostr/accounts.ts`; adapters can depend on the nostr client as-is.

## Renderer Integration
- **Pixi Renderer (`src/game/initGame.ts`)**
  - Rename to `src/pixi/createRenderer.ts` to reflect its new role.
  - Replace hook props with a `GameView` interface that supplies observables (`localPlayer$`, `remotePlayers$`, `map$`, `headRects$`) and accepts callbacks for renderer-originated actions (`onInputCaptured`, `onSpawnRequested`, `onFacingChanged`).
  - Keep Pixi-specific state (textures, Sprite instances, tilemap caches) internal; use `GameStore` data only for logical updates.
  - Provide a small wrapper in `App.tsx` that mounts Pixi and wires callbacks to `gameStore` commands.

- **Solid UI (`src/App.tsx`, `src/components`)**
  - Instantiate a single `GameStore` (probably via `createRoot` or context provider) and pass to subcomponents.
  - Replace direct imports from `stream.ts` with selectors/commands from `GameStore`:
    - `Console` consumes `chat$`, `log$` (derived), and dispatches `sendChat`/`requestSpawn`.
    - `Header` watches `connection$`, `audio$`, `localPlayer$`.
    - `Login` calls `login`, `logout` commands and observes `auth$`.
  - Provide utility functions (`fromObservable` helpers under `src/ui/rx.ts`) to bridge RxJS with Solid signals while handling unmount cleanup.

## Refactor Phases
1. **Scaffold GameStore (no behaviour change)**
   - Add new files: `src/game/state/types.ts`, `src/game/state/gameStore.ts`, `src/game/state/index.ts`.
   - Mirror current `stream.ts` exports by proxying to the legacy module so the app keeps running.

2. **Introduce Command Bus & Observables**
   - Wrap the existing callbacks exported from `stream.ts` so they forward to `GameStore`; create `commands` subject, but still let `stream.ts` perform the work.
   - Start migrating consumers (Solid UI, Pixi) to use the new observables instead of ad-hoc hooks; keep `stream.ts` as the internal implementation.

3. **Split `stream.ts` into adapters**
   - Move player sync, chat, audio, and profile logic into adapter modules that depend on `GameStore`.
   - Reduce `stream.ts` to a thin shim that initialises adapters (and eventually delete it).

4. **Refactor Pixi Renderer**
   - Change `initGame` signature to consume `GameStore` observables directly.
   - Remove Solid-specific hook callbacks; replace them with `GameStore` commands to update head positions, room occupancy, and spawn requests.

5. **Refactor Solid UI**
   - Create a `GameStoreProvider` (`src/ui/GameStoreProvider.tsx`) to expose the store via context.
   - Update components to consume observables via hooks (e.g. `useObservable(gameStore.chat$)`), drop direct imports from adapter modules.

6. **Remove Legacy Surface & Clean Up**
   - Delete `src/multiplayer/stream.ts` once all exports are covered by the new adapters.
   - Update documentation (`README.md`, `MERGE_BACK_TO_GAME.md`) to describe the new architecture and how to add adapters/commands.

## File Map & Responsibilities (after refactor)
- `src/game/state/types.ts` – shared type definitions for game state slices & commands.
- `src/game/state/gameStore.ts` – RxJS store implementation, command dispatcher, state selectors.
- `src/game/state/index.ts` – public factory (`createGameStore`) with DI hooks for adapters.
- `src/game/adapters/moqConnection.ts` – reacts to connection lifecycle, updates connection status.
- `src/game/adapters/playerSync.ts` – syncs player positions/rooms with Moq tracks.
- `src/game/adapters/chat.ts` – handles chat stream ingestion/emission & TTL policies.
- `src/game/adapters/audio.ts` – wraps Hang publish/watch, surfaces audio state & speaking levels.
- `src/pixi/createRenderer.ts` – Pixi initialisation and rendering based on observables; exports `createPixiRenderer` returning `{ mount, destroy }`.
- `src/ui/GameStoreProvider.tsx` – Solid context provider + hooks for observables.
- `src/App.tsx` – orchestrates store creation, mounts Pixi renderer, composes UI components without direct multiplayer imports.

## Incremental Testing & Verification
- After each phase, run existing smoke flow: login, move avatar, verify chat, mic toggle, room switching.
- Add unit tests for the store (e.g. `src/game/state/gameStore.test.ts`) covering command -> state transitions; use RxJS marbles for temporal behaviour where needed.
- For adapters, add integration-style tests with mocked Moq/Hang objects to ensure re-subscription/resilience logic works outside of the UI.

## Risks & Mitigations
- **Regression in multiplayer sync**: mitigate by keeping legacy `stream.ts` behaviour until adapters are fully migrated and by instrumenting the new command bus with logging (behind a debug flag) during transition.
- **Resource leaks**: enforce a consistent subscription lifecycle by exposing a `GameStore.dispose()` and ensuring renderers call it on unmount; adapters should also register disposables.
- **Concurrent nostr work**: avoid touching `src/nostr/*` beyond replacing direct imports with `GameStore` lookups; coordinate if new APIs are required.

## Next Steps
1. Create `GameStore` scaffolding and wire minimal observables to existing stream helpers.
2. Introduce Solid context/provider and migrate `App.tsx` to consume the store for read/write.
3. Start adapter extraction from `stream.ts`, beginning with player/rooms handling to unblock Pixi decoupling.
