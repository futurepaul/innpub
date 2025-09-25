import { mkdir, cp } from "fs/promises";

async function run() {
  const build = Bun.spawn([
    "bun",
    "build",
    "./src/index.html",
    "--outdir=dist",
    "--sourcemap",
    "--target=browser",
    "--minify",
    "--define:process.env.NODE_ENV=\"production\"",
    "--env=BUN_PUBLIC_*",
  ], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`bun build exited with code ${exitCode}`);
  }

  await mkdir("dist", { recursive: true });
  await cp("map", "dist/map", { recursive: true });
  await cp("assets", "dist/assets", { recursive: true });
}

run().catch(error => {
  console.error("Build failed", error);
  process.exit(1);
});
