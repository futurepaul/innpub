import { EventStore } from "applesauce-core";
import { createAddressLoader } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];

const pool = new RelayPool();
const eventStore = new EventStore();

const addressLoader = createAddressLoader(pool, {
  eventStore,
  lookupRelays: DEFAULT_RELAYS,
});

eventStore.addressableLoader = addressLoader;
eventStore.replaceableLoader = addressLoader;

export { eventStore, pool };
