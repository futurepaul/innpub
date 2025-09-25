import * as Moq from "@kixelated/moq";

export const RELAY_URL = "https://moq.justinmoon.com/anon";
export const PLAYERS_PREFIX = Moq.Path.from("innpub", "players");
export const STATE_TRACK = "state.json";
export const AUDIO_TRACK = "audio.pcm";
export const SPEAKING_TRACK = "speaking.json";
export const ROOMS_TRACK = "rooms.json";

export type MoqConnection = Moq.Connection.Established;

type ConnectionListener = (connection: MoqConnection) => void;
type DisconnectListener = () => void;

declare global {
  interface Window {
    __innpubMoqDebug?: {
      getConnection: () => MoqConnection | null;
    };
  }
}

let currentConnection: MoqConnection | null = null;
let connectPromise: Promise<MoqConnection> | null = null;
let shuttingDown = false;

const connectListeners = new Set<ConnectionListener>();
const disconnectListeners = new Set<DisconnectListener>();

function exposeDebugHandle() {
  if (typeof window === "undefined") {
    return;
  }
  if (window.__innpubMoqDebug) {
    return;
  }
  window.__innpubMoqDebug = {
    getConnection: () => currentConnection,
  };
}

async function establish(): Promise<MoqConnection> {
  const connection = await Moq.Connection.connect(new URL(RELAY_URL), { websocket: { enabled: false } });
  currentConnection = connection;
  exposeDebugHandle();

  for (const listener of connectListeners) {
    try {
      listener(connection);
    } catch (error) {
      console.error("moq connection listener failed", error);
    }
  }

  void connection.closed
    .catch(() => undefined)
    .finally(() => {
      if (currentConnection === connection) {
        currentConnection = null;
        for (const listener of disconnectListeners) {
          try {
            listener();
          } catch (error) {
            console.error("moq disconnect listener failed", error);
          }
        }
        const shouldReconnect = !shuttingDown;
        connectPromise = null;
        if (shouldReconnect) {
          void ensureConnection().catch(error => {
            console.error("failed to reconnect to moq", error);
          });
        }
      }
    });

  return connection;
}

export async function ensureConnection(): Promise<MoqConnection> {
  if (currentConnection) {
    return currentConnection;
  }
  if (!connectPromise) {
    shuttingDown = false;
    connectPromise = establish().catch(error => {
      connectPromise = null;
      throw error;
    });
  }
  return connectPromise;
}

export function getConnection(): MoqConnection | null {
  return currentConnection;
}

export function onConnection(listener: ConnectionListener): () => void {
  connectListeners.add(listener);
  if (currentConnection) {
    try {
      listener(currentConnection);
    } catch (error) {
      console.error("moq connection listener failed", error);
    }
  }
  return () => connectListeners.delete(listener);
}

export function onDisconnect(listener: DisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => disconnectListeners.delete(listener);
}

export async function shutdownConnection(): Promise<void> {
  shuttingDown = true;
  const connection = currentConnection;
  currentConnection = null;
  connectPromise = null;
  try {
    connection?.close();
  } catch (error) {
    console.warn("failed to close moq connection", error);
  }
  for (const listener of disconnectListeners) {
    try {
      listener();
    } catch (error) {
      console.error("moq disconnect listener failed", error);
    }
  }
}
