import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const env: Record<string, string | undefined> = process.env;
const host = env.TAURI_DEV_HOST;
// A dev slot's own port (scripts/hub-dev.mjs puts it in the slot's beforeDevCommand). 1420 otherwise: plain
// `npm run dev` and upstream's devUrl. strictPort stays on, so a clash fails loudly instead of moving the page.
const port = Number(env.MONOCODE_VITE_PORT) || 1420;

/** The mockup's lazy chunks, grouped (shiki's languages and themes, the diagram code), so the files stay few. */
function mockupChunk(id: string): string | undefined {
  const lang = /node_modules\/@shikijs\/langs\/dist\/([a-z0-9])/.exec(id);
  if (lang) return `shiki-langs-${lang[1] < "h" ? "a" : lang[1] < "p" ? "h" : "p"}`;
  if (id.includes("node_modules/@shikijs/themes/")) return "shiki-themes";
  if (/node_modules\/(mermaid|@mermaid-js|cytoscape|dagre|d3|khroma|katex)/.test(id)) return "diagrams";
  return undefined;
}

export default defineConfig(async ({ mode }) => {
  const stable = mode === "stable";
  // The design mockup (src/dev/mockup, `npm run mockup:build`): the real app as static files with every native call
  // stubbed, served from any folder.
  const mockup = mode === "mockup";

  return {
    plugins: [react(), tailwindcss()],
    // Each checkout keeps its own pre-bundled deps. Worktrees link node_modules from the main checkout
    // (scripts/setup-worktree.mjs), so the default node_modules/.vite is shared: one slot's re-optimize answered every
    // other slot's page with "504 Outdated Optimize Dep" and left their windows on the boot splash. Each dev slot also
    // keeps its own, by its port: two slots from one worktree shared target/vite and the second window went blank (Mac
    // rehearsal, 21 Oct).
    cacheDir: env.MONOCODE_VITE_PORT && Number(env.MONOCODE_VITE_PORT) ? `target/vite-${Number(env.MONOCODE_VITE_PORT)}` : "target/vite",
    worker: { format: "es", ...(mockup ? { rollupOptions: { output: { manualChunks: mockupChunk } } } : {}) },
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
    // ASCII output: a host that checks text files refuses a literal U+FFFD (the code has some in strings).
    ...(mockup ? { base: "./", esbuild: { charset: "ascii" as const } } : {}),
    build: {
      ...(mockup ? { outDir: "target/mockup", emptyOutDir: true } : {}),
      rollupOptions: {
        // The mockup is published as a few hundred files at most: the lazy language and diagram chunks go together.
        ...(mockup ? { output: { manualChunks: mockupChunk } } : {}),
        // The quick composer panel loads its own page so it does not boot the
        // whole workspace.
        input: mockup ? { mockup: "mockup.html" } : {
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
