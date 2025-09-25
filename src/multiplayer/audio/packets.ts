const VERSION = 1;
const HEADER_BYTES = 16;

export interface EncodedPacket {
  buffer: Uint8Array;
  frameCount: number;
}

export interface DecodedPacket {
  channels: Float32Array[];
  sampleRate: number;
  frameCount: number;
}

export function encodePacket(channels: Float32Array[], sampleRate: number): EncodedPacket | undefined {
  if (channels.length === 0) return undefined;
  const frameCount = channels[0].length;
  if (frameCount === 0) return undefined;

  const channelCount = channels.length;
  const capacity = HEADER_BYTES + frameCount * channelCount * 4;
  const arrayBuffer = new ArrayBuffer(capacity);
  const view = new DataView(arrayBuffer);

  view.setUint8(0, VERSION);
  view.setUint8(1, channelCount);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, frameCount, true);

  const data = new Float32Array(arrayBuffer, HEADER_BYTES, frameCount * channelCount);
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const source = channels[channelIndex];
    if (source.length !== frameCount) return undefined;
    data.set(source, channelIndex * frameCount);
  }

  return {
    buffer: new Uint8Array(arrayBuffer),
    frameCount,
  };
}

export function decodePacket(payload: Uint8Array): DecodedPacket | undefined {
  if (payload.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) return undefined;

  const channelCount = view.getUint8(1);
  const sampleRate = view.getUint32(4, true);
  const frameCount = view.getUint32(8, true);

  const expected = HEADER_BYTES + channelCount * frameCount * 4;
  if (payload.byteLength !== expected) return undefined;

  const dataOffset = payload.byteOffset + HEADER_BYTES;
  const needsCopy = dataOffset % 4 !== 0;
  const sampleSource = needsCopy ? payload.slice(HEADER_BYTES) : payload;
  const sampleOffset = needsCopy ? sampleSource.byteOffset : dataOffset;
  const data = new Float32Array(sampleSource.buffer, sampleOffset, channelCount * frameCount);
  const channels: Float32Array[] = [];

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const start = channelIndex * frameCount;
    const slice = data.subarray(start, start + frameCount);
    channels.push(new Float32Array(slice));
  }

  return {
    channels,
    sampleRate,
    frameCount,
  };
}
