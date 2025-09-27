import * as Hang from "@kixelated/hang";
import { Room as HangRoom } from "@kixelated/hang/meet";
import { Signal } from "@kixelated/signals";
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
  ROOMS_TRACK,
  CHAT_TRACK,
} from "./moqConnection";

export type FacingDirection = 0 | 1 | 2 | 3;

export interface PlayerState {
  npub: string;
  x: number;
  y: number;
  facing: FacingDirection;
  rooms?: string[];
  speakingLevel?: number;
}

export interface PlayerProfile {
  npub: string;
  profile?: ProfileContent;
}

export interface ChatMessage {
  id: string;
  npub: string;
  message: string;
  ts: number;
  expiresAt: number;
}

type PlayerListener = (state: PlayerState[]) => void;
type ProfileListener = (profiles: Map<string, PlayerProfile>) => void;
type AudioStateListener = (state: AudioControlState) => void;
type ChatListener = (messages: Map<string, ChatMessage>) => void;

interface RemoteSubscription {
  path: Moq.Path.Valid;
  stateTrack: Moq.Track;
  roomsTrack?: Moq.Track;
  chatTrack?: Moq.Track;
  sourceKey: string;
  lastSeen: number;
  npub?: string;
  pendingRooms?: string[];
}

interface LocalSession {
  npub: string;
  broadcastPath: Moq.Path.Valid;
  broadcast: Moq.Broadcast;
}

type RemoteAudioSession = {
  path: Moq.Path.Valid;
  room: string;
  npub?: string;
  broadcast: Hang.Watch.Broadcast;
  emitter: Hang.Watch.Audio.Emitter;
  disposeSpeaking?: () => void;
};

type RoomAudioSubscription = {
  room: string;
  prefix: Moq.Path.Valid;
  roomWatcher: HangRoom;
};

const listeners = new Set<PlayerListener>();
const profileListeners = new Set<ProfileListener>();
const audioStateListeners = new Set<AudioStateListener>();
const chatListeners = new Set<ChatListener>();

const players = new Map<string, PlayerState>();
const stateBySource = new Map<string, PlayerState>();
const sourcesByNpub = new Map<string, Set<string>>();
const profiles = new Map<string, PlayerProfile>();
const profileSubscriptions = new Map<string, { unsubscribe: () => void }>();
const speakingLevels = new Map<string, number>();
const roomsByNpub = new Map<string, string[]>();
const chatMessages = new Map<string, ChatMessage>();
let chatSessionEpoch = Date.now();
const textDecoder = new TextDecoder();

const remoteSubscriptions = new Map<string, RemoteSubscription>();
const stateSubscribers = new Set<Moq.Track>();
const roomsSubscribers = new Set<Moq.Track>();
const chatSubscribers = new Set<Moq.Track>();
const resubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const resubscribeAttempts = new Map<string, number>();
const resetErrorCounts = new Map<string, number>();

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
let micEnabled = false;
let speakerEnabled = true;
let beforeUnloadRegistered = false;
let localRooms: string[] = [];
let chatCounter = 0;

const hangConnectionSignal = new Signal<Moq.Connection.Established | undefined>(undefined);
const hangBroadcastPath = new Signal<Moq.Path.Valid | undefined>(undefined);
const hangPublishEnabled = new Signal(false);
const roomAudioSubscriptions = new Map<string, RoomAudioSubscription>();
const remoteAudioSessions = new Map<Moq.Path.Valid, RemoteAudioSession>();
const ROOM_PROTOCOL_VERSION = "v2";

const AUDIO_SESSION_SUFFIX = Math.random().toString(36).slice(2, 8);
const hangPublish =
  typeof window !== "undefined"
    ? new Hang.Publish.Broadcast({
        connection: hangConnectionSignal,
        enabled: hangPublishEnabled,
        path: hangBroadcastPath,
        audio: {
          enabled: hangPublishEnabled,
          speaking: { enabled: true },
        },
      })
    : null;

hangPublish?.audio.speaking.active.watch(active => {
  const identity = localState?.npub ?? pendingLocalIdentity ?? localSession?.npub;
  if (!identity) {
    return;
  }
  if (active === undefined) {
    setSpeakingLevel(identity, 0);
    return;
  }
  setSpeakingLevel(identity, active ? 1 : 0);
});

let hangMicrophoneTrack: MediaStreamTrack | null = null;
let micRequested = false;
let currentAudioRoom: string | null = null;

const LOCAL_SOURCE_KEY = "local";
const HEARTBEAT_INTERVAL_MS = 1000;
const STALE_TIMEOUT_MS = 5000;
const EPSILON = 0.25;
const TAB_SUFFIX = Math.random().toString(36).slice(2, 8);
const SPEAKING_THROTTLE_MS = 150;
const CHAT_TTL_MS = 7000;
const MAX_CHAT_LENGTH = 240;
const RESUBSCRIBE_BASE_DELAY_MS = 200;
const RESUBSCRIBE_MAX_DELAY_MS = 8000;
const RESUBSCRIBE_JITTER_RATIO = 0.35;
const MAX_RESUBSCRIBE_ATTEMPTS = 10;
const MAX_RESET_LOGS = 5;
export interface AudioControlState {
  micEnabled: boolean;
  speakerEnabled: boolean;
  micError: string | null;
  supported: boolean;
}

