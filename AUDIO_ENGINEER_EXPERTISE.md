You’ve got three big sources of glitch risk right now:

1. you’re *pushing* short PCM chunks into many `AudioBufferSourceNode`s (schedule-and-pray),
2. you don’t hold a stable “playout head” with a jitter buffer, and
3. work (net I/O + decoding + mixing decisions) happens on the main thread.

Both reference projects solve these with the same pattern: **a continuous pull-based renderer (AudioWorklet) reading from a ring buffer** that you keep filled from a **jitter-buffered stream**, ideally written from a **Worker**. Here’s how to port those wins into innpub with the least churn.

---

# 1) Replace BufferSource queue with a pull-based sink

Your `AudioPlayback.enqueue()` builds an `AudioBuffer`, picks a future `startAt`, and fires a `BufferSource`. This is super sensitive to GC pauses, tab throttling, and clock drift → pops/underruns.

**What to do:** add a render worklet (like `@ain1084/audio-worklet-stream`’s OutputStreamNode or the `source_buffer_worklet.js` used by moq-encoder-player) that pulls frames from a ring/circular buffer every 128-frame quantum. You then just keep that buffer topped up.

Sketch:

```ts
// main thread
const ctx = new AudioContext({ sampleRate: 48000 });
await ctx.audioWorklet.addModule('/worklets/output-sink.js');
const sink = new AudioWorkletNode(ctx, 'innpub-output-sink', {
  numberOfInputs: 0,
  numberOfOutputs: 1,
  outputChannelCount: [1], // or 2
});
sink.connect(ctx.destination);

// Provide a SharedArrayBuffer-backed ring for PCM
const sab = new SharedArrayBuffer(RING_BYTES);
const state = new SharedArrayBuffer(STATE_BYTES);
sink.port.postMessage({ type: 'init', sab, state, channels: 1, sampleRate: 48000 });

// When you receive a decoded packet for a remote:
// write into that remote's mixer input ring (see §3).
```

```js
// /worklets/output-sink.js
class OutputSink extends AudioWorkletProcessor {
  constructor() { super(); /* map of per-remote ring readers + mixer */ }
  process(_inputs, outputs) {
    const out = outputs[0];
    // pull exactly out[0].length frames from your mixed ring each quantum
    // zero-fill on underrun; keep a running underrun counter
    return true;
  }
}
registerProcessor('innpub-output-sink', OutputSink);
```

Why this helps:

* the **audio device clock** drives rendering (no brittle future timestamps),
* you can **smooth** through short fetch hiccups by keeping a target buffer depth,
* underruns become measurable and recoverable (silence fill), not pops.

If you don’t want to build this from scratch, you can embed the pattern from `audio-worklet-stream` (manual/timed/worker writer into a ring) and just **write the decoded PCM into its writer**.

---

# 2) Add a tiny per-remote jitter buffer (60–100 ms) with sequence & PTS

Your `packets.ts` has only version/chanCount/sampleRate/frameCount; there’s **no timing** or ordering metadata. On variable-latency networks that means packets can arrive late/out-of-order → “late” buffers get scheduled too close to `currentTime` and glitch.

**What to change in the packet:**

* add `seq` (uint32) and `pts` (int64 in microseconds, or float64 seconds) to the header.
* keep frame size fixed (e.g., 960 @ 48kHz = 20 ms, like you already do in the worklet). Consistent chunking simplifies jitter buffering.

Minimal header extension (keeping your 16-byte start, add 12 bytes):

```
byte 0:  version (u8)
byte 1:  channels (u8)
byte 2-3: reserved (u16)
byte 4-7: sampleRate (u32 LE)
byte 8-11: frameCount (u32 LE)
byte 12-15: seq (u32 LE)
byte 16-23: pts_us (u64 LE)
... Float32 PCM interleaved-by-channel as you do now
```

**On receive:** per remote, keep an ordered min-heap/map keyed by `seq` (or `pts`). Deliver to the renderer **only when** you’ve accumulated ~60–100 ms of audio or the next expected `seq` appears. On gap, insert equivalent silence and advance (moq-encoder-player computes a `timestampOffset` and continues).

This mirrors their `jitter_buffer.js` and eliminates “bunching up at the head”.

---

# 3) Mix in the worklet, not on the graph

You’re doing per-remote gains via separate nodes and scheduling separate sources. Once you move to a pull sink, **do the mixing inside the worklet**:

* Maintain one SAB ring **per remote** (writer on main/Worker, reader in worklet).
* In `process`, pull N frames from each audible remote, multiply by that remote’s gain (based on your rooms logic), sum into output. Remote with no data → mix silence.
* You already have a great policy in `updateAudioMix()`; keep that, just make gain a **param posted to the worklet** so there’s no main-thread timing dependency.

This removes many graph nodes and avoids param races.

---

# 4) Move receive/parse/decode off the main thread

