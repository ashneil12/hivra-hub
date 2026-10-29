import { migrateMonoModels } from "../../monos/model/monoModels";
import { DEFAULT_TEAM, DEFAULT_TEAM_IDS, ensureBuiltInMonos } from "./builtInMonos";
import { leadFor } from "./hubLeads";
import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { loadTabGroupLabels, saveTabGroupLabel } from "../../workspace/model/tabGroups";
import { examplesOn } from "./examples";
import { startActivityTracking } from "./hubActivity";
import { HubStore } from "./hubStore";
import { tauriAshOsServer, tauriHubTransport } from "./hubTransport";
import { makesProjectLeads } from "./hubBundle";
import { completeLeadAdoption, ensureProjectLeads, reseedAdoptedLeadSoul } from "./hubLeads";
import { registerClaudeGuards, registeredHubMcpArgs, setHubDocsDir, setHubMcpServers, type HubMcpServers } from "./hubMcp";
import { codingTeamChatProject } from "./codingTeam";
import { devAshOsStandIn } from "./devAshOs";
import { invoke } from "@tauri-apps/api/core";
import { habitRunMono } from "../../monos/model/monoHabits";
import { noteTeamEngines, seatLeadershipTeams, seedFrankAshAsks, seedTeamFiles, tieTeamToProjects } from "./hubTeam";
import { refreshSoulsSoon } from "./soulRefresh";
import { renameAshLeadToHubLead } from "./monoRename";
import { applyMemoryLineFixes } from "./memoryLineFixes";
import { checkSouls, watchSoulOpens } from "./soulTamper";
import { stripProjects } from "./hubProjects";
import { defaultSoul, loadMonoFiles, readAgentFile, setHubDocsPath, writeAgentFile } from "../../monos/model/monoFiles";
import { findMono, monoForSession } from "../../monos/model/mono";
import { setClaudeExtraArgs } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { resourceDir } from "@tauri-apps/api/path";
import { pathKey } from "../../../shared/lib/paths";
import { createLiveHubData } from "./liveHubData";
import { mockHubData } from "./mockData";
import type { HubDataSource, HubProject } from "./types";
import { IS_HUB_BUNDLE, seedHubBundleDefaults } from "./hubBundle";
import { connectorServersForMono, loadConnectors } from "./hubConnectors";
import { applyProjectPrefs, projectPrefsVersion, useProjectPrefsVersion } from "./projectPrefs";

// Before the first chat is made (App imports this module first): the Hub bundle starts new chats on Claude Code.
seedHubBundleDefaults();

/**
 * Every hub chat's Claude Code session gets one --mcp-config (hubMcp.ts): Ash's ash-os entry with the chat's identity,
 * for a Mono's own chat the delegate tool, and for a Mono's chat and its habit runs the connectors its projects allow
 * (hubConnectors.ts; read again whenever a window comes back to the front, and re-checked by the launcher at start). A session that starts before the entries are read waits for them (at
 * most a few seconds; then it starts without them).
 */
