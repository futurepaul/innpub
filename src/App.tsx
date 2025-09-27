import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import "./index.css";
import { initGame, type GameInstance } from "./game/initGame";
import { Application } from "pixi.js";
import { ExtensionSigner } from "applesauce-signers";
import { getDisplayName } from "applesauce-core/helpers";
import { decode as decodeNip19, npubEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  startStream,
  stopStream,
  subscribe,
  subscribeProfiles,
  updateLocalPlayer,
  updateLocalRooms,
  removePlayer,
  type PlayerState,
  type PlayerProfile,
  type FacingDirection,
  getProfilePictureUrl,
  subscribeAudioState,
  setMicrophoneEnabled,
  setSpeakerEnabled,
  getAudioState,
  type AudioControlState,
  subscribeChats,
  sendChatMessage,
  type ChatMessage,
} from "./multiplayer/stream";

type DirectionKey = "up" | "down" | "left" | "right";

const DIRECTION_KEY_MAP: Record<DirectionKey, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const consoleInputRef = useRef<HTMLInputElement>(null);
  const gameInstanceRef = useRef<GameInstance | null>(null);
  const consoleLogRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<string | null>(null);
  const pubkeyRef = useRef<string | null>(null);
  const remotePlayersRef = useRef<PlayerState[]>([]);

  const [playerRooms, setPlayerRooms] = useState<string[]>([]);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [inputMode, setInputMode] = useState<"command" | "chat" | null>(null);
  const [consoleInput, setConsoleInput] = useState("/");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [npub, setNpub] = useState<string | null>(null);
  const [localAlias, setLocalAlias] = useState<string | null>(null);
  const [npubInputValue, setNpubInputValue] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [remotePlayers, setRemotePlayers] = useState<PlayerState[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, PlayerProfile>>(new Map());
  const [headRects, setHeadRects] = useState<Map<string, { rect: { x: number; y: number; width: number; height: number }; facing: FacingDirection }>>(new Map());
  const [audioState, setAudioState] = useState<AudioControlState>(() => getAudioState());
  const [chatMap, setChatMap] = useState<Map<string, ChatMessage>>(new Map());
  const [guestNameInput, setGuestNameInput] = useState("");
  const [consoleFocusReason, setConsoleFocusReason] = useState<"keyboard" | "pointer" | null>(null);
  const consoleOpen = inputMode !== null;
  const profileMapRef = useRef<Map<string, PlayerProfile>>(new Map());
  const chatSeenRef = useRef<Map<string, string>>(new Map());

  const appendLog = useCallback((message: string) => {
    setLogMessages(prev => {
      const next = [...prev, message];
      if (next.length > 100) {
        return next.slice(next.length - 100);
      }
      return next;
    });
  }, []);

  const activeDirectionsRef = useRef<Set<DirectionKey>>(new Set());

  const pressDirection = useCallback(
    (direction: DirectionKey) => {
      if (activeDirectionsRef.current.has(direction)) {
        return;
      }
      activeDirectionsRef.current.add(direction);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: DIRECTION_KEY_MAP[direction], bubbles: true }));
    },
    [],
  );

  const releaseDirection = useCallback(
    (direction: DirectionKey) => {
      if (!activeDirectionsRef.current.has(direction)) {
        return;
      }
      activeDirectionsRef.current.delete(direction);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: DIRECTION_KEY_MAP[direction], bubbles: true }));
    },
    [],
  );

  const createDpadPressHandler = useCallback(
    (direction: DirectionKey) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pressDirection(direction);
    },
    [pressDirection],
  );

  const createDpadReleaseHandler = useCallback(
    (direction: DirectionKey) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      releaseDirection(direction);
    },
    [releaseDirection],
  );

  const resolvePubkey = useCallback((input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("Enter a public key");
    }

    if (/^npub/i.test(trimmed)) {
      const decoded = decodeNip19(trimmed);
      if (decoded.type !== "npub") {
        throw new Error("Unsupported NIP-19 format");
      }
      const data = decoded.data;
      if (typeof data !== "string") {
        throw new Error("Invalid npub payload");
      }
      return data.toLowerCase();
    }

    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    throw new Error("Invalid public key");
  }, []);

  const finalizeLogin = useCallback(
    (hex: string, alias?: string) => {
      const normalized = hex.toLowerCase();
      const encoded = npubEncode(normalized);
      pubkeyRef.current = normalized;
      setPubkey(normalized);
      setNpub(encoded);
      setLocalAlias(alias ?? null);
      setLoginError(null);
      setNpubInputValue("");
      setGuestNameInput("");
      appendLog(alias ? `Joined as ${alias} (${encoded})` : `Logged in as ${encoded}`);
      gameInstanceRef.current?.spawn();
    },
    [appendLog],
  );

  useEffect(() => {
    pubkeyRef.current = pubkey;
  }, [pubkey]);

  useEffect(() => {
    profileMapRef.current = profileMap;
  }, [profileMap]);

  useEffect(() => {
    startStream();
    const unsubscribePlayers = subscribe(states => {
      remotePlayersRef.current = states;
      setRemotePlayers(states);
    });
    const unsubscribeProfiles = subscribeProfiles(map => {
      const clone = new Map(map);
      profileMapRef.current = clone;
      setProfileMap(clone);
    });
    const unsubscribeAudio = subscribeAudioState(state => {
      setAudioState(state);
    });
    const unsubscribeChats = subscribeChats(map => {
      const clone = new Map(map);
      setChatMap(clone);

      const seen = chatSeenRef.current;
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

        const currentPubkey = pubkeyRef.current;
        const isLocal = currentPubkey ? entry.npub === currentPubkey : false;
        const profile = profileMapRef.current.get(entry.npub)?.profile;
        const display = isLocal
          ? "You"
          : profile
            ? getDisplayName(profile) ?? `${entry.npub.slice(0, 12)}…`
            : `${entry.npub.slice(0, 12)}…`;
        appendLog(`[Chat] ${display}: ${entry.message}`);
      });
    });

    return () => {
      if (pubkeyRef.current) {
        removePlayer(pubkeyRef.current);
      }
      setPlayerRooms([]);
      unsubscribeProfiles();
      unsubscribePlayers();
      unsubscribeAudio();
      unsubscribeChats();
      chatSeenRef.current.clear();
      setChatMap(new Map());
      stopStream();
    };
  }, []);

  useEffect(() => {
    updateLocalRooms(playerRooms);
  }, [playerRooms]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const desiredAspect = 3 / 2;
    const app = new Application();
    let disposed = false;
    let cleanup: (() => void) | undefined;
    let hasRenderer = false;
    let canvasAttached = false;

    const resizeViewport = () => {
      if (!hasRenderer || !app.renderer) {
        return;
      }

      const parent = container.parentElement as HTMLElement | null;
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

      container.style.width = `${targetWidth}px`;
      container.style.height = `${targetHeight}px`;
      container.style.maxWidth = "100%";

      app.renderer.resize(targetWidth, targetHeight);
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
        const firstChild = container.firstChild;
        if (firstChild) {
          container.insertBefore(app.canvas, firstChild);
        } else {
          container.appendChild(app.canvas);
        }
        canvasAttached = true;
        const game = await initGame(app, {
          onPlayerPosition: data => {
            const currentNpub = pubkeyRef.current;
            if (currentNpub) {
              updateLocalPlayer({ npub: currentNpub, x: data.x, y: data.y, facing: data.facing });
            }
          },
          onConsoleMessage: appendLog,
          onHeadPosition: (id, rect, facing) => {
            const key = id === "local" ? pubkeyRef.current : id;
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
        gameInstanceRef.current = game;
        game.setAvatar(avatarRef.current);
        const currentNpub = pubkeyRef.current;
        const remotes = remotePlayersRef.current.filter(player => player.npub !== currentNpub);
        game.syncPlayers(remotes);
        cleanup = () => {
          game.destroy();
          gameInstanceRef.current = null;
        };
      })
      .catch(error => {
        console.error("Failed to initialise PixiJS", error);
      });

    return () => {
      disposed = true;
      cleanup?.();
      window.removeEventListener("resize", resizeViewport);
      if (canvasAttached && app.renderer && app.canvas.parentElement === container) {
        container.removeChild(app.canvas);
      }
      if (hasRenderer && app.renderer) {
        app.destroy(true);
      }
    };
  }, []);

  useEffect(() => {
    if (!consoleOpen || consoleFocusReason !== "keyboard") {
      return;
    }
    const input = consoleInputRef.current;
    if (!input) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(consoleInput.length, consoleInput.length);
    });

    return () => cancelAnimationFrame(frame);
  }, [consoleOpen, consoleInput.length, consoleFocusReason]);

  useEffect(() => {
    if (!consoleOpen) {
      return;
    }

    const element = consoleLogRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [consoleOpen, logMessages.length]);

  useEffect(() => {
    if (!gameInstanceRef.current) {
      return;
    }

    if (!pubkey) {
      gameInstanceRef.current.setInputCaptured(true);
      return;
    }

    const input = consoleInputRef.current;
    const shouldCapture = Boolean(consoleOpen && (consoleFocusReason === "keyboard" || document.activeElement === input));
    gameInstanceRef.current.setInputCaptured(shouldCapture);
  }, [pubkey, consoleOpen, consoleFocusReason]);

  useEffect(() => {
    if (!consoleOpen) {
      setConsoleFocusReason(null);
    }
  }, [consoleOpen]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (inputMode) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }

      const isModifierHeld = event.ctrlKey || event.metaKey || event.altKey;
      if (!isModifierHeld && event.key === "/") {
        event.preventDefault();
        event.stopPropagation();
        setInputMode("command");
        setConsoleInput("/");
        gameInstanceRef.current?.setInputCaptured(true);
        setConsoleFocusReason("keyboard");
        return;
      }

      if (!isModifierHeld && (event.key === "t" || event.key === "T")) {
        event.preventDefault();
        event.stopPropagation();
        setInputMode("chat");
        setConsoleInput("");
        gameInstanceRef.current?.setInputCaptured(true);
        setConsoleFocusReason("keyboard");
      }
    };

    window.addEventListener("keydown", handleShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleShortcut, { capture: true });
  }, [inputMode]);

  const handleConsoleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const mode = inputMode;
      const trimmed = consoleInput.trim();

      if (mode === "chat") {
        if (trimmed.length > 0) {
          try {
            await sendChatMessage(trimmed);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to send chat";
            appendLog(`[Chat] ${message}`);
          }
        }
      } else if (mode === "command") {
        if (trimmed.length > 0 && trimmed !== "/") {
          appendLog(`> ${trimmed}`);
          if (trimmed === "/spawn") {
            gameInstanceRef.current?.spawn();
          }
        }
      }

      setConsoleInput("/");
      setInputMode(null);
      setConsoleFocusReason(null);
      gameInstanceRef.current?.setInputCaptured(false);
    },
    [appendLog, consoleInput, inputMode],
  );

  const handleManualLogin = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      try {
        const pubkeyHex = resolvePubkey(npubInputValue);
        finalizeLogin(pubkeyHex);
      } catch (error) {
        setLoginError(error instanceof Error ? error.message : "Failed to parse public key");
      }
    },
    [finalizeLogin, npubInputValue, resolvePubkey],
  );

  const handleExtensionLogin = useCallback(async () => {
    setLoginPending(true);
    setLoginError(null);
    try {
      const signer = new ExtensionSigner();
      const pubkeyHex = await signer.getPublicKey();
      finalizeLogin(pubkeyHex);
    } catch (error) {
      console.error("Extension login failed", error);
      setLoginError("Failed to login with NIP-07 extension");
    } finally {
      setLoginPending(false);
    }
  }, [finalizeLogin]);

  const handleGuestLogin = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = guestNameInput.trim();
      if (!trimmed) {
        setLoginError("Pick a display name to join as a guest.");
        return;
      }
      try {
        const secretKey = generateSecretKey();
        const pubkeyHex = getPublicKey(secretKey);
        finalizeLogin(pubkeyHex, trimmed);
      } catch (error) {
        console.error("Guest login failed", error);
        setLoginError("Failed to generate a guest identity");
      }
    },
    [finalizeLogin, guestNameInput],
  );

  const handleLogout = useCallback(() => {
    const previousNpub = pubkeyRef.current;
    if (previousNpub) {
      removePlayer(previousNpub);
      setHeadRects(prev => {
        const next = new Map(prev);
        next.delete(previousNpub);
        return next;
      });
    }
    pubkeyRef.current = null;
    setPubkey(null);
    setNpub(null);
    setLoginError(null);
    setNpubInputValue("");
    setGuestNameInput("");
    setLocalAlias(null);
    setInputMode(null);
    setConsoleInput("/");
    setConsoleFocusReason(null);
    appendLog("Logged out");
    avatarRef.current = null;
    gameInstanceRef.current?.setAvatar(null);
    setPlayerRooms([]);
    void setMicrophoneEnabled(false);
  }, [appendLog]);

  const handleConsoleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setConsoleInput("/");
      setInputMode(null);
      gameInstanceRef.current?.setInputCaptured(false);
      setConsoleFocusReason(null);
    }
  }, []);

  const handleToggleMic = useCallback(async () => {
    if (!audioState.supported) {
      return;
    }
    try {
      await setMicrophoneEnabled(!audioState.micEnabled);
    } catch (error) {
      console.error("Failed to toggle microphone", error);
    }
  }, [audioState.micEnabled, audioState.supported]);

  const handleToggleSpeaker = useCallback(() => {
    setSpeakerEnabled(!audioState.speakerEnabled);
  }, [audioState.speakerEnabled]);

  const handleConsoleTap = useCallback(() => {
    if (consoleOpen || !pubkey) {
      return;
    }
    setInputMode("chat");
    setConsoleInput("");
    gameInstanceRef.current?.setInputCaptured(true);
    setConsoleFocusReason("pointer");
  }, [consoleOpen, pubkey]);

  const localProfile = pubkey ? profileMap.get(pubkey)?.profile : undefined;

  const displayName = useMemo(() => {
    if (localAlias) {
      return localAlias;
    }
    const name = localProfile ? getDisplayName(localProfile) : null;
    if (name) {
      return name;
    }
    if (npub) {
      return `${npub.slice(0, 12)}…`;
    }
    return null;
  }, [localAlias, localProfile, npub]);

  const avatarUrl = useMemo(() => {
    if (!pubkey) {
      return null;
    }
    return getProfilePictureUrl(pubkey) ?? null;
  }, [pubkey, profileMap]);

  useEffect(() => {
    avatarRef.current = avatarUrl;
    if (!gameInstanceRef.current) {
      return;
    }
    gameInstanceRef.current.setAvatar(avatarUrl);
  }, [avatarUrl]);

  useEffect(() => {
    const game = gameInstanceRef.current;
    if (!game) {
      return;
    }
    const currentNpub = pubkeyRef.current;
    const remotes = remotePlayers.filter(player => player.npub !== currentNpub);
    game.syncPlayers(remotes);
  }, [remotePlayers]);

  const overlayEntries = useMemo(() => {
    const stateMap = new Map(remotePlayers.map(player => [player.npub, player]));
    const entries: Array<{
      npub: string;
      rect: { x: number; y: number; width: number; height: number };
      name: string;
      avatar: string;
      speakingLevel: number;
      chat?: ChatMessage;
    }> = [];
    headRects.forEach(({ rect }, key) => {
      const profile = profileMap.get(key)?.profile;
      let display = profile ? getDisplayName(profile) : `${key.slice(0, 12)}…`;
      if (key === (npub ?? "")) {
        display = displayName ?? display;
      }

      const avatar =
        getProfilePictureUrl(key) ??
        (key === (npub ?? "") ? avatarUrl ?? undefined : undefined) ??
        `https://robohash.org/${key}.png`;

      const playerState = stateMap.get(key);
      const speakingLevel = playerState?.speakingLevel ?? 0;
      const chat = chatMap.get(key);

      entries.push({ npub: key, rect, name: display ?? "Player", avatar, speakingLevel, chat });
    });
    return entries;
  }, [headRects, profileMap, npub, displayName, avatarUrl, remotePlayers, chatMap]);

  const lines = consoleOpen ? logMessages : logMessages.slice(-1);
  const statusMessage = inputMode === "chat" ? "Chat ready" : inputMode === "command" ? "Console ready" : "Tap here or press T to chat";
  const visibleLogs = lines.length > 0 ? lines : [statusMessage];
  const consoleRegionClass = `console-region${consoleOpen ? " is-open" : ""}`;

  return (
    <div className="app-shell">
      <div className="app-main">
        <header className="status-bar">
          {pubkey ? (
            <div className="status-strip">
              <div className="status-strip__identity">
                {avatarUrl ? (
                  <img className="status-strip__avatar" src={avatarUrl} alt="Avatar" />
                ) : (
                  <div className="status-strip__avatar status-strip__avatar--placeholder" />
                )}
                <div className="status-strip__meta">
                  <span className="status-strip__label">Logged in</span>
                  <span className="status-strip__name" title={npub ?? undefined}>
                    {displayName ?? (npub ? `${npub.slice(0, 12)}…` : "Guest")}
                  </span>
                </div>
              </div>
              <div className="status-strip__controls">
                <button
                  type="button"
                  className={`status-strip__btn${audioState.micEnabled ? " is-on" : ""}`}
                  onClick={handleToggleMic}
                  disabled={!audioState.supported}
                >
                  {audioState.micEnabled ? "Mic On" : "Mic Off"}
                </button>
                <button
                  type="button"
                  className={`status-strip__btn${audioState.speakerEnabled ? " is-on" : ""}`}
                  onClick={handleToggleSpeaker}
                >
                  {audioState.speakerEnabled ? "Speaker On" : "Speaker Off"}
                </button>
                <button type="button" className="status-strip__btn status-strip__btn--ghost" onClick={handleLogout}>
                  Logout
                </button>
              </div>
              {audioState.micError ? <div className="status-error">{audioState.micError}</div> : null}
            </div>
          ) : (
            <div className="status-strip status-strip--placeholder">Sign in to explore the InnPub.</div>
          )}
        </header>

        <div className="game-container">
          <div className="game-surface" ref={containerRef}>
            <div className="game-overlays">
              <div className="player-overlays">
                {overlayEntries.map(entry => (
                  <div
                    key={entry.npub}
                    className={`avatar-head${entry.speakingLevel > 0.02 ? " is-speaking" : ""}`}
                    style={{
                      width: `${entry.rect.width}px`,
                      height: `${entry.rect.height}px`,
                      transform: `translate3d(${entry.rect.x}px, ${entry.rect.y}px, 0)`,
                    }}
                  >
                    <img src={entry.avatar} alt={entry.name} />
                    {entry.chat ? (
                      <div className="chat-bubble" key={entry.chat.id}>
                        <span>{entry.chat.message}</span>
                      </div>
                    ) : null}
                    <div className="avatar-label">{entry.name}</div>
                  </div>
                ))}
              </div>
              {pubkey ? (
                <div className="dpad" aria-hidden="true">
                  <button
                    type="button"
                    className="dpad-btn dpad-btn--up"
                    onPointerDown={createDpadPressHandler("up")}
                    onPointerUp={createDpadReleaseHandler("up")}
                    onPointerLeave={createDpadReleaseHandler("up")}
                    onPointerCancel={createDpadReleaseHandler("up")}
                  >
                    ↑
                  </button>
                  <div className="dpad-middle">
                    <button
                      type="button"
                      className="dpad-btn dpad-btn--left"
                      onPointerDown={createDpadPressHandler("left")}
                      onPointerUp={createDpadReleaseHandler("left")}
                      onPointerLeave={createDpadReleaseHandler("left")}
                      onPointerCancel={createDpadReleaseHandler("left")}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="dpad-btn dpad-btn--right"
                      onPointerDown={createDpadPressHandler("right")}
                      onPointerUp={createDpadReleaseHandler("right")}
                      onPointerLeave={createDpadReleaseHandler("right")}
                      onPointerCancel={createDpadReleaseHandler("right")}
                    >
                      →
                    </button>
                  </div>
                  <button
                    type="button"
                    className="dpad-btn dpad-btn--down"
                    onPointerDown={createDpadPressHandler("down")}
                    onPointerUp={createDpadReleaseHandler("down")}
                    onPointerLeave={createDpadReleaseHandler("down")}
                    onPointerCancel={createDpadReleaseHandler("down")}
                  >
                    ↓
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <section
          className={consoleRegionClass}
          onClick={consoleOpen ? undefined : handleConsoleTap}
          role="presentation"
        >
          <div className="console-region__log" ref={consoleLogRef}>
            {visibleLogs.map((line, index) => (
              <div key={`${index}-${line}`} className="console-line">
                {line}
              </div>
            ))}
          </div>
          {consoleOpen && (
            <form className="console-region__form" onSubmit={handleConsoleSubmit}>
              <span className="console-region__prompt">&gt;</span>
              <input
                ref={consoleInputRef}
                value={consoleInput}
                onChange={event => setConsoleInput(event.target.value)}
                onKeyDown={handleConsoleInputKeyDown}
                onFocus={() => setConsoleFocusReason("keyboard")}
                onBlur={() => setConsoleFocusReason(null)}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                aria-label="Console input"
                placeholder={inputMode === "chat" ? "Type a message…" : undefined}
              />
            </form>
          )}
        </section>
      </div>

      {!pubkey && (
        <div className="login-overlay">
          <div className="login-modal">
            <h1>INNPUB</h1>
            <p className="login-description">Choose how you want to enter the tavern.</p>
            <form className="login-form" onSubmit={handleManualLogin}>
              <input
                type="text"
                value={npubInputValue}
                onChange={event => {
                  setNpubInputValue(event.target.value);
                  setLoginError(null);
                }}
                placeholder="Paste your npub or hex public key"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
              />
              <button type="submit" disabled={loginPending}>
                Continue
              </button>
            </form>
            <div className="login-divider" aria-hidden="true">
              <span>or</span>
            </div>
            <form className="guest-form" onSubmit={handleGuestLogin}>
              <input
                type="text"
                value={guestNameInput}
                onChange={event => {
                  setGuestNameInput(event.target.value);
                  setLoginError(null);
                }}
                placeholder="Pick a display name"
                maxLength={32}
              />
              <button type="submit">Join as Guest</button>
            </form>
            <button type="button" className="ext-login" onClick={handleExtensionLogin} disabled={loginPending}>
              {loginPending ? "Connecting…" : "Login with NIP-07"}
            </button>
            {loginError && <div className="login-error">{loginError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
