class InnpubCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.monitor = false;
    this.synthetic = false;
    this.frequency = 440;
    this.amplitude = 0.25;
    this.phase = 0;
    this.port.onmessage = event => {
      const data = event.data;
      if (!data || typeof data !== "object") {
        return;
      }
      if (data.type === "setConfig") {
        if (typeof data.synthetic === "boolean") {
          this.synthetic = data.synthetic;
        }
        if (typeof data.monitor === "boolean") {
          this.monitor = data.monitor;
        }
        if (typeof data.frequency === "number") {
          this.frequency = data.frequency;
        }
        if (typeof data.amplitude === "number") {
          this.amplitude = Math.max(0, Math.min(1, data.amplitude));
        }
      }
    };
  }

  process(inputs) {
    const channelBuffers = [];
    const sr = sampleRate;
    let rms = 0;

    if (this.synthetic) {
      const frameCount = 960;
      const buffer = new Float32Array(frameCount);
      const omega = (2 * Math.PI * this.frequency) / sr;
      let sumSquares = 0;

      for (let i = 0; i < frameCount; i += 1) {
        const sample = Math.sin(this.phase) * this.amplitude;
        buffer[i] = sample;
        this.phase += omega;
        if (this.phase >= 2 * Math.PI) {
          this.phase -= 2 * Math.PI;
        }
        sumSquares += sample * sample;
      }

      channelBuffers.push(buffer);
      rms = Math.sqrt(sumSquares / frameCount);

      this.port.postMessage(
        {
          type: "samples",
          channels: channelBuffers,
          level: rms,
          sampleRate: sr,
        },
        channelBuffers.map(channel => channel.buffer),
      );
      return true;
    }

    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    if (channelCount === 0) {
      return true;
    }

    const frameCount = input[0]?.length ?? 0;
    if (frameCount === 0) {
      return true;
    }

    let total = 0;
    let sampleCount = 0;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = input[channelIndex];
      const copy = new Float32Array(frameCount);
      copy.set(channel);
      channelBuffers.push(copy);

      for (let frame = 0; frame < frameCount; frame += 1) {
        const sample = channel[frame];
        total += sample * sample;
        sampleCount += 1;
      }
    }

    rms = sampleCount > 0 ? Math.sqrt(total / sampleCount) : 0;

    this.port.postMessage(
      {
        type: "samples",
        channels: channelBuffers,
        level: rms,
        sampleRate: sr,
      },
      channelBuffers.map(channel => channel.buffer),
    );

    return true;
  }
}

registerProcessor("innpub-capture-processor", InnpubCaptureProcessor);

export {};