const audioSupported =
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  (typeof window.AudioContext !== "undefined" ||
    typeof (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== "undefined");

let audioState: AudioControlState = {
  micEnabled: false,
  speakerEnabled: true,
  micError: null,
  supported: audioSupported,
};

function notifyAudioState() {
  for (const listener of audioStateListeners) {
    try {
      listener(audioState);
    } catch (error) {
      console.error("audio state listener failed", error);
    }
  }
}

function setAudioState(patch: Partial<AudioControlState>) {
  audioState = { ...audioState, ...patch };
  notifyAudioState();
}

function isResetStreamError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (typeof error === "string") {
    return error.includes("RESET_STREAM");
  }
  if (error instanceof Error) {
    return error.message.includes("RESET_STREAM");
  }
  return false;
}

function logTrackSubscribeFailure(path: Moq.Path.Valid, track: string, error: unknown) {
  if (isResetStreamError(error)) {
    const key = `${path}:${track}`;
    const count = (resetErrorCounts.get(key) ?? 0) + 1;
    resetErrorCounts.set(key, count);
    if (count <= MAX_RESET_LOGS || count % 5 === 0) {
      console.debug(`${track} reset for ${path} (attempt ${count})`);
    }
  } else {
    console.warn(`failed to subscribe to ${track} for ${path}`, error);
  }
}

function ensureBeforeUnloadHook() {
  if (beforeUnloadRegistered) {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  beforeUnloadRegistered = true;
  window.addEventListener("beforeunload", () => {
    hangPublishEnabled.set(false);
    hangBroadcastPath.set(undefined);
    releaseMicrophoneTrack();
    clearRemoteAudioSessions();
  });
}

function buildAudioBroadcastPath(room: string, npub: string): Moq.Path.Valid {
  const normalizedRoom = room.trim();
  const normalizedNpub = npub.trim();
  return Moq.Path.from("innpub", "rooms", ROOM_PROTOCOL_VERSION, normalizedRoom, normalizedNpub, AUDIO_SESSION_SUFFIX);
}

function parseAudioBroadcastPath(path: Moq.Path.Valid): { room?: string; npub?: string } {
  const base = Moq.Path.from("innpub", "rooms", ROOM_PROTOCOL_VERSION);
  const suffix = Moq.Path.stripPrefix(base, path);
  if (suffix === null) {
    return {};
  }
  const segments = suffix.split("/").filter(Boolean);
  if (segments.length < 2) {
    return { room: segments[0] };
  }
  return { room: segments[0], npub: segments[1] };
}

async function ensureMicrophoneTrack(): Promise<void> {
  if (!hangPublish || !audioSupported) {
    const message = "Microphone capture is not supported in this environment";
    setAudioState({ micEnabled: false, micError: message });
    throw new Error(message);
  }

  if (hangMicrophoneTrack && hangMicrophoneTrack.readyState === "live") {
    return;
  }

  releaseMicrophoneTrack();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [track] = stream.getAudioTracks();
    if (!track) {
      throw new Error("No audio track available");
    }
    for (const extra of stream.getTracks()) {
      if (extra !== track) {
        extra.stop();
      }
    }
    hangMicrophoneTrack = track;
    track.addEventListener("ended", handleLocalTrackEnded);
    hangPublish.audio.source.set(track as Hang.Publish.Audio.Source);
    micEnabled = true;
    setAudioState({ micEnabled: true, micError: null });
  } catch (error) {
    micEnabled = false;
    const message = error instanceof Error ? error.message : "Failed to start microphone";
    setAudioState({ micEnabled: false, micError: message });
    throw error instanceof Error ? error : new Error(message);
  }
}

function handleLocalTrackEnded() {
  releaseMicrophoneTrack();
  micRequested = false;
  hangPublishEnabled.set(false);
  hangBroadcastPath.set(undefined);
  setAudioState({ micEnabled: false });
}

function releaseMicrophoneTrack() {
  if (!hangMicrophoneTrack) {
    return;
  }
  hangMicrophoneTrack.removeEventListener("ended", handleLocalTrackEnded);
  if (hangMicrophoneTrack.readyState === "live") {
    hangMicrophoneTrack.stop();
  }
  hangMicrophoneTrack = null;
  hangPublish?.audio.source.set(undefined);
  if (micEnabled) {
    micEnabled = false;
    setAudioState({ micEnabled: false });
  }
}

