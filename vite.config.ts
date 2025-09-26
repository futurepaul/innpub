import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const CROSS_ORIGIN_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    headers: CROSS_ORIGIN_HEADERS,
    middlewareMode: false,
    configureServer(server) {
      server.middlewares.use((_, res, next) => {
        Object.entries(CROSS_ORIGIN_HEADERS).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        next();
      });
    },
  },
  preview: {
    headers: CROSS_ORIGIN_HEADERS,
  },
});
