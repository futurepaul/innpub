import { serve } from "bun";
import index from "./index.html";

const server = serve({
  routes: {
    "/map/*": async request => {
      const { pathname } = new URL(request.url);
      const relativePath = pathname.slice(1);

      if (relativePath.includes("..")) {
        return new Response("Invalid path", { status: 400 });
      }

      const file = Bun.file(relativePath);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(file);
    },

    "/assets/*": async request => {
      const { pathname } = new URL(request.url);
      const relativePath = pathname.slice(1);

      if (relativePath.includes("..")) {
        return new Response("Invalid path", { status: 400 });
      }

      const file = Bun.file(relativePath);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(file);
    },

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Client ready at ${server.url}`);
