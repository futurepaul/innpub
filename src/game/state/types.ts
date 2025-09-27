import type { ProfileContent } from "applesauce-core/helpers";

export const ROOM_PROTOCOL_VERSION = "v2" as const;

export type FacingDirection = 0 | 1 | 2 | 3;

export interface Vector2 {
  x: number;
  y: number;
}

export interface PlayerTransform {
  position: Vector2;
  facing: FacingDirection;
}

export interface PlayerPresence {
  npub: string;
  position: Vector2;
  facing: FacingDirection;
  rooms: string[];
  speakingLevel: number;
  updatedAt: number;
}

export interface LocalPlayerState extends PlayerPresence {
  alias?: string | null;
  avatarUrl?: string | null;
}

export interface RemotePlayerState extends PlayerPresence {}

export interface PlayerProfileEntry {
  npub: string;
  profile?: ProfileContent;
}

export interface AudioState {
  micEnabled: boolean;
  speakerEnabled: boolean;
  micError: string | null;
  supported: boolean;
}

export interface ChatEntry {
  id: string;
  npub: string;
  message: string;
  ts: number;
  expiresAt: number;
}

export interface HeadBounds {
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  facing: FacingDirection;
}

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  relayUrl?: string;
  error?: string;
  lastConnectedAt?: number;
}

export interface GameSettingsState {
  inputCaptured: boolean;
  debugConsole: boolean;
}

export interface GameLogEntry {
  message: string;
  ts: number;
  level: "info" | "warn" | "error";
}

export interface GameStateSnapshot {
  connection: ConnectionState;
  localPlayer: LocalPlayerState | null;
  remotePlayers: ReadonlyMap<string, RemotePlayerState>;
  rooms: readonly string[];
  audio: AudioState;
  chat: ReadonlyMap<string, ChatEntry>;
  profiles: ReadonlyMap<string, PlayerProfileEntry>;
  headBounds: ReadonlyMap<string, HeadBounds>;
  logs: readonly GameLogEntry[];
  settings: GameSettingsState;
}

export type GameCommand =
  | { type: "login"; npub: string; alias?: string | null }
  | { type: "logout" }
  | { type: "set-local-transform"; transform: PlayerTransform }
  | { type: "set-local-rooms"; rooms: string[] }
  | { type: "request-spawn" }
  | { type: "set-avatar"; url?: string | null }
  | { type: "send-chat"; message: string }
  | { type: "toggle-mic"; enabled: boolean }
  | { type: "toggle-speaker"; enabled: boolean }
  | { type: "set-input-captured"; captured: boolean }
  | { type: "append-log"; entry: GameLogEntry }
  | { type: "set-debug-console"; enabled: boolean };

export type CommandListener = (command: GameCommand) => void;

