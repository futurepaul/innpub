import * as Moq from "@kixelated/moq";
import { getProfilePicture, type ProfileContent } from "applesauce-core/helpers";
import { decode as decodeNip19 } from "nostr-tools/nip19";

import { DEFAULT_RELAYS, eventStore } from "../nostr/client";
import {
  ensureConnection,
  getConnection,
  onConnection,
  onDisconnect,
  shutdownConnection,
  PLAYERS_PREFIX,
  STATE_TRACK,
} from "./moqConnection";

export type FacingDirection = 0 | 1 | 2 | 3;

export interface PlayerState {
  npub: string;
  x: number;
  y: number;
  facing: FacingDirection;
  room?: string;
}

export interface PlayerProfile {
  npub: string;
  profile?: ProfileContent;
}

type PlayerListener = (state: PlayerState[]) => void;
type ProfileListener = (profiles: Map<string, PlayerProfile>) => void;

interface RemoteSubscription {
  path: Moq.Path.Valid;
  track: Moq.Track;
  sourceKey: string;
  lastSeen: number;
}

interface LocalSession {
  npub: string;
  broadcastPath: Moq.Path.Valid;
  broadcast: Moq.Broadcast;
}

const listeners = new Set<PlayerListener>();
const profileListeners = new Set<ProfileListener>();

const players = new Map<string, PlayerState>();
const stateBySource = new Map<string, PlayerState>();
const sourcesByNpub = new Map<string, Set<string>>();
const profiles = new Map<string, PlayerProfile>();
const profileSubscriptions = new Map<string, { unsubscribe: () => void }>();

const remoteSubscriptions = new Map<string, RemoteSubscription>();
const stateSubscribers = new Set<Moq.Track>();

let started = false;
let pruneTimerId: ReturnType<typeof setInterval> | null = null;
let announcementAbort: AbortController | null = null;
let removeConnectionListener: (() => void) | null = null;
let removeDisconnectListener: (() => void) | null = null;

let localSession: LocalSession | null = null;
let localState: PlayerState | null = null;
let pendingLocalIdentity: string | null = null;
let lastSentState: PlayerState | null = null;
let lastSentAt = 0;

const LOCAL_SOURCE_KEY = "local";
const HEARTBEAT_INTERVAL_MS = 1000;
const STALE_TIMEOUT_MS = 5000;
const EPSILON = 0.25;
const TAB_SUFFIX = Math.random().toString(36).slice(2, 8);

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function stateChanged(a: PlayerState | null, b: PlayerState): boolean {
  if (!a) return true;
  if (a.npub !== b.npub) return true;
  if (Math.abs(a.x - b.x) > EPSILON) return true;
  if (Math.abs(a.y - b.y) > EPSILON) return true;
  if (a.facing !== b.facing) return true;
  if ((a.room ?? "") !== (b.room ?? "")) return true;
  return false;
}

function addSourceState(sourceKey: string, state: PlayerState) {
  const previous = stateBySource.get(sourceKey);
  if (previous && previous.npub !== state.npub) {
    const prevSources = sourcesByNpub.get(previous.npub);
    if (prevSources) {
      prevSources.delete(sourceKey);
      if (prevSources.size === 0) {
        sourcesByNpub.delete(previous.npub);
        players.delete(previous.npub);
        cleanupProfileIfOrphan(previous.npub);
      } else {
        const fallbackKey = prevSources.values().next().value;
        const fallbackState = stateBySource.get(fallbackKey);
        if (fallbackState) {
          players.set(previous.npub, fallbackState);
        } else {
          players.delete(previous.npub);
          cleanupProfileIfOrphan(previous.npub);
        }
      }
    }
  }

  stateBySource.set(sourceKey, state);
  let bucket = sourcesByNpub.get(state.npub);
  if (!bucket) {
    bucket = new Set<string>();
    sourcesByNpub.set(state.npub, bucket);
  }
  bucket.add(sourceKey);
  players.set(state.npub, state);
  trackProfile(state.npub);
  notifyPlayers();
}

