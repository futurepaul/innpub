# Audio Worklet Flow

This app ships a custom audio worklet (`capture-worklet.js`) that lives at
`src/multiplayer/audio/worklets/capture-worklet.js`. Bun does not automatically
serve files that sit outside the bundler graph, so we handle both build‑time and
runtime plumbing ourselves.

## Build step

`scripts/build.ts` runs `bun build` for the React bundle and then copies
additional static assets into `dist/`:

- `dist/map/**`
- `dist/assets/**`
- `dist/DotGothic16-Regular.ttf`
- `dist/worklets/capture-worklet.js`

Copying the worklet into `dist/worklets/` makes it available when we host the
prebuilt app with `bun start` (which simply executes `src/index.tsx`).

## Runtime routing

The Bun server in `src/index.tsx` serves a handful of static routes. After the
change we just made, `/worklets/*` now resolves to either:

1. `dist/worklets/<file>` (production / `bun run build` + `bun start`)
2. `src/multiplayer/audio/worklets/<file>` (development / `bun --hot src/index.tsx`)

This ensures hot reload works while we develop, but the built assets continue to
load for production.

## Client consumption

`AudioCapture` in `src/multiplayer/audio/capture.ts` always calls
`new URL("/worklets/capture-worklet.js", window.location.origin)` before calling
`audioContext.audioWorklet.addModule`. Because the server exposes `/worklets/*`,
that fetch succeeds in both dev and prod.

## Commands

- Development: `bun --hot src/index.tsx`
- Production build: `bun run build`
- Serve production build: `bun start`

Keep those three pieces (copy, route, URL) in sync whenever you add more worklet
files.
