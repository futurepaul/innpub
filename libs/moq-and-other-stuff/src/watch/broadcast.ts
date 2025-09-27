import * as Moq from "@kixelated/moq";
import { Effect, type Getter, Signal } from "@kixelated/signals";

import * as Catalog from "../catalog";
import * as Audio from "./audio";
import { PRIORITY } from "./priority";

export interface BroadcastProps {
  connection?: Moq.Connection.Established | Signal<Moq.Connection.Established | undefined>;
  enabled?: boolean | Signal<boolean>;
  path?: Moq.Path.Valid | Signal<Moq.Path.Valid | undefined>;
  reload?: boolean | Signal<boolean>;
  audio?: Audio.SourceProps;
}

export class Broadcast {
  connection: Signal<Moq.Connection.Established | undefined>;

  enabled: Signal<boolean>;
  path: Signal<Moq.Path.Valid | undefined>;
  status = new Signal<"offline" | "loading" | "live">("offline");
  reload: Signal<boolean>;

  audio: Audio.Source;

  #broadcast = new Signal<Moq.Broadcast | undefined>(undefined);
  #catalog = new Signal<Catalog.Root | undefined>(undefined);
  readonly catalog: Getter<Catalog.Root | undefined> = this.#catalog;

  #active = new Signal(false);
  readonly active: Getter<boolean> = this.#active;

  #signals = new Effect();

  constructor(props?: BroadcastProps) {
    this.connection = Signal.from(props?.connection);
    this.path = Signal.from(props?.path);
    this.enabled = Signal.from(props?.enabled ?? false);
    this.reload = Signal.from(props?.reload ?? true);
    this.audio = new Audio.Source(this.#broadcast, this.#catalog, props?.audio);

    this.#signals.effect(this.#runReload.bind(this));
    this.#signals.effect(this.#runBroadcast.bind(this));
    this.#signals.effect(this.#runCatalog.bind(this));
  }

  #runReload(effect: Effect): void {
    const enabled = effect.get(this.enabled);
    if (!enabled) return;

    const reload = effect.get(this.reload);
    if (!reload) {
      effect.set(this.#active, true, false);
      return;
    }

    const conn = effect.get(this.connection);
    if (!conn) return;

    const path = effect.get(this.path);
    if (!path) return;

    const announced = conn.announced(path);
    effect.cleanup(() => announced.close());

    effect.spawn(async () => {
      for (;;) {
        const update = await announced.next();
        if (!update) break;

        if (update.path !== path) {
          continue;
        }

        effect.set(this.#active, update.active, false);
      }
    });
  }

  #runBroadcast(effect: Effect): void {
    const conn = effect.get(this.connection);
    const enabled = effect.get(this.enabled);
    const path = effect.get(this.path);
    const active = effect.get(this.#active);
    if (!conn || !enabled || !path || !active) return;

    const broadcast = conn.consume(path);
    effect.cleanup(() => broadcast.close());

    effect.set(this.#broadcast, broadcast);
  }

  #runCatalog(effect: Effect): void {
    if (!effect.get(this.enabled)) return;

    const broadcast = effect.get(this.#broadcast);
    if (!broadcast) return;

    this.status.set("loading");

    const catalog = broadcast.subscribe("catalog.json", PRIORITY.catalog);
    effect.cleanup(() => catalog.close());

    effect.spawn(this.#fetchCatalog.bind(this, catalog));
  }

  async #fetchCatalog(catalog: Moq.Track): Promise<void> {
    try {
      for (;;) {
        const update = await Catalog.fetch(catalog);
        if (!update) break;

        this.#catalog.set(update);
        this.status.set("live");
      }
    } catch (err) {
      console.warn("error fetching catalog", this.path.peek(), err);
    } finally {
      this.#catalog.set(undefined);
      this.status.set("offline");
    }
  }

  close() {
    this.#signals.close();
    this.audio.close();
  }
}
