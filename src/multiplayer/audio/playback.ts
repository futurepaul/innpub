import type { DecodedPacket } from "./packets";

interface RemoteState {
  gain: GainNode;
  nextTime: number;
}

export class AudioPlayback {
  #context?: AudioContext;
  #masterGain?: GainNode;
  #remotes = new Map<string, RemoteState>();
  #enabled = true;

  async resume(): Promise<void> {
    const context = await this.#ensureContext();
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
    const gain = this.#masterGain;
    if (gain) {
      gain.gain.value = enabled ? 1 : 0;
    }
  }

  enqueue(path: string, packet: DecodedPacket) {
    const context = this.#context;
    const masterGain = this.#masterGain;
    if (!context || !masterGain) return;

    const { channels, sampleRate, frameCount } = packet;
    if (channels.length === 0) return;

    const buffer = context.createBuffer(channels.length, frameCount, sampleRate);
    for (let channel = 0; channel < channels.length; channel += 1) {
      buffer.copyToChannel(channels[channel], channel);
    }

    const remote = this.#remotes.get(path) ?? this.#createRemote(path);
    const startAt = Math.max(remote.nextTime, context.currentTime + 0.05);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(remote.gain);
    source.start(startAt);

    remote.nextTime = startAt + buffer.duration;
  }

  close(path: string) {
    const remote = this.#remotes.get(path);
    if (!remote) return;
    remote.gain.disconnect();
    this.#remotes.delete(path);
  }

  shutdown() {
    for (const key of [...this.#remotes.keys()]) {
      this.close(key);
    }
    void this.#context?.close();
    this.#context = undefined;
    this.#masterGain = undefined;
  }

  async #ensureContext(): Promise<AudioContext> {
    if (this.#context) {
      return this.#context;
    }
    const context = new AudioContext({ sampleRate: 48000 });
    const masterGain = context.createGain();
    masterGain.gain.value = this.#enabled ? 1 : 0;
    masterGain.connect(context.destination);
    this.#context = context;
    this.#masterGain = masterGain;
    return context;
  }

  #createRemote(path: string): RemoteState {
    if (!this.#context || !this.#masterGain) {
      throw new Error("audio context not initialized");
    }
    const gain = this.#context.createGain();
    gain.gain.value = 1;
    gain.connect(this.#masterGain);

    const state: RemoteState = {
      gain,
      nextTime: this.#context.currentTime + 0.05,
    };
    this.#remotes.set(path, state);
    return state;
  }
}
