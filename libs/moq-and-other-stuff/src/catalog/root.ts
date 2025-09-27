import type * as Moq from "@kixelated/moq";
import { z } from "zod";

import { AudioSchema } from "./audio";

// Accept only the audio catalog we care about while tolerating extra properties
// sent by other producers (Hang, etc.).
export const RootSchema = z
	.object({
		audio: z.array(AudioSchema).optional(),
	})
	.passthrough();

export type Root = z.infer<typeof RootSchema>;

export function encode(root: Root): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(JSON.stringify(root));
}

export function decode(raw: Uint8Array): Root {
	const decoder = new TextDecoder();
	const str = decoder.decode(raw);
	try {
		const json = JSON.parse(str);
		return RootSchema.parse(json);
	} catch (error) {
		console.warn("invalid catalog", str);
		throw error;
	}
}

export async function fetch(track: Moq.Track): Promise<Root | undefined> {
	const frame = await track.readFrame();
	if (!frame) return undefined;
	return decode(frame);
}
