import { BehaviorSubject, Observable, Subject } from "rxjs";
import {
  type AudioState,
  type ChatEntry,
  type ConnectionState,
  type GameCommand,
  type GameLogEntry,
  type GameSettingsState,
  type GameStateSnapshot,
  type HeadBounds,
  type LocalPlayerState,
  type PlayerPresence,
  type PlayerProfileEntry,
  type RemotePlayerState,
} from "./types";

const MAX_LOG_ENTRIES = 200;

export interface GameStoreOptions {
  readonly initialConnection?: ConnectionState;
  readonly initialLocalPlayer?: LocalPlayerState | null;
  readonly initialRemotePlayers?: Iterable<RemotePlayerState>;
  readonly initialRooms?: Iterable<string>;
  readonly initialAudio?: AudioState;
  readonly initialChat?: Iterable<ChatEntry>;
  readonly initialProfiles?: Iterable<PlayerProfileEntry>;
  readonly initialHeadBounds?: Iterable<[string, HeadBounds]>;
  readonly initialLogs?: Iterable<GameLogEntry>;
  readonly initialSettings?: GameSettingsState;
}

function toReadonlyMap<K, V>(entries?: Iterable<[K, V]>): ReadonlyMap<K, V> {
  if (!entries) {
    return new Map();
  }
  const map = new Map<K, V>();
  for (const [key, value] of entries) {
    map.set(key, value);
  }
  return map;
}

function clonePresence<T extends PlayerPresence>(player: T): T {
  return {
    ...player,
    position: { ...player.position },
    rooms: [...player.rooms],
    updatedAt: player.updatedAt,
  };
}

function toPresenceMap(items?: Iterable<PlayerPresence>): ReadonlyMap<string, RemotePlayerState> {
  if (!items) {
    return new Map();
  }
  const map = new Map<string, RemotePlayerState>();
  for (const item of items) {
    map.set(item.npub, clonePresence(item));
  }
  return map;
}

function cloneLocal(player: LocalPlayerState): LocalPlayerState {
  const base = clonePresence(player);
  return {
    ...base,
    alias: player.alias ?? null,
    avatarUrl: player.avatarUrl ?? null,
  };
}

function cloneProfile(entry: PlayerProfileEntry): PlayerProfileEntry {
  return { ...entry };
}

function toProfileMap(items?: Iterable<PlayerProfileEntry>): ReadonlyMap<string, PlayerProfileEntry> {
  if (!items) {
    return new Map();
  }
  const map = new Map<string, PlayerProfileEntry>();
  for (const entry of items) {
    map.set(entry.npub, cloneProfile(entry));
  }
  return map;
}

