export interface CaptureCallbacks {
  onSamples(channels: Float32Array[], sampleRate: number): void;
  onLevel(level: number): void;
}

declare global {
  interface AudioData {
    readonly numberOfChannels: number;
    readonly numberOfFrames: number;
    readonly sampleRate: number;
    copyTo(destination: ArrayBufferView, options?: { planeIndex?: number }): Promise<void>;
    close(): void;
  }

  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
  }

  class MediaStreamTrackProcessor<T = AudioData> {
    constructor(init: MediaStreamTrackProcessorInit);
    readonly readable: ReadableStream<T>;
  }
}

const SAMPLE_RATE = 48_000;
const TARGET_FRAME_COUNT = 960; // ~20ms @ 48kHz
const TONE_FRAME_COUNT = TARGET_FRAME_COUNT;

const supportsMediaTrackProcessor =
  typeof window !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined";

export const isCaptureSupported = supportsMediaTrackProcessor;

class MicAccumulator {
  #channels: Float32Array[] = [];
  #length = 0;
  #channelCount = 0;

  reset(channelCount: number) {
    if (this.#channelCount !== channelCount) {
      this.#channels = Array.from({ length: channelCount }, () => new Float32Array(0));
      this.#channelCount = channelCount;
    } else {
      for (let i = 0; i < this.#channels.length; i += 1) {
        this.#channels[i] = new Float32Array(0);
      }
    }
    this.#length = 0;
  }

  push(channels: Float32Array[]) {
    if (channels.length === 0) return;
    if (this.#channelCount !== channels.length) {
      this.reset(channels.length);
    }
    for (let index = 0; index < channels.length; index += 1) {
      const source = channels[index];
      const existing = this.#channels[index];
      const combined = new Float32Array(existing.length + source.length);
      combined.set(existing, 0);
      combined.set(source, existing.length);
      this.#channels[index] = combined;
    }
    this.#length += channels[0]?.length ?? 0;
  }

  hasFrame(): boolean {
    return this.#length >= TARGET_FRAME_COUNT;
  }

  takeFrame(): Float32Array[] | undefined {
    if (!this.hasFrame()) {
      return undefined;
    }
    const output: Float32Array[] = new Array(this.#channelCount);
    for (let channel = 0; channel < this.#channelCount; channel += 1) {
      const buffer = this.#channels[channel];
      output[channel] = new Float32Array(buffer.subarray(0, TARGET_FRAME_COUNT));
      const remaining = buffer.length - TARGET_FRAME_COUNT;
      if (remaining > 0) {
        const tail = buffer.subarray(TARGET_FRAME_COUNT);
        const copy = new Float32Array(remaining);
        copy.set(tail);
        this.#channels[channel] = copy;
      } else {
        this.#channels[channel] = new Float32Array(0);
      }
    }
    this.#length -= TARGET_FRAME_COUNT;
    return output;
  }
}

function computeRms(channel: Float32Array | undefined): number {
  if (!channel || channel.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const sample = channel[index];
    sum += sample * sample;
  }
  return Math.sqrt(sum / channel.length);
}

export class AudioCapture {
  #callbacks: CaptureCallbacks;
  #stream?: MediaStream;
  #reader?: ReadableStreamDefaultReader<AudioData>;
  #toneTimer: number | null = null;
  #tonePhase = 0;
  #mode: "none" | "mic" | "tone" = "none";
  #toneConfig = {
    enabled: false,
    frequency: 440,
    amplitude: 0.05,
  };
  #accumulator = new MicAccumulator();

  constructor(callbacks: CaptureCallbacks) {
    this.#callbacks = callbacks;
  }

  async start(): Promise<void> {
    await this.stop();
    if (this.#toneConfig.enabled) {
      this.#startTone();
    } else {
      await this.#startMic();
    }
  }

  async stop(): Promise<void> {
    if (this.#mode === "tone") {
      this.#stopTone();
    }
    if (this.#mode === "mic") {
      await this.#stopMic();
    }
    this.#mode = "none";
  }

