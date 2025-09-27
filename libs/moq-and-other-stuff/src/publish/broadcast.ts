import * as Moq from "@kixelated/moq";
import { Effect, Signal } from "@kixelated/signals";

import * as Catalog from "../catalog";
import * as Audio from "./audio";

export type BroadcastProps = {
  connection?: Moq.Connection.Established | Signal<Moq.Connection.Established | undefined>;
  enabled?: boolean | Signal<boolean>;
  path?: Moq.Path.Valid | Signal<Moq.Path.Valid | undefined>;
  audio?: Audio.EncoderProps;
};

export class Broadcast {
  static readonly CATALOG_TRACK = "catalog.json";

  connection: Signal<Moq.Connection.Established | undefined>;
  enabled: Signal<boolean>;
  path: Signal<Moq.Path.Valid | undefined>;

  audio: Audio.Encoder;

  #signals = new Effect();

  constructor(props?: BroadcastProps) {
    this.connection = Signal.from(props?.connection);
    this.enabled = Signal.from(props?.enabled ?? false);
    this.path = Signal.from(props?.path);

    this.audio = new Audio.Encoder(props?.audio);

    this.#signals.effect(this.#run.bind(this));
  }

  #run(effect: Effect) {
    const enabled = effect.get(this.enabled);
    if (!enabled) return;

    const connection = effect.get(this.connection);
    if (!connection) return;

    const path = effect.get(this.path);
    if (!path) return;

    const broadcast = new Moq.Broadcast();
    effect.cleanup(() => broadcast.close());

    connection.publish(path, broadcast);
    effect.spawn(this.#runBroadcast.bind(this, broadcast, effect));
  }

  async #runBroadcast(broadcast: Moq.Broadcast, effect: Effect) {
    for (;;) {
      const request = await broadcast.requested();
      if (!request) break;

      effect.cleanup(() => request.track.close());

      effect.effect(inner => {
        if (inner.get(request.track.state.closed)) {
          return;
        }

        switch (request.track.name) {
          case Broadcast.CATALOG_TRACK: {
            this.#serveCatalog(request.track, inner);
            break;
          }
          case Audio.Encoder.TRACK: {
            this.audio.serve(request.track, inner);
            break;
          }
          case Audio.Speaking.TRACK: {
            this.audio.speaking.serve(request.track, inner);
            break;
          }
          default: {
            console.warn("received subscription for unknown track", request.track.name);
            request.track.close(new Error(`Unknown track: ${request.track.name}`));
            break;
          }
        }
      });
    }
  }

  #serveCatalog(track: Moq.Track, effect: Effect): void {
    if (!effect.get(this.enabled)) {
      track.writeFrame(Catalog.encode({}));
      return;
    }

    const audio = effect.get(this.audio.catalog);

    const root: Catalog.Root = {
      audio: audio ? [audio] : undefined,
    };
    const encoded = Catalog.encode(root);
    track.writeFrame(encoded);
  }

  close() {
    this.#signals.close();
    this.audio.close();
  }
}
