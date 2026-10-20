// Dev only: boots the real app in a plain browser (hub-dev.html) so the hub
// frontend can be run with vite and screenshotted. Never shipped.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { createStubBridge } from "./hubStubBridge";
import { configureChildBackend } from "../integrations/harness/core/child";
import { fakeClaudeBackend } from "./fakeClaudeBackend";

// ?fakeClaude: a stand-in for the Claude CLI behind the real Claude adapter (fakeClaudeBackend.ts), for browser tests.
// The chats' project folders then count as there, so a message goes in.
const fakeClaude = new URLSearchParams(location.search).has("fakeClaude");
if (fakeClaude) configureChildBackend(fakeClaudeBackend());

// Look like the Mac app (traffic-light space, ⌘ shortcuts).
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });

// Example Monos for the hub's mock projects (real ones come from the store).
// Dev page: example data and no onboarding, unless ?onboarding is in the URL,
// which starts like a clean first launch (no projects, as the app ships).
//
// With `?stub=http://127.0.0.1:<port>` the hub reads a hub-stub-server (started with --dev) through the app's real
// transport code, as it would read Ash OS through the Rust plugin: no example data, no onboarding.
// With `?live=http://127.0.0.1:18869` it reads the REAL Ash OS through scripts/hub-live-proxy.mjs, which holds the key.
const liveUrl = new URLSearchParams(location.search).get("live");
const stubUrl = new URLSearchParams(location.search).get("stub") ?? liveUrl;
if (stubUrl) {
  for (const k of ["monocode:hub-examples", "monocode:hub-projects", "monocode:hub-templates", "monocode:hub-nav"]) localStorage.removeItem(k);
  localStorage.setItem("monocode:hub-onboarded", "1");
  localStorage.setItem("monocode:mono-roster", "[]");
  // Make the project Leads as the Hub bundle does, so the Coding team shows them here too.
  localStorage.setItem("monocode:hub-leads-dev", "1");
} else if (new URLSearchParams(location.search).has("onboarding")) {
  if (!sessionStorage.getItem("hub-clean-start")) {
    sessionStorage.setItem("hub-clean-start", "1");
    for (const k of ["monocode:hub-examples", "monocode:hub-projects", "monocode:hub-templates", "monocode:hub-onboarded", "monocode:mono-team-seeded", "monocode:mono-team-added"]) localStorage.removeItem(k);
    // Clean start: none of our example Monos.
    localStorage.setItem("monocode:mono-roster", "[]");
  }
} else {
  localStorage.setItem("monocode:hub-examples", "1");
  localStorage.setItem("monocode:hub-onboarded", "1");
}
if (localStorage.getItem("monocode:hub-examples") === "1" && (localStorage.getItem("monocode:mono-roster") ?? "[]") === "[]") {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      // The default team first (Critiquito is an add-on, off until Ash adds it), then each project's Lead.
      { id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "projects-manager", name: "Projects Manager", mascot: "crab", color: "hsl(211 92% 62%)", projects: [] },
      { id: "frank", name: "frank", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "alfred", name: "Alfred", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "vg-game-lead", name: "EXO lead", mascot: "robot", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "hivra-lead", name: "Hivra lead", mascot: "rocket", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/hivra"] },
      { id: "nibbii-lead", name: "Nibbii lead", mascot: "cat", color: "hsl(12 80% 58%)", projects: ["/Users/ash/harness/nibbii"] },
      { id: "ash-lead", name: "Harness lead", mascot: "robot", color: "hsl(210 8% 58%)", projects: ["/Users/ash/harness/org"] },
    ]),
  );
}

// Stand-in for the native macOS traffic lights.
window.addEventListener("DOMContentLoaded", () => {
  const lights = document.createElement("div");
  lights.setAttribute("aria-hidden", "true");
  lights.style.cssText = "position:fixed;left:14px;top:14px;display:flex;gap:8px;z-index:99999;pointer-events:none";
  for (const c of ["#ff5f57", "#febc2e", "#28c840"]) {
    const d = document.createElement("span");
    d.style.cssText = `width:12px;height:12px;border-radius:50%;background:${c}`;
    lights.appendChild(d);
  }
  document.body.appendChild(lights);

});

// DEV STAND-IN ONLY: a dim dark-blue "desktop" behind the window, plus the
// tint AppKit would paint over the vibrancy (base colour at the opacity the
// app asks for). On a Mac the real wallpaper and NSVisualEffectView do this.
type GlassArgs = { enabled?: boolean; background?: { r: number; g: number; b: number }; opacity?: number };
const DESKTOP = "radial-gradient(120% 90% at 30% 20%, #1b2a44 0%, #0f1a2e 45%, #070c16 100%)";
function emulateNativeGlass(a: GlassArgs | undefined) {
  const root = document.documentElement;
  if (!a?.enabled || !a.background) {
    root.style.background = "";
    return;
  }
  const { r, g, b } = a.background;
  const o = a.opacity ?? 0.91;
  root.style.background = `linear-gradient(rgb(${r} ${g} ${b} / ${o}), rgb(${r} ${g} ${b} / ${o})), ${DESKTOP}`;
  document.body.style.background = "transparent";
}