async function syncLocalAudioPublishState(): Promise<void> {
  if (!hangPublish) {
    return;
  }

  const identity = localState?.npub ?? pendingLocalIdentity ?? localSession?.npub;
  const room = currentAudioRoom;
  const shouldPublish = micRequested && !!identity && !!room && audioSupported;

  if (!shouldPublish) {
    hangPublishEnabled.set(false);
    hangBroadcastPath.set(undefined);
    releaseMicrophoneTrack();
    if (!micRequested) {
      setAudioState({ micEnabled: false, micError: null });
    }
    return;
  }

  const path = buildAudioBroadcastPath(room, identity);
  hangBroadcastPath.set(path);

  try {
    await ensureMicrophoneTrack();
    hangPublishEnabled.set(true);
  } catch (error) {
    hangPublishEnabled.set(false);
    hangBroadcastPath.set(undefined);
    throw error;
  }
}

function ensureRoomSubscription(room: string) {
  if (roomAudioSubscriptions.has(room)) {
    return;
  }
  const prefix = Moq.Path.from("innpub", "rooms", ROOM_PROTOCOL_VERSION, room);
  const roomWatcher = new HangRoom({ connection: hangConnectionSignal, path: prefix });
  roomWatcher.onRemote((path, broadcast) => {
    if (broadcast) {
      handleRemoteAudioAdded(room, path, broadcast);
    } else {
      handleRemoteAudioRemoved(path);
    }
  });
  roomAudioSubscriptions.set(room, { room, prefix, roomWatcher });
}

function disposeRoomSubscription(room: string) {
  const entry = roomAudioSubscriptions.get(room);
  if (!entry) {
    return;
  }
  entry.roomWatcher.onRemote(undefined);
  entry.roomWatcher.close();
  roomAudioSubscriptions.delete(room);

  for (const [path, session] of [...remoteAudioSessions.entries()]) {
    if (session.room === room) {
      handleRemoteAudioRemoved(path);
    }
  }
}

function handleRemoteAudioAdded(room: string, path: Moq.Path.Valid, broadcast: Hang.Watch.Broadcast) {
  const localPath = hangBroadcastPath.peek();
  if (localPath && localPath === path) {
    return;
  }
  if (remoteAudioSessions.has(path)) {
    return;
  }

  const { npub } = parseAudioBroadcastPath(path);
  const emitter = new Hang.Watch.Audio.Emitter(broadcast.audio, {
    muted: !speakerEnabled,
    paused: !speakerEnabled,
  });

  const session: RemoteAudioSession = {
    path,
    room,
    npub,
    broadcast,
    emitter,
  };

  session.disposeSpeaking = broadcast.audio.speaking.active.watch(active => {
    if (!npub) {
      return;
    }
    if (active === undefined) {
      clearSpeakingLevel(npub);
      return;
    }
    setSpeakingLevel(npub, active ? 1 : 0);
  });

  broadcast.enabled.set(true);
  broadcast.audio.enabled.set(speakerEnabled && localRooms.includes(room));

  remoteAudioSessions.set(path, session);
}

function handleRemoteAudioRemoved(path: Moq.Path.Valid) {
  const session = remoteAudioSessions.get(path);
  if (!session) {
    return;
  }
  remoteAudioSessions.delete(path);
  session.disposeSpeaking?.();
  session.emitter.close();
  if (session.npub) {
    clearSpeakingLevel(session.npub);
  }
}

function clearRemoteAudioSessions() {
  for (const [path] of [...remoteAudioSessions.entries()]) {
    handleRemoteAudioRemoved(path);
  }
  for (const [room] of [...roomAudioSubscriptions.keys()]) {
    disposeRoomSubscription(room);
  }
}

function updateRoomAudioSubscriptions() {
  const desired = new Set(localRooms);
  for (const room of desired) {
    ensureRoomSubscription(room);
  }
  for (const [room] of [...roomAudioSubscriptions.keys()]) {
    if (!desired.has(room)) {
      disposeRoomSubscription(room);
    }
  }
  syncRemoteAudioPlayback();
}

function syncRemoteAudioPlayback() {
  for (const session of remoteAudioSessions.values()) {
    const shouldPlay = speakerEnabled && localRooms.includes(session.room);
    session.broadcast.audio.enabled.set(shouldPlay);
    session.emitter.paused.set(!speakerEnabled || !shouldPlay);
    session.emitter.muted.set(!speakerEnabled || !shouldPlay);
  }
}

function sendRooms(track: Moq.Track) {
  try {
    track.writeJson({ rooms: localRooms, ts: Date.now() });
  } catch (error) {
    console.warn("failed to write rooms", error);
    roomsSubscribers.delete(track);
  }
}

function broadcastRoomsUpdate(): void {
  for (const track of [...roomsSubscribers]) {
    sendRooms(track);
  }
}

