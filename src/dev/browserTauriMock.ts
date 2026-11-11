// Dev only: boots the real app in a plain browser (hub-dev.html) so the hub
// frontend can be run with vite and screenshotted. Never shipped.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { configureChildBackend } from "../integrations/harness/core/child";
import { fakeClaudeBackend } from "./fakeClaudeBackend";
import { recordSetupFact, SETUP_FACT_IDS } from "../features/hub/model/setupProof";

// The first-launch setup checks (H7) need a real CLI and real paths, so they can never pass in a plain browser. The
// preview stands in for a proved install; the card itself is exercised in the app's own tests.
function markSetupProved() {
  for (const id of SETUP_FACT_IDS) recordSetupFact(id, "proved by the browser preview");
}

// ?fakeClaude: a stand-in for the Claude CLI behind the real Claude adapter (fakeClaudeBackend.ts), for browser tests.
// The chats' project folders then count as there, so a message goes in.
const fakeClaude = new URLSearchParams(location.search).has("fakeClaude");
if (fakeClaude) configureChildBackend(fakeClaudeBackend());

// The hub's dev page opens on the hub before anything is picked, as the Hub bundle does (hubNav.ts opensOnHub).
Object.assign(window, { __MONOCODE_HUB_DEV_PAGE__: true });

// Look like the Mac app (traffic-light space, ⌘ shortcuts).
Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });

