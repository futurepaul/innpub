import { useEffect, useRef } from "react";

import "./index.css";
import { initGame } from "./game/initGame";
import { Application } from "pixi.js";

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);

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
        cleanup = await initGame(app);
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

  return <div className="viewport" ref={containerRef} />;
}

export default App;
