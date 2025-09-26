import type { CaptureCallbacks } from "../multiplayer/audio/capture";

type CaptureMode = "mic" | "tone";

type ToneConfig = {
  frequency: number;
  amplitude: number;
};

declare global {
  // Minimal declarations for browsers that support WebCodecs APIs.
  // These overlays are intentionally partial and will be ignored if
  // the environment already provides full type definitions.
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
const TONE_FRAME_COUNT = 960; // ~20ms at 48kHz
const TARGET_FRAME_COUNT = 960;

export class AudioLabCapture {
  #callbacks: CaptureCallbacks;
  #toneConfig: ToneConfig = { frequency: 440, amplitude: 0.05 };
  #mode: CaptureMode | "none" = "none";
  #stream?: MediaStream;
  #reader?: ReadableStreamDefaultReader<AudioData>;
  #toneTimer: number | null = null;
  #tonePhase = 0;
  #active = false;
  #pendingChannels: Float32Array[] = [];
  #pendingLength = 0;

  constructor(callbacks: CaptureCallbacks) {
    this.#callbacks = callbacks;
  }

  async start(mode: CaptureMode): Promise<void> {
    await this.stop();
    if (mode === "mic") {
      await this.#startMic();
    } else {
      this.#startTone();
    }
    this.#mode = mode;
    this.#active = true;
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#mode = "none";
    if (this.#toneTimer !== null) {
      clearInterval(this.#toneTimer);
      this.#toneTimer = null;
    }
    if (this.#reader) {
      try {
        await this.#reader.cancel();
      } catch (error) {
        // ignore cancellation errors
      }
    }
    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        track.stop();
      }
      this.#stream = undefined;
    }
    this.#reader = undefined;
    this.#pendingChannels = [];
    this.#pendingLength = 0;
  }

  updateTone(config: Partial<ToneConfig>) {
    if (typeof config.frequency === "number" && Number.isFinite(config.frequency)) {
      this.#toneConfig.frequency = Math.min(5_000, Math.max(20, config.frequency));
    }
    if (typeof config.amplitude === "number" && Number.isFinite(config.amplitude)) {
      this.#toneConfig.amplitude = Math.min(1, Math.max(0, config.amplitude));
    }
  }

  get isActive(): boolean {
    return this.#active;
  }

  async #startMic(): Promise<void> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media capture APIs are unavailable");
    }
    if (typeof MediaStreamTrackProcessor === "undefined") {
      throw new Error("MediaStreamTrackProcessor is not supported in this browser");
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
      throw new Error("No audio track available");
    }
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    this.#reader = reader;
    this.#stream = stream;
    this.#pendingChannels = [];
    this.#pendingLength = 0;

    const pump = async () => {
      for (;;) {
        const result = await reader.read();
        if (result.done || this.#mode !== "mic") {
          break;
        }
        const frame = result.value;
        try {
          await this.#handleAudioData(frame);
        } finally {
          frame.close();
        }
      }
    };

    void pump().catch(error => {
      if (this.#mode === "mic") {
        // eslint-disable-next-line no-console
        console.error("AudioLabCapture mic failure", error);
      }
    });
  }

  async #handleAudioData(frame: AudioData) {
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

    this.#appendAndEmitMicFrames(channels, frame.sampleRate || SAMPLE_RATE);
  }

  #appendAndEmitMicFrames(channels: Float32Array[], sampleRate: number) {
    if (this.#pendingChannels.length !== channels.length) {
      this.#pendingChannels = Array.from({ length: channels.length }, () => new Float32Array(0));
      this.#pendingLength = 0;
    }

    for (let channel = 0; channel < channels.length; channel += 1) {
      const existing = this.#pendingChannels[channel];
      const incoming = channels[channel];
      const combined = new Float32Array(existing.length + incoming.length);
      combined.set(existing, 0);
      combined.set(incoming, existing.length);
      this.#pendingChannels[channel] = combined;
    }
    this.#pendingLength += channels[0]?.length ?? 0;

    while (this.#pendingLength >= TARGET_FRAME_COUNT) {
      const slice: Float32Array[] = new Array(this.#pendingChannels.length);
      for (let channel = 0; channel < this.#pendingChannels.length; channel += 1) {
        const source = this.#pendingChannels[channel];
        slice[channel] = source.subarray(0, TARGET_FRAME_COUNT); // view
      }

      const copyForEmit = slice.map(channelSlice => new Float32Array(channelSlice));
      const rms = this.#computeRms(copyForEmit[0]);
      this.#callbacks.onLevel(rms);
      this.#callbacks.onSamples(copyForEmit, sampleRate);

      const remaining = this.#pendingLength - TARGET_FRAME_COUNT;
      for (let channel = 0; channel < this.#pendingChannels.length; channel += 1) {
        const source = this.#pendingChannels[channel];
        if (remaining > 0) {
          const remainder = new Float32Array(remaining);
          remainder.set(source.subarray(TARGET_FRAME_COUNT));
          this.#pendingChannels[channel] = remainder;
        } else {
          this.#pendingChannels[channel] = new Float32Array(0);
        }
      }
      this.#pendingLength = remaining;
    }
  }

  #startTone() {
    this.#toneTimer = window.setInterval(() => {
      this.#emitToneFrame();
    }, Math.round((TONE_FRAME_COUNT / SAMPLE_RATE) * 1000));
  }

  #emitToneFrame() {
    const frameCount = TONE_FRAME_COUNT;
    const buffer = new Float32Array(frameCount);
    const frequency = this.#toneConfig.frequency;
    const amplitude = this.#toneConfig.amplitude;
    const phaseStep = (2 * Math.PI * frequency) / SAMPLE_RATE;

    let sumSquares = 0;
    for (let index = 0; index < frameCount; index += 1) {
      const sample = Math.sin(this.#tonePhase) * amplitude;
      buffer[index] = sample;
      sumSquares += sample * sample;
      this.#tonePhase += phaseStep;
      if (this.#tonePhase > Math.PI * 2) {
        this.#tonePhase -= Math.PI * 2;
      }
    }

    const rms = Math.sqrt(sumSquares / frameCount);
    this.#callbacks.onLevel(rms);
    this.#callbacks.onSamples([buffer], SAMPLE_RATE);
  }

  #computeRms(channel: Float32Array): number {
    if (!channel || channel.length === 0) {
      return 0;
    }
    let sumSquares = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = channel[index];
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / channel.length);
  }
}
