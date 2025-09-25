import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import "./index.css";
import { initGame, type GameInstance } from "./game/initGame";
import { Application } from "pixi.js";
import { ExtensionSigner } from "applesauce-signers";
import { useObservableMemo } from "applesauce-react/hooks";
import { getDisplayName, getProfilePicture } from "applesauce-core/helpers";
import { decode as decodeNip19, npubEncode } from "nostr-tools/nip19";
import { eventStore, DEFAULT_RELAYS } from "./nostr/client";

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const consoleInputRef = useRef<HTMLInputElement>(null);
  const gameInstanceRef = useRef<GameInstance | null>(null);
  const consoleLogRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<string | null>(null);

  const [playerPosition, setPlayerPosition] = useState({ x: 0, y: 0 });
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleInput, setConsoleInput] = useState("/");
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [npub, setNpub] = useState<string | null>(null);
  const [npubInputValue, setNpubInputValue] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);

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
          onPlayerPosition: position => setPlayerPosition(position),
          onConsoleMessage: appendLog,
        });
        gameInstanceRef.current = game;
        game.setAvatar(avatarRef.current);
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
    const handleOpenConsole = (event: globalThis.KeyboardEvent) => {
      if (consoleOpen) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        setConsoleOpen(true);
        setConsoleInput("/");
        gameInstanceRef.current?.setInputCaptured(true);
      }
    };

    window.addEventListener("keydown", handleOpenConsole, { capture: true });
    return () => window.removeEventListener("keydown", handleOpenConsole, { capture: true });
  }, [consoleOpen]);

  const handleConsoleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = consoleInput.trim();
      if (trimmed.length > 0 && trimmed !== "/") {
        appendLog(`> ${trimmed}`);
        if (trimmed === "/spawn") {
          gameInstanceRef.current?.spawn();
        }
      }

      setConsoleInput("/");
      setConsoleOpen(false);
      gameInstanceRef.current?.setInputCaptured(false);
    },
    [appendLog, consoleInput],
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
    setPubkey(null);
    setNpub(null);
    setLoginError(null);
    setNpubInputValue("");
    appendLog("Logged out");
    gameInstanceRef.current?.setAvatar(null);
  }, [appendLog]);

  const handleConsoleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setConsoleInput("/");
      setConsoleOpen(false);
      gameInstanceRef.current?.setInputCaptured(false);
    }
  }, []);

  const profile = useObservableMemo(
    () => (pubkey ? eventStore.profile({ pubkey, relays: DEFAULT_RELAYS }) : undefined),
    [pubkey],
  );

  const displayName = useMemo(() => {
    const name = profile ? getDisplayName(profile) : null;
    if (name) {
      return name;
    }
    if (npub) {
      return `${npub.slice(0, 12)}…`;
    }
    return null;
  }, [profile, npub]);

  const avatarUrl = useMemo(() => {
    if (!pubkey) {
      return null;
    }
    const url = getProfilePicture(profile ?? undefined, undefined);
    return url ?? null;
  }, [profile, pubkey]);

  useEffect(() => {
    avatarRef.current = avatarUrl;
    if (!gameInstanceRef.current) {
      return;
    }
    gameInstanceRef.current.setAvatar(avatarUrl);
  }, [avatarUrl]);

  const lines = consoleOpen ? logMessages : logMessages.slice(-1);
  const visibleLogs = lines.length > 0 ? lines : [consoleOpen ? "Console ready" : "Press / to open console"];

  return (
    <div className="viewport" ref={containerRef}>
      <div className="hud" aria-hidden={!consoleOpen && visibleLogs.length === 0}>
        <div className="hud-top">
          <div className="debug-panel">
            <div className="debug-title">Debug</div>
            <div className="debug-row">x: {Math.round(playerPosition.x)}</div>
            <div className="debug-row">y: {Math.round(playerPosition.y)}</div>
          </div>

          <div className="login-panel">
            {pubkey ? (
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
            ) : (
              <div className="login-controls">
                <form className="login-form" onSubmit={handleManualLogin}>
                  <input
                    type="text"
                    value={npubInputValue}
                    onChange={event => {
                      setNpubInputValue(event.target.value);
                      setLoginError(null);
                    }}
                    placeholder="Enter npub or hex"
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                  />
                  <button type="submit" disabled={loginPending}>
                    Use npub
                  </button>
                </form>
                <button type="button" className="ext-login" onClick={handleExtensionLogin} disabled={loginPending}>
                  {loginPending ? "Connecting…" : "Login with NIP-07"}
                </button>
              </div>
            )}
            {loginError && <div className="login-error">{loginError}</div>}
          </div>
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
              />
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
