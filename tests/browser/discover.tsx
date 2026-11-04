import { createRoot } from "react-dom/client";
import { SOURCES_KEY } from "../../src/features/plugins/model/discover";
import { PluginsPage } from "../../src/features/plugins/ui/DiscoverPage";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

// WP-32. The real Discover screen. The only native command it may use to list plugins is `plugins_discover`.
const COMMIT = "6ea74587e384e1a8035c09ae33a46fe3f881eb9b";
const calls: { command: string; args: Record<string, unknown> }[] = [];

installFakeTauri("discover", (command, args) => {
  calls.push({ command, args });
  if (command === "plugins_discover") {
    return [
      {
        source: { kind: "bundled" },
        index: {
          title: "Hivra plugins",
          format: "hivra",
          skipped: [],
          entries: [
            {
              name: "pstack",
              title: "pstack",
              description: "Skills for rigor and verification.",
              author: "Lauren Tan",
              license: "MIT",
              keywords: ["rigor"],
              platforms: [],
              adds: [{ kind: "skills", count: 58, names: ["architect", "tdd"] }],
              leftOut: [],
              permissions: ["Reads the repository"],
              status: "available",
              format: "hivra",
              source: { kind: "git", url: "https://github.com/cursor/plugins", commit: COMMIT, path: "pstack" },
            },
            {
              name: "browser",
              title: "Browser",
              description: "A real browser for agents.",
              keywords: [],
              platforms: [],
              adds: [{ kind: "mcpServers", count: 1, names: ["browser"] }],
              leftOut: [],
              permissions: ["Runs a browser on this computer"],
              status: "planned",
              reason: "Not published yet.",
              format: "hivra",
            },
            {
              name: "dsh-only",
              title: "DeepSeek bundle",
              description: "Runs inside DeepSeek Harness.",
              keywords: [],
              platforms: [],
              adds: [],
              leftOut: [],
              permissions: [],
              status: "not-compatible",
              reason: "A DeepSeek Harness bundle: it runs inside DeepSeek Harness's own agent loop.",
              format: "dsh",
            },
          ],
        },
      },
      {
        source: { kind: "url", url: "https://example.com/down.json" },
        error: "The index didn't answer. Nothing was listed.",
      },
    ];
  }
  if (command === "plugins_install") return { message: "Installed pstack." };
  throw new Error(`Discover fixture refused ${command}`);
});

Object.assign(window, { discoverCalls: () => calls });

// The failing address is one this page asked to read. An error for a source it didn't ask for is not shown.
localStorage.setItem(SOURCES_KEY, JSON.stringify({
  revision: 1,
  sources: [
    { kind: "bundled" },
    { kind: "url", url: "https://example.com/down.json" },
  ],
}));

createRoot(document.getElementById("root")!).render(<PluginsPage />);
