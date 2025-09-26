import { StreamNodeFactory, UnderrunEvent, type OutputStreamNode } from "@ain1084/audio-worklet-stream";
import type { FrameBufferWriter } from "@ain1084/audio-frame-buffer";

import type { DecodedPacket } from "./packets";

const LEAD_BUFFER_FRAMES = 48_000; // 1s @ 48kHz
const LEAD_SECONDS = 0.65;

export interface PlaybackStats {
  framesDecoded: number;
  bufferedAhead: number;
  underruns: number;
}

type RemoteState = {
  node: OutputStreamNode;
  writer: FrameBufferWriter;
  gain: GainNode;
  stats: PlaybackStats;
  sampleRate: number;
  channelCount: number;
  started: boolean;
  droppedFrames: number;
};

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
  #factoryPromise?: Promise<StreamNodeFactory>;
  #factory?: StreamNodeFactory;
  #masterGain?: GainNode;
  #enabled = true;
  #remotes = new Map<string, RemoteState>();
  #pendingRemotes = new Map<string, Promise<RemoteState>>();
  #volumes = new Map<string, number>();
  #processorLoaded = false;

  async resume(): Promise<void> {
    await this.#ensureContext();
    if (this.#context?.state === "suspended") {
      await this.#context.resume();
    }
  }

  setEnabled(enabled: boolean) {
    this.#enabled = enabled;
    if (this.#masterGain) {
      this.#masterGain.gain.value = enabled ? 1 : 0;
    }
  }

  async enqueue(path: string, packet: DecodedPacket): Promise<void> {
    if (packet.frameCount === 0 || packet.channels.length === 0) {
      return;
    }
    const remote = await this.#getRemote(path, packet);
    if (remote.channelCount !== packet.channels.length) {
      await this.#recreateRemote(path, packet);
      return this.enqueue(path, packet);
    }

    const totalFrames = packet.frameCount;
    const channels = packet.channels;
    const written = remote.writer.write((segment, offset) => {
      const remaining = totalFrames - offset;
      if (remaining <= 0) {
        return 0;
      }
      const framesToCopy = Math.min(segment.frameCount, remaining);
      for (let frame = 0; frame < framesToCopy; frame += 1) {
        for (let channel = 0; channel < channels.length; channel += 1) {
          segment.set(frame, channel, channels[channel][offset + frame]);
        }
      }
      return framesToCopy;
    });

    if (written < totalFrames) {
      const dropped = totalFrames - written;
      remote.droppedFrames += dropped;
      console.warn(`AudioPlayback dropping ${dropped} frames for ${path}`);
    }

    remote.sampleRate = packet.sampleRate;

    const totalWritten = Number(remote.writer.totalFrames);
    const totalRead = Number(remote.node.totalReadFrames);
    const bufferFrames = Math.max(0, totalWritten - totalRead);

    remote.stats.bufferedAhead = bufferFrames / remote.sampleRate;
    remote.stats.framesDecoded = totalRead;

    if (!remote.started && written > 0) {
      if (!remote.node.isStart) {
        remote.node.start();
      }
      remote.started = true;
    }
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
    if (!remote) {
      return;
    }
    this.#remotes.delete(path);
    this.#volumes.delete(path);
    remote.gain.disconnect();
    void remote.node.stop();
  }

  shutdown() {
    for (const [path] of this.#remotes) {
      this.close(path);
    }
    void this.#context?.close();
    this.#context = undefined;
    this.#factoryPromise = undefined;
    this.#factory = undefined;
    this.#masterGain = undefined;
    this.#processorLoaded = false;
    this.#exposeDebugHandle();
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

  async #ensureContext(): Promise<void> {
    if (this.#factoryPromise) {
      await this.#factoryPromise;
      return;
    }
    const promise = (async () => {
      const context = new AudioContext({ sampleRate: 48_000 });
      const masterGain = context.createGain();
      masterGain.gain.value = this.#enabled ? 1 : 0;
      masterGain.connect(context.destination);
      this.#context = context;
      this.#masterGain = masterGain;
      const factory = await StreamNodeFactory.create(context);
      this.#factory = factory;
      this.#exposeDebugHandle();
      return factory;
    })();
    this.#factoryPromise = promise;
    await promise;
  }

  async #ensureProcessorModule(): Promise<void> {
    if (!this.#context) {
      throw new Error("Audio context not initialized");
    }
    if (this.#processorLoaded) {
      return;
    }
    await this.#context.audioWorklet.addModule("/worklets/audio-worklet-stream-output.js");
    this.#processorLoaded = true;
  }

  async #getRemote(path: string, packet: DecodedPacket): Promise<RemoteState> {
    const existing = this.#remotes.get(path);
    if (existing) {
      return existing;
    }
    const pending = this.#pendingRemotes.get(path);
    if (pending) {
      return pending;
    }
    const creation = this.#createRemote(path, packet);
    this.#pendingRemotes.set(path, creation);
    const remote = await creation;
    this.#pendingRemotes.delete(path);
    this.#remotes.set(path, remote);
    return remote;
  }

  async #recreateRemote(path: string, packet: DecodedPacket): Promise<void> {
    this.close(path);
    this.#remotes.delete(path);
    await this.#getRemote(path, packet);
  }

  async #createRemote(path: string, packet: DecodedPacket): Promise<RemoteState> {
    await this.#ensureContext();
    await this.#ensureProcessorModule();
    if (!this.#context || !this.#masterGain || !this.#factory) {
      throw new Error("Audio context not initialized");
    }
    const channelCount = Math.max(1, packet.channels.length);
    const frameCount = Math.max(LEAD_BUFFER_FRAMES, packet.frameCount * 4);
    const [node, writer] = await this.#factory.createManualBufferNode({
      channelCount,
      frameCount,
    });
    const gain = this.#context.createGain();
    const targetGain = this.#volumes.get(path) ?? 1;
    gain.gain.value = targetGain;
    node.connect(gain);
    gain.connect(this.#masterGain);

    const remote: RemoteState = {
      node,
      writer,
      gain,
      stats: {
        framesDecoded: 0,
        bufferedAhead: 0,
        underruns: 0,
      },
      sampleRate: packet.sampleRate,
      channelCount,
      started: false,
      droppedFrames: 0,
    };

    node.addEventListener(UnderrunEvent.type, () => {
      remote.stats.underruns += 1;
    });

    return remote;
  }

  #exposeDebugHandle() {
    if (typeof window === "undefined") {
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
