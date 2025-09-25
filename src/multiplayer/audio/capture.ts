export interface CaptureCallbacks {
  onSamples(channels: Float32Array[], sampleRate: number): void;
  onLevel(level: number): void;
}

const WORKLET_URL = new URL("./worklets/captureProcessor.js", import.meta.url);

export const isCaptureSupported =
  typeof window !== "undefined" &&
  typeof AudioContext !== "undefined" &&
  typeof AudioWorkletNode !== "undefined";

export class AudioCapture {
  #context?: AudioContext;
  #node?: AudioWorkletNode;
  #source?: MediaStreamAudioSourceNode;
  #stream?: MediaStream;
  #callbacks: CaptureCallbacks;
  #active = false;

  constructor(callbacks: CaptureCallbacks) {
    this.#callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (!isCaptureSupported) {
      throw new Error("AudioWorklet not supported in this browser");
    }
    if (this.#active) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Media capture APIs are unavailable");
    }

    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule(WORKLET_URL);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "innpub-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });

    worklet.port.onmessage = event => {
      const data = event.data as
        | { type: "samples"; channels: Float32Array[]; level: number; sampleRate: number }
        | undefined;
      if (!data || data.type !== "samples") {
        return;
      }
      this.#callbacks.onSamples(data.channels, data.sampleRate);
      this.#callbacks.onLevel(data.level);
    };

    source.connect(worklet);

    this.#context = context;
    this.#node = worklet;
    this.#source = source;
    this.#stream = stream;
    this.#active = true;

    if (context.state === "suspended") {
      await context.resume();
    }
  }

  async stop(): Promise<void> {
    if (!this.#active) {
      return;
    }

    this.#active = false;

    this.#node?.disconnect();
    this.#source?.disconnect();

    const stream = this.#stream;
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    if (this.#context) {
      await this.#context.close();
    }

    this.#node = undefined;
    this.#source = undefined;
    this.#stream = undefined;
    this.#context = undefined;
  }
}
