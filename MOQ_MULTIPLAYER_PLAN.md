# MOQ Multiplayer Integration Plan

## Overview
We will migrate the current mock multiplayer layer to the real `@kixelated/moq` transport used in `../moq-demos/demos/map-coordinates`. The implementation will be split into two stages: Stage 1 focuses on positional sync, Stage 2 adds audio streaming. Throughout both stages we will adapt the demo code to our existing Pixi + React architecture, our player state types (`PlayerState`, `FacingDirection`, rooms, etc.), and the Applesauce-powered profile system. No backwards compatibility is required; the mock stream will be removed during this work.

## Stage 0 – Preparation
- [ ] Audit current multiplayer plumbing (`src/multiplayer/stream.ts`, consumers in `src/App.tsx` & Pixi) and document the API surface we must preserve (subscriptions, local updates, profile tracking, cleanup hooks).
- [ ] Digest `../moq-demos/demos/map-coordinates/src` with emphasis on `main.ts`, `players.ts`, `render.ts`, `audio/*`, and how they encode/decode packets.
- [ ] Identify reusable utilities (eg. MoQ connection helpers, position snapshot cadence, pruning logic) and list which ones should be ported vs. rewritten for our architecture.
- [ ] Confirm dependency set (`@kixelated/moq`, audio helpers) and add/update packages as needed.

## Stage 1 – Movement over MoQ
1. **Connection + Session Wiring**
   - [ ] Build a new `src/multiplayer/moqConnection.ts` (or similar) that encapsulates establishing a connection to `https://moq.justinmoon.com/anon`, handles reconnection, and exposes subscribe/send hooks under the `innpub` namespace.
   - [ ] Centralize relay configuration (constant or env shim) for future overrides, but default to the hardcoded relay per spec.

2. **Player State Codec & Tracks**
   - [ ] Define our movement payload type (likely `{ npub, x, y, facing, room }`). Align update cadence with the Pixi 60 fps tick (≈16.7 ms) to leverage the relay’s binary transport capacity.
   - [ ] Implement encode/decode for the payload (JSON initially, with room to optimize later) and ensure broadcast packets are versioned if needed.
   - [ ] Implement send scheduling keyed to the Pixi tick; still detect and suppress redundant packets when the state is unchanged, but otherwise publish at tick rate.

3. **Subscription & Player Registry**
   - [ ] Replace the mock `startStream/stopStream/subscribe` implementation with MoQ-driven feeds while keeping the current public API for React/Pixi consumers.
   - [ ] Manage remote player map keyed by track path; expose aggregated state by `npub`. Handle players joining before their npub arrives and update once known.
   - [ ] Implement stale-player pruning using timestamps from track updates.
   - [ ] Preserve Applesauce profile tracking; trigger profile fetch when a new `npub` is seen.

4. **Local Player Broadcast**
   - [ ] Hook our existing `updateLocalPlayer` flow so Pixi position updates feed the MoQ broadcast queue while avoiding self-echo.
   - [ ] Ensure we announce/bind tracks once per session and tear them down cleanly on logout/disconnect.

5. **Integration Testing**
   - [ ] Run the app against the relay, verify local + remote movement sync, and confirm state recovery after transient disconnects.

## Stage 2 – Audio Broadcasting & Playback
1. **Modern Audio Pipeline Research & Port**
   - [ ] Review the demo’s audio stack and investigate modern replacements for `ScriptProcessorNode` (eg. `AudioWorkletNode`, `MediaStreamTrackProcessor`). Capture findings and choose an approach compatible with browsers we target.
   - [ ] Port or rewrite audio capture/playback utilities under `src/multiplayer/audio/*`, favoring the modern pipeline.

2. **MoQ Audio Tracks**
   - [ ] Establish audio (`audio.pcm` equivalent) and speaking-level (`speaking.json`) tracks under the `innpub` namespace.
   - [ ] Encode PCM packets and speaking-level updates using the new audio pipeline; throttle speaking updates (~150 ms).
   - [ ] Subscribe to remote audio streams, decode, and feed the playback mixer while updating `PlayerState.speakingLevel`.

3. **Player State Extensions & React/Pixi Integration**
   - [ ] Extend `PlayerState` with speaking level and audio handles; ensure Pixi overlays or React HUD can react to speaking state (eg. halo or icon).
   - [ ] Clean up audio nodes/subscriptions on player disconnect or when the local user mutes.

4. **UX & Controls**
   - [ ] Add mic and speaker toggles to the existing profile display in the top-right; reflect status changes and handle permission errors gracefully.
   - [ ] Decide default states (likely muted until toggled) and persist per-session preference if feasible.

5. **Testing & Validation**
   - [ ] Verify audio publish/subscribe between two tabs, including mute/unmute flows and failure handling when mic access is denied.
   - [ ] Ensure no audio continues after a player disconnects (prune playback nodes).

## Clarifying Details
- Relay URL: `https://moq.justinmoon.com/anon` (hardcoded default for now).
- Namespace: `innpub`.
- Authentication: none required.
- Audio UI: mic + speaker toggles integrated into the profile HUD; no extra tone/monitor controls.
- Offline fallback: none required; mock stream will be removed.
- Audio implementation should avoid deprecated `ScriptProcessorNode`; research and adopt modern alternatives.
- Movement updates should align with Pixi’s 60 fps tick cadence.

