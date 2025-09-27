# moq-and-other-stuff

Minimal media-over-QUIC helpers for Innpub that mirror the publish/watch audio pieces we previously consumed from [`@kixelated/hang`](https://github.com/kixelated/moq/tree/main/js/hang). The API surface intentionally matches Hang so the app keeps the same wiring for rooms, publish/watch toggles, and audio worklets without depending on Hang's extra modules or heavy WASM/VAD dependencies.

## Features
- Audio publish pipeline with capture worklet, WebCodecs/Opus encoder, and speaking heuristic
- Audio watch pipeline with jitter buffer, WebCodecs/Opus decoder, and render worklet
- Room helper for managing active broadcasts via MoQ announcements
- Catalog utilities trimmed to audio-only data

## Acknowledgements
Large portions of this library are derived from `@kixelated/hang` (MIT / Apache-2.0). We keep the same dual-license terms and include simplified implementations rather than the full upstream feature set.

## License
This project is licensed under both the MIT License and the Apache License, Version 2.0. See [`LICENSE-MIT`](./LICENSE-MIT) and [`LICENSE-APACHE`](./LICENSE-APACHE) for details.