Even if you keep raw PCM, the **read→decode→copy** pipeline should be off main. Your `stream.ts`’s subscription loops (`readFrame()`, `decodePacket()`, `audioPlayback.enqueue`) live on the main thread. Any layout/GC hiccup = glitch.

Two options:

* **Worker**: read MOQT frames in a Worker, decode, and write Float32 chunks into SAB rings. Post only control messages to main (levels, debug, stats). This mirrors `moq-encoder-player` (workers everywhere).
* **Worklet input**: in some designs you can write directly from a Worker to the SAB that the output worklet reads.

Either way, keep the main thread light.

---

# 5) Standardize on 48 kHz mono/stereo, fixed frame = 960 samples

You already start capture at 48k and the capture worklet synthesizes in 960-frame blocks. Keep **everything** at that hop size end-to-end:

* capture → 960-frame chunks,
* packetization → 960,
* jitter buffer release → 960,
* ring writes → multiples of 960.

That eliminates fractional-block edge cases and keeps math exact.

---

# 6) Report & act on underruns instead of big LEAD padding

You currently use `LEAD_SECONDS = 0.65` and reset `nextTime` if it falls behind. With the sink pattern, you can:

* maintain a **target ring depth** (e.g., 120 ms),
* if depth < threshold, count an underrun and optionally **temporarily increase** fill aggressiveness (write extra chunks) until recovered,
* expose depth/underruns via your existing `__innpubAudioDebug()` (you already have great plumbing; just repoint it to ring metrics).

This feels like `audio-worklet-stream`’s “UnderrunEvent” and the moq player’s “renderer.currentAudioTS” health info.

---

# 7) (Optional but huge) Switch to Opus via WebCodecs

Raw PCM over MOQT is bandwidth-heavy and very unforgiving. The moq demo uses **Opus @ 32–64 kbps** with **10 ms frames** and tolerates jitter better:

* Encode microphone with `AudioEncoder` (`opus.frameDuration = 10000` us).
* Transport encoded chunks; jitter buffer works on chunk seq.
* Decode with `AudioDecoder` and hand PCM to the same sink ring.

You can keep your current plumbing and only swap the `encodePacket/decodePacket` with encoder/decoder wrappers. Expect a massive reduction in drops under network stress.

---

# 8) Concrete, staged changes for innpub

If you want to keep momentum, do it in these small PR-sized steps:

**A. Timing + jitter (no worklet yet)**

* Extend audio packet header with `seq` + `pts`.
* Add a minimal per-remote jitter buffer (target 80 ms) in `subscribeToRemote()`’s audio path; only call `enqueue()` with ordered, smoothed chunks.
* Cut `LEAD_SECONDS` from 0.65 → 0.15 and see immediate glitch reduction.

**B. Worklet sink**

* Add `/worklets/output-sink.js` and a simple SharedArrayBuffer ring (one mixed ring).
* Replace `AudioPlayback.enqueue()` with ring writes, and stop creating `BufferSource`s altogether.
* Route your `audioPlayback.setVolume`/rooms logic to the sink via `port.postMessage({ setGain, setAudibleRemotes… })`.

**C. Offload**

* Move MOQT `readFrame()` loop for audio to a Worker; write decoded PCM straight into the per-remote rings.
* Post only stats to main (you already have `AudioDebugSnapshot` scaffolding).

**D. Opus (optional)**

* Wrap WebCodecs in `encodeOpus(packet)` / `decodeOpus(chunk)` helpers that still hand 960-frame PCM blocks to the same ring.

---

# 9) Tiny fixes you can do *today* with current code

* **Clamp the max lead more aggressively**: you already do `if (remote.nextTime - currentTime > LEAD_SECONDS * 4) nextTime = currentTime + LEAD_SECONDS;` Drop `* 4` (or reduce to `* 2`), otherwise a single burst can push you seconds ahead and then any clock skew causes audible bumps.
* **Avoid rescheduling behind currentTime**: before `source.start(startAt)`, if `startAt < currentTime + 0.02`, bump to `currentTime + 0.02` and count an underrun. Right now you set `remote.nextTime = currentTime` but still use `startAt = Math.max(remote.nextTime, currentTime + LEAD_SECONDS)`; that creates a big gap jump.
* **Use constant block sizes**: when capturing, ensure the chunk you send to MOQT is exactly 960 frames every time (you do this for the synthetic path, but the mic path forwards whatever quantum size the platform gives—usually 128). Buffer 128s into a 960-frame slab before `encodePacket()`.
* **Transfer ownership**: you already use `postMessage(..., channelBuffers.map(b => b.buffer))` in the capture worklet—good. Do the same (transfer) on any Worker boundaries you add for playback.

---

If you want, I can draft:

* a drop-in `output-sink.js` worklet + a tiny `RingBuffer` backed by SAB,
* a 50-line jitter buffer you can drop into `stream.ts`,
* a revised `packets.ts` header with `seq`+`pts`.

That’ll get you from “glitchy but working” → “solid and resilient” without a big refactor.