// The hub plugin's stand-in: the same three commands, served by the stub server.
const stubBridge = stubUrl
  ? createStubBridge(stubUrl, liveUrl ? () => "added-by-the-dev-proxy" : async () => ((await (await fetch(`${stubUrl}/__stub/token`)).json()) as { token: string }).token)
  : undefined;
let closeStubFeed: (() => void) | undefined;
function hubIpc(cmd: string, args: Record<string, unknown> | undefined): unknown {
  if (!stubBridge) return Promise.reject({ kind: "unreachable", message: "Ash OS isn't running." });
  if (cmd === "plugin:hub|hub_call") return stubBridge.call(String(args?.action), (args?.payload ?? {}) as Record<string, unknown>);
  if (cmd === "plugin:hub|hub_events_open") {
    closeStubFeed?.();
    closeStubFeed = stubBridge.openFeed(
      Number(args?.after ?? 0),
      (e) => void emit("hub:event", e),
      (s) => void emit("hub:state", s),
    );
    return null;
  }
  closeStubFeed?.();
  closeStubFeed = undefined;
  return null;
}

/** Where this browser page's app data would be (a dev copy's data folder has its own name). */
const DEV_DATA = "/Users/ash/Library/Application Support/com.ash.monocode-hub.dev.browser";

mockWindows("main");
const seen = new Set<string>();
mockIPC(
  (cmd, args) => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      (window as unknown as { __ipc: string[] }).__ipc = [...seen];
    }
    if (cmd.startsWith("plugin:hub|")) return hubIpc(cmd, args as Record<string, unknown> | undefined);
    if (cmd === "set_window_glass_enabled") {
      emulateNativeGlass(args as GlassArgs);
      return true;
    }
    if (cmd === "plugin:path|resolve_directory" || cmd === "home_dir") return "/Users/ash";
    if (fakeClaude && cmd === "app_cli_path") return "/fake/monocode";
    if (fakeClaude && cmd === "resolve_project_location") {
      const path = String((args as { path?: string } | undefined)?.path ?? "");
      return { path, identity: `dev:${path}` };
    }
    if (cmd === "fetch_claude_usage") {
      // Dev only: a plan 3% into its 5-hour window and 99% into its week, so the usage bar shows both words and red.
      const at = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
      return { status: "ok", body: JSON.stringify({ five_hour: { utilization: 3, resets_at: at(165) }, seven_day: { utilization: 99, resets_at: at((5 * 24 + 15) * 60) } }) };
    }
    // A Mono renamed (mono.rs mono_rename: ash-lead → hub-lead): this page has no folders or database rows to move.
    if (cmd === "mono_rename") return { folder: { moved: false, keptSoul: false, soulUpdated: false }, refs: {} };
    if (cmd === "mono_archive") { const a = args as { mono: string; stamp: string }; return `${a.mono}-${a.stamp}`; }
    // A Mono's own team folder (mono.rs mono_team_dir), in this page's stand-in data folder.
    if (cmd === "mono_team_dir") return `${DEV_DATA}/mono-teams/${(args as { mono: string }).mono}`;
    // Dev only: delegation rows a browser test seeds (`monocode:dev-delegations`), as delegations_recent returns them;
    // `__devDelegationsChanged()` tells the app they changed, as delegations.rs does.
    if (cmd === "delegations_recent") {
      try {
        return JSON.parse(localStorage.getItem("monocode:dev-delegations") ?? "[]");
      } catch {
        return [];
      }
    }
    // Dev only: chats a browser test seeds (`monocode:dev-sessions`, as session_list_by_project returns them) for their
    // folder; session_get reads one back with an empty transcript, so opening it from the list works.
    if (cmd === "session_list_by_project" || cmd === "session_get") {
      let seeded: Array<Record<string, unknown>> = [];
      try {
        seeded = JSON.parse(localStorage.getItem("monocode:dev-sessions") ?? "[]");
      } catch {
        seeded = [];
      }
      const a = args as { cwd?: string; sessionId?: string };
      if (cmd === "session_get") {
        const found = seeded.find((entry) => entry.id === a.sessionId);
        return found ? { modelSettings: {}, blocks: [], ...found } : null;
      }
      const key = (path: unknown) => String(path ?? "").replace(/\/+$/, "");
      return seeded.filter((entry) => key(entry.cwd) === key(a.cwd));
    }
    if (cmd.startsWith("plugin:event|")) return 1;
    if (cmd.includes("list") || cmd.includes("read_dir")) return [];
    return null;
  },
  { shouldMockEvents: true },
);

// Dev only: the project icon upload reads a file in the browser instead of copying it into app data.
void import("../features/hub/model/projectPrefs").then(({ setProjectFileActions }) =>
  setProjectFileActions({
    showFolder: async () => undefined,
    pickImage: () =>
      new Promise((resolve) => {
        const input = Object.assign(document.createElement("input"), { type: "file", accept: ".png,.jpg,.jpeg,.svg" });
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return resolve(null);
          const reader = new FileReader();
          reader.onload = () => resolve({ src: String(reader.result) });
          reader.readAsDataURL(file);
        };
        input.click();
      }),
  }),
);

Object.assign(window, {
  __devDelegationsChanged: () => void emit("monocode:delegations-changed", { ids: [] }),
  __devHubSelect: (selection: { project: string; item: string }) =>
    import("../features/hub/model/hubNav").then(({ setHubSelection }) => setHubSelection(selection)),
});
