import type { AudioFrame } from "./capture";

export type Request = Init;

export interface Init {
  type: "init";
  worklet: MessagePort;
  sampleRate?: number;
  threshold?: number;
  releaseMs?: number;
}

export type Result = Speaking;

export interface Speaking {
  type: "speaking";
  speaking: boolean;
  rms: number;
}

const DEFAULT_THRESHOLD = 0.015; // Tuned by ear; tweak if we move to UI-driven calibration.
const DEFAULT_RELEASE_MS = 250; // Require ~250ms of quiet before dropping to "not speaking".

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const message = event.data;
  if (message.type !== "init") {
    return;
  }

  const sampleRate = message.sampleRate ?? 16000;
  const threshold = message.threshold ?? DEFAULT_THRESHOLD;
  const releaseSamples = Math.max(
    1,
    Math.round(((message.releaseMs ?? DEFAULT_RELEASE_MS) / 1000) * sampleRate),
  );

  let speaking = false;
  let quietSamples = releaseSamples;

  message.worklet.onmessage = ({ data }: MessageEvent<AudioFrame>) => {
    const primary = data.channels[0];
    if (!primary || primary.length === 0) {
      return;
    }

    let sumSquares = 0;
    for (let i = 0; i < primary.length; i += 1) {
      const sample = primary[i];
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / primary.length);

    if (rms >= threshold) {
      quietSamples = 0;
      if (!speaking) {
        speaking = true;
        postResult({ type: "speaking", speaking: true, rms });
      }
      return;
    }

    quietSamples += primary.length;
    if (speaking && quietSamples >= releaseSamples) {
      speaking = false;
      postResult({ type: "speaking", speaking: false, rms });
    }
  };
});

function postResult(msg: Result) {
  self.postMessage(msg);
}
