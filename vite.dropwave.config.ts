// The Dropwave preview (src/features/dropwave, `npm run dropwave:build`): the new captain-first screens on example
// data, as one small static page. Separate from the app build so it never changes what ships.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  esbuild: { charset: "ascii" },
  cacheDir: "target/vite-dropwave",
  build: {
    outDir: "target/dropwave",
    emptyOutDir: true,
    rollupOptions: { input: { dropwave: "dropwave.html" } },
  },
});