function removeSource(sourceKey: string) {
  const existing = stateBySource.get(sourceKey);
  if (!existing) {
    return;
  }

  stateBySource.delete(sourceKey);
  const bucket = sourcesByNpub.get(existing.npub);
  if (bucket) {
    bucket.delete(sourceKey);
    if (bucket.size === 0) {
      sourcesByNpub.delete(existing.npub);
      players.delete(existing.npub);
      cleanupProfileIfOrphan(existing.npub);
    } else {
      const fallbackKey = bucket.values().next().value;
      const fallbackState = stateBySource.get(fallbackKey);
      if (fallbackState) {
        players.set(existing.npub, fallbackState);
      } else {
        players.delete(existing.npub);
        cleanupProfileIfOrphan(existing.npub);
      }
    }
  } else {
    players.delete(existing.npub);
    cleanupProfileIfOrphan(existing.npub);
  }

  notifyPlayers();
}

function clearRemoteSources() {
  const keys = [...stateBySource.keys()].filter(key => key.startsWith("remote:"));
  for (const key of keys) {
    removeSource(key);
  }
}

function notifyPlayers() {
  const snapshot = Array.from(players.values());
  for (const listener of listeners) {
    listener(snapshot);
  }
}

function notifyProfiles() {
  for (const listener of profileListeners) {
    listener(profiles);
  }
}

function trackProfile(npub: string) {
  if (profileSubscriptions.has(npub)) {
    return;
  }

  const hexPubkey = normalizeIdentifier(npub);

  const subscription = eventStore
    .profile({ pubkey: hexPubkey ?? npub, relays: DEFAULT_RELAYS })
    .subscribe(profile => {
      profiles.set(npub, { npub, profile });
      notifyProfiles();
    });

  profileSubscriptions.set(npub, {
    unsubscribe: () => subscription.unsubscribe(),
  });

  if (!profiles.has(npub)) {
    profiles.set(npub, { npub });
    notifyProfiles();
  }
}

function untrackProfile(npub: string) {
  profileSubscriptions.get(npub)?.unsubscribe();
  profileSubscriptions.delete(npub);
  profiles.delete(npub);
  notifyProfiles();
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  try {
    const decoded = decodeNip19(trimmed);
    if (decoded.type === "npub" && typeof decoded.data === "string") {
      return decoded.data.toLowerCase();
    }
  } catch (error) {
    console.warn("Failed to decode npub", trimmed, error);
  }
  return trimmed;
}

function serializeState(state: PlayerState) {
  return {
    npub: state.npub,
    x: state.x,
    y: state.y,
    facing: state.facing,
    room: state.room,
    ts: Date.now(),
  };
}

function maybeBroadcastLocal(force = false) {
  if (!localState || stateSubscribers.size === 0) {
    return;
  }
  const changed = stateChanged(lastSentState, localState);
  const nowMs = now();
  if (!force && !changed && nowMs - lastSentAt < HEARTBEAT_INTERVAL_MS) {
    return;
  }

  lastSentState = { ...localState };
  lastSentAt = nowMs;
  const payload = serializeState(localState);

  for (const track of [...stateSubscribers]) {
    try {
      track.writeJson(payload);
    } catch (error) {
      console.warn("failed to write local state", error);
      stateSubscribers.delete(track);
    }
  }
}

function teardownLocalSession() {
  if (!localSession) {
    stateSubscribers.clear();
    return;
  }

  stateSubscribers.clear();
  try {
    localSession.broadcast.close();
  } catch (error) {
    console.warn("failed to close local broadcast", error);
  }
  localSession = null;
}

