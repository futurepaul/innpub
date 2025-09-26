import { mkdir, cp, rename, rm } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const publicWorkletsDir = resolve(repoRoot, "public", "worklets");

async function main() {
  const captureSource = resolve(repoRoot, "src", "multiplayer", "audio", "worklets", "capture-worklet.js");
  const captureDestination = resolve(publicWorkletsDir, "capture-worklet.js");
  const processorEntry = resolve(repoRoot, "node_modules", "@ain1084", "audio-worklet-stream", "dist", "output-stream-processor.js");
  const processorDestination = resolve(publicWorkletsDir, "audio-worklet-stream-output.js");

  await mkdir(publicWorkletsDir, { recursive: true });
  await cp(captureSource, captureDestination);

  const buildResult = await Bun.build({
    entrypoints: [processorEntry],
    outdir: publicWorkletsDir,
    target: "browser",
    format: "esm",
    minify: true,
  });

  if (!buildResult.success) {
    buildResult.logs.forEach(log => {
      console.error(log.message);
    });
    throw new Error("Failed to bundle audio worklet stream processor");
  }

  const bundledPath = resolve(publicWorkletsDir, "output-stream-processor.js");
  await rm(processorDestination, { force: true });
  await rename(bundledPath, processorDestination);
}

main().catch(error => {
  console.error("Failed to prepare audio worklets", error);
  process.exit(1);
});
