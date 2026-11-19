import { build } from "esbuild";
import { copyFile } from "node:fs/promises";

await build({
  entryPoints: ["host/cli.ts"],
  outfile: "build/host/monocode-host.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  loader: { ".ps1": "text" },
  // The host is plain Node: no Vite env. Shared web modules it bundles read import.meta.env (the hub flag, in
  // hubBundle.ts and others), which is undefined here and crashed the host on start; they see an empty env instead.
  define: { "import.meta.hot": "undefined", "import.meta.env": "{}" },
  sourcemap: true,
});
await copyFile("host/provider-guard.mjs", "build/host/provider-guard.mjs");