async function ensureLocalSession(npub: string) {
  pendingLocalIdentity = npub;

  if (localSession?.npub === npub) {
    return;
  }

  teardownLocalSession();

  try {
    const connection = await ensureConnection();
    if (pendingLocalIdentity !== npub) {
      return;
    }

    const broadcast = new Moq.Broadcast();
    const pathSuffix = Moq.Path.from(`${npub}#${TAB_SUFFIX}`);
    const broadcastPath = Moq.Path.join(PLAYERS_PREFIX, pathSuffix);

    connection.publish(broadcastPath, broadcast);

    localSession = {
      npub,
      broadcastPath,
      broadcast,
    };

    runPublishLoop(broadcast);
    if (localState) {
      maybeBroadcastLocal(true);
    }
  } catch (error) {
    console.error("failed to establish local moq session", error);
  }
}

function runPublishLoop(broadcast: Moq.Broadcast) {
  (async () => {
    for (;;) {
      const request = await broadcast.requested();
      if (!request) break;

      if (request.track.name === STATE_TRACK) {
        const track = request.track;
        stateSubscribers.add(track);
        track.closed
          .catch(() => undefined)
          .finally(() => {
            stateSubscribers.delete(track);
          });
        maybeBroadcastLocal(true);
      } else {
        request.track.close(new Error(`Unsupported track ${request.track.name}`));
      }
    }
  })().catch(error => {
    console.error("local publish loop ended", error);
  });
}

function handleConnected(connection: Moq.Connection.Established) {
  announcementAbort?.abort();
  announcementAbort = new AbortController();
  void startAnnouncementLoop(connection, announcementAbort.signal);

  if (localState) {
    void ensureLocalSession(localState.npub);
  }
}

function handleDisconnected() {
  announcementAbort?.abort();
  announcementAbort = null;

  for (const [, sub] of remoteSubscriptions) {
    try {
      sub.track.close();
    } catch {}
  }
  remoteSubscriptions.clear();
  clearRemoteSources();
  teardownLocalSession();
}

async function startAnnouncementLoop(connection: Moq.Connection.Established, signal: AbortSignal) {
  const announced = connection.announced(PLAYERS_PREFIX);

  try {
    for (;;) {
      if (signal.aborted) {
        break;
      }
      const entry = await announced.next();
      if (!entry) {
        break;
      }
      if (signal.aborted) {
        break;
      }
      if (localSession && entry.path === localSession.broadcastPath) {
        continue;
      }
      if (entry.active) {
        subscribeToRemote(entry.path);
      } else {
        unsubscribeFromRemote(entry.path);
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      console.error("announcement loop failed", error);
    }
  }
}

function subscribeToRemote(path: Moq.Path.Valid) {
  const connection = getConnection();
  if (!connection) {
    return;
  }
  if (remoteSubscriptions.has(path)) {
    return;
  }
  if (localSession && localSession.broadcastPath === path) {
    return;
  }

  const broadcast = connection.consume(path);

  let track: Moq.Track;
  try {
    track = broadcast.subscribe(STATE_TRACK, 0);
  } catch (error) {
    console.warn(`failed to subscribe to ${STATE_TRACK} for ${path}`, error);
    return;
  }

  const subscription: RemoteSubscription = {
    path,
    track,
    sourceKey: `remote:${path}`,
    lastSeen: now(),
  };
  remoteSubscriptions.set(path, subscription);

  track.closed
    .catch(() => undefined)
    .finally(() => {
      if (remoteSubscriptions.get(path) === subscription) {
        remoteSubscriptions.delete(path);
        removeSource(subscription.sourceKey);
      }
    });

  (async () => {
    for (;;) {
      const payload = await track.readJson();
      if (!payload) {
        break;
      }
      const state = parseRemoteState(payload);
      if (!state) {
        continue;
      }
      subscription.lastSeen = now();
      addSourceState(subscription.sourceKey, state);
    }
  })().catch(error => {
    console.warn(`remote subscription failed for ${path}`, error);
  });
}

function unsubscribeFromRemote(path: Moq.Path.Valid) {
  const subscription = remoteSubscriptions.get(path);
  if (!subscription) {
    return;
  }
  remoteSubscriptions.delete(path);
  try {
    subscription.track.close();
  } catch {}
  removeSource(subscription.sourceKey);
}

function parseRemoteState(payload: unknown): PlayerState | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const data = payload as Record<string, unknown>;

  const npub = normalizeIdentifier(data.npub);
  if (!npub) {
    return null;
  }

  const xRaw = data.x;
  const yRaw = data.y;
  const facingRaw = data.facing;

  if (typeof xRaw !== "number" || typeof yRaw !== "number") {
    return null;
  }

  let facing: FacingDirection = 1;
  if (typeof facingRaw === "number" && facingRaw >= 0 && facingRaw <= 3) {
    facing = Math.floor(facingRaw) as FacingDirection;
  }

  const room = typeof data.room === "string" ? data.room : undefined;

  return {
    npub,
    x: xRaw,
    y: yRaw,
    facing,
    room,
  };
}

