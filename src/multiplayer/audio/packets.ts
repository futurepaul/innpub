const VERSION = 1;
const HEADER_BYTES = 28;
const DEFAULT_FRAME_SIZE = 960;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_BITRATE = 48_000;

interface PacketHeader {
  channelCount: number;
  sampleRate: number;
  frameCount: number;
  sequence: number;
  timestampUs: number;
  payloadLength: number;
}

interface PendingEncode {
  resolve: (value: Uint8Array) => void;
  reject: (reason: Error) => void;
}

interface PendingDecode {
  resolve: (value: DecodedPacket | undefined) => void;
  reject: (reason: Error) => void;
}

class SampleFifo {
  #segments: Float32Array[] = [];
  #offset = 0;
  #length = 0;

  push(segment: Float32Array) {
    if (segment.length === 0) return;
    this.#segments.push(segment);
    this.#length += segment.length;
  }

  read(count: number): Float32Array | null {
    if (this.#length < count) {
      return null;
    }
    const output = new Float32Array(count);
    let written = 0;

    while (written < count) {
      const current = this.#segments[0];
      if (!current) {
        break;
      }
      const remaining = current.length - this.#offset;
      const need = count - written;
      const take = Math.min(remaining, need);
      output.set(current.subarray(this.#offset, this.#offset + take), written);
      written += take;
      this.#offset += take;
      if (this.#offset >= current.length) {
        this.#segments.shift();
        this.#offset = 0;
      }
    }

    this.#length -= count;
    return output;
  }

  available(): number {
    return this.#length;
  }

  reset() {
    this.#segments = [];
    this.#offset = 0;
    this.#length = 0;
  }
}

function assertWebCodecsSupport(): void {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") {
    throw new Error("WebCodecs audio support is required for Opus transport");
  }
}

function writeHeader(view: DataView, header: PacketHeader) {
  view.setUint8(0, VERSION);
  view.setUint8(1, header.channelCount);
  view.setUint16(2, 0, true);
  view.setUint32(4, header.sampleRate, true);
  view.setUint32(8, header.frameCount, true);
  view.setUint32(12, header.sequence, true);
  view.setFloat64(16, header.timestampUs, true);
  view.setUint32(24, header.payloadLength, true);
}

function parseHeader(payload: Uint8Array): PacketHeader | null {
  if (payload.byteLength < HEADER_BYTES) {
    return null;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) {
    return null;
  }
  const channelCount = view.getUint8(1);
  const sampleRate = view.getUint32(4, true);
  const frameCount = view.getUint32(8, true);
  const sequence = view.getUint32(12, true);
  const timestampUs = view.getFloat64(16, true);
  const payloadLength = view.getUint32(24, true);
  if (channelCount === 0 || sampleRate === 0 || frameCount === 0 || payloadLength === 0) {
    return null;
  }
  if (HEADER_BYTES + payloadLength > payload.byteLength) {
    return null;
  }
  return { channelCount, sampleRate, frameCount, sequence, timestampUs, payloadLength };
}

function createPacket(header: PacketHeader, payload: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  writeHeader(view, { ...header, payloadLength: payload.byteLength });
  buffer.set(payload, HEADER_BYTES);
  return buffer;
}

export interface EncodedPacket {
  buffer: Uint8Array;
  sequence: number;
  timestampUs: number;
  frameCount: number;
}

export interface DecodedPacket {
  channels: Float32Array[];
  sampleRate: number;
  frameCount: number;
  sequence: number;
  timestampUs: number;
}

export interface OpusEncoderOptions {
  frameSize?: number;
  sampleRate?: number;
  bitrate?: number;
}

export class OpusPacketEncoder {
  #encoder: AudioEncoder | null = null;
  #fifo: SampleFifo[] = [];
  #pending: PendingEncode[] = [];
  #frameSize: number;
  #sampleRate: number;
  #channelCount: number | null = null;
  #timestampUs = 0;
  #sequence = 0;
  #frameDurationUs: number;
  #bitrate: number;

  constructor(options: OpusEncoderOptions = {}) {
    assertWebCodecsSupport();
    this.#frameSize = options.frameSize ?? DEFAULT_FRAME_SIZE;
    this.#sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.#bitrate = options.bitrate ?? DEFAULT_BITRATE;
    this.#frameDurationUs = Math.round((this.#frameSize / this.#sampleRate) * 1_000_000);
  }

