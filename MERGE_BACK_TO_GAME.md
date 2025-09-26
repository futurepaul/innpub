# Merge Audio Lab Improvements into Main Game

This document enumerates what to delete, what to port over, and what to tweak so
that the production game reuses the stable Audio Lab audio pipeline. Presence
and position streams stay untouched; the focus is the audio capture/publish,
stream subscription, retry logic, and playback path.

## 1. Components to Retire or Replace

- **Legacy capture worklet & wrapper** (`src/multiplayer/audio/worklets/capture-worklet.js`,
  `src/multiplayer/audio/capture.ts`): replace with the new accumulator-based
  capture logic from Audio Lab so the game always emits 960-sample / 20 ms frames
  at 48 kHz.
- **Old playback engine** (`src/multiplayer/audio/playback.ts` as currently used
  by the game): swap to the worker-backed ring buffer (`src/audio/labPlayback.ts`)
  so both environments share scheduling, underrun tracking, and volume control.
- **Ad-hoc stream handling** in `src/multiplayer/stream.ts` for audio tracks:
  drop the pre-existing subscribe/write logic in favour of the Audio Lab
  pipeline that handles tail subscriptions, exponential backoff with jitter, and
  guardrails around SharedArrayBuffer.
- **Tone/test scaffolding** embedded in the game (if any remnants remain): remove
  bespoke tone handling once the Audio Lab tooling is shared via optional dev
  UI.
- **Old build plumbing**: ensure the deprecated `scripts/build.ts` / Bun server
  audio routes stay deleted; the Vite + `prepare-worklets` flow is now the single
  source of truth.

## 2. Modules to Promote from Audio Lab

Promote these files into shared locations (or import them directly if they’re
already in `src/audio/`):

- `src/audio/labCapture.ts` → make this the canonical `AudioCapture` for both
  the game and lab (perhaps rename to `capture.ts` and relocate to
  `src/multiplayer/audio/`), keeping the 960-sample accumulator and RMS stats.
- `src/audio/labPlayback.ts` → merge into the game’s playback manager, keeping
  the worker-based `OutputStreamNode` path, SharedArrayBuffer requirement, and
  clamp/dropped-frame warnings.
- `src/audio/AudioLab.tsx`’s MoQ subscribe utilities (tail offsets, jittered
  retries, reset counters) → port those helpers into
  `src/multiplayer/stream.ts` and extract any reusable pieces to avoid
  duplication.
- `scripts/prepare-worklets.ts` → already in root; ensure any game-specific
  build scripts invoke it instead of legacy copy logic.
- `public/worklets/audio-worklet-stream-output.js` & `capture-worklet.js` → keep
  them as the single source for both environments.

## 3. Game-Specific Tweaks Required

- **Identity handling**: wire the merged playback manager to use the player’s
  npub for lookup keys (mirroring the current game behaviour) instead of the
  random Audio Lab path IDs.
- **Room-based muting**: adapt the Audio Lab `updateLocalRooms`/`rooms.json`
  plumbing to honour the game’s dynamic room names (room_1, room_2, etc.) so the
  worker playback sets per-remote gain to zero when they’re outside the local
  room.
- **Speaking indicators**: ensure the shared pipeline still publishes speaking
  state / volume levels expected by the existing UI (if the game currently
  toggles a “speaking” track).
- **Telemetry hooks**: keep the debug telemetry (`__innpubAudioPlaybackDebug`) in
  the shared playback manager so both the game and Audio Lab can inspect buffer
  depth, frames decoded, underruns, and volumes.
- **Header enforcement**: document (and, if needed, guard) the requirement for
  COOP/COEP `credentialless` headers in the production router / hosting config so
  SAB remains available outside the lab.

## 4. Shared Utilities & Free Wins

- `src/multiplayer/audio/packets.ts` is already shared—no changes needed beyond
  ensuring the captured frames stay 960 samples.
- `scripts/prepare-worklets.ts` now outputs both worklets; no additional
  duplication required.
- Debug logging and exponential retry logic from the Audio Lab should be moved
  into helper functions so both the lab and game call the same code (e.g.
  `subscribeToAudioTrack`, `handleSubscribeError`).

## 5. Migration Checklist

1. Replace the game’s capture implementation with the accumulator-based logic.
2. Swap the playback manager to the worker-backed `AudioLabPlayback` (renamed
   appropriately) and remove the legacy class.
3. Consolidate the MoQ subscription/backoff logic by exporting helpers from the
   lab pipeline and using them in `src/multiplayer/stream.ts`.
4. Ensure room-based volume gating and speaking-state publishing survive the
   refactor by adapting the shared code to watch npub + room metadata.
5. Verify COOP/COEP headers are set in production hosting (Vercel config already
   handles this; confirm any other deployment targets do as well).
6. Run end-to-end tests: 
   - Two-player audio call (rooms + avatar images)
   - Tone toggle in dev (still via Audio Lab UI) to check buffer timing
   - MoQ reconnect / retry scenarios to confirm exponential backoff.
7. Remove any dead code, unused imports, or build steps after the merge.

Following this plan leaves a single audio pipeline powering both the Audio Lab
and the production game, eliminating drift and ensuring future audio fixes apply
everywhere.