function distinctRooms(items?: Iterable<string>): readonly string[] {
  if (!items) {
    return [];
  }
  const unique = new Set<string>();
  for (const item of items) {
    const normalized = item.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort();
}

const DEFAULT_AUDIO_STATE: AudioState = {
  micEnabled: false,
  speakerEnabled: true,
  micError: null,
  supported: true,
};

const DEFAULT_SETTINGS: GameSettingsState = {
  inputCaptured: false,
  debugConsole: false,
};

export class GameStore {
  private readonly commandSubject = new Subject<GameCommand>();
  private readonly connectionSubject: BehaviorSubject<ConnectionState>;
  private readonly localPlayerSubject: BehaviorSubject<LocalPlayerState | null>;
  private readonly remotePlayersSubject: BehaviorSubject<ReadonlyMap<string, RemotePlayerState>>;
  private readonly roomsSubject: BehaviorSubject<readonly string[]>;
  private readonly audioSubject: BehaviorSubject<AudioState>;
  private readonly chatSubject: BehaviorSubject<ReadonlyMap<string, ChatEntry>>;
  private readonly profilesSubject: BehaviorSubject<ReadonlyMap<string, PlayerProfileEntry>>;
  private readonly headBoundsSubject: BehaviorSubject<ReadonlyMap<string, HeadBounds>>;
  private readonly logsSubject: BehaviorSubject<readonly GameLogEntry[]>;
  private readonly settingsSubject: BehaviorSubject<GameSettingsState>;
  private disposed = false;

  public readonly commands$: Observable<GameCommand> = this.commandSubject.asObservable();
  public readonly connection$: Observable<ConnectionState>;
  public readonly localPlayer$: Observable<LocalPlayerState | null>;
  public readonly remotePlayers$: Observable<ReadonlyMap<string, RemotePlayerState>>;
  public readonly rooms$: Observable<readonly string[]>;
  public readonly audio$: Observable<AudioState>;
  public readonly chat$: Observable<ReadonlyMap<string, ChatEntry>>;
  public readonly profiles$: Observable<ReadonlyMap<string, PlayerProfileEntry>>;
  public readonly headBounds$: Observable<ReadonlyMap<string, HeadBounds>>;
  public readonly logs$: Observable<readonly GameLogEntry[]>;
  public readonly settings$: Observable<GameSettingsState>;

  constructor(options: GameStoreOptions = {}) {
    this.connectionSubject = new BehaviorSubject<ConnectionState>(
      options.initialConnection ?? {
        status: "idle",
        relayUrl: undefined,
        error: undefined,
        lastConnectedAt: undefined,
      },
    );
    this.localPlayerSubject = new BehaviorSubject<LocalPlayerState | null>(
      options.initialLocalPlayer ?? null,
    );
    this.remotePlayersSubject = new BehaviorSubject<ReadonlyMap<string, RemotePlayerState>>(
      toPresenceMap(options.initialRemotePlayers),
    );
    this.roomsSubject = new BehaviorSubject<readonly string[]>(
      distinctRooms(options.initialRooms),
    );
    this.audioSubject = new BehaviorSubject<AudioState>(
      options.initialAudio ?? DEFAULT_AUDIO_STATE,
    );
    const initialChatEntries = options.initialChat
      ? Array.from(options.initialChat, entry => [entry.id, { ...entry }] as const)
      : undefined;
    this.chatSubject = new BehaviorSubject<ReadonlyMap<string, ChatEntry>>(
      toReadonlyMap(initialChatEntries),
    );
    this.profilesSubject = new BehaviorSubject<ReadonlyMap<string, PlayerProfileEntry>>(
      toProfileMap(options.initialProfiles),
    );
    this.headBoundsSubject = new BehaviorSubject<ReadonlyMap<string, HeadBounds>>(
      toReadonlyMap(options.initialHeadBounds),
    );
    this.logsSubject = new BehaviorSubject<readonly GameLogEntry[]>(
      options.initialLogs ? Array.from(options.initialLogs) : [],
    );
    this.settingsSubject = new BehaviorSubject<GameSettingsState>(
      options.initialSettings ?? DEFAULT_SETTINGS,
    );

    this.connection$ = this.connectionSubject.asObservable();
    this.localPlayer$ = this.localPlayerSubject.asObservable();
    this.remotePlayers$ = this.remotePlayersSubject.asObservable();
    this.rooms$ = this.roomsSubject.asObservable();
    this.audio$ = this.audioSubject.asObservable();
    this.chat$ = this.chatSubject.asObservable();
    this.profiles$ = this.profilesSubject.asObservable();
    this.headBounds$ = this.headBoundsSubject.asObservable();
    this.logs$ = this.logsSubject.asObservable();
    this.settings$ = this.settingsSubject.asObservable();
  }

  public dispatch(command: GameCommand): void {
    if (this.disposed) {
      throw new Error("Cannot dispatch commands after store disposal");
    }

    switch (command.type) {
      case "set-input-captured":
        this.setInputCaptured(command.captured);
        break;
      case "append-log":
        this.appendLog(command.entry);
        break;
      case "set-debug-console":
        this.setDebugConsole(command.enabled);
        break;
      case "set-local-rooms":
        this.setLocalRooms(command.rooms);
        break;
      default:
        break;
    }

    this.commandSubject.next(command);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.commandSubject.complete();
    this.connectionSubject.complete();
    this.localPlayerSubject.complete();
    this.remotePlayersSubject.complete();
    this.roomsSubject.complete();
    this.audioSubject.complete();
    this.chatSubject.complete();
    this.profilesSubject.complete();
    this.headBoundsSubject.complete();
    this.logsSubject.complete();
    this.settingsSubject.complete();
  }

  public setConnection(state: ConnectionState): void {
    this.connectionSubject.next({ ...state });
  }

  public patchConnection(patch: Partial<ConnectionState>): void {
    const current = this.connectionSubject.getValue();
    this.connectionSubject.next({ ...current, ...patch });
  }

  public setLocalPlayer(state: LocalPlayerState | null): void {
    this.localPlayerSubject.next(state ? cloneLocal(state) : null);
  }

  public patchLocalPlayer(patch: Partial<LocalPlayerState>): void {
    const current = this.localPlayerSubject.getValue();
    if (!current) {
      return;
    }
    const next: LocalPlayerState = {
      ...current,
      ...patch,
      position: patch.position ? { ...patch.position } : { ...current.position },
      rooms: patch.rooms ? [...patch.rooms] : [...current.rooms],
    };
    this.localPlayerSubject.next(cloneLocal(next));
  }

  public setRemotePlayers(players: Iterable<RemotePlayerState>): void {
    const map = new Map<string, RemotePlayerState>();
    for (const player of players) {
      map.set(player.npub, clonePresence(player));
    }
    this.remotePlayersSubject.next(map);
  }

  public upsertRemotePlayer(player: RemotePlayerState): void {
    const next = new Map(this.remotePlayersSubject.getValue());
    next.set(player.npub, clonePresence(player));
    this.remotePlayersSubject.next(next);
  }

  public removeRemotePlayer(npub: string): void {
    const next = new Map(this.remotePlayersSubject.getValue());
    if (!next.delete(npub)) {
      return;
    }
    this.remotePlayersSubject.next(next);
  }

  public setLocalRooms(rooms: Iterable<string>): void {
    const normalized = distinctRooms(rooms);
    this.roomsSubject.next(normalized);
    const local = this.localPlayerSubject.getValue();
    if (local) {
      this.localPlayerSubject.next(
        cloneLocal({
          ...local,
          rooms: normalized,
        }),
      );
    }
  }

  public setAudioState(state: AudioState): void {
    this.audioSubject.next({ ...state });
  }

  public patchAudioState(patch: Partial<AudioState>): void {
    const current = this.audioSubject.getValue();
    this.audioSubject.next({ ...current, ...patch });
  }

  public setChat(entries: Iterable<ChatEntry>): void {
    const map = new Map<string, ChatEntry>();
    for (const entry of entries) {
      map.set(entry.id, { ...entry });
    }
    this.chatSubject.next(map);
  }

  public upsertChat(entry: ChatEntry): void {
    const next = new Map(this.chatSubject.getValue());
    next.set(entry.id, { ...entry });
    this.chatSubject.next(next);
  }

  public removeChat(chatId: string): void {
    const next = new Map(this.chatSubject.getValue());
    if (!next.delete(chatId)) {
      return;
    }
    this.chatSubject.next(next);
  }

  public setProfiles(entries: Iterable<PlayerProfileEntry>): void {
    const map = new Map<string, PlayerProfileEntry>();
    for (const entry of entries) {
      map.set(entry.npub, { ...entry });
    }
    this.profilesSubject.next(map);
  }

  public upsertProfile(entry: PlayerProfileEntry): void {
    const next = new Map(this.profilesSubject.getValue());
    next.set(entry.npub, { ...entry });
    this.profilesSubject.next(next);
  }

  public removeProfile(npub: string): void {
    const next = new Map(this.profilesSubject.getValue());
    if (!next.delete(npub)) {
      return;
    }
    this.profilesSubject.next(next);
  }

  public setHeadBounds(entries: Iterable<[string, HeadBounds]>): void {
    const map = new Map<string, HeadBounds>();
    for (const [key, value] of entries) {
      map.set(key, { rect: { ...value.rect }, facing: value.facing });
    }
    this.headBoundsSubject.next(map);
  }

  public updateHeadBounds(npub: string, bounds: HeadBounds | null): void {
    const next = new Map(this.headBoundsSubject.getValue());
    if (bounds) {
      next.set(npub, { rect: { ...bounds.rect }, facing: bounds.facing });
    } else {
      next.delete(npub);
    }
    this.headBoundsSubject.next(next);
  }

  public appendLog(entry: GameLogEntry): void {
    const current = this.logsSubject.getValue();
    const next = [...current, entry];
    if (next.length > MAX_LOG_ENTRIES) {
      next.splice(0, next.length - MAX_LOG_ENTRIES);
    }
    this.logsSubject.next(next);
  }

  public logInfo(message: string): void {
    this.appendLog({ message, ts: Date.now(), level: "info" });
  }

  public logWarn(message: string): void {
    this.appendLog({ message, ts: Date.now(), level: "warn" });
  }

  public logError(message: string): void {
    this.appendLog({ message, ts: Date.now(), level: "error" });
  }

  public setInputCaptured(captured: boolean): void {
    const current = this.settingsSubject.getValue();
    if (current.inputCaptured === captured) {
      return;
    }
    this.settingsSubject.next({ ...current, inputCaptured: captured });
  }

  public setDebugConsole(enabled: boolean): void {
    const current = this.settingsSubject.getValue();
    if (current.debugConsole === enabled) {
      return;
    }
    this.settingsSubject.next({ ...current, debugConsole: enabled });
  }

  public getSnapshot(): GameStateSnapshot {
    return {
      connection: this.connectionSubject.getValue(),
      localPlayer: this.localPlayerSubject.getValue(),
      remotePlayers: this.remotePlayersSubject.getValue(),
      rooms: this.roomsSubject.getValue(),
      audio: this.audioSubject.getValue(),
      chat: this.chatSubject.getValue(),
      profiles: this.profilesSubject.getValue(),
      headBounds: this.headBoundsSubject.getValue(),
      logs: this.logsSubject.getValue(),
      settings: this.settingsSubject.getValue(),
    };
  }

  public derivePlayerList(): PlayerPresence[] {
    const local = this.localPlayerSubject.getValue();
    const remotes = this.remotePlayersSubject.getValue();
    const players: PlayerPresence[] = [];
    if (local) {
      players.push(local);
    }
    for (const player of remotes.values()) {
      players.push(player);
    }
    return players;
  }
}