  async encode(channels: Float32Array[], sampleRate: number): Promise<EncodedPacket[]> {
    if (channels.length === 0) {
      return [];
    }
    if (sampleRate !== this.#sampleRate) {
      throw new Error(`Unsupported sample rate ${sampleRate}; expected ${this.#sampleRate}`);
    }

    if (this.#channelCount === null) {
      this.#channelCount = channels.length;
      this.#fifo = Array.from({ length: this.#channelCount }, () => new SampleFifo());
      await this.#ensureEncoder();
    } else if (channels.length !== this.#channelCount) {
      throw new Error(`Channel count changed from ${this.#channelCount} to ${channels.length}`);
    }

    for (let index = 0; index < channels.length; index += 1) {
      const samples = channels[index];
      if (!samples) {
        throw new Error("Missing channel samples for Opus encode");
      }
      const fifo = this.#fifo[index];
      if (!fifo) {
        throw new Error("FIFO unavailable for channel");
      }
      fifo.push(samples);
    }

    const packets: EncodedPacket[] = [];
    for (;;) {
      if (!this.#hasFullFrame()) {
        break;
      }
      const frame = this.#readFrame();
      if (!frame) {
        break;
      }
      const interleaved = interleaveChannels(frame);
      const timestampUs = this.#timestampUs;
      const sequence = this.#sequence;
      this.#timestampUs += this.#frameDurationUs;
      this.#sequence = (this.#sequence + 1) >>> 0;

      const payload = await this.#encodeFrame(interleaved, timestampUs);
      const packet = createPacket(
        {
          channelCount: frame.length,
          sampleRate: this.#sampleRate,
          frameCount: this.#frameSize,
          sequence,
          timestampUs,
          payloadLength: payload.byteLength,
        },
        payload,
      );
      packets.push({ buffer: packet, sequence, timestampUs, frameCount: this.#frameSize });
    }

    return packets;
  }

  reset() {
    this.#fifo.forEach(fifo => fifo.reset());
    this.#fifo = [];
    this.#pending.forEach(entry => entry.reject(new Error("Opus encoder reset")));
    this.#pending = [];
    this.#channelCount = null;
    this.#timestampUs = 0;
    this.#sequence = 0;
    if (this.#encoder) {
      const encoder = this.#encoder;
      this.#encoder = null;
      void encoder.flush().catch(() => undefined);
      encoder.close();
    }
  }

  async flush(): Promise<EncodedPacket[]> {
    if (!this.#channelCount) {
      return [];
    }
    const packets: EncodedPacket[] = [];
    while (this.#hasFullFrame()) {
      const frame = this.#readFrame();
      if (!frame) {
        break;
      }
      const interleaved = interleaveChannels(frame);
      const timestampUs = this.#timestampUs;
      const sequence = this.#sequence;
      this.#timestampUs += this.#frameDurationUs;
      this.#sequence = (this.#sequence + 1) >>> 0;
      const payload = await this.#encodeFrame(interleaved, timestampUs);
      const packet = createPacket(
        {
          channelCount: frame.length,
          sampleRate: this.#sampleRate,
          frameCount: this.#frameSize,
          sequence,
          timestampUs,
          payloadLength: payload.byteLength,
        },
        payload,
      );
      packets.push({ buffer: packet, sequence, timestampUs, frameCount: this.#frameSize });
    }
    return packets;
  }

  async #ensureEncoder() {
    if (this.#encoder) {
      return;
    }
    assertWebCodecsSupport();
    const encoder = new AudioEncoder({
      output: chunk => {
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        const entry = this.#pending.shift();
        if (entry) {
          entry.resolve(payload);
        }
      },
      error: error => {
        const err = error instanceof Error ? error : new Error(String(error));
        const entry = this.#pending.shift();
        if (entry) {
          entry.reject(err);
        }
        this.reset();
      },
    });

    const config = {
      codec: "opus",
      sampleRate: this.#sampleRate,
      numberOfChannels: this.#channelCount ?? 1,
      bitrate: this.#bitrate,
    };

    if (typeof AudioEncoder.isConfigSupported === "function") {
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (!support || !support.supported || !support.config) {
        encoder.close();
        throw new Error("Opus encoder configuration unsupported");
      }
      encoder.configure(support.config);
    } else {
      encoder.configure(config);
    }

    this.#encoder = encoder;
  }

  async #encodeFrame(interleaved: Float32Array, timestampUs: number): Promise<Uint8Array> {
    await this.#ensureEncoder();
    if (!this.#encoder) {
      throw new Error("Opus encoder unavailable");
    }

    const dataBuffer = interleaved.buffer as ArrayBuffer;
    const audioData = new AudioData({
      format: "f32",
      sampleRate: this.#sampleRate,
      numberOfChannels: this.#channelCount ?? 1,
      numberOfFrames: this.#frameSize,
      timestamp: timestampUs,
      data: dataBuffer,
    });

    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });

    try {
      this.#encoder.encode(audioData);
    } catch (error) {
      this.#pending.pop();
      audioData.close();
      throw error instanceof Error ? error : new Error(String(error));
    }

    audioData.close();
    return promise;
  }

  #hasFullFrame(): boolean {
    return this.#fifo.length > 0 && this.#fifo.every(fifo => fifo.available() >= this.#frameSize);
  }

  #readFrame(): Float32Array[] | null {
    if (this.#channelCount === null) {
      return null;
    }
    const frame: Float32Array[] = [];
    for (let channel = 0; channel < this.#channelCount; channel += 1) {
      const fifo = this.#fifo[channel];
      if (!fifo) {
        throw new Error("FIFO unavailable for channel");
      }
      const samples = fifo.read(this.#frameSize);
      if (!samples) {
        return null;
      }
      frame.push(samples);
    }
    return frame;
  }
}