function broadcastChat(entry: ChatMessage): void {
  const payload = {
    npub: entry.npub,
    message: entry.message,
    ts: entry.ts,
    id: entry.id,
  };

  for (const track of [...chatSubscribers]) {
    try {
      track.writeJson(payload);
    } catch (error) {
      console.warn("failed to write chat message", error);
      chatSubscribers.delete(track);
    }
  }
}

function pruneChatMessages() {
  if (chatMessages.size === 0) {
    return;
  }
  const nowTs = Date.now();
  let mutated = false;
  for (const [npub, entry] of chatMessages) {
    if (entry.expiresAt <= nowTs) {
      chatMessages.delete(npub);
      mutated = true;
    }
  }
  if (mutated) {
    notifyChats();
  }
}

function updateAudioMix(): void {
  syncRemoteAudioPlayback();
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function stateChanged(a: PlayerState | null, b: PlayerState): boolean {
  if (!a) return true;
  if (a.npub !== b.npub) return true;
  if (Math.abs(a.x - b.x) > EPSILON) return true;
  if (Math.abs(a.y - b.y) > EPSILON) return true;
  if (a.facing !== b.facing) return true;
  if (!roomsEqual(a.rooms ?? [], b.rooms ?? [])) return true;
  return false;
}

function withSpeakingLevel(state: PlayerState): PlayerState {
  const level = speakingLevels.get(state.npub);
  if (level === undefined) {
    if (state.speakingLevel === undefined) {
      return { ...state };
    }
    return stripSpeaking(state);
  }
  if (state.speakingLevel === level) {
    return { ...state };
  }
  return { ...state, speakingLevel: level };
}

function withRooms(state: PlayerState): PlayerState {
  const rooms = roomsByNpub.get(state.npub);
  if (!rooms) {
    if (!state.rooms) {
      return state;
    }
    return stripRooms(state);
  }
  if (state.rooms && roomsEqual(state.rooms, rooms)) {
    return state;
  }
  return { ...state, rooms };
}

function stripSpeaking(state: PlayerState): PlayerState {
  const { speakingLevel: _omit, ...rest } = state;
  return { ...rest };
}

function setSpeakingLevel(npub: string, level: number) {
  const previous = speakingLevels.get(npub);
  if (previous !== undefined && Math.abs(previous - level) < 0.0001) {
    return;
  }

  speakingLevels.set(npub, level);

  const sources = sourcesByNpub.get(npub);
  if (sources) {
    for (const sourceKey of sources) {
      const existing = stateBySource.get(sourceKey);
      if (!existing) continue;
      const updated: PlayerState = { ...existing, speakingLevel: level };
      stateBySource.set(sourceKey, updated);
    }
  }

  if (localState?.npub === npub) {
    localState = { ...localState, speakingLevel: level };
  }

  const current = players.get(npub);
  if (current) {
    players.set(npub, { ...current, speakingLevel: level });
  }

  notifyPlayers();
}

function clearSpeakingLevel(npub: string) {
  if (!speakingLevels.delete(npub)) {
    return;
  }

  const sources = sourcesByNpub.get(npub);
  if (sources) {
    for (const sourceKey of sources) {
      const existing = stateBySource.get(sourceKey);
      if (!existing) continue;
      stateBySource.set(sourceKey, stripSpeaking(existing));
    }
  }

  if (localState?.npub === npub) {
    localState = stripSpeaking(localState);
  }

  const current = players.get(npub);
  if (current) {
    players.set(npub, stripSpeaking(current));
  }

  notifyPlayers();
}

function normalizeRooms(rooms: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const room of rooms) {
    if (typeof room === "string" && room.trim().length > 0) {
      unique.add(room.trim());
    }
  }
  return Array.from(unique).sort();
}

function roomsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function stripRooms(state: PlayerState): PlayerState {
  const { rooms: _omit, ...rest } = state;
  return { ...rest };
}

function setRooms(npub: string, rooms: readonly string[]): void {
  const normalized = normalizeRooms(rooms);
  const previous = roomsByNpub.get(npub);
  if (previous && roomsEqual(previous, normalized)) {
    return;
  }

  if (normalized.length > 0) {
    roomsByNpub.set(npub, normalized);
  } else {
    roomsByNpub.delete(npub);
  }

  const bucket = sourcesByNpub.get(npub);
  if (bucket) {
    for (const sourceKey of bucket) {
      const existing = stateBySource.get(sourceKey);
      if (!existing) continue;
      const updated = normalized.length > 0 ? { ...existing, rooms: normalized } : stripRooms(existing);
      stateBySource.set(sourceKey, updated);
      if (sourceKey === LOCAL_SOURCE_KEY) {
        localState = updated;
      }
    }
  }

  const current = players.get(npub);
  if (current) {
    players.set(npub, normalized.length > 0 ? { ...current, rooms: normalized } : stripRooms(current));
  }

  notifyPlayers();
  updateAudioMix();
}

