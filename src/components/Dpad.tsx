import { type Component } from "solid-js";

type DirectionKey = "up" | "down" | "left" | "right";

const DIRECTION_KEY_MAP: Record<DirectionKey, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

export interface DpadProps {
  /** Whether the dpad should be visible and interactive */
  visible?: boolean;
}

export const Dpad: Component<DpadProps> = (props) => {
  const activeDirectionsRef: Set<DirectionKey> = new Set();

  const pressDirection = (direction: DirectionKey) => {
    if (activeDirectionsRef.has(direction)) {
      return;
    }
    activeDirectionsRef.add(direction);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: DIRECTION_KEY_MAP[direction], bubbles: true }));
  };

  const releaseDirection = (direction: DirectionKey) => {
    if (!activeDirectionsRef.has(direction)) {
      return;
    }
    activeDirectionsRef.delete(direction);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: DIRECTION_KEY_MAP[direction], bubbles: true }));
  };

  const createDpadPressHandler = (direction: DirectionKey) => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLButtonElement).setPointerCapture?.(event.pointerId);
    pressDirection(direction);
  };

  const createDpadReleaseHandler = (direction: DirectionKey) => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLButtonElement).releasePointerCapture?.(event.pointerId);
    releaseDirection(direction);
  };

  if (!props.visible) {
    return null;
  }

  return (
    <div class="dpad" aria-hidden="true">
      <button
        type="button"
        class="dpad-btn dpad-btn--up"
        onPointerDown={createDpadPressHandler("up")}
        onPointerUp={createDpadReleaseHandler("up")}
        onPointerLeave={createDpadReleaseHandler("up")}
        onPointerCancel={createDpadReleaseHandler("up")}
      >
        ↑
      </button>
      <div class="dpad-middle">
        <button
          type="button"
          class="dpad-btn dpad-btn--left"
          onPointerDown={createDpadPressHandler("left")}
          onPointerUp={createDpadReleaseHandler("left")}
          onPointerLeave={createDpadReleaseHandler("left")}
          onPointerCancel={createDpadReleaseHandler("left")}
        >
          ←
        </button>
        <button
          type="button"
          class="dpad-btn dpad-btn--right"
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
        class="dpad-btn dpad-btn--down"
        onPointerDown={createDpadPressHandler("down")}
        onPointerUp={createDpadReleaseHandler("down")}
        onPointerLeave={createDpadReleaseHandler("down")}
        onPointerCancel={createDpadReleaseHandler("down")}
      >
        ↓
      </button>
    </div>
  );
};
