import { defineConfig } from "@playwright/test";
import perf from "./performance.config";

// WP-03: upstream's workspace benchmark (workspace-performance.spec.ts, unchanged) in each of upstream's two layouts,
// on the release-mode benchmark build. The page runs without the Hub flag, so the stored layout still applies there;
// Hivra itself only renders Classic (src/features/hub/model/hivraLayout.ts). Summarised by
// `node scripts/hivra-layout-bench.mjs`, which runs this config.
const ORIGIN = "http://127.0.0.1:1435";
const state = (inset: boolean) => ({
  cookies: [],
  origins: [
    {
      origin: ORIGIN,
      localStorage: [
        { name: "monocode.insetLayout", value: inset ? "1" : "0" },
        { name: "monocode.newLayoutPromptDismissed", value: "1" },
        // The fixture page opens on the Hub's project screen and first-launch cards otherwise.
        { name: "monocode:hub-onboarded", value: "1" },
        { name: "monocode:hub-setup-not-now", value: "1" },
        { name: "monocode:hub-nav", value: JSON.stringify({ project: "fixture", item: "coding-team" }) },
      ],
    },
  ],
});
const engine = process.env.LAYOUT_BENCH_ENGINE ?? "chromium";
const browser = (perf.projects ?? []).find((project) => project.name === engine)?.use ?? { browserName: engine };

export default defineConfig({
  ...perf,
  grep: /switches six large sessions/,
  projects: [
    { name: `classic-${engine}`, use: { ...browser, storageState: state(false) } },
    { name: `focused-${engine}`, use: { ...browser, storageState: state(true) } },
  ],
});