function clearRooms(npub: string): void {
  if (!roomsByNpub.has(npub)) {
    return;
  }
  roomsByNpub.delete(npub);

  const bucket = sourcesByNpub.get(npub);
  if (bucket) {
    for (const sourceKey of bucket) {
      const existing = stateBySource.get(sourceKey);
      if (!existing) continue;
      const updated = stripRooms(existing);
      stateBySource.set(sourceKey, updated);
      if (sourceKey === LOCAL_SOURCE_KEY) {
        localState = updated;
      }
    }
  }

  const current = players.get(npub);
  if (current) {
    players.set(npub, stripRooms(current));
  }

  notifyPlayers();
  updateAudioMix();
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

  const enriched = withSpeakingLevel(withRooms(state));
  stateBySource.set(sourceKey, enriched);
  let bucket = sourcesByNpub.get(state.npub);
  if (!bucket) {
    bucket = new Set<string>();
    sourcesByNpub.set(state.npub, bucket);
  }
  bucket.add(sourceKey);
  players.set(state.npub, enriched);
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

function clearResubscribe(path: string): void {
  const timer = resubscribeTimers.get(path);
  if (timer) {
    const clearer = typeof window !== "undefined" && window.clearTimeout ? window.clearTimeout.bind(window) : clearTimeout;
    clearer(timer);
    resubscribeTimers.delete(path);
  }
  resubscribeAttempts.delete(path);
  clearResetErrorCounts(path);
}

function scheduleResubscribe(path: string): void {
  if (!started) {
    return;
  }
  if (remoteSubscriptions.has(path)) {
    resubscribeAttempts.delete(path);
    return;
  }
  if (resubscribeTimers.has(path)) {
    return;
  }

  const attempts = (resubscribeAttempts.get(path) ?? 0) + 1;
  if (attempts > MAX_RESUBSCRIBE_ATTEMPTS) {
    if (!resetErrorCounts.has(`${path}:drop`)) {
      resetErrorCounts.set(`${path}:drop`, attempts);
      console.warn(`giving up on resubscribing to ${path} after ${MAX_RESUBSCRIBE_ATTEMPTS} attempts`);
    }
    return;
  }
  resubscribeAttempts.set(path, attempts);

  const exponentialDelay = Math.min(RESUBSCRIBE_BASE_DELAY_MS * 2 ** (attempts - 1), RESUBSCRIBE_MAX_DELAY_MS);
  const jitter = exponentialDelay * RESUBSCRIBE_JITTER_RATIO;
  const randomOffset = jitter * (Math.random() * 2 - 1);
  const delay = Math.max(RESUBSCRIBE_BASE_DELAY_MS, Math.min(RESUBSCRIBE_MAX_DELAY_MS, exponentialDelay + randomOffset));

  const scheduler = typeof window !== "undefined" && window.setTimeout ? window.setTimeout.bind(window) : setTimeout;
  const timer = scheduler(() => {
    resubscribeTimers.delete(path);
    if (!started) {
      resubscribeAttempts.delete(path);
      return;
    }
    if (remoteSubscriptions.has(path)) {
      resubscribeAttempts.delete(path);
      return;
    }
    try {
      subscribeToRemote(path as Moq.Path.Valid);
      clearResetErrorCounts(path);
    } catch (error) {
      logSubscriptionRetry(path, error);
      scheduleResubscribe(path);
    }
  }, delay);

  resubscribeTimers.set(path, timer);
}

function logSubscriptionRetry(path: string, error: unknown) {
  if (isResetStreamError(error)) {
    const key = `${path}:retry`;
    const count = (resetErrorCounts.get(key) ?? 0) + 1;
    resetErrorCounts.set(key, count);
    if (count <= MAX_RESET_LOGS || count % 5 === 0) {
      console.debug(`resubscribe reset for ${path} (attempt ${count})`);
    }
    return;
  }
  console.warn(`failed to resubscribe to ${path}`, error);
}

function clearResetErrorCounts(prefix: string): void {
  for (const key of [...resetErrorCounts.keys()]) {
    if (key.startsWith(prefix)) {
      resetErrorCounts.delete(key);
    }
  }
}

function notifyChats() {
  const snapshot = new Map(chatMessages);
  for (const listener of chatListeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("chat listener failed", error);
    }
  }
}

function setChatEntry(entry: ChatMessage) {
  if (entry.ts < chatSessionEpoch) {
    return;
  }
  chatMessages.set(entry.npub, entry);
  notifyChats();
}

function clearChatEntry(npub: string) {
  if (chatMessages.delete(npub)) {
    notifyChats();
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
    room: state.rooms?.[0],
    rooms: state.rooms,
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
    roomsSubscribers.clear();
    return;
  }

  stateSubscribers.clear();
  roomsSubscribers.clear();
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
      } else if (request.track.name === ROOMS_TRACK) {
        const track = request.track;
        roomsSubscribers.add(track);
        track.closed
          .catch(() => undefined)
          .finally(() => {
            roomsSubscribers.delete(track);
          });
        sendRooms(track);
      } else if (request.track.name === CHAT_TRACK) {
        const track = request.track;
        chatSubscribers.add(track);
        track.closed
          .catch(() => undefined)
          .finally(() => {
            chatSubscribers.delete(track);
          });
      } else {
        request.track.close(new Error(`Unsupported track ${request.track.name}`));
      }
    }
  })().catch(error => {
    console.error("local publish loop ended", error);
  });
}

