import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { Link } from "wouter";

import "./index.css";
import { initGame, type GameInstance } from "./game/initGame";
import { Application } from "pixi.js";
import { ExtensionSigner } from "applesauce-signers";
import { getDisplayName } from "applesauce-core/helpers";
import { decode as decodeNip19, npubEncode } from "nostr-tools/nip19";
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
  setSyntheticTone as setSyntheticToneSource,
  subscribeChats,
  sendChatMessage,
  type ChatMessage,
} from "./multiplayer/stream";

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const consoleInputRef = useRef<HTMLInputElement>(null);
  const gameInstanceRef = useRef<GameInstance | null>(null);
  const consoleLogRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<string | null>(null);
  const pubkeyRef = useRef<string | null>(null);
  const remotePlayersRef = useRef<PlayerState[]>([]);

  const [playerPosition, setPlayerPosition] = useState({ x: 0, y: 0 });
  const [playerRooms, setPlayerRooms] = useState<string[]>([]);
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [inputMode, setInputMode] = useState<"command" | "chat" | null>(null);
  const [consoleInput, setConsoleInput] = useState("/");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [npub, setNpub] = useState<string | null>(null);
  const [npubInputValue, setNpubInputValue] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [remotePlayers, setRemotePlayers] = useState<PlayerState[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, PlayerProfile>>(new Map());
  const [headRects, setHeadRects] = useState<Map<string, { rect: { x: number; y: number; width: number; height: number }; facing: FacingDirection }>>(new Map());
  const [playerFacing, setPlayerFacing] = useState<FacingDirection>(1);
  const [audioState, setAudioState] = useState<AudioControlState>(() => getAudioState());
  const [chatMap, setChatMap] = useState<Map<string, ChatMessage>>(new Map());
  const [toneEnabled, setToneEnabled] = useState(false);
  const [toneFrequency, setToneFrequency] = useState(440);
  const [toneAmplitude, setToneAmplitude] = useState(0.05);

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
    (hex: string) => {
      const normalized = hex.toLowerCase();
      const encoded = npubEncode(normalized);
      pubkeyRef.current = normalized;
      setPubkey(normalized);
      setNpub(encoded);
      setLoginError(null);
      setNpubInputValue("");
      appendLog(`Logged in as ${encoded}`);
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

      let targetWidth = window.innerWidth;
      let targetHeight = targetWidth / desiredAspect;

      if (targetHeight > window.innerHeight) {
        targetHeight = window.innerHeight;
        targetWidth = targetHeight * desiredAspect;
      }

      targetWidth = Math.floor(targetWidth);
      targetHeight = Math.floor(targetHeight);

      container.style.width = `${targetWidth}px`;
      container.style.height = `${targetHeight}px`;
      container.style.maxWidth = "100vw";
      container.style.maxHeight = "100vh";

      app.renderer.resize(targetWidth, targetHeight);
    };

    app
      .init({
        background: "#121212",
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
        container.appendChild(app.canvas);
        canvasAttached = true;
        const game = await initGame(app, {
          onPlayerPosition: data => {
            setPlayerPosition({ x: data.x, y: data.y });
            setPlayerFacing(data.facing);
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
    if (!consoleOpen) {
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
  }, [consoleOpen, consoleInput.length]);

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

    if (!pubkey || consoleOpen) {
      gameInstanceRef.current.setInputCaptured(true);
    } else {
      gameInstanceRef.current.setInputCaptured(false);
    }
  }, [pubkey, consoleOpen]);

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
        return;
      }

      if (!isModifierHeld && (event.key === "t" || event.key === "T")) {
        event.preventDefault();
        event.stopPropagation();
        setInputMode("chat");
        setConsoleInput("");
        gameInstanceRef.current?.setInputCaptured(true);
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
    setInputMode(null);
    setConsoleInput("/");
    appendLog("Logged out");
    avatarRef.current = null;
    gameInstanceRef.current?.setAvatar(null);
    setPlayerRooms([]);
    void setMicrophoneEnabled(false);
    setToneEnabled(false);
    void setSyntheticToneSource({ enabled: false });
  }, [appendLog]);

  const handleConsoleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setConsoleInput("/");
      setInputMode(null);
      gameInstanceRef.current?.setInputCaptured(false);
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

  const localProfile = pubkey ? profileMap.get(pubkey)?.profile : undefined;

  const displayName = useMemo(() => {
    const name = localProfile ? getDisplayName(localProfile) : null;
    if (name) {
      return name;
    }
    if (npub) {
      return `${npub.slice(0, 12)}…`;
    }
    return null;
  }, [localProfile, npub]);

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
    void setSyntheticToneSource({
      enabled: toneEnabled,
      frequency: toneFrequency,
      amplitude: toneAmplitude,
    });
  }, [toneEnabled, toneFrequency, toneAmplitude]);

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
  const statusMessage = inputMode === "chat" ? "Chat ready" : inputMode === "command" ? "Console ready" : "Press T to chat, / for commands";
  const visibleLogs = lines.length > 0 ? lines : [statusMessage];

  return (
    <div className="viewport" ref={containerRef}>
      <div className="hud" aria-hidden={!consoleOpen && visibleLogs.length === 0}>
        <div className="hud-top">
          <div className="debug-panel">
            <div className="debug-title">Debug</div>
            <div className="debug-row">x: {Math.round(playerPosition.x)}</div>
            <div className="debug-row">y: {Math.round(playerPosition.y)}</div>
            <Link href="/audio-lab" className="debug-link">
              Open Audio Lab ↗
            </Link>
          </div>

          {pubkey ? (
            <div className="login-panel">
              <div className="login-summary">
                {avatarUrl ? (
                  <img className="login-avatar" src={avatarUrl} alt="Avatar" />
                ) : (
                  <div className="login-avatar placeholder" />
                )}
                <div className="login-details">
                  <div className="login-label">Logged in</div>
                  <div className="login-name" title={npub ?? undefined}>
                    {displayName ?? (npub ? `${npub.slice(0, 12)}…` : "Anon")}
                  </div>
                </div>
                <button type="button" className="btn-link" onClick={handleLogout}>
                  Logout
                </button>
              </div>
              <div className="audio-controls">
                <button
                  type="button"
                  className={`audio-btn${audioState.micEnabled ? " is-on" : ""}`}
                  onClick={handleToggleMic}
                  disabled={!audioState.supported}
                  title={audioState.supported ? undefined : "Microphone not supported"}
                >
                  {audioState.micEnabled ? "Mic On" : "Mic Off"}
                </button>
                <button
                  type="button"
                  className={`audio-btn${audioState.speakerEnabled ? " is-on" : ""}`}
                  onClick={handleToggleSpeaker}
                >
                  {audioState.speakerEnabled ? "Speaker On" : "Speaker Off"}
                </button>
                <button
                  type="button"
                  className={`audio-btn tone-btn${toneEnabled ? " is-on" : ""}`}
                  onClick={() => {
                    setToneEnabled(prev => {
                      const next = !prev;
                      void setSyntheticToneSource({
                        enabled: next,
                        frequency: toneFrequency,
                        amplitude: toneAmplitude,
                      });
                      appendLog(next ? "Synthetic tone enabled" : "Synthetic tone disabled");
                      return next;
                    });
                  }}
                >
                  {toneEnabled ? "Tone On" : "Test Tone"}
                </button>
              </div>
              <div className="tone-controls">
                <label>
                  <span>Freq</span>
                  <input
                    type="number"
                    min={50}
                    max={4000}
                    value={toneFrequency}
                    onChange={event => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        const clamped = Math.min(4000, Math.max(50, value));
                        setToneFrequency(clamped);
                        void setSyntheticToneSource({
                          enabled: toneEnabled,
                          frequency: clamped,
                          amplitude: toneAmplitude,
                        });
                      }
                    }}
                  />
                </label>
                <label>
                  <span>Gain</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={toneAmplitude}
                    onChange={event => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value)) {
                        const clamped = Math.min(1, Math.max(0, value));
                        setToneAmplitude(clamped);
                        void setSyntheticToneSource({
                          enabled: toneEnabled,
                          frequency: toneFrequency,
                          amplitude: clamped,
                        });
                      }
                    }}
                  />
                </label>
              </div>
              {audioState.micError ? <div className="audio-error">{audioState.micError}</div> : null}
            </div>
          ) : null}
        </div>

        <div className={`console-panel${consoleOpen ? " is-open" : ""}`}>
          <div className="console-log" ref={consoleLogRef}>
            {visibleLogs.map((line, index) => (
              <div key={`${index}-${line}`} className="console-line">
                {line}
              </div>
            ))}
          </div>
          {consoleOpen && (
            <form className="console-input" onSubmit={handleConsoleSubmit}>
              <span className="console-prompt">&gt;</span>
              <input
                ref={consoleInputRef}
                value={consoleInput}
                onChange={event => setConsoleInput(event.target.value)}
                onKeyDown={handleConsoleInputKeyDown}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                aria-label="Console input"
                placeholder={inputMode === "chat" ? "Type a message…" : undefined}
              />
            </form>
          )}
        </div>
      </div>

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

      {!pubkey && (
        <div className="login-overlay">
          <div className="login-modal">
            <h1>InnPub</h1>
            <p className="login-description">Sign in with your Nostr public key to enter the tavern.</p>
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
