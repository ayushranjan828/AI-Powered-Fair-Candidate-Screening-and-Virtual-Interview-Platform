import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The FastAPI app mounts frontend/dist at /static and serves dist/index.html
// from "/", so every built asset URL has to start with /static/.
export default defineConfig({
  plugins: [react()],
  base: "/static/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // `npm run dev` talks to the Python backend on 8000 for everything
    // the React app cannot answer itself.
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});
