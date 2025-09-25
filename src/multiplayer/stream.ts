import { eventStore, DEFAULT_RELAYS } from "../nostr/client";
import { getProfilePicture, type ProfileContent } from "applesauce-core/helpers";
import { decode as decodeNip19 } from "nostr-tools/nip19";

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

const listeners = new Set<(state: PlayerState[]) => void>();
const profileListeners = new Set<(profiles: Map<string, PlayerProfile>) => void>();

const players = new Map<string, PlayerState>();
const profiles = new Map<string, PlayerProfile>();
const profileSubscriptions = new Map<string, { unsubscribe: () => void }>();

let animationFrame: number | null = null;

function notify() {
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

export function subscribe(callback: (state: PlayerState[]) => void) {
  listeners.add(callback);
  callback(Array.from(players.values()));
  return () => listeners.delete(callback);
}

export function subscribeProfiles(callback: (profiles: Map<string, PlayerProfile>) => void) {
  profileListeners.add(callback);
  callback(profiles);
  return () => profileListeners.delete(callback);
}

function trackProfile(npub: string) {
  if (profileSubscriptions.has(npub)) {
    return;
  }

  const hexPubkey = (() => {
    if (/^[0-9a-f]{64}$/i.test(npub)) {
      return npub.toLowerCase();
    }
    try {
      const decoded = decodeNip19(npub);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch (error) {
      console.warn("Failed to decode npub", npub, error);
    }
    return npub;
  })();

  const subscription = eventStore.profile({ pubkey: hexPubkey, relays: DEFAULT_RELAYS }).subscribe(profile => {
    profiles.set(npub, { npub, profile });
    notifyProfiles();
  });

  profileSubscriptions.set(npub, {
    unsubscribe: () => subscription.unsubscribe(),
  });

  profiles.set(npub, { npub });
  notifyProfiles();
}

export function updateLocalPlayer(state: PlayerState) {
  players.set(state.npub, state);
  trackProfile(state.npub);
  notify();
}

export function removePlayer(npub: string) {
  players.delete(npub);
  notify();

  const sub = profileSubscriptions.get(npub);
  if (sub) {
    sub.unsubscribe();
    profileSubscriptions.delete(npub);
  }
  profiles.delete(npub);
  notifyProfiles();
}

const sampleNpub = "npub1zxu639qym0esxnn7rzrt48wycmfhdu3e5yvzwx7ja3t84zyc2r8qz8cx2y";
const BASE_SPEED = 45;
const DIRECTION_TICKS = 30;

function ensureSamplePlayer() {
  const existing = players.get(sampleNpub);
  if (existing) {
    return existing;
  }

  const sample: PlayerState = {
    npub: sampleNpub,
    x: 160,
    y: 160,
    facing: 1,
  };
  const firstPlayer = Array.from(players.values()).find(p => p.npub !== sampleNpub);
  if (firstPlayer) {
    sample.x = firstPlayer.x;
    sample.y = firstPlayer.y;
    sample.facing = firstPlayer.facing;
  }
  players.set(sampleNpub, sample);
  trackProfile(sampleNpub);
  return sample;
}

let lastTick = performance.now();
let directionAngle = Math.random() * Math.PI * 2;
let directionTicksRemaining = DIRECTION_TICKS;

function tick() {
  const now = performance.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;

  const sample = ensureSamplePlayer();

  if (directionTicksRemaining <= 0) {
    directionAngle = Math.random() * Math.PI * 2;
    directionTicksRemaining = DIRECTION_TICKS;
  }

  directionTicksRemaining -= 1;

  const speed = BASE_SPEED;
  sample.x += Math.cos(directionAngle) * speed * delta;
  sample.y += Math.sin(directionAngle) * speed * delta;

  const absX = Math.abs(Math.cos(directionAngle));
  const absY = Math.abs(Math.sin(directionAngle));
  if (absX >= absY) {
    sample.facing = Math.cos(directionAngle) >= 0 ? 1 : 0;
  } else {
    sample.facing = Math.sin(directionAngle) >= 0 ? 3 : 2;
  }

  players.set(sample.npub, sample);
  notify();

  animationFrame = requestAnimationFrame(tick);
}

export function startStream() {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  lastTick = performance.now();
  animationFrame = requestAnimationFrame(tick);
}

export function stopStream() {
  if (animationFrame !== null) {
    cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
}

export function getProfilePictureUrl(npub: string): string | undefined {
  const profile = profiles.get(npub)?.profile;
  return profile ? getProfilePicture(profile) ?? undefined : undefined;
}
