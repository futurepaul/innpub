# Hang Migration Plan

## Context & Goals
- Current audio pipeline (`src/multiplayer/audio/*`, manual packet encoding/decoding, custom worklets) is fragile, hard to maintain, and duplicates features that `@kixelated/hang` already implements.
- Objective is to replace all bespoke audio capture, encoding, transport, and playback with Hang’s reactive publish/watch API while keeping our existing player state, chat, and room mechanics intact.
- Secondary objective is to revisit our MoQ data channels against Hang’s examples (catalog, location, chat) and adopt any best practices that improve interoperability or reduce custom code.

## Target Architecture Overview
- **Connection lifecycle**: continue to establish a single MoQ connection (potentially via a thin wrapper that exposes both `@kixelated/moq` and Hang helpers) so game state, chat, and Hang audio share the same transport.
- **Local audio publishing**:
  - Instantiate a `Hang.Publish.Broadcast` only while the player has an active mic **and** is inside a room; disable it otherwise.
  - Drive the broadcast path from room membership, e.g. `Moq.Path.from("innpub", "rooms", roomSlug, publishId)` so discovery can be filtered by room prefix.
  - Configure `publish.audio.enabled = true` and feed it the `MediaStreamTrack` returned from `getUserMedia`; Hang’s encoder handles opus encoding, speaking-level extraction, catalog updates, and frame grouping.
  - Reuse Hang’s speaking detector (`audio.speaking`) to publish speaking levels instead of our manual JSON track.
- **Remote audio playback**:
  - For each room the local player is listening to, use `Hang.Room` (or a tailored watcher built on top of `connection.announced`) to track active broadcasts under the same `innpub/rooms/<room>/` prefix.
  - Instantiate `Hang.Watch.Broadcast` per remote publisher, enable audio, and attach `Hang.Watch.Audio.Emitter` to route decoded audio into a shared `AudioContext` with per-stream gain control.
  - Only enable `watch.audio.enabled` when the listener is in the matching room, so we avoid downloading audio for other rooms entirely.
  - Use Hang’s catalog metadata to surface speaking levels (`watch.audio.speaking`) and other stream info for our UI and mute indicators.
- **Game state + chat**: keep existing `state.json`, `rooms.json`, `chat.json` tracks for now, but audit them against Hang’s `publish/location` and `publish/chat` implementations to decide whether future refactors can piggyback on the shared catalog structure.

## Implementation Steps
1. **Dependencies & build plumbing** ✅
   - Added `@kixelated/hang`/`@kixelated/signals`, trimmed Bun scripts, and kept COOP/COEP headers in place.
2. **Connection abstraction** ✅
   - Reused the existing MoQ connection, exposing it to Hang via signals and tightening reconnect cleanup.
3. **Local audio module rewrite** ✅
   - Replaced bespoke capture/packets with a Hang publish pipeline that derives room-prefixed paths and toggles publishing from mic + room state.
4. **Remote audio consumption** ✅
   - Subscribed to per-room broadcasts via `Hang.Room`, piping each stream through `Hang.Watch.Audio.Emitter` and removing the old playback engine.
5. **Room-aware audio filtering** ✅
   - Only enable audio for broadcasts whose path matches the listener’s active rooms; tear down watchers when rooms change.
6. **UI and state integration** ✅
   - Simplified the HUD to Hang-driven mic/speaker controls and removed the AudioLab/testing UI.
7. **Data channel audit** ☐
   - Still to evaluate adopting Hang chat/location helpers; current tracks remain in place.
8. **Cleanup & verification** ⚠️
   - Core code and assets cleaned; doc updates and broader regression passes still pending.

## Best-Practice Notes from Hang
- Use Hang’s catalog (`catalog.json`) as the single source of truth for stream capabilities; remote watchers rely on it to discover audio tracks and metadata like speaking/captions.
- Prefer reactive signals (`@kixelated/signals`) for state changes; avoid manual event emitters so Hang can clean up resources automatically when signals disable.
- Keep audio latency settings at defaults initially (100 ms jitter buffer) and expose hooks only if needed.
- Hang’s audio encoder requires `AudioContext` sample rate alignment; ensure we do not reintroduce manual resampling.
- Speaking detection and captions are optional but already wired; we can decide whether to surface them in our UI, but no need to maintain parallel logic.

## Cleanup Checklist
- [x] Remove `scripts/prepare-worklets.ts` and associated npm scripts.
- [x] Delete `src/multiplayer/audio` directory and `src/audio/AudioLab*`.
- [x] Purge generated worklet files under `public/worklets`.
- [x] Drop unused dependencies (`@ain1084/audio-worklet-stream`, `@ain1084/audio-frame-buffer`, etc.).
- [ ] Update documentation (`README.md`, `MERGE_BACK_TO_GAME.md`, `MOQ_MULTIPLAYER_PLAN.md`) to describe Hang-based audio.

## Open Questions
1. Should each room spawn its own Hang broadcast (temporary path per room entry) or should we instead keep a single player broadcast and encode the room inside metadata (requires forking Hang’s audio track naming)?
PAUL: let's do it the hang way. each room has its own path entry
2. Do we want to adopt Hang’s chat/location helpers now or keep our bespoke tracks for a while? If we plan to switch, what compatibility guarantees do we need for existing clients?
PAUL: let's do whatever requires the least code in the long run, which is probably use hang's chat stuff
3. How should we handle synthetic tone/debug audio going forward—retain a lightweight test mode via WebAudio, or drop it entirely with the new pipeline?
PAUL: let's kill all our current audio code for now including the debug and synthetic tone stuff. also delete the AudioLab
4. Are there constraints around broadcast path length or character set for room names we should enforce before generating Hang paths?
PAUL: our app defines the two room names, and we should broadcast the npub as the "speaker" somehow. 
5. Any need to persist per-room volume preferences or should all remote audio inherit the global speaker toggle for now?
PAUL: inherit the global speaker toggle for now