export class OpusPacketDecoder {
  #decoder: AudioDecoder | null = null;
  #pending: PendingDecode[] = [];
  #expectedSampleRate: number | null = null;
  #expectedChannels: number | null = null;

  constructor() {
    assertWebCodecsSupport();
  }

  async decode(packet: Uint8Array): Promise<DecodedPacket | undefined> {
    const header = parseHeader(packet);
    if (!header) {
      return undefined;
    }
    const payload = packet.subarray(HEADER_BYTES, HEADER_BYTES + header.payloadLength);
    await this.#ensureDecoder(header.sampleRate, header.channelCount);
    if (!this.#decoder) {
      throw new Error("Opus decoder unavailable");
    }

    const chunk = new EncodedAudioChunk({
      type: "key",
      timestamp: header.timestampUs,
      duration: Math.round((header.frameCount / header.sampleRate) * 1_000_000),
      data: payload,
    });

    const promise = new Promise<DecodedPacket | undefined>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });

    try {
      this.#decoder.decode(chunk);
    } catch (error) {
      this.#pending.pop();
      throw error instanceof Error ? error : new Error(String(error));
    }

    return promise.then(result => {
      if (!result) {
        return undefined;
      }
      return {
        ...result,
        sequence: header.sequence,
        timestampUs: header.timestampUs,
      };
    });
  }

  reset() {
    this.#pending.forEach(entry => entry.reject(new Error("Opus decoder reset")));
    this.#pending = [];
    this.#expectedSampleRate = null;
    this.#expectedChannels = null;
    if (this.#decoder) {
      const decoder = this.#decoder;
      this.#decoder = null;
      void decoder.flush().catch(() => undefined);
      decoder.close();
    }
  }

  async #ensureDecoder(sampleRate: number, channelCount: number) {
    if (
      this.#decoder &&
      this.#expectedSampleRate === sampleRate &&
      this.#expectedChannels === channelCount
    ) {
      return;
    }

    this.reset();
    assertWebCodecsSupport();

    const decoder = new AudioDecoder({
      output: audioData => {
        const frames = audioData.numberOfFrames;
        const channelCount = audioData.numberOfChannels;
        const channels: Float32Array[] = [];
        let planar = true;
        for (let channel = 0; channel < channelCount; channel += 1) {
          const channelData = new Float32Array(frames);
          try {
            audioData.copyTo(channelData, { planeIndex: channel });
            channels.push(channelData);
          } catch (error) {
            planar = false;
            break;
          }
        }

        if (!planar) {
          const interleaved = new Float32Array(frames * channelCount);
          audioData.copyTo(interleaved, { planeIndex: 0 });
          const separated = deinterleaveChannels(interleaved, channelCount);
          channels.splice(0, channels.length, ...separated);
        }

        const result: DecodedPacket = {
          channels,
          sampleRate: audioData.sampleRate,
          frameCount: frames,
          sequence: 0,
          timestampUs: audioData.timestamp ?? 0,
        };
        audioData.close();
        const entry = this.#pending.shift();
        if (entry) {
          entry.resolve(result);
        }
      },
      error: error => {
        const err = error instanceof Error ? error : new Error(String(error));
        const entry = this.#pending.shift();
        if (entry) {
          entry.reject(err);
        }
        this.reset();
      },
    });

    const config = {
      codec: "opus",
      sampleRate,
      numberOfChannels: channelCount,
    };

    if (typeof AudioDecoder.isConfigSupported === "function") {
      const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
      if (!support || !support.supported || !support.config) {
        decoder.close();
        throw new Error("Opus decoder configuration unsupported");
      }
      decoder.configure(support.config);
    } else {
      decoder.configure(config);
    }

    this.#decoder = decoder;
    this.#expectedSampleRate = sampleRate;
    this.#expectedChannels = channelCount;
  }
}

export function interleaveChannels(frame: Float32Array[]): Float32Array {
  const channels = frame.length;
  if (channels === 0) {
    return new Float32Array(0);
  }
  const first = frame[0];
  if (!first) {
    return new Float32Array(0);
  }
  const frames = first.length;
  const interleaved = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = frame[channel];
      interleaved[i * channels + channel] = channelData ? channelData[i] ?? 0 : 0;
    }
  }
  return interleaved;
}

export function deinterleaveChannels(data: Float32Array, channels: number): Float32Array[] {
  if (channels <= 0) {
    return [];
  }
  const frames = Math.floor(data.length / channels);
  const result: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const channelData = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const value = data[frame * channels + channel] ?? 0;
      channelData[frame] = value;
    }
    result.push(channelData);
  }
  return result;
}

export function createOpusPacketEncoder(options?: OpusEncoderOptions): OpusPacketEncoder {
  return new OpusPacketEncoder(options);
}

export function createOpusPacketDecoder(): OpusPacketDecoder {
  return new OpusPacketDecoder();
}

export function getHeaderBytes(): number {
  return HEADER_BYTES;
}

export function getOpusFrameSize(): number {
  return DEFAULT_FRAME_SIZE;
}
