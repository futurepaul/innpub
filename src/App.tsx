import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import "./index.css";
import { initGame, type GameInstance } from "./game/initGame";
import { Application } from "pixi.js";

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const consoleInputRef = useRef<HTMLInputElement>(null);
  const gameInstanceRef = useRef<GameInstance | null>(null);
  const consoleLogRef = useRef<HTMLDivElement>(null);

  const [playerPosition, setPlayerPosition] = useState({ x: 0, y: 0 });
  const [logMessages, setLogMessages] = useState<string[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleInput, setConsoleInput] = useState("/");

  const appendLog = useCallback((message: string) => {
    setLogMessages(prev => {
      const next = [...prev, message];
      if (next.length > 100) {
        return next.slice(next.length - 100);
      }
      return next;
    });
  }, []);

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

  const handleConsoleInputKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setConsoleInput("/");
      setConsoleOpen(false);
      gameInstanceRef.current?.setInputCaptured(false);
    }
  }, []);

  const lines = consoleOpen ? logMessages : logMessages.slice(-1);
  const visibleLogs = lines.length > 0 ? lines : [consoleOpen ? "Console ready" : "Press / to open console"];

  return (
    <div className="viewport" ref={containerRef}>
      <div className="hud" aria-hidden={!consoleOpen && visibleLogs.length === 0}>
        <div className="debug-panel">
          <div className="debug-title">Debug</div>
          <div className="debug-row">x: {Math.round(playerPosition.x)}</div>
          <div className="debug-row">y: {Math.round(playerPosition.y)}</div>
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