// Example Monos for the hub's mock projects (real ones come from the store).
// Dev page: example data and no onboarding, unless ?onboarding is in the URL,
// which starts like a clean first launch (no projects, as the app ships) — apart from the setup checks, which need a
// real CLI and are marked proved here (see markSetupProved).
//
// With `?local` the hub reads its own local store through the app's real transport code (hub/model/localHub), kept in
// this page's localStorage under `monocode:dev-local-hub:<key>` (a test seeds it first, see seedLocalHub below): no
// example data, no onboarding. (The Ash OS stub and live proxy this used to read are retired: WP-04.)
const localHub = new URLSearchParams(location.search).has("local");
if (localHub) {
  for (const k of ["monocode:hub-examples", "monocode:hub-projects", "monocode:hub-templates", "monocode:hub-nav"]) localStorage.removeItem(k);
  localStorage.setItem("monocode:hub-onboarded", "1");
  markSetupProved();
  // A proof can start from a saved roster (for example a picked green crab); otherwise none.
  localStorage.setItem("monocode:mono-roster", localStorage.getItem("monocode:dev-roster-seed") ?? "[]");
  // Make the project Leads as the Hub bundle does, so the Coding team shows them here too.
  localStorage.setItem("monocode:hub-leads-dev", "1");
} else if (new URLSearchParams(location.search).has("onboarding")) {
  if (!sessionStorage.getItem("hub-clean-start")) {
    sessionStorage.setItem("hub-clean-start", "1");
    for (const k of ["monocode:hub-examples", "monocode:hub-projects", "monocode:hub-templates", "monocode:hub-onboarded", "monocode:hub-setup-not-now", "monocode:mono-team-seeded", "monocode:mono-team-added"]) localStorage.removeItem(k);
    // Clean start: none of our example Monos.
    localStorage.setItem("monocode:mono-roster", "[]");
  }
  markSetupProved();
  // WP-20: the preview is not the Hub bundle, so it does not make Leads or open a coding team unless this is set
  // (the same switch ?local uses). The real app has the bundle flag and does not need it.
  localStorage.setItem("monocode:hub-leads-dev", "1");
} else {
  localStorage.setItem("monocode:hub-examples", "1");
  localStorage.setItem("monocode:hub-onboarded", "1");
  markSetupProved();
}
if (localStorage.getItem("monocode:hub-examples") === "1" && (localStorage.getItem("monocode:mono-roster") ?? "[]") === "[]") {
  localStorage.setItem(
    "monocode:mono-roster",
    JSON.stringify([
      // A few ordinary Monos, then each project's lead.
      { id: "ada", name: "Ada", mascot: "crab", mascotPicked: true, color: "hsl(142 55% 50%)", projects: [] },
      { id: "bo", name: "Bo", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "ed", name: "ed", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "cam", name: "Cam", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] },
      { id: "vg-game-lead", name: "EXO lead", mascot: "invader", color: "hsl(211 92% 62%)", projects: ["/Users/ash/harness/exo-game"] },
      { id: "hivra-lead", name: "Hivra lead", mascot: "ghost", color: "hsl(12 80% 58%)", projects: ["/Users/ash/harness/hivra"] },
      { id: "nibbii-lead", name: "Nibbii lead", mascot: "robot", color: "hsl(45 90% 55%)", projects: ["/Users/ash/harness/nibbii"] },
      { id: "ash-lead", name: "Harness lead", mascot: "cat", color: "hsl(142 55% 50%)", projects: ["/Users/ash/harness/org"] },
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

// The hub plugin's stand-in: the local store's documents in this page's localStorage (src-tauri/src/local_hub.rs keeps
// them in the app's database). Everything else on the plugin (connectors, model keys) answers nothing here.
export const LOCAL_HUB_PREFIX = "monocode:dev-local-hub:";

// WP-92: the vault's stand-in for a browser preview. Values live in this page's memory and never in localStorage, the
// same promise the real vault keeps; the page's storage therefore holds metadata only.
const DEV_SECRETS: {
  rows: Array<Record<string, unknown>>;
  values: Map<string, string>;
  requests: Array<Record<string, unknown>>;
} = { rows: [], values: new Map(), requests: [] };
const secretKey = (scope: unknown, name: unknown) => `${String(scope)}\u0000${String(name)}`;
function secretSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[ _]/g, "-");
}
function secretRow(scope: string, name: string, label: string, value: string) {
  const last4 = value.length >= 12 ? value.slice(-4) : null;
  return {
    scope,
    name,
    label: label || name,
    last4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: null,
    version: 1,
    approved: [],
    executables: [],
    envFiles: [],
    needsValue: false,
  };
}
function secretsIpc(cmd: string, args: Record<string, unknown> | undefined): unknown {
  const a = args ?? {};
  switch (cmd) {
    case "plugin:hub|secrets_list":
      return DEV_SECRETS.rows.map((row) => ({
        ...row,
        approved: [],
        executables: [],
        envFiles: [],
        needsValue: !DEV_SECRETS.values.has(secretKey(row.scope, row.name)),
      }));
    case "plugin:hub|secrets_requests":
    case "plugin:hub|secrets_pending":
      return DEV_SECRETS.requests.filter((row) => row.state === "open");
    case "plugin:hub|secrets_slug":
      return secretSlug(String(a.name ?? ""));
    case "plugin:hub|secrets_save_new": {
      const scope = String(a.scope ?? "global");
      const name = String(a.name ?? "");
      const value = String(a.value ?? "");
      DEV_SECRETS.values.set(secretKey(scope, name), value);
      const row = secretRow(scope, name, String(a.label ?? ""), value);
      const at = DEV_SECRETS.rows.findIndex((r) => r.scope === scope && r.name === name);
      if (at >= 0) DEV_SECRETS.rows[at] = row;
      else DEV_SECRETS.rows.push(row);
      return row;
    }
    case "plugin:hub|secrets_begin_save": {
      const row = DEV_SECRETS.requests.find((r) => r.id === a.id);
      if (!row || row.state !== "open") throw new Error("That key was already saved.");
      row.state = "saving";
      return { request: row, token: `dev-token-${row.id}` };
    }
    case "plugin:hub|secrets_save": {
      const row = DEV_SECRETS.requests.find((r) => r.id === a.id);
      if (!row || row.state !== "saving") throw new Error("That key was already saved.");
      const scope = String(row.scope);
      const name = String(row.name);
      const value = String(a.value ?? "");
      DEV_SECRETS.values.set(secretKey(scope, name), value);
      const saved = secretRow(scope, name, String(a.label ?? row.name), value);
      const at = DEV_SECRETS.rows.findIndex((r) => r.scope === scope && r.name === name);
      if (at >= 0) DEV_SECRETS.rows[at] = saved;
      else DEV_SECRETS.rows.push(saved);
      row.state = "filled";
      return saved;
    }
    case "plugin:hub|secrets_decline": {
      const row = DEV_SECRETS.requests.find((r) => r.id === a.id);
      if (row) row.state = "declined";
      return null;
    }
    case "plugin:hub|secrets_rename": {
      const row = DEV_SECRETS.rows.find((r) => r.scope === a.scope && r.name === a.name);
      if (!row) throw new Error("That key isn't here any more.");
      row.label = String(a.label ?? row.name);
      row.version = Number(row.version) + 1;
      row.updatedAt = Date.now();
      return row;
    }
    case "plugin:hub|secrets_rotate": {
      const scope = String(a.scope ?? "");
      const name = String(a.name ?? "");
      const value = String(a.value ?? "");
      if (!DEV_SECRETS.values.has(secretKey(scope, name))) throw new Error("That key isn't here any more.");
      DEV_SECRETS.values.set(secretKey(scope, name), value);
      const row = DEV_SECRETS.rows.find((r) => r.scope === scope && r.name === name)!;
      row.last4 = value.length >= 12 ? value.slice(-4) : null;
      row.version = Number(row.version) + 1;
      row.updatedAt = Date.now();
      return { secret: row, updated: [], leftAlone: [] };
    }
    case "plugin:hub|secrets_delete": {
      const at = DEV_SECRETS.rows.findIndex((r) => r.scope === a.scope && r.name === a.name);
      if (at >= 0) DEV_SECRETS.rows.splice(at, 1);
      DEV_SECRETS.values.delete(secretKey(a.scope, a.name));
      return { removedGrants: 0, removedEnvLines: [] };
    }
    case "plugin:hub|secrets_reveal": {
      const value = DEV_SECRETS.values.get(secretKey(a.scope, a.name));
      if (value === undefined) throw new Error("That key isn't in your keychain any more.");
      return value;
    }
    case "plugin:hub|secrets_grants":
      return [];
    case "plugin:hub|secrets_revoke_grant":
      return 0;
    case "plugin:hub|secrets_index":
      return {
        secrets: DEV_SECRETS.rows.map((row) => ({
          name: row.name,
          scope: row.scope,
          label: row.label,
          last4: row.last4,
          createdAt: row.createdAt,
        })),
      };
    case "plugin:hub|secrets_env_write":
    case "plugin:hub|secrets_env_remove":
      return null;
    default:
      return undefined;
  }
}

function hubIpc(cmd: string, args: Record<string, unknown> | undefined): unknown {
  const key = String(args?.key ?? "");
  // A document's revision sits beside it (`<key>#rev`); a seeded document with none is at revision 1.
  const rev = () => {
    const raw = localStorage.getItem(`${LOCAL_HUB_PREFIX}${key}#rev`);
    return raw ? Number(raw) : localStorage.getItem(`${LOCAL_HUB_PREFIX}${key}`) !== null ? 1 : 0;
  };
  if (cmd === "plugin:hub|local_hub_read") {
    const raw = localStorage.getItem(`${LOCAL_HUB_PREFIX}${key}`);
    return { value: raw ? JSON.parse(raw) : null, rev: rev() };
  }
  if (cmd === "plugin:hub|local_hub_write") {
    const current = rev();
    if (typeof args?.expectRev === "number" && args.expectRev !== current) return null;
    localStorage.setItem(`${LOCAL_HUB_PREFIX}${key}`, JSON.stringify(args?.value ?? null));
    localStorage.setItem(`${LOCAL_HUB_PREFIX}${key}#rev`, String(current + 1));
    return current + 1;
  }
  if (cmd === "plugin:hub|local_hub_make_folder") return `/Users/example/Projects/${String(args?.id ?? "project")}`;
  if (cmd.startsWith("plugin:hub|secrets_")) {
    const answer = secretsIpc(cmd, args);
    if (answer !== undefined) return answer;
  }
  if (cmd === "git_worktrees") {
    const cwd = String((args as { cwd?: string } | undefined)?.cwd ?? "/Users/example/Projects/tally");
    return { worktrees: [{ path: cwd, branch: "main", isMain: true }], defaultRoot: cwd };
  }
  if (cmd === "plugin:hub|ash_os_import_fetch") return { state: "absent", message: "No Ash OS in the browser preview.", projects: [], memberships: [], pages: [] };
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
    // The CLI paths Settings saved are the ones this run uses (harness.rs harness_runtime_binary_paths).
    if (cmd === "harness_runtime_binary_paths") return (args as { paths?: unknown } | undefined)?.paths ?? {};
    if (fakeClaude && cmd === "app_cli_path") return "/fake/monocode";
    if (fakeClaude && cmd === "resolve_project_location") {
      const path = String((args as { path?: string } | undefined)?.path ?? "");
      return { path, identity: `dev:${path}` };
    }
    if (cmd === "fetch_claude_usage") {
      // Dev only, sample data (not a real account): a plan 3% into its 5-hour window and 99% into its week, so the chip shows both
      // labels and the "nearly used" wording. Never shown on the Grok bridge, where the Claude chip is hidden.
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
    // Dev only: the file picker and the files a browser test attaches (`window.__devPick = [{ path, size, data? }]`, and
    // `__devDisk`, files that stay readable after the pick): the
    // dialog returns their paths, inspect_paths and read_file_base64 answer as fs.rs would, and a pasted picture
    // written with write_attachment gets a temp path back.
    if (cmd === "plugin:dialog|open") {
      const picks = (window as unknown as { __devPick?: { path: string }[] }).__devPick ?? [];
      return picks.length ? picks.map((p) => p.path) : null;
    }
    if (cmd === "inspect_paths") {
      const picks = (window as unknown as { __devPick?: { path: string; size?: number }[] }).__devPick ?? [];
      return ((args as { paths?: string[] }).paths ?? []).map((path) => ({
        path,
        name: path.split("/").pop() ?? path,
        size: picks.find((p) => p.path === path)?.size ?? 1,
        isDir: false,
      }));
    }
    if (cmd === "read_file_base64") {
      const w = window as unknown as { __devPick?: { path: string; data?: string }[]; __devDisk?: { path: string; data?: string }[] };
      const found = [...(w.__devDisk ?? []), ...(w.__devPick ?? [])].find((p) => p.path === (args as { path?: string }).path);
      if (!found?.data) throw new Error("No such file");
      return found.data;
    }
    if (cmd === "write_attachment") return `/tmp/monocode-attachments/dev-${(args as { name?: string }).name ?? "attachment"}`;
    // The CLI paths set in Settings, as the Rust side hands them back when they exist (a proof sets the Grok bridge).
    if (cmd === "harness_runtime_binary_paths") return (args as { paths?: Record<string, string> } | undefined)?.paths ?? {};
    if (cmd.startsWith("plugin:event|")) return 1;
    // WP-06: the real shell's crew and inbox read these. A browser spec seeds them; a missing or bad value is an empty list.
    const seededList = (key: string): unknown[] => {
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? "[]");
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    };
    if (cmd === "delegations_list_open") return seededList("monocode:dev-delegations");
    if (cmd === "decisions_list") return seededList("monocode:dev-decisions");
    if (cmd === "delivery_list") return seededList("monocode:dev-deliveries");
    if (cmd === "pr_watch_list") return seededList("monocode:dev-pr-watches");
    // WP-210: answering a seeded decision clears it on the one Needs you list.
    if (cmd === "decisions_answer") {
      const input = (args ?? {}) as { project?: string; key?: string; answer?: string };
      const stored = "monocode:dev-decisions";
      const rows = seededList(stored);
      const now = Date.now();
      let decision: unknown = null;
      const next = rows.map((row) => {
        if (!row || typeof row !== "object") return row;
        const item = row as { project?: string; decisionKey?: string };
        if (item.project !== input.project || item.decisionKey !== input.key) return row;
        decision = { ...item, state: "answered", answer: input.answer ?? null, answeredAt: now };
        return decision;
      });
      localStorage.setItem(stored, JSON.stringify(next));
      void emit("hivra:decisions-changed", {});
      return { applied: decision != null, decision, released: [], releasedTasks: [] };
    }
    // WP-06: a browser spec seeds a ship summary (`monocode:dev-ship`). Missing or bad JSON is no ship.
    if (cmd === "ship_status") {
      try {
        const raw = localStorage.getItem("monocode:dev-ship");
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }
    if (cmd.includes("list") || cmd.includes("read_dir")) return [];
    return null;
  },
  { shouldMockEvents: true },
);

// Dev only: mono_create, page_build and hub_change for browser proofs (selfBuildProof.ts).
void import("./selfBuildProof");

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
