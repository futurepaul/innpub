# Audio Worklet Flow

This app ships two audio worklet scripts that live outside the React bundle:

- `public/worklets/capture-worklet.js`
- `public/worklets/audio-worklet-stream-output.js` (bundled from
  `@ain1084/audio-worklet-stream/dist/output-stream-processor.js` so the module
  ships with no bare imports)

Vite serves anything in `public/` as static assets, which keeps the worklets
available in both the dev server and production build.

## Build step

Before launching either `vite dev` or `vite build` we run
`scripts/prepare-worklets.ts`. It copies the local capture worklet into
`public/worklets/capture-worklet.js` and bundles
`node_modules/@ain1084/audio-worklet-stream/dist/output-stream-processor.js`
into `public/worklets/audio-worklet-stream-output.js` via `Bun.build`, removing
the bare module specifiers that would otherwise break in the browser. Everything
else in `public/` is committed directly.

## Runtime routing

Vite's dev server automatically serves files in `public/`, and the production
build emits them into `dist/`. We add COOP/COEP (`Cross-Origin-Embedder-Policy:
credentialless`) headers in `vite.config.ts` so the browser stays cross-origin
isolated while still allowing remote assets like Nostr avatars.

## Client consumption

`AudioCapture` in `src/multiplayer/audio/capture.ts` always calls
`new URL("/worklets/capture-worklet.js", window.location.origin)` before calling
`audioContext.audioWorklet.addModule`. Because the server exposes `/worklets/*`,
that fetch succeeds in both dev and prod.

## Commands

- Development: `bunx vite`
- Production build: `bunx vite build`
- Preview production build locally: `bunx vite preview`

Keep the prepare script, public directory, and worklet URLs in sync whenever you
add more worklet files.