function handleConnected(connection: Moq.Connection.Established) {
  hangConnectionSignal.set(connection);
  announcementAbort?.abort();
  announcementAbort = new AbortController();
  void startAnnouncementLoop(connection, announcementAbort.signal);

  if (localState) {
    void ensureLocalSession(localState.npub);
  }
  updateRoomAudioSubscriptions();
  void syncLocalAudioPublishState().catch(() => undefined);
}

function handleDisconnected() {
  hangConnectionSignal.set(undefined);
  announcementAbort?.abort();
  announcementAbort = null;

  for (const [, sub] of remoteSubscriptions) {
    try {
      sub.stateTrack.close();
    } catch {}
    try {
      sub.roomsTrack?.close();
    } catch {}
    try {
      sub.chatTrack?.close();
    } catch {}
  }
  remoteSubscriptions.clear();
  for (const [path, timer] of resubscribeTimers) {
    const clearer = typeof window !== "undefined" && window.clearTimeout ? window.clearTimeout.bind(window) : clearTimeout;
    clearer(timer);
  }
  resubscribeTimers.clear();
  resubscribeAttempts.clear();
  stateSubscribers.clear();
  roomsSubscribers.clear();
  chatSubscribers.clear();
  clearRemoteSources();
  teardownLocalSession();
  clearRemoteAudioSessions();
  hangPublishEnabled.set(false);
  hangBroadcastPath.set(undefined);
  releaseMicrophoneTrack();
  if (chatMessages.size > 0) {
    chatMessages.clear();
    notifyChats();
  }
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

  let stateTrack: Moq.Track;
  try {
    stateTrack = broadcast.subscribe(STATE_TRACK, 0);
    clearResetErrorCounts(`${path}:${STATE_TRACK}`);
  } catch (error) {
    logTrackSubscribeFailure(path, STATE_TRACK, error);
    scheduleResubscribe(path);
    return;
  }

  const subscription: RemoteSubscription = {
    path,
    stateTrack,
    sourceKey: `remote:${path}`,
    lastSeen: now(),
  };
  clearResubscribe(path);
  clearResetErrorCounts(path);
  remoteSubscriptions.set(path, subscription);

  stateTrack.closed
    .catch(() => undefined)
    .finally(() => {
      if (remoteSubscriptions.get(path) === subscription) {
        remoteSubscriptions.delete(path);
        try {
          subscription.roomsTrack?.close();
        } catch {}
        try {
          subscription.chatTrack?.close();
        } catch {}
        removeSource(subscription.sourceKey);
        if (subscription.npub) {
          setRooms(subscription.npub, []);
        }
        scheduleResubscribe(path);
      }
    });

  const stateConsumer = new Hang.Frame.Consumer(stateTrack);
  (async () => {
    for (;;) {
      const frame = await stateConsumer.decode();
      if (!frame) break;

      let state: PlayerState | null = null;
      try {
        const payload = JSON.parse(textDecoder.decode(frame.data));
        state = parseRemoteState(payload);
      } catch (error) {
        console.warn("failed to decode remote state", error);
        continue;
      }
      if (!state) {
        continue;
      }
      if (!state) {
        continue;
      }
      if (state.npub && localState?.npub && state.npub === localState.npub) {
        unsubscribeFromRemote(path);
        return;
      }
      subscription.lastSeen = now();
      subscription.npub = state.npub;
      addSourceState(subscription.sourceKey, state);
      if (subscription.pendingRooms) {
        setRooms(state.npub, subscription.pendingRooms);
        subscription.pendingRooms = undefined;
      } else if (state.rooms && state.rooms.length > 0) {
        setRooms(state.npub, state.rooms);
      }
    }
    }
  })()
    .catch(error => {
      if (!isResetStreamError(error)) {
        console.warn(`remote subscription failed for ${path}`, error);
      } else {
        logTrackSubscribeFailure(path, STATE_TRACK, error);
      }
      scheduleResubscribe(path);
    })
    .finally(() => stateConsumer.close());

  try {
    const roomsTrack = broadcast.subscribe(ROOMS_TRACK, 0);
    clearResetErrorCounts(`${path}:${ROOMS_TRACK}`);
    subscription.roomsTrack = roomsTrack;
    roomsTrack.closed
      .catch(() => undefined)
      .finally(() => {
        if (subscription.roomsTrack === roomsTrack) {
          subscription.roomsTrack = undefined;
        }
        if (subscription.npub) {
          setRooms(subscription.npub, []);
        }
        subscription.pendingRooms = undefined;
      });

    (async () => {
      for (;;) {
        const payload = await roomsTrack.readJson();
        if (!payload) {
          break;
        }
        const rooms = parseRoomsPayload(payload);
        if (!rooms) {
          continue;
        }
        if (subscription.npub) {
          setRooms(subscription.npub, rooms);
        } else {
          subscription.pendingRooms = rooms;
        }
      }
  })().catch(error => {
    logTrackSubscribeFailure(path, ROOMS_TRACK, error);
    scheduleResubscribe(path);
  });
  } catch (error) {
    logTrackSubscribeFailure(path, ROOMS_TRACK, error);
    scheduleResubscribe(path);
  }

  try {
    const chatTrack = broadcast.subscribe(CHAT_TRACK, 0);
    clearResetErrorCounts(`${path}:${CHAT_TRACK}`);
    subscription.chatTrack = chatTrack;
    chatTrack.closed
      .catch(() => undefined)
      .finally(() => {
        if (subscription.chatTrack === chatTrack) {
          subscription.chatTrack = undefined;
        }
      });

    const chatConsumer = new Hang.Frame.Consumer(chatTrack);
    (async () => {
      for (;;) {
        const frame = await chatConsumer.decode();
        if (!frame) {
          break;
        }
        let parsed: { npub: string; message: string; ts: number; id: string } | undefined;
        try {
          parsed = parseChatPayload(JSON.parse(textDecoder.decode(frame.data)));
        } catch (error) {
          console.warn("failed to decode chat payload", error);
          continue;
        }
        if (!parsed) {
          continue;
        }
        const expiresAt = Math.max(parsed.ts, Date.now()) + CHAT_TTL_MS;
        const entry: ChatMessage = {
          npub: parsed.npub,
          message: parsed.message,
          ts: parsed.ts,
          id: parsed.id,
          expiresAt,
        };
        setChatEntry(entry);
        trackProfile(parsed.npub);
      }
    })()
      .catch(error => {
        logTrackSubscribeFailure(path, CHAT_TRACK, error);
        scheduleResubscribe(path);
      })
      .finally(() => chatConsumer.close());
  } catch (error) {
    logTrackSubscribeFailure(path, CHAT_TRACK, error);
    scheduleResubscribe(path);
  }
}

