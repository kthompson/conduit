import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { reactRouterDevTools } from "react-router-devtools";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => ({
  // Matches `basename` in react-router.config.ts so assets load from /ui/assets.
  base: "/ui/",
  plugins: [
    // DevTools only run in development, mounted inside the conduit process.
    command === "serve" && mode === "development" ? reactRouterDevTools() : null,
    tailwindcss(),
    reactRouter(),
  ],
  build: { sourcemap: false },
}));
