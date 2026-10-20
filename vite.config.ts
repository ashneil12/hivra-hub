import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const env: Record<string, string | undefined> = process.env;
const host = env.TAURI_DEV_HOST;
// A dev slot's own port (scripts/hub-dev.mjs puts it in the slot's beforeDevCommand). 1420 otherwise: plain
// `npm run dev` and upstream's devUrl. strictPort stays on, so a clash fails loudly instead of moving the page.
const port = Number(env.MONOCODE_VITE_PORT) || 1420;

export default defineConfig(async ({ mode }) => {
  const stable = mode === "stable";

  return {
    plugins: [react(), tailwindcss()],
    // Each checkout keeps its own pre-bundled deps. Worktrees link node_modules from the main checkout
    // (scripts/setup-worktree.mjs), so the default node_modules/.vite is shared: one slot's re-optimize answered every
    // other slot's page with "504 Outdated Optimize Dep" and left their windows on the boot splash. Each dev slot also
    // keeps its own, by its port: two slots from one worktree shared target/vite and the second window went blank (Mac
    // rehearsal, 21 Oct).
    cacheDir: env.MONOCODE_VITE_PORT && Number(env.MONOCODE_VITE_PORT) ? `target/vite-${Number(env.MONOCODE_VITE_PORT)}` : "target/vite",
    worker: { format: "es" },
    resolve: {
      alias: [
        ...(mode.startsWith("benchmark")
          ? [
              {
                find: /^@tauri-apps\/api\/core$/,
                replacement: new URL(
                  "./tests/browser/tauriFixture.ts",
                  import.meta.url,
                ).pathname,
              },
            ]
          : []),
        ...(mode === "benchmark-profile"
          ? [{ find: "react-dom/client", replacement: "react-dom/profiling" }]
          : []),
      ],
    },
    clearScreen: false,
    build: {
      rollupOptions: {
        // The quick composer panel loads its own page so it does not boot the
        // whole workspace.
        input: {
          main: "index.html",
          quickComposer: "quick-composer.html",
          monoChat: "mono-chat.html",
          ...(mode.startsWith("benchmark")
            ? { workspaceBenchmark: "tests/browser/workspace-performance.html" }
            : {}),
        },
      },
    },
    server: {
      port,
      strictPort: true,
      host: host || false,
      hmr: stable
        ? false
        : host
          ? {
              protocol: "ws",
              host,
              port: port + 1,
            }
          : undefined,
      watch: {
        // target/ holds every slot's generated config and Rust build output; none of it is page source.
        ignored: stable ? ["**/*"] : ["**/src-tauri/**", "**/target/**"],
      },
    },
  };
});