function unsubscribeFromRemote(path: Moq.Path.Valid) {
  const subscription = remoteSubscriptions.get(path);
  if (!subscription) {
    return;
  }
  remoteSubscriptions.delete(path);
  clearResubscribe(path);
  try {
    subscription.stateTrack.close();
  } catch {}
        try {
          subscription.roomsTrack?.close();
        } catch {}
        try {
          subscription.chatTrack?.close();
        } catch {}
  removeSource(subscription.sourceKey);
  if (subscription.npub) {
    setRooms(subscription.npub, []);
    clearChatEntry(subscription.npub);
  }
  subscription.pendingRooms = undefined;
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

  let rooms: string[] | undefined;
  const roomsRaw = (data as Record<string, unknown>).rooms;
  if (Array.isArray(roomsRaw)) {
    const normalized = normalizeRooms(roomsRaw);
    if (normalized.length > 0) {
      rooms = normalized;
    }
  }
  const room = typeof data.room === "string" ? data.room : undefined;
  if (!rooms && room) {
    rooms = [room];
  }

  return {
    npub,
    x: xRaw,
    y: yRaw,
    facing,
    rooms,
  };
}

function parseRoomsPayload(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const roomsValue = (payload as Record<string, unknown>).rooms;
  if (!Array.isArray(roomsValue)) {
    return undefined;
  }
  const parsed = roomsValue.filter((value): value is string => typeof value === "string");
  return normalizeRooms(parsed);
}

function parseChatPayload(payload: unknown): { npub: string; message: string; ts: number; id: string } | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const data = payload as Record<string, unknown>;
  const npub = normalizeIdentifier(data.npub) ?? (typeof data.npub === "string" ? data.npub : null);
  if (!npub) {
    return undefined;
  }
  const messageRaw = data.message;
  if (typeof messageRaw !== "string") {
    return undefined;
  }
  const message = messageRaw.trim();
  if (!message) {
    return undefined;
  }
  const normalized = message.slice(0, MAX_CHAT_LENGTH);
  const tsValue = typeof data.ts === "number" && Number.isFinite(data.ts) ? data.ts : Date.now();
  const idValue = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : `${npub}:${tsValue}`;
  return {
    npub,
    message: normalized,
    ts: tsValue,
    id: idValue,
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
  clearRooms(npub);
  clearSpeakingLevel(npub);
  clearChatEntry(npub);
  untrackProfile(npub);
}

