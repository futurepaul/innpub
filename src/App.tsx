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
import { createObservableSignal } from "./ui/useObservable";
import {
  gameStore,
  getProfilePictureUrl,
  login as loginService,
  logout as logoutService,
  requestSpawn,
  resetChat,
  setAvatar,
  setMicEnabled,
  setSpeakerEnabled,
  startGameServices,
  stopGameServices,
} from "./game/service";
import {
  type AudioState,
  type ChatEntry,
  type HeadBounds,
  type PlayerProfileEntry,
  type RemotePlayerState,
} from "./game/state";

interface OverlayEntry {
  npub: string;
  rect: HeadBounds["rect"];
  name: string;
  avatar: string;
  speakingLevel: number;
  chat?: ChatEntry;
}

export const App: Component = () => {
  let containerRef: HTMLDivElement | undefined;
  let gameInstance: GameInstance | null = null;
  let cleanupRenderer: (() => void) | undefined;
  let disposed = false;

  startGameServices();

  const activeAccount = from(manager.active$);
  const pubkey = createMemo(() => activeAccount()?.pubkey?.toLowerCase() ?? null);
  const [npub, setNpub] = createSignal<string | null>(null);
  const [localAlias, setLocalAlias] = createSignal<string | null>(null);

  const audioState = createObservableSignal<AudioState>(gameStore.audio$, gameStore.getSnapshot().audio);
  const chatMap = createObservableSignal<ReadonlyMap<string, ChatEntry>>(gameStore.chat$, gameStore.getSnapshot().chat);
  const profileMap = createObservableSignal<ReadonlyMap<string, PlayerProfileEntry>>(gameStore.profiles$, gameStore.getSnapshot().profiles);
  const remotePlayers = createObservableSignal<ReadonlyMap<string, RemotePlayerState>>(gameStore.remotePlayers$, gameStore.getSnapshot().remotePlayers);
  const headBounds = createObservableSignal<ReadonlyMap<string, HeadBounds>>(gameStore.headBounds$, gameStore.getSnapshot().headBounds);
  const logsSignal = createObservableSignal(gameStore.logs$, gameStore.getSnapshot().logs);
  const localPlayerSignal = createObservableSignal(gameStore.localPlayer$, gameStore.getSnapshot().localPlayer);

  const logMessages = createMemo(() => logsSignal().map(entry => entry.message));

  const isLoggedIn = createMemo(() => Boolean(activeAccount() ?? localPlayerSignal()?.npub ?? null));
  const showLoginOverlay = createMemo(() => !activeAccount());

  const avatarUrl = createMemo(() => {
    const pk = pubkey();
    if (!pk) {
      return null;
    }
    return getProfilePictureUrl(pk) ?? null;
  });

  createEffect(() => {
    setAvatar(avatarUrl());
  });

  const chatSeenRef = new Map<string, string>();

  let lastAccountPubkey: string | null = null;

  createEffect(() => {
    const account = activeAccount();
    const normalized = account?.pubkey?.toLowerCase() ?? null;

    if (!normalized) {
      if (lastAccountPubkey) {
        void setMicEnabled(false);
        setSpeakerEnabled(true);
        resetChat();
        chatSeenRef.clear();
        logoutService();
        setAvatar(null);
        setLocalAlias(null);
        setNpub(null);
        gameStore.logInfo("Logged out");
      }
      lastAccountPubkey = null;
      return;
    }

    if (normalized !== lastAccountPubkey) {
      lastAccountPubkey = normalized;
      const encoded = npubEncode(normalized);
      setNpub(encoded);
      resetChat(Date.now());
      chatSeenRef.clear();
      loginService(normalized, null);
      requestSpawn();
      gameStore.logInfo(`Logged in as ${encoded}`);
    }

    const profile = profileMap().get(normalized)?.profile;
    const alias = profile ? getDisplayName(profile) : null;
    setLocalAlias(alias ?? null);
  });

  createEffect(() => {
    const entries = chatMap();
    for (const [npubKey, entry] of entries) {
      const lastId = chatSeenRef.get(npubKey);
      if (lastId === entry.id) {
        continue;
      }
      chatSeenRef.set(npubKey, entry.id);

      const currentPubkey = pubkey();
      const isLocal = currentPubkey ? npubKey === currentPubkey : false;
      const profile = profileMap().get(npubKey)?.profile;
      const display = isLocal
        ? "You"
        : profile
            ? getDisplayName(profile) ?? `${npubKey.slice(0, 12)}…`
            : `${npubKey.slice(0, 12)}…`;
      gameStore.logInfo(`[Chat] ${display}: ${entry.message}`);
    }

    for (const key of [...chatSeenRef.keys()]) {
      if (!entries.has(key)) {
        chatSeenRef.delete(key);
      }
    }
  });

  const overlayEntries = createMemo<OverlayEntry[]>(() => {
    const bounds = headBounds();
    const remote = remotePlayers();
    const profiles = profileMap();
    const chats = chatMap();
    const localPlayer = localPlayerSignal();
    const localNpub = localPlayer?.npub ?? null;
    const localAvatar = avatarUrl();
    const alias = localAlias();

    const entries: OverlayEntry[] = [];
    bounds.forEach((value, npubKey) => {
      const isLocal = localNpub ? npubKey === localNpub : false;
      const remoteState = remote.get(npubKey);
      const speakingLevel = isLocal ? localPlayer?.speakingLevel ?? 0 : remoteState?.speakingLevel ?? 0;

      let display = profiles.get(npubKey)?.profile ? getDisplayName(profiles.get(npubKey)!.profile!) : `${npubKey.slice(0, 12)}…`;
      if (isLocal) {
        if (alias) {
          display = alias;
        } else if (npub()) {
          display = `${npub()!.slice(0, 12)}…`;
        }
      }

      const resolvedAvatar =
        (isLocal ? localAvatar ?? undefined : getProfilePictureUrl(npubKey) ?? undefined) ??
        `https://robohash.org/${npubKey}.png`;

      entries.push({
        npub: npubKey,
        rect: value.rect,
        name: display ?? "Player",
        avatar: resolvedAvatar,
        speakingLevel,
        chat: chats.get(npubKey),
      });
    });

    return entries;
  });

  const handleLogout = () => {
    manager.clearActive();
  };

  const desiredAspect = 3 / 2;
  const app = new Application();
  let hasRenderer = false;
  let canvasAttached = false;

  const resizeViewport = () => {
    if (!containerRef) return;
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

      const game = await initGame(app, gameStore);
      gameInstance = game;

      cleanupRenderer = () => {
        game.destroy();
        gameInstance = null;
      };
    })
    .catch(error => {
      console.error("Failed to initialise PixiJS", error);
    });

  onCleanup(() => {
    disposed = true;
    cleanupRenderer?.();
    window.removeEventListener("resize", resizeViewport);
    if (canvasAttached && app.renderer && app.canvas.parentElement === containerRef) {
      containerRef?.removeChild(app.canvas);
    }
    if (hasRenderer && app.renderer) {
      app.destroy(true);
    }
    logoutService();
    stopGameServices();
  });

  return (
    <div class="app-shell">
      <div class="app-main">
        <Header
          pubkey={pubkey()}
          npub={npub()}
          localAlias={localAlias()}
          profileMap={profileMap()}
          audioState={audioState()}
          onLogout={handleLogout}
        />

        <div class="game-container">
          <div class="game-surface" ref={containerRef}>
            <div class="game-overlays">
              <div class="player-overlays">
                <For each={overlayEntries()}>
                  {entry => (
                    <div
                      class={`avatar-head${entry.speakingLevel > 0.02 ? " is-speaking" : ""}`}
                      style={{
                        width: `${entry.rect.width}px`,
                        height: `${entry.rect.height}px`,
                        transform: `translate3d(${entry.rect.x}px, ${entry.rect.y}px, 0)`,
                      }}
                    >
                      <img src={entry.avatar} alt={entry.name} />
                      <div class="avatar-head__label">
                        <span>{entry.name}</span>
                        <Show when={entry.chat}>
                          <span class="avatar-head__chat">{entry.chat!.message}</span>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>

        <Console
          isLoggedIn={!showLoginOverlay()}
          logMessages={logMessages()}
          onAppendLog={message => gameStore.logInfo(message)}
          onSetInputCaptured={captured => gameStore.dispatch({ type: "set-input-captured", captured })}
          onSpawn={requestSpawn}
        />
      </div>

      <div class="app-sidebar">
        <Show when={showLoginOverlay()}>
          <Login />
        </Show>
        <Dpad visible={!showLoginOverlay()} />
      </div>
    </div>
  );
};

export default App;