function pruneRemoteSubscriptions() {
  const threshold = now() - STALE_TIMEOUT_MS;
  for (const [path, subscription] of remoteSubscriptions) {
    if (subscription.lastSeen < threshold) {
      unsubscribeFromRemote(path);
    }
  }
}

function cleanupProfileIfOrphan(npub: string) {
  if (sourcesByNpub.has(npub)) {
    return;
  }
  if (localState?.npub === npub) {
    return;
  }
  untrackProfile(npub);
}

function startPruneTimer() {
  if (pruneTimerId !== null) {
    return;
  }
  const scheduler = typeof window !== "undefined" && window.setInterval ? window.setInterval.bind(window) : setInterval;
  pruneTimerId = scheduler(pruneRemoteSubscriptions, 1000);
}

function stopPruneTimer() {
  if (pruneTimerId !== null) {
    const clearer = typeof window !== "undefined" && window.clearInterval ? window.clearInterval.bind(window) : clearInterval;
    clearer(pruneTimerId);
    pruneTimerId = null;
  }
}

export function subscribe(callback: PlayerListener) {
  listeners.add(callback);
  callback(Array.from(players.values()));
  return () => {
    listeners.delete(callback);
  };
}

export function subscribeProfiles(callback: ProfileListener) {
  profileListeners.add(callback);
  callback(profiles);
  return () => {
    profileListeners.delete(callback);
  };
}

export function startStream() {
  if (started) {
    return;
  }
  started = true;

  removeConnectionListener = onConnection(handleConnected);
  removeDisconnectListener = onDisconnect(handleDisconnected);

  startPruneTimer();
  void ensureConnection().catch(error => {
    console.error("failed to connect to moq", error);
  });
}

export function stopStream() {
  if (!started) {
    return;
  }
  started = false;

  stopPruneTimer();

  removeConnectionListener?.();
  removeConnectionListener = null;
  removeDisconnectListener?.();
  removeDisconnectListener = null;

  handleDisconnected();
  void shutdownConnection();
}

export function updateLocalPlayer(state: PlayerState) {
  const normalized = normalizeIdentifier(state.npub) ?? state.npub;
  localState = { ...state, npub: normalized };
  addSourceState(LOCAL_SOURCE_KEY, localState);
  void ensureLocalSession(normalized);
  maybeBroadcastLocal();
}

export function removePlayer(npub: string) {
  if (localSession && localSession.npub === npub) {
    teardownLocalSession();
  }

  const wasLocal = localState?.npub === npub;
  if (wasLocal) {
    localState = null;
    lastSentState = null;
    lastSentAt = 0;
    pendingLocalIdentity = null;
    removeSource(LOCAL_SOURCE_KEY);
  }

  untrackProfile(npub);
}

export function getProfilePictureUrl(npub: string): string | undefined {
  const profile = profiles.get(npub)?.profile;
  return profile ? getProfilePicture(profile) ?? undefined : undefined;
}
