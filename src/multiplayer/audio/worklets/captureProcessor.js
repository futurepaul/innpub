/* eslint-disable no-undef */
class InnpubCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelCount = input.length;
    if (channelCount === 0) {
      return true;
    }

    const frameCount = input[0].length;
    if (frameCount === 0) {
      return true;
    }

    const channels = new Array(channelCount);
    let total = 0;
    let sampleCount = 0;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = input[channelIndex];
      const copy = new Float32Array(frameCount);
      copy.set(channel);
      channels[channelIndex] = copy;
      for (let frame = 0; frame < frameCount; frame += 1) {
        const sample = channel[frame];
        total += sample * sample;
        sampleCount += 1;
      }
    }

    const rms = sampleCount > 0 ? Math.sqrt(total / sampleCount) : 0;

    this.port.postMessage(
      {
        type: "samples",
        channels,
        level: rms,
        sampleRate,
      },
      channels.map(channel => channel.buffer),
    );

    return true;
  }
}

registerProcessor("innpub-capture-processor", InnpubCaptureProcessor);
