import * as Moq from "@kixelated/moq";
import { Effect, Signal } from "@kixelated/signals";
import * as Catalog from "../../catalog";
import CaptureWorklet from "./capture-worklet?worker&url";
import type { Request, Result } from "./speaking-worker";
import type { Source } from "./types";

export type SpeakingProps = {
	enabled?: boolean | Signal<boolean>;
	threshold?: number | Signal<number>;
	releaseMs?: number | Signal<number>;
};

// Detects when the user is speaking.
export class Speaking {
	static readonly TRACK = "audio/speaking.bool";
	source: Signal<Source | undefined>;

	enabled: Signal<boolean>;
	threshold: Signal<number>;
	releaseMs: Signal<number>;

	active = new Signal<boolean>(false);
	catalog = new Signal<Catalog.Speaking | undefined>(undefined);

	signals = new Effect();

	constructor(source: Signal<Source | undefined>, props?: SpeakingProps) {
		this.source = source;
		this.enabled = Signal.from(props?.enabled ?? false);
		// Simple RMS heuristic for "is speaking". Future work: swap in ML-based VAD
		// or expose calibration UI if we need richer confidence levels.
		this.threshold = Signal.from(props?.threshold ?? 0.015);
		this.releaseMs = Signal.from(props?.releaseMs ?? 250);
		this.signals.effect(this.#runCatalog.bind(this));
	}

	#runCatalog(effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		const catalog: Catalog.Speaking = {
			track: Speaking.TRACK,
		};
		effect.set(this.catalog, catalog);
	}

	serve(track: Moq.Track, effect: Effect): void {
		const enabled = effect.get(this.enabled);
		if (!enabled) return;

		const source = effect.get(this.source);
		if (!source) return;

		// Create a nested effect to avoid recreating the track every time the speaking changes.
		effect.effect((nested) => {
			const active = nested.get(this.active);
			track.writeBool(active);
		});

		const worker = new Worker(new URL("./speaking-worker", import.meta.url), { type: "module" });
		effect.cleanup(() => worker.terminate());

		// Handle messages from the worker
		worker.onmessage = ({ data }: MessageEvent<Result>) => {
			if (data.type === "speaking") {
				this.active.set(data.speaking);
			}
		};

		effect.cleanup(() => {
			worker.onmessage = null;
			this.active.set(false);
		});

		const ctx = new AudioContext({
			latencyHint: "interactive",
			sampleRate: 16000,
		});
		effect.cleanup(() => ctx.close());

		// Create the source node.
		const root = new MediaStreamAudioSourceNode(ctx, {
			mediaStream: new MediaStream([source]),
		});
		effect.cleanup(() => root.disconnect());

		// The workload needs to be loaded asynchronously, unfortunately, but it should be instant.
		effect.spawn(async () => {
			await ctx.audioWorklet.addModule(CaptureWorklet);

			// Create the worklet.
			const worklet = new AudioWorkletNode(ctx, "capture", {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 1,
				channelCountMode: "explicit",
				channelInterpretation: "discrete",
			});
			effect.cleanup(() => worklet.disconnect());

			root.connect(worklet);

			const init: Request = {
				type: "init",
				worklet: worklet.port,
				sampleRate: ctx.sampleRate,
				threshold: this.threshold.peek(),
				releaseMs: this.releaseMs.peek(),
			};
			worker.postMessage(init, [init.worklet]);
		});
	}

	close() {
		this.signals.close();
	}
}
