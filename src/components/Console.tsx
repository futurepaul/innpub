import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import { sendChat } from "../game/service";

export interface ConsoleProps {
  /** Whether the user is logged in (affects console behavior) */
  isLoggedIn: boolean;
  /** Array of log messages to display */
  logMessages: string[];
  /** Function to append a new log message */
  onAppendLog: (message: string) => void;
  /** Function called when input capture state should change */
  onSetInputCaptured: (captured: boolean) => void;
  /** Function called when spawn command is executed */
  onSpawn: () => void;
}

export const Console: Component<ConsoleProps> = (props) => {
  let consoleInputRef: HTMLInputElement | undefined;
  let consoleLogRef: HTMLDivElement | undefined;
  let consoleRegionRef: HTMLElement | undefined;

  const [inputMode, setInputMode] = createSignal<"command" | "chat" | null>(null);
  const [consoleInput, setConsoleInput] = createSignal("/");
  const [consoleFocusReason, setConsoleFocusReason] = createSignal<"keyboard" | "pointer" | null>(null);

  const consoleOpen = createMemo(() => inputMode() !== null);

  // Console focus effect
  createEffect(() => {
    if (!consoleOpen() || consoleFocusReason() !== "keyboard") {
      return;
    }
    const input = consoleInputRef;
    if (!input) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(consoleInput().length, consoleInput().length);
    });

    onCleanup(() => cancelAnimationFrame(frame));
  });

  // Console scroll effect
  createEffect(() => {
    if (!consoleOpen()) {
      return;
    }

    const element = consoleLogRef;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  });

  // Input capture effect
  createEffect(() => {
    if (!props.isLoggedIn) {
      props.onSetInputCaptured(true);
      return;
    }

    const input = consoleInputRef;
    const shouldCapture = Boolean(consoleOpen() && (consoleFocusReason() === "keyboard" || document.activeElement === input));
    props.onSetInputCaptured(shouldCapture);
  });

  // Console focus reason reset effect
  createEffect(() => {
    if (!consoleOpen()) {
      setConsoleFocusReason(null);
    }
  });

  // Keyboard shortcuts effect
  createEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (inputMode()) {
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
        props.onSetInputCaptured(true);
        setConsoleFocusReason("keyboard");
        return;
      }

      if (!isModifierHeld && (event.key === "t" || event.key === "T")) {
        event.preventDefault();
        event.stopPropagation();
        setInputMode("chat");
        setConsoleInput("");
        props.onSetInputCaptured(true);
        setConsoleFocusReason("keyboard");
      }
    };

    window.addEventListener("keydown", handleShortcut, { capture: true });
    onCleanup(() => window.removeEventListener("keydown", handleShortcut, { capture: true }));
  });

  const handleConsoleSubmit = async (event: Event) => {
    event.preventDefault();
    const mode = inputMode();
    const trimmed = consoleInput().trim();

    const isCommand = trimmed.startsWith("/");

    if (isCommand) {
      if (trimmed !== "/") {
        props.onAppendLog(`> ${trimmed}`);
        if (trimmed === "/spawn") {
          props.onSpawn();
        }
      }
    } else if (trimmed.length > 0) {
      try {
        await sendChat(trimmed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to send chat";
        props.onAppendLog(`[Chat] ${message}`);
      }
    }

    setConsoleInput("/");
    setInputMode(null);
    setConsoleFocusReason(null);
    props.onSetInputCaptured(false);
  };

  const handleConsoleInputKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setConsoleInput("/");
      setInputMode(null);
      props.onSetInputCaptured(false);
      setConsoleFocusReason(null);
    }
  };

  const handleConsoleTap = () => {
    if (consoleOpen() || !props.isLoggedIn) {
      return;
    }
    setInputMode("chat");
    setConsoleInput("");
    props.onSetInputCaptured(true);
    setConsoleFocusReason("pointer");
  };

  // Reset console state when user logs out
  createEffect(() => {
    if (!props.isLoggedIn) {
      setInputMode(null);
      setConsoleInput("/");
      setConsoleFocusReason(null);
    }
  });

  const lines = createMemo(() => consoleOpen() ? props.logMessages : props.logMessages.slice(-1));
  const statusMessage = createMemo(() =>
    inputMode() === "chat" ? "Chat ready" :
    inputMode() === "command" ? "Console ready" :
    "Tap here or press T to chat"
  );
  const visibleLogs = createMemo(() => lines().length > 0 ? lines() : [statusMessage()]);
  const consoleRegionClass = createMemo(() => `console-region${consoleOpen() ? " is-open" : ""}`);

  createEffect(() => {
    if (!consoleOpen()) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!consoleRegionRef) {
        return;
      }
      if (consoleRegionRef.contains(event.target as Node)) {
        return;
      }

      setConsoleInput("/");
      setInputMode(null);
      setConsoleFocusReason(null);
      props.onSetInputCaptured(false);
    };

    window.addEventListener("pointerdown", handlePointerDown, { capture: true });
    onCleanup(() => window.removeEventListener("pointerdown", handlePointerDown, { capture: true }));
  });

  return (
    <section
      class={consoleRegionClass()}
      ref={element => {
        consoleRegionRef = element ?? undefined;
      }}
      onClick={consoleOpen() ? undefined : handleConsoleTap}
      role="presentation"
    >
      <div class="console-region__log" ref={consoleLogRef}>
        <For each={visibleLogs()}>
          {(line, index) => (
            <div class="console-line">
              {line}
            </div>
          )}
        </For>
      </div>
      <Show when={consoleOpen()}>
        <form class="console-region__form" onSubmit={handleConsoleSubmit}>
          <span class="console-region__prompt">&gt;</span>
          <input
            ref={consoleInputRef}
            value={consoleInput()}
            onInput={(event) => setConsoleInput(event.currentTarget.value)}
            onKeyDown={handleConsoleInputKeyDown}
            onFocus={() => setConsoleFocusReason("keyboard")}
            onBlur={() => setConsoleFocusReason(null)}
            spellcheck={false}
            autocomplete="off"
            autocorrect="off"
            aria-label="Console input"
            placeholder={inputMode() === "chat" ? "Type a message…" : undefined}
          />
        </form>
      </Show>
    </section>
  );
};
