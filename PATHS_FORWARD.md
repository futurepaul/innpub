# Debugging Paths Forward

## 1. Minimal Transport Loop (Audio-Only Sandbox)
- Strip the multiplayer stack down to a single MoQ track that carries audio, ignoring rooms, speaking levels, chat, or position updates.
- Publish a dedicated HTML page that mounts only the audio capture + playback pipeline; hardcode the tone toggle and mic toggle.
- Goal: confirm whether pure audio (no state churn, no PIXI loop) stays glitch-free. If yes, reintroduce features one at a time until hiccups return.
- Bonus: log precise timestamps for `writeFrame`/`readFrame` operations to see end-to-end latency without cross-talk from the game loop.

## 2. Instrumented Frame Profiler
- Build a debug overlay that records every step in the main loop (capture, encode, enqueue, PIXI update, network publish) with high-resolution timestamps.
- Aggregate into per-frame histograms showing total time spent and variance; emit a warning if any step exceeds the audio frame duration (20 ms).
- Combine with `window.__innpubAudioDebug` so each capture packet includes the duration spent before hitting `track.writeFrame`.
- Objective: verify whether our own work (game logic or listeners) is starving the audio queue.

## 3. Offline Buffer Capture & Analysis
- Add a temporary “record” mode that writes inbound PCM frames to an ArrayBuffer / downloadable WAV for a short window (e.g., 5 seconds).
- Pair with a CLI or small script that visualises the waveform and RMS to spot discontinuities or repeated offsets.
- Use the same hook for outgoing frames, allowing comparison between what we send and what partners receive. This isolates format mismatches (sample rate, interleaving) from transport issues.
- After validation, remove or behind a debug flag to keep production lean.

