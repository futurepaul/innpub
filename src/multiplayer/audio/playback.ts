import type { DecodedPacket } from "./packets";

const LEAD_SECONDS = 0.65;

export interface PlaybackStats {
  framesDecoded: number;
  bufferedAhead: number;
  underruns: number;
}

interface RemoteState {
  gain: GainNode;
  nextTime: number;
  stats: PlaybackStats;
}

declare global {
  interface Window {
    __innpubAudioPlaybackDebug?: () => {
      volumes: Record<string, number>;
      stats: Record<string, PlaybackStats>;
      enabled: boolean;
    };
  }
}

export class AudioPlayback {
  #context?: AudioContext;
  #masterGain?: GainNode;
  #remotes = new Map<string, RemoteState>();
  #enabled = true;
  #volumes = new Map<string, number>();

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
    if (channels.length === 0 || frameCount === 0) return;

    const buffer = context.createBuffer(channels.length, frameCount, sampleRate);
    for (let channel = 0; channel < channels.length; channel += 1) {
      buffer.copyToChannel(channels[channel], channel);
    }

    const remote = this.#remotes.get(path) ?? this.#createRemote(path);
    const targetGain = this.#volumes.get(path);
    if (typeof targetGain === "number") {
      remote.gain.gain.value = targetGain;
    }

    if (remote.nextTime < context.currentTime) {
      remote.stats.underruns += 1;
      remote.nextTime = context.currentTime;
    }

    if (remote.nextTime - context.currentTime > LEAD_SECONDS * 4) {
      remote.nextTime = context.currentTime + LEAD_SECONDS;
    }

    const startAt = Math.max(remote.nextTime, context.currentTime + LEAD_SECONDS);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(remote.gain);
    source.start(startAt);

    remote.nextTime = startAt + buffer.duration;
    remote.stats.framesDecoded += frameCount;
    remote.stats.bufferedAhead = Math.max(0, remote.nextTime - context.currentTime);
  }

  setVolume(path: string, value: number) {
    this.#volumes.set(path, value);
    const remote = this.#remotes.get(path);
    if (remote) {
      remote.gain.gain.value = value;
    }
  }

  close(path: string) {
    const remote = this.#remotes.get(path);
    if (!remote) return;
    remote.gain.disconnect();
    this.#remotes.delete(path);
    this.#volumes.delete(path);
  }

  shutdown() {
    for (const key of [...this.#remotes.keys()]) {
      this.close(key);
    }
    void this.#context?.close();
    this.#context = undefined;
    this.#masterGain = undefined;
    this.#volumes.clear();
  }

  getVolume(path: string): number | undefined {
    const remote = this.#remotes.get(path);
    if (remote) {
      return remote.gain.gain.value;
    }
    return this.#volumes.get(path);
  }

  getVolumes(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [key, value] of this.#volumes) {
      snapshot[key] = value;
    }
    for (const [key, remote] of this.#remotes) {
      snapshot[key] = remote.gain.gain.value;
    }
    return snapshot;
  }

  getStats(path: string): PlaybackStats | undefined {
    const remote = this.#remotes.get(path);
    if (!remote) return undefined;
    return { ...remote.stats };
  }

  getAllStats(): Record<string, PlaybackStats> {
    const snapshot: Record<string, PlaybackStats> = {};
    for (const [key, remote] of this.#remotes) {
      snapshot[key] = { ...remote.stats };
    }
    return snapshot;
  }

  isEnabled(): boolean {
    return this.#enabled;
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
    this.#exposeDebugHandle();
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
      nextTime: this.#context.currentTime + LEAD_SECONDS,
      stats: {
        framesDecoded: 0,
        bufferedAhead: 0,
        underruns: 0,
      },
    };
    this.#remotes.set(path, state);
    return state;
  }

  #exposeDebugHandle() {
    if (typeof window === "undefined") {
      return;
    }
    if (window.__innpubAudioPlaybackDebug) {
      return;
    }
    window.__innpubAudioPlaybackDebug = () => ({
      volumes: this.getVolumes(),
      stats: this.getAllStats(),
      enabled: this.isEnabled(),
    });
  }
}

export default AudioPlayback;
