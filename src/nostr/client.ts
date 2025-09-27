import { EventStore } from "applesauce-core";
import { createAddressLoader } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";

// Hard coded default relays (bad)
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];

// Create relay pool and event store
const pool = new RelayPool();
const eventStore = new EventStore();

// Create address loader for replaceable events
const addressLoader = createAddressLoader(pool, {
  eventStore,
  lookupRelays: DEFAULT_RELAYS,
});

// Attach loaders to event store for loading missing events
eventStore.addressableLoader = addressLoader;
eventStore.replaceableLoader = addressLoader;

export { eventStore, pool };
