import { getDisplayName } from "applesauce-core/helpers";
import { npubEncode } from "nostr-tools/nip19";
import { manager } from "./nostr/accounts";
import { Application } from "pixi.js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  from,
  onCleanup,
  Show,
  type Component,
} from "solid-js";
import { Console, Dpad, Header, Login } from "./components";
import { initGame, type GameInstance } from "./game/initGame";
import "./index.css";
import {
  getAudioState,
  getProfilePictureUrl,
  removePlayer,
  resetChatSession,
  setMicrophoneEnabled,
  setSpeakerEnabled,
  startStream,
  stopStream,
  subscribe,
  subscribeAudioState,
  subscribeChats,
  subscribeProfiles,
  updateLocalPlayer,
  updateLocalRooms,
  type AudioControlState,
  type ChatMessage,
  type FacingDirection,
  type PlayerProfile,
  type PlayerState
} from "./multiplayer/stream";

export const App: Component = () => {
  let containerRef: HTMLDivElement | undefined;
  let gameInstance: GameInstance | null = null;
  let avatarRef: string | null = null;
  let pubkeyRef: string | null = null;
  let remotePlayersRef: PlayerState[] = [];

  const [playerRooms, setPlayerRooms] = createSignal<string[]>([]);
  const [logMessages, setLogMessages] = createSignal<string[]>([]);
  // Use account manager as source of truth for active account
  const activeAccount = from(manager.active$);
  const pubkey = createMemo(() => activeAccount()?.pubkey || null);
  const [npub, setNpub] = createSignal<string | null>(null);
  const [localAlias, setLocalAlias] = createSignal<string | null>(null);
  const [remotePlayers, setRemotePlayers] = createSignal<PlayerState[]>([]);
  const [profileMap, setProfileMap] = createSignal<Map<string, PlayerProfile>>(new Map());
  const [headRects, setHeadRects] = createSignal<Map<string, { rect: { x: number; y: number; width: number; height: number }; facing: FacingDirection }>>(new Map());
  const [audioState, setAudioState] = createSignal<AudioControlState>(getAudioState());
  const [chatMap, setChatMap] = createSignal<Map<string, ChatMessage>>(new Map());
  let profileMapRef: Map<string, PlayerProfile> = new Map();
  let chatSeenRef: Map<string, string> = new Map();

  const appendLog = (message: string) => {
    setLogMessages(prev => {
      const next = [...prev, message];
      if (next.length > 100) {
        return next.slice(next.length - 100);
      }
      return next;
    });
  };

  // Effect to handle when account becomes active
  createEffect(() => {
    const account = activeAccount();
    if (account) {
      const normalized = account.pubkey.toLowerCase();
      const encoded = npubEncode(normalized);
      const epoch = Date.now();
      resetChatSession(epoch);
      chatSeenRef.clear();
      setChatMap(new Map());
      pubkeyRef = normalized;
      setNpub(encoded);
      // Get display name from account metadata or profile
      const profile = profileMap().get(account.pubkey);
      const alias = profile ? getDisplayName(profile.profile) : null;
      setLocalAlias(alias ?? null);
      appendLog(alias ? `Joined as ${alias} (${encoded})` : `Logged in as ${encoded}`);
      gameInstance?.spawn();
    } else {
      // Handle logout
      const previousNpub = pubkeyRef;
      if (previousNpub) {
        removePlayer(previousNpub);
      }
      pubkeyRef = null;
      setNpub(null);
      setLocalAlias(null);
    }
  });

  // Effect to sync pubkeyRef with pubkey signal
  createEffect(() => {
    pubkeyRef = pubkey();
  });

  // Effect to sync profileMapRef with profileMap signal
  createEffect(() => {
    profileMapRef = profileMap();
  });

  // Main stream setup effect
  startStream();
  const unsubscribePlayers = subscribe(states => {
    remotePlayersRef = states;
    setRemotePlayers(states);
  });
  const unsubscribeProfiles = subscribeProfiles(map => {
    const clone = new Map(map);
    profileMapRef = clone;
    setProfileMap(clone);
  });
  const unsubscribeAudio = subscribeAudioState(state => {
    setAudioState(state);
  });
  const unsubscribeChats = subscribeChats(map => {
    const clone = new Map(map);
    setChatMap(clone);

    const seen = chatSeenRef;
    for (const key of [...seen.keys()]) {
      if (!clone.has(key)) {
        seen.delete(key);
      }
    }

    clone.forEach(entry => {
      const lastId = seen.get(entry.npub);
      if (lastId === entry.id) {
        return;
      }
      seen.set(entry.npub, entry.id);

      const currentPubkey = pubkeyRef;
      const isLocal = currentPubkey ? entry.npub === currentPubkey : false;
      const profile = profileMapRef.get(entry.npub)?.profile;
      const display = isLocal
        ? "You"
        : profile
          ? getDisplayName(profile) ?? `${entry.npub.slice(0, 12)}…`
          : `${entry.npub.slice(0, 12)}…`;
      appendLog(`[Chat] ${display}: ${entry.message}`);
    });
  });

  onCleanup(() => {
    if (pubkeyRef) {
      removePlayer(pubkeyRef);
    }
    setPlayerRooms([]);
    unsubscribeProfiles();
    unsubscribePlayers();
    unsubscribeAudio();
    unsubscribeChats();
    chatSeenRef.clear();
    setChatMap(new Map());
    stopStream();
  });

  // Effect to update local rooms
  createEffect(() => {
    updateLocalRooms(playerRooms());
  });

  // Game initialization effect
  const desiredAspect = 3 / 2;
  const app = new Application();
  let disposed = false;
  let cleanup: (() => void) | undefined;
  let hasRenderer = false;
  let canvasAttached = false;

  const resizeViewport = () => {
    if(!containerRef) return
    if (!hasRenderer || !app.renderer) return;

    const parent = containerRef.parentElement as HTMLElement | null;
    const availableWidth = parent ? parent.clientWidth : window.innerWidth;
    const maxHeight = Math.max(240, window.innerHeight * 0.6);

    let targetWidth = availableWidth;
    let targetHeight = targetWidth / desiredAspect;

    if (targetHeight > maxHeight) {
      targetHeight = maxHeight;
      targetWidth = targetHeight * desiredAspect;
    }

    targetWidth = Math.floor(targetWidth);
    targetHeight = Math.floor(targetHeight);

    containerRef.style.width = `${targetWidth}px`;
    containerRef.style.height = `${targetHeight}px`;
    containerRef.style.maxWidth = "100%";

    app.renderer.resize(targetWidth, targetHeight);
    app.canvas.style.width = `${targetWidth}px`;
    app.canvas.style.height = `${targetHeight}px`;
  };

  app
    .init({
      background: "#344149",
      hello: false,
      autoDensity: true,
      antialias: false,
      preference: "webgl",
    })
    .then(async () => {
      hasRenderer = true;
      resizeViewport();
      window.addEventListener("resize", resizeViewport);

      if (disposed) {
        window.removeEventListener("resize", resizeViewport);
        app.destroy(true);
        return;
      }

      app.canvas.classList.add("game-canvas");
      const firstChild = containerRef?.firstChild;
      if (firstChild) {
        containerRef?.insertBefore(app.canvas, firstChild);
      } else {
        containerRef?.appendChild(app.canvas);
      }
      canvasAttached = true;
      const game = await initGame(app, {
        onPlayerPosition: data => {
          const currentNpub = pubkeyRef;
          if (currentNpub) {
            updateLocalPlayer({ npub: currentNpub, x: data.x, y: data.y, facing: data.facing });
          }
        },
        onConsoleMessage: appendLog,
        onHeadPosition: (id, rect, facing) => {
          const key = id === "local" ? pubkeyRef : id;
          if (!key) {
            return;
          }

          setHeadRects(prev => {
            const next = new Map(prev);
            if (rect) {
              next.set(key, { rect, facing });
            } else {
              next.delete(key);
            }
            return next;
          });
        },
        onPlayerRooms: rooms => {
          setPlayerRooms(rooms);
        },
      });
      gameInstance = game;
      game.setAvatar(avatarRef);
      const currentNpub = pubkeyRef;
      const remotes = remotePlayersRef.filter(player => player.npub !== currentNpub);
      game.syncPlayers(remotes);
      cleanup = () => {
        game.destroy();
        gameInstance = null;
      };
    })
    .catch(error => {
      console.error("Failed to initialise PixiJS", error);
    });

  onCleanup(() => {
    disposed = true;
    cleanup?.();
    window.removeEventListener("resize", resizeViewport);
    if (canvasAttached && app.renderer && app.canvas.parentElement === containerRef) {
      containerRef?.removeChild(app.canvas);
    }
    if (hasRenderer && app.renderer) {
      app.destroy(true);
    }
  });

  const handleLogout = () => {
    // Clear the active account from the manager
    // This will trigger the effect above to handle most of the cleanup
    manager.clearActive();

    // Additional cleanup not handled by the effect
    setHeadRects(prev => {
      const next = new Map(prev);
      if (pubkeyRef) {
        next.delete(pubkeyRef);
      }
      return next;
    });
    appendLog("Logged out");
    avatarRef = null;
    gameInstance?.setAvatar(null);
    setPlayerRooms([]);
    void setMicrophoneEnabled(false);
    const epoch = Date.now();
    resetChatSession(epoch);
    chatSeenRef.clear();
    setChatMap(new Map());
  };


  const avatarUrl = createMemo(() => {
    const pk = pubkey();
    if (!pk) {
      return null;
    }
    return getProfilePictureUrl(pk) ?? null;
  });

  // Avatar effect
  createEffect(() => {
    avatarRef = avatarUrl();
    if (!gameInstance) {
      return;
    }
    gameInstance.setAvatar(avatarUrl());
  });

  // Remote players sync effect
  createEffect(() => {
    const game = gameInstance;
    if (!game) return;

    const currentNpub = pubkeyRef;
    const remotes = remotePlayers().filter(player => player.npub !== currentNpub);
    game.syncPlayers(remotes);
  });

  const overlayEntries = createMemo(() => {
    const stateMap = new Map(remotePlayers().map(player => [player.npub, player]));
      const entries: Array<{
      npub: string;
      rect: { x: number; y: number; width: number; height: number };
      name: string;
      avatar: string;
      speakingLevel: number;
      chat?: ChatMessage;
    }> = [];
    headRects().forEach(({ rect }, key) => {
      const profile = profileMap().get(key)?.profile;
      let display = profile ? getDisplayName(profile) : `${key.slice(0, 12)}…`;
      if (key === (npub() ?? "")) {
        // For local player, show alias if available, otherwise profile name or npub
        const alias = localAlias();
        if (alias) {
          display = alias;
        } else {
          const localProfile = profile;
          const name = localProfile ? getDisplayName(localProfile) : null;
          if (name) {
            display = name;
          } else {
            const currentNpub = npub();
            if (currentNpub) {
              display = `${currentNpub.slice(0, 12)}…`;
            }
          }
        }
      }

      const avatar =
        getProfilePictureUrl(key) ??
        (key === (npub() ?? "") ? avatarUrl() ?? undefined : undefined) ??
        `https://robohash.org/${key}.png`;

      const playerState = stateMap.get(key);
      const speakingLevel = playerState?.speakingLevel ?? 0;
      const chat = chatMap().get(key);

      entries.push({ npub: key, rect, name: display ?? "Player", avatar, speakingLevel, chat });
    });
    return entries;
  });


  return (
    <div class="app-shell">
      <div class="app-main">
        <Header
          profileMap={profileMap()}
          audioState={audioState()}
          onLogout={handleLogout}
        />

        <div class="game-container">
          <div class="game-surface" ref={containerRef}>
            <div class="game-overlays">
              <div class="player-overlays">
                <For each={overlayEntries()}>
                  {(entry) => (
                    <div
                      class={`avatar-head${entry.speakingLevel > 0.02 ? " is-speaking" : ""}`}
                      style={{
                        width: `${entry.rect.width}px`,
                        height: `${entry.rect.height}px`,
                        transform: `translate3d(${entry.rect.x}px, ${entry.rect.y}px, 0)`,
                      }}
                    >
                      <img src={entry.avatar} alt={entry.name} />
                      <Show when={entry.chat}>
                        <div class="chat-bubble">
                          <span>{entry.chat!.message}</span>
                        </div>
                      </Show>
                      <div class="avatar-label">{entry.name}</div>
                    </div>
                  )}
                </For>
              </div>
              <Dpad visible={!!pubkey()} />
            </div>
          </div>
        </div>

        <Console
          isLoggedIn={!!pubkey()}
          logMessages={logMessages()}
          onAppendLog={appendLog}
          onSetInputCaptured={(captured) => gameInstance?.setInputCaptured(captured)}
          onSpawn={() => gameInstance?.spawn()}
        />
      </div>

      <Show when={!pubkey()}>
        <Login />
      </Show>
    </div>
  );
};

export default App;