function startHubMcp(): void {
  const lookups = {
    monoOf: monoForSession,
    habitRunMono,
    isLead: (id: string) => !!leadFor(id),
    // A Lead's chat, habit runs and workers carry its project (ASH_PROJECT): they reach only its memory and Ash's global one.
    leadProject: (id: string) => leadFor(id)?.projectId,
    // So does a chat in a project's coding team, and its workers: they are orchestrators like the Lead (codingTeam.ts).
    codingTeamProject: codingTeamChatProject,
  };
  // The app's own helper Claude processes (titles, commit text, the room's gate) carry the Monos-home fence too.
  registerClaudeGuards();
  // The hub's docs ship in the app (tauri.conf.json resources, docs/hub/README.md): every chat's note points at them.
  void resourceDir()
    .then((dir) => {
      setHubDocsPath(`${dir.replace(/\/+$/, "")}/hub-docs/README.md`);
      setHubDocsDir(`${dir.replace(/\/+$/, "")}/hub-docs`);
    })
    .catch(() => undefined);
  // Who a chat is is known at once: a chat that starts before the entries are read still gets the checker's limits.
  setHubMcpServers({ ashOs: null, cli: null }, lookups);
  const ashOs = tauriAshOsServer().then((server) => server ?? devAshOsStandIn());
  const cli = invoke<string>("app_cli_path").catch(() => null);
  const connectors = loadConnectors();
  window.addEventListener("focus", () => void loadConnectors());
  const read = Promise.all([ashOs, cli, connectors]).then(
    ([ashOs, cli]): HubMcpServers => ({ ashOs, cli, connectors: connectorServersForMono }),
  );
  const ready = Promise.race([
    read.then((servers) => {
      setHubMcpServers(servers, lookups);
      return true;
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]).catch(() => false);
  setClaudeExtraArgs(async (sessionId) => {
    await ready;
    return registeredHubMcpArgs(sessionId);
  });
}
if (IS_HUB_BUNDLE) startHubMcp();

// The app ships clean: it reads Ash OS. The example data answers only behind the dev flag
// (`monocode:hub-examples`, set by hub-dev.html), or when a source is swapped in with `setHubDataSource`.
let override: { source: HubDataSource; store?: HubStore } | undefined;
let chosen: { source: HubDataSource; store?: HubStore } | undefined;

function choose(): { source: HubDataSource; store?: HubStore } {
  if (chosen) return chosen;
  if (examplesOn()) {
    chosen = { source: mockHubData };
  } else {
    const store = new HubStore({
      transport: tauriHubTransport,
      whileRunning: (s) => startActivityTracking((at) => void s.reportActive(at)),
    });
    chosen = { source: createLiveHubData(store), store };
    if (makesProjectLeads()) startHubBundleLeads(store);
  }
  return chosen;
}

/**
 * The Hub bundle's project Leads and leadership team: once Ash OS has said which projects there are (and their
 * folders), make the Leads that are missing and write their souls (the old Harness lead becomes the MonoCode Hub lead
 * in place), give the team its souls, make it a member of every project and seat it in each Leadership team. Every
 * chat's Claude Code session carries its ash-os identity (startHubMcp).
 */
function startHubBundleLeads(store: HubStore): void {
  noteTeamEngines();
  void seedTeamFiles();
  // Every project on the strip gets its Lead (and the team's membership and seat), including one Ash just made with
  // New project: checked again whenever the strip's projects change (each step is idempotent; Leads register once).
  let seen = "";
  const register = (monoId: string, projectId: string) =>
    tauriHubTransport.call("ash-hub-mono-project-add", { mono_id: monoId, project_id: projectId, role: "lead" });
  const unregister = (monoId: string, projectId: string) =>
    tauriHubTransport.call("ash-hub-mono-project-remove", { mono_id: monoId, project_id: projectId });
  const tryLeads = () => {
    const projects = store.getSnapshot().projects;
    const strip = stripProjects(projects);
    const key = strip.map((p) => `${p.id}:${p.folder ?? ""}`).join("|");
    if (!strip.length || key === seen) return;
    seen = key;
    const result = ensureProjectLeads(strip, register, unregister);
    // Writes each new Lead's SOUL.md now (seeded from its standing instructions), not on its first chat.
    for (const id of result.created) void loadMonoFiles(id).catch(() => undefined);
    for (const id of result.adopted)
      void completeLeadAdoption(id, () =>
        reseedAdoptedLeadSoul(id, findMono(id)?.projects[0] ?? null, defaultSoul, readAgentFile, writeAgentFile),
      );
    // The team is normally on the roster already (the rail repairs it on render); make sure before tying and seating.
    ensureBuiltInMonos();
    tieTeamToProjects(strip, (monoId, projectId) =>
      tauriHubTransport.call("ash-hub-mono-project-add", { mono_id: monoId, project_id: projectId, role: "member" }),
    );
    seatLeadershipTeams(strip);
    // Every Mono and Lead names Grok 4.7, the Monos made before that included (monoModels.ts); idempotent.
    migrateMonoModels();
    // After the seeds: a Mono whose soul is behind the app's template takes it, as a Bot change with Undo (soulRefresh.ts).
    // Then every soul is checked against the last one the app saved, before anything else reads it (soulTamper.ts).
    watchSoulOpens();
    void seedTeamFiles()
      .then(() => seedFrankAshAsks())
      .then(() => checkSouls())
      .then(() => applyMemoryLineFixes())
      .then(() => refreshSoulsSoon());
  };
  // ash-lead becomes hub-lead first (monoRename.ts), so the Leads are made and registered under the new id.
  void renameAshLeadToHubLead({ unregister })
    .catch(() => undefined)
    .finally(() => {
      store.subscribe(tryLeads);
      tryLeads();
    });
}

/**
 * The hub project a folder belongs to (its Ash OS id), and the folder of a hub project id. A delegation records the hub
 * project id for Ash OS, which resolves it directly (docs/PHASE-2-DESIGN.md, H2/H3); a Mono may name one by its id.
 */
export function hubProjectIdFor(folder: string): string | undefined {
  const key = pathKey(folder);
  return (override ?? choose()).source.listProjects().find((project) => project.folder && pathKey(project.folder) === key)?.id;
}

export function hubProjectFolder(id: string): string | undefined {
  return (override ?? choose()).source.listProjects().find((project) => project.id === id)?.folder ?? undefined;
}

/**
 * The live store when the hub reads Ash OS (the app, a dev copy, the dev page with a stub or the live proxy); undefined
 * with the example data. Writes that Ash's taps make (keep a page, apply a change, create or rename a project) go
 * through it, so the slices they move are read again at once.
 */
export function liveHubStore(): HubStore | undefined {
  return (override ?? choose()).store;
}

/** The one place the frontend gets hub data from. */
export function hubData(): HubDataSource {
  return withProjectPrefs((override ?? choose()).source);
}

/** The projects as Ash OS has them, before Ash's own names, order and "Remove from hub": what a setup export carries. */
export function registryProjects(): HubProject[] {
  return (override ?? choose()).source.listProjects();
}

/** Every screen reads projects with Ash's own name, order and "Remove from hub" applied (projectPrefs.ts). */
const wrapped = new WeakMap<HubDataSource, HubDataSource>();
function withProjectPrefs(source: HubDataSource): HubDataSource {
  let w = wrapped.get(source);
  if (!w) {
    let memo: { from: HubProject[]; v: number; out: HubProject[] } | undefined;
    w = Object.create(source) as HubDataSource;
    w.listProjects = () => {
      const from = source.listProjects();
      const v = projectPrefsVersion();
      if (!memo || memo.from !== from || memo.v !== v) memo = { from, v, out: applyProjectPrefs(from) };
      return memo.out;
    };
    wrapped.set(source, w);
  }
  return w;
}

/**
 * Swap in another source (tests, or a different backend). Pass its store too if the screens should re-render and
 * start it when the data changes.
 */
export function setHubDataSource(next: HubDataSource | undefined, store?: HubStore): void {
  override = next ? { source: next, store } : undefined;
}

const noSubscribe = () => () => undefined;
const noSnapshot = () => undefined;

/**
 * Call this in any component that reads `hubData()` while rendering: it re-renders when the data changes, and it is
 * what starts the live store (the first screen to subscribe) and stops it (a moment after the last one leaves).
 */
export function useHubDataVersion(): void {
  useProjectPrefsVersion();
  const store = (override ?? choose()).store;
  useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getSnapshot : noSnapshot);
}

/**
 * The live store's checks (hubChecks.ts) for the app to hand to their chats; none behind the example data. Subscribing
 * keeps the store running, so a check reaches its chat whichever screen is open.
 */
export function hubCheckFeed(): Pick<HubStore, "onChecks" | "checksDelivered" | "subscribe"> | undefined {
  return (override ?? choose()).store;
}

/** Ash left the page: Needs that ticked themselves off while he was looking go away. */
export function dismissDoneNeeds(): void {
  (override ?? choose()).store?.dismissDone();
}

/**
 * Give Monocode's own project label the hub's display name, so the coding
 * views say "EXO game" rather than the folder name.
 */
export function nameHubProject(project: HubProject): void {
  if (!project.folder) return;
  const key = projectKey(project.folder);
  if (loadTabGroupLabels()[key] !== project.name) saveTabGroupLabel(key, project.name);
}

/**
 * The Since paragraph as Ash reads it: no lists of raw titles in brackets (Ash OS's plain fallback text quotes them),
 * tidy spacing. The screen also clamps it to four lines.
 */
export function calmSummary(text: string): string {
  return text
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => (inner.length > 24 || inner.includes(",") || inner.includes(";") ? "" : whole))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "Since 2pm", "Since yesterday", "Since Monday", "Since 3 Oct". */
/**
 * r65 (Critiquito: the Inbox said "since" twice): a section titled "Since you were last here" or "Since you were away"
 * reads just the time ("Since 2:10am"); any other title keeps it after a dot ("Changes · since 2:10am").
 */
export function sinceHeading(title: string, label: string): string {
  return /^since\b/i.test(title.trim()) ? label : `${title} · ${label.toLowerCase()}`;
}

export function sinceLabel(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86_400_000);
  if (days <= 0) {
    const h = then.getHours();
    const m = then.getMinutes();
    const hour = h % 12 || 12;
    return `Since ${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  }
  if (days === 1) return "Since yesterday";
  if (days < 7) return `Since ${then.toLocaleDateString("en-GB", { weekday: "long" })}`;
  return `Since ${then.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
}

/**
 * The hub's Monos list is one flat list: the default team first (Chief of Staff, Projects Manager, frank, Alfred),
 * then the project Leads, then anything else Ash added. Temporary workers are not Monos and never appear here; they
 * show only in a project's Being built.
 */
export function hubMonoRank(mono: { id: string; name?: string }): number {
  // r66 (Alfred A3): by id, so Chief of Staff renamed "Boss" keeps the top slot; the name only for an older roster entry.
  const byId = DEFAULT_TEAM_IDS.indexOf(mono.id);
  if (byId >= 0) return byId;
  const team = DEFAULT_TEAM.indexOf(mono.name ?? "");
  if (team >= 0) return team;
  if (leadFor(mono.id)) return 10;
  return 20;
}