async function startMicrophoneCapture(): Promise<void> {
  if (micRequested) {
    return;
  }
  if (!audioSupported) {
    const message = "Microphone capture is not supported in this browser";
    setAudioState({ micEnabled: false, micError: message });
    throw new Error(message);
  }
  const identity = localState?.npub ?? pendingLocalIdentity ?? localSession?.npub;
  if (!identity) {
    const message = "Login before enabling the microphone";
    setAudioState({ micEnabled: false, micError: message });
    throw new Error(message);
  }
  ensureBeforeUnloadHook();
  micRequested = true;
  try {
    await syncLocalAudioPublishState();
  } catch (error) {
    micRequested = false;
    throw error;
  }
}

async function stopMicrophoneCapture(force = false): Promise<void> {
  if (!micRequested && !force) {
    return;
  }

  micRequested = false;
  hangPublishEnabled.set(false);
  hangBroadcastPath.set(undefined);
  releaseMicrophoneTrack();

  const identity = localState?.npub ?? pendingLocalIdentity ?? localSession?.npub;
  if (identity) {
    setSpeakingLevel(identity, 0);
  }
  setAudioState({ micEnabled: false, micError: null });
}

function startPruneTimer() {
  if (pruneTimerId !== null) {
    return;
  }
  const scheduler = typeof window !== "undefined" && window.setInterval ? window.setInterval.bind(window) : setInterval;
  pruneTimerId = scheduler(() => {
    pruneRemoteSubscriptions();
    pruneChatMessages();
  }, 1000);
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

export function subscribeAudioState(callback: AudioStateListener) {
  audioStateListeners.add(callback);
  callback(audioState);
  return () => {
    audioStateListeners.delete(callback);
  };
}

export function subscribeChats(callback: ChatListener) {
  chatListeners.add(callback);
  callback(new Map(chatMessages));
  return () => {
    chatListeners.delete(callback);
  };
}

export function startStream() {
  if (started) {
    return;
  }
  started = true;

  ensureBeforeUnloadHook();
  updateRoomAudioSubscriptions();

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

  void stopMicrophoneCapture(true);
  handleDisconnected();
  void shutdownConnection();
}

export function resetChatSession(epoch: number = Date.now()): void {
  chatSessionEpoch = epoch;
  if (chatMessages.size > 0) {
    chatMessages.clear();
    notifyChats();
  }
}

export function updateLocalPlayer(state: PlayerState) {
  const normalized = normalizeIdentifier(state.npub) ?? state.npub;
  const rooms = localRooms;
  localState = { ...state, npub: normalized, rooms };
  addSourceState(LOCAL_SOURCE_KEY, localState);
  void ensureLocalSession(normalized);
  if (normalized) {
    setRooms(normalized, rooms);
  }
  maybeBroadcastLocal();
}

export function updateLocalRooms(rooms: string[]): void {
  const normalized = normalizeRooms(rooms);
  if (roomsEqual(localRooms, normalized)) {
    return;
  }
  localRooms = normalized;
  currentAudioRoom = normalized[0] ?? null;
  if (localState) {
    localState = { ...localState, rooms: normalized };
    stateBySource.set(LOCAL_SOURCE_KEY, localState);
  }
  const npub = localState?.npub;
  if (npub) {
    setRooms(npub, normalized);
  }
  updateRoomAudioSubscriptions();
  updateAudioMix();
  void syncLocalAudioPublishState().catch(() => undefined);
  broadcastRoomsUpdate();
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
    localRooms = [];
    currentAudioRoom = null;
    removeSource(LOCAL_SOURCE_KEY);
    void stopMicrophoneCapture();
    updateRoomAudioSubscriptions();
  }

  untrackProfile(npub);
  clearRooms(npub);
  clearChatEntry(npub);
}

export async function sendChatMessage(message: string): Promise<ChatMessage | null> {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }

  const identity = localState?.npub ?? pendingLocalIdentity ?? localSession?.npub;
  if (!identity) {
    throw new Error("Login before sending chat messages");
  }

  const normalized = trimmed.slice(0, MAX_CHAT_LENGTH);
  const timestamp = Date.now();
  const entry: ChatMessage = {
    id: `${identity}:${timestamp}:${chatCounter += 1}`,
    npub: identity,
    message: normalized,
    ts: timestamp,
    expiresAt: timestamp + CHAT_TTL_MS,
  };

  trackProfile(identity);
  setChatEntry(entry);
  broadcastChat(entry);

  return entry;
}

export async function setMicrophoneEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await startMicrophoneCapture();
  } else {
    await stopMicrophoneCapture();
  }
}

export function setSpeakerEnabled(enabled: boolean): void {
  if (speakerEnabled === enabled) {
    return;
  }
  speakerEnabled = enabled;
  ensureBeforeUnloadHook();
  setAudioState({ speakerEnabled: enabled });
  syncRemoteAudioPlayback();
}

export function getAudioState(): AudioControlState {
  return audioState;
}

export function getProfilePictureUrl(npub: string): string | undefined {
  const profile = profiles.get(npub)?.profile;
  return profile ? getProfilePicture(profile) ?? undefined : undefined;
}
