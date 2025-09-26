# Audio Lab Notes

## Architecture Overview
- **SPA Route**: `/audio-lab` renders the React `AudioLab` component (via `wouter`) alongside the main Pixi app.
- **MoQ Publishing**: Each tab publishes to `innpub/audio-lab/<uuid>#<tabId>` using a dedicated `Moq.Broadcast`; only the `audio.pcm` track is exposed.
- **Capture**: `AudioLabCapture` reads mic samples via `MediaStreamTrackProcessor` (AudioData frames) and generates 48 kHz sine bursts for the tone path on the main thread—no custom AudioWorklet anymore. The worklet scripts now live in `public/worklets/` so Vite serves them in dev/prod.
- **Tone Toggle**: Synthetic tone remains 20 ms/960-frame chunks with configurable amplitude/frequency; RMS updates flow through the same callback path as mic frames.
- **Playback**: `AudioLabPlayback` now uses `@ain1084/audio-worklet-stream`’s manual ring buffer strategy (`OutputStreamNode` + `FrameBufferWriter`), fronted by a shared gain node per remote. The required processor is copied to `/worklets/audio-worklet-stream-output.js` and loaded at runtime. We still subscribe with offset `-1`, clamp runaway buffers, and gate playback behind an explicit “Enable Playback” gesture.
- **Discovery**: The announcement loop watches `innpub/audio-lab` entries, delays first subscribe 150 ms, and retries with exponential backoff + jitter (capped at 10 tries). Reset counters and retry attempts are tracked per path.
- **Build/Serve**: We now rely on Vite (`bunx vite` / `bunx vite build`). `scripts/prepare-worklets.ts` copies the audio-worklet-stream processor into `public/worklets/` so the static build contains both required modules.
- **Debug UI**: Remote table shows buffered seconds, decoded frames, underruns, last packet age, reset counts. Debug card displays capture stats, playback state, tone configuration, and the latest log entries.

## What We’ve Tried
1. **Autoplay Unlock**: Added the explicit “Enable Playback” button so Chrome allows the `AudioContext`. This fixed initial silence and lets us control when playback resumes.
2. **Tail Subscriptions**: Switched `broadcast.subscribe` to `offset = -1` for both Audio Lab and main Pixi stream; also clamp `remote.nextTime` if buffered ahead grows beyond 4× lead. Buffers now stay ~0.65 s instead of minutes.
3. **Reset Backoff**: Added jittered exponential retry and logging; announcement loop waits 150 ms before first subscribe to avoid immediate RESET_STREAM storms. RESET counters surface in the debug panel and via `window.__innpubAudioDebug`.
4. **UI Diagnostics**: Surfaced capture frame size/duration, RMS, playback enabled state, and logs inside the panel with generous height to keep telemetry readable.
5. **Tone Test**: Tone generation shares the capture pipeline (960-sample frames, amplitude defaults to 0.05). Despite matching metrics, the tone still exhibits stuttering—the issue persists even with clean inputs.
6. **Library Spike**: Migrated playback to `@ain1084/audio-worklet-stream` (manual writer) and swapped capture to the WebCodecs processor to eliminate the bespoke capture worklet. Initial tests confirm the new path still reproduces the blippy artefacts, so the root cause is likely downstream of capture.

## Current Observations
- Capture frames consistently show ~960 samples / 20 ms in tone mode and track the mic’s source rate (usually 48 kHz) via `MediaStreamTrackProcessor`; RMS stays within expected bounds for both mic and tone.
- Playback buffers ~0.6–1.6 s even after clamping, with zero underruns reported—yet audio remains “blippy”.
- Remote reset counters stay at 0 post-fixes, so transport isn’t repeatedly resetting; glitchiness likely originates in PCM handling (encoding/decoding or scheduling).
- Both tone and mic exhibit identical artifacts, suggesting the issue is not source-specific but somewhere between `encodePacket` -> transport -> `decodePacket` -> playback scheduling.

## Next Steps (Ideas)
- Capture raw PCM from the wire (5 s window) to inspect continuity offline.
- Validate `encodePacket`/`decodePacket` alignment and verify channel interleaving vs MoQ framing.
- Experiment with smaller lead time and explicit `currentTime + frameDuration` scheduling to check if we’re stacking frames unnecessarily.
