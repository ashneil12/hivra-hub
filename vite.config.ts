import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const env: Record<string, string | undefined> = process.env;
const host = env.TAURI_DEV_HOST;
// A dev slot's own port (scripts/hub-dev.mjs puts it in the slot's beforeDevCommand). 1420 otherwise: plain
// `npm run dev` and upstream's devUrl. strictPort stays on, so a clash fails loudly instead of moving the page.
const port = Number(env.MONOCODE_VITE_PORT) || 1420;
// A dev slot keeps its own pre-bundled dependencies in its worktree's target/. Worktrees share node_modules through a
// link, and slots running side by side would otherwise re-optimise one node_modules/.vite under each other: a page
// then gets "504 Outdated Optimize Dep" for a dependency and the window stays black.
const cacheDir = env.MONOCODE_VITE_PORT ? "target/vite-deps" : undefined;

export default defineConfig(async ({ mode }) => {
  const stable = mode === "stable";

  return {
    ...(cacheDir ? { cacheDir } : {}),
    plugins: [react(), tailwindcss()],
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
