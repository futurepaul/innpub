import type { PlayerTransform } from "./state";
import {
  gameStore,
  getProfilePictureUrl,
  resetChatSession,
  sendChatMessage,
  setMicrophoneEnabled as legacySetMicrophoneEnabled,
  setSpeakerEnabled as legacySetSpeakerEnabled,
  startStream,
  stopStream,
} from "../multiplayer/stream";

export { gameStore, getProfilePictureUrl };

export function startGameServices(): void {
  startStream();
}

export function stopGameServices(): void {
  stopStream();
}

export function login(npub: string, alias?: string | null): void {
  gameStore.dispatch({ type: "login", npub, alias: alias ?? null });
}

export function logout(): void {
  gameStore.dispatch({ type: "logout" });
}

export function setLocalTransform(transform: PlayerTransform): void {
  gameStore.dispatch({ type: "set-local-transform", transform });
}

export function setLocalRooms(rooms: string[]): void {
  gameStore.dispatch({ type: "set-local-rooms", rooms });
}

export function requestSpawn(): void {
  gameStore.dispatch({ type: "request-spawn" });
}

export function setAvatar(url?: string | null): void {
  gameStore.dispatch({ type: "set-avatar", url: url ?? null });
}

export async function sendChat(message: string) {
  return sendChatMessage(message);
}

export async function setMicEnabled(enabled: boolean): Promise<void> {
  await legacySetMicrophoneEnabled(enabled);
}

export function setSpeakerEnabled(enabled: boolean): void {
  legacySetSpeakerEnabled(enabled);
}

export function resetChat(epoch: number = Date.now()): void {
  resetChatSession(epoch);
}

