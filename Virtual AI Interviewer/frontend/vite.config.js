import { resolve } from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two pages, not one: the recruiter console and the candidate's own interview
// are separate documents on purpose. The candidate page must not be able to
// reach recruiter-only views, and keeping them as separate entry points means
// that is enforced by the bundle, not just by a route guard.
export default defineConfig({
  plugins: [react()],
  base: "/static/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        candidate: resolve(__dirname, "candidate.html"),
      },
      output: {
        // three is big and changes rarely; keeping it out of the app chunk
        // means a UI tweak does not invalidate 600 kB of cached library.
        manualChunks: (id) => (id.includes("node_modules/three") ? "three" : undefined),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8010",
      "/i": "http://127.0.0.1:8010",
    },
  },
});
