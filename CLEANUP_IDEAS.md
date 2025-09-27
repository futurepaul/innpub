# Cleanup & Improvement Ideas

- **Stream layer refactor** – Split `subscribeToRemote` into focused helpers (state, rooms, chat) so reconnect logic isn’t duplicated and the control flow is easier to reason about.
- **Per-session chat storage** – Replace the global `chatMessages` map with a scoped store keyed by connection/epoch to reduce mutable globals and simplify resets.
- **Unified input handling** – Move the d-pad into the Pixi scene (or share a single input manager) to avoid synthesising `KeyboardEvent`s for touch and keep keyboard/touch parity in one place.
- **Componentise login UI** – Extract the login modal and status strip into isolated components so `App.tsx` focuses on orchestration rather than markup.
- **Adopt Hang helpers for data tracks** – Explore using Hang’s location/chat abstractions (or shared Zod schemas) to enforce consistent encoding and reduce bespoke JSON parsing.
- **Avatar highlight polish** – Consider moving speaking indicators directly into the Pixi avatars for richer effects (sprite tint or shader) once the overlay glow is validated.
- **Canvas pixel rounding audit** – Revisit the resize logic to guarantee exact tile multiples (matching the earlier “rounded pixel” behaviour) and encapsulate it in a utility.
- **Documentation pass** – Update README/roadmaps to describe the Hang-based pipeline, chat session reset semantics, and mobile controls once the designs settle.
- **Automation for map assets** – Convert or wrap the TMX `.tsx` files so TypeScript tooling stops erroring, or exclude them cleanly from the project.