  async setSyntheticTone(config: { enabled?: boolean; frequency?: number; amplitude?: number }): Promise<void> {
    if (typeof config.enabled === "boolean") {
      this.#toneConfig.enabled = config.enabled;
    }
    if (typeof config.frequency === "number" && Number.isFinite(config.frequency)) {
      this.#toneConfig.frequency = Math.max(20, Math.min(5000, config.frequency));
    }
    if (typeof config.amplitude === "number" && Number.isFinite(config.amplitude)) {
      this.#toneConfig.amplitude = Math.max(0, Math.min(1, config.amplitude));
    }

    if (this.#mode === "tone") {
      // Restart tone with new parameters
      this.#stopTone();
      this.#startTone();
      return;
    }

    if (this.#mode === "mic") {
      if (this.#toneConfig.enabled) {
        await this.#stopMic();
        this.#startTone();
      }
      return;
    }

    // Not active yet; nothing else to do.
  }

  updateTone(config: { frequency?: number; amplitude?: number }) {
    void this.setSyntheticTone({ ...config, enabled: this.#toneConfig.enabled });
  }

  #startTone() {
    this.#mode = "tone";
    this.#tonePhase = 0;
    const intervalMs = (TONE_FRAME_COUNT / SAMPLE_RATE) * 1000;
    const timer = () => {
      const frame = new Float32Array(TONE_FRAME_COUNT);
      const step = (2 * Math.PI * this.#toneConfig.frequency) / SAMPLE_RATE;
      let sumSquares = 0;
      for (let index = 0; index < TONE_FRAME_COUNT; index += 1) {
        const sample = Math.sin(this.#tonePhase) * this.#toneConfig.amplitude;
        frame[index] = sample;
        sumSquares += sample * sample;
        this.#tonePhase += step;
        if (this.#tonePhase > Math.PI * 2) {
          this.#tonePhase -= Math.PI * 2;
        }
      }
      const rms = Math.sqrt(sumSquares / TONE_FRAME_COUNT);
      this.#callbacks.onLevel(rms);
      this.#callbacks.onSamples([frame], SAMPLE_RATE);
    };
    timer();
    this.#toneTimer = setInterval(timer, intervalMs) as unknown as number;
  }

  async #startMic(): Promise<void> {
    if (!supportsMediaTrackProcessor) {
      throw new Error("MediaStreamTrackProcessor is not supported in this browser");
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media capture APIs are unavailable");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const [track] = stream.getAudioTracks();
    if (!track) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error("No audio track available");
    }

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    this.#stream = stream;
    this.#reader = reader;
    this.#mode = "mic";
    this.#accumulator.reset(0);

    (async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done || this.#mode !== "mic") {
          break;
        }
        const frame = result.value;
        try {
          await this.#handleMicFrame(frame);
        } finally {
          frame.close();
        }
      }
    })().catch(error => {
      console.error("AudioCapture pump failed", error);
    });
  }

  async #stopMic(): Promise<void> {
    if (this.#reader) {
      try {
        await this.#reader.cancel();
      } catch (error) {
        console.warn("failed to cancel audio reader", error);
      }
    }
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        track.stop();
      }
    }
    this.#reader = undefined;
    this.#stream = undefined;
    this.#accumulator.reset(0);
  }

  #stopTone() {
    if (this.#toneTimer !== null) {
      clearInterval(this.#toneTimer);
      this.#toneTimer = null;
    }
    this.#tonePhase = 0;
  }

  async #handleMicFrame(frame: AudioData) {
    const channelCount = frame.numberOfChannels || 1;
    const frameCount = frame.numberOfFrames;
    if (frameCount === 0) {
      return;
    }

    const channels: Float32Array[] = [];
    for (let channel = 0; channel < channelCount; channel += 1) {
      const buffer = new Float32Array(frameCount);
      await frame.copyTo(buffer, { planeIndex: channel });
      channels.push(buffer);
    }

    this.#accumulator.push(channels);
    let emitted = false;
    for (;;) {
      const next = this.#accumulator.takeFrame();
      if (!next) break;
      emitted = true;
      const rms = computeRms(next[0]);
      this.#callbacks.onLevel(rms);
      this.#callbacks.onSamples(next, frame.sampleRate || SAMPLE_RATE);
    }

    if (!emitted) {
      const rms = computeRms(channels[0]);
      this.#callbacks.onLevel(rms);
    }
  }
}

export default AudioCapture;
