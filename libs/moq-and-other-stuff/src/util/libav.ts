// WebCodecs availability check used by the publish/watch audio paths.
// Hang pulled in a full libav.js polyfill for Safari; we intentionally skip that
// to keep this library lightweight. If WebCodecs is missing, callers can decide
// how to surface the error (we simply return false so the pipeline can bail).
export async function polyfill(): Promise<boolean> {
  if (typeof globalThis.AudioEncoder === "function" && typeof globalThis.AudioDecoder === "function") {
    return true;
  }

  console.error("WebCodecs AudioEncoder/AudioDecoder are required for moq-and-other-stuff audio support.");
  return false;
}
