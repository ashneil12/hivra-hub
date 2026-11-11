import { DEFAULT_TEAM, DEFAULT_TEAM_IDS, ensureBuiltInMonos } from "./builtInMonos";
import { leadFor } from "./hubLeads";
import { useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { normalizeProjectPath } from "../../projects/model/recents";
import {
  hiddenProjectFolders,
  hiddenProjectsLoaded,
  hiddenProjectsVersion,
  hiddenProjectsWithheld,
} from "../../trash/model/hidden";
import { loadTabGroupLabels, saveTabGroupLabel } from "../../workspace/model/tabGroups";
import { examplesOn } from "./examples";
import { HubStore } from "./hubStore";
import { appHubTransport } from "./localHub/localTransport";
import { startAshOsImport } from "./localHub/ashOsImport";
import { appIdentity } from "../../../app/model/appIdentity";
import { makesProjectLeads } from "./hubBundle";
import { completeLeadAdoption, ensureProjectLeads, reseedAdoptedLeadSoul } from "./hubLeads";
import { registerClaudeGuards, registeredCodexLeadConfig, registeredHubMcpArgs, setHubDocsDir, setHubMcpServers, type HubMcpServers } from "./hubMcp";
import { codingTeamChatProject } from "./codingTeam";
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
import { setCodexLeadConfig } from "../../../integrations/harness/providers/codex/codexLeadConfig";
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
 * Every hub chat's Claude Code session gets one --mcp-config (hubMcp.ts): for a Mono's own chat the delegate tool, and for a Mono's chat and its habit runs the connectors its projects allow
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
  setHubMcpServers({ cli: null }, lookups);
  const cli = invoke<string>("app_cli_path").catch(() => null);
  const connectors = loadConnectors();
  window.addEventListener("focus", () => void loadConnectors());
  const read = Promise.all([cli, connectors]).then(([cli]): HubMcpServers => ({ cli, connectors: connectorServersForMono }));
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
  // WP-120: a Codex lead gets the same monocode server, once the app CLI is known.
  setCodexLeadConfig(async (sessionId) => {
    await ready;
    return registeredCodexLeadConfig(sessionId);
  });
}
if (IS_HUB_BUNDLE) startHubMcp();

// The app ships clean: it reads its own local store (localHub/, WP-04). The example data answers only behind the dev flag
// (`monocode:hub-examples`, set by hub-dev.html), or when a source is swapped in with `setHubDataSource`.
let override: { source: HubDataSource; store?: HubStore } | undefined;
let chosen: { source: HubDataSource; store?: HubStore } | undefined;

function choose(): { source: HubDataSource; store?: HubStore } {
  if (chosen) return chosen;
  if (examplesOn()) {
    chosen = { source: mockHubData };
  } else {
    const store = new HubStore({ transport: appHubTransport() });
    chosen = { source: createLiveHubData(store), store };
    // The fake-Claude bench's projects (its plan, verify_live.rs), added once; then the first start after the bridge was
    // retired offers to bring Ash OS's projects and kept Pages over, once.
    const benchProjects = appIdentity()?.verify?.projects;
    if (benchProjects?.length) void appHubTransport().hub.importFrom({ projects: benchProjects, memberships: [], pages: [] });
    void startAshOsImport(appHubTransport().hub);
    if (makesProjectLeads()) startHubBundleLeads(store);
  }
  return chosen;
}

/**
 * The Hub bundle's project Leads and leadership team: once the local store has said which projects there are (and their
 * folders), make the Leads that are missing and write their souls. An existing ash-lead is renamed to hub-lead first;
 * if that move cannot happen it stays the hub lead, and a second hub-lead is not made. Give the team its souls, make
 * it a member of every project and seat it in each Leadership team.
 */
function startHubBundleLeads(store: HubStore): void {
  noteTeamEngines();
  void seedTeamFiles();
  // Every project on the strip gets its Lead (and the team's membership and seat), including one Ash just made with
  // New project: checked again whenever the strip's projects change (each step is idempotent; Leads register once).
  let seen = "";
  const register = (monoId: string, projectId: string) =>
    appHubTransport().call("mono-project-add", { mono_id: monoId, project_id: projectId, role: "lead" });
  const unregister = (monoId: string, projectId: string) =>
    appHubTransport().call("mono-project-remove", { mono_id: monoId, project_id: projectId });
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
      appHubTransport().call("mono-project-add", { mono_id: monoId, project_id: projectId, role: "member" }),
    );
    seatLeadershipTeams(strip);
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
 * The hub project a folder belongs to (its id), and the folder of a hub project id. A delegation records the hub
 * project id (docs/PHASE-2-DESIGN.md, H2/H3); a Mono may name one by its id.
 */
export function hubProjectIdFor(folder: string): string | undefined {
  const key = pathKey(folder);
  return (override ?? choose()).source.listProjects().find((project) => project.folder && pathKey(project.folder) === key)?.id;
}

/** The hub's projects as the spend gate reads them: the id and the folder (when it has one). */
export function hubProjectList(): Array<{ id: string; folder?: string }> {
  return (override ?? choose()).source.listProjects().map((project) => ({ id: project.id, folder: project.folder ?? undefined }));
}

export function hubProjectFolder(id: string): string | undefined {
  return (override ?? choose()).source.listProjects().find((project) => project.id === id)?.folder ?? undefined;
}

/** WP-141 round 11: every hub project folder, so a worktree can be owned by the project it belongs to. */
export function hubProjectFolders(): string[] {
  return (override ?? choose()).source.listProjects().flatMap((project) =>
    typeof project.folder === "string" && project.folder.trim() !== "" ? [project.folder] : [],
  );
}

/**
 * The live store when the hub reads its local store (the app, a dev copy); undefined with the example data. Writes that Ash's taps make (keep a page, apply a change, create or rename a project) go
 * through it, so the slices they move are read again at once.
 */
export function liveHubStore(): HubStore | undefined {
  return (override ?? choose()).store;
}

/** The one place the frontend gets hub data from. */
export function hubData(): HubDataSource {
  return withProjectPrefs((override ?? choose()).source);
}

/** The projects as the local store has them, before Ash's own names, order and "Remove from hub": what a setup export carries. */
export function registryProjects(): HubProject[] {
  return (override ?? choose()).source.listProjects();
}

/** Every screen reads projects with Ash's own name, order and "Remove from hub" applied (projectPrefs.ts). */
function projectInTrash(project: HubProject, hidden: ReadonlySet<string>): boolean {
  const ids = [project.id, project.folder].filter((id): id is string => !!id);
  return ids.some((id) => hidden.has(id) || hidden.has(normalizeProjectPath(id)));
}

function withoutTrashedProjects(projects: HubProject[]): HubProject[] {
  if (hiddenProjectsWithheld()) return [];
  if (!hiddenProjectsLoaded()) return projects;
  const hidden = hiddenProjectFolders();
  if (hidden.size === 0) return projects;
  return projects.filter((project) => !projectInTrash(project, hidden));
}

const wrapped = new WeakMap<HubDataSource, HubDataSource>();
function withProjectPrefs(source: HubDataSource): HubDataSource {
  let w = wrapped.get(source);
  if (!w) {
    let memo: { from: HubProject[]; v: number; hidden: number; out: HubProject[] } | undefined;
    w = Object.create(source) as HubDataSource;
    w.listProjects = () => {
      const from = source.listProjects();
      const v = projectPrefsVersion();
      // WP-76: a trashed project leaves Home and the rails. A failed read keeps the previous set.
      const hidden = hiddenProjectsVersion();
      if (!memo || memo.from !== from || memo.v !== v || memo.hidden !== hidden) {
        memo = { from, v, hidden, out: withoutTrashedProjects(applyProjectPrefs(from)) };
      }
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
 * The snapshot is the return value, so a memo that reads the data can list it.
 */
export function useHubDataVersion() {
  useProjectPrefsVersion();
  const store = (override ?? choose()).store;
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getSnapshot : noSnapshot);
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

/** A moment's wall clock in a zone: the Mac's own (Europe/London for Ash) unless one is named. */
function wallClock(at: Date, timeZone?: string): { y: number; mo: number; d: number; h: number; m: number } {
  if (!timeZone) return { y: at.getFullYear(), mo: at.getMonth(), d: at.getDate(), h: at.getHours(), m: at.getMinutes() };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  return { y: parts.year, mo: parts.month - 1, d: parts.day, h: parts.hour, m: parts.minute };
}

/**
 * r83: Today's "Since …" reads Ash's own clock. With no zone named it is the Mac's (Europe/London), so 13:30 UTC in
 * July reads "Since 2:30pm" (BST); a test names the zone to prove it.
 */
export function sinceLabel(iso: string, now = new Date(), timeZone?: string): string {
  const then = new Date(iso);
  const a = wallClock(then, timeZone);
  const b = wallClock(now, timeZone);
  const days = Math.round((Date.UTC(b.y, b.mo, b.d) - Date.UTC(a.y, a.mo, a.d)) / 86_400_000);
  if (days <= 0) {
    const hour = a.h % 12 || 12;
    return `Since ${hour}${a.m ? `:${String(a.m).padStart(2, "0")}` : ""}${a.h < 12 ? "am" : "pm"}`;
  }
  if (days === 1) return "Since yesterday";
  const zone = timeZone ? { timeZone } : {};
  if (days < 7) return `Since ${then.toLocaleDateString("en-GB", { weekday: "long", ...zone })}`;
  return `Since ${then.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zone })}`;
}

/**
 * The hub's Monos list is one flat list: the default team first (Chief of Staff, Projects Manager, ed, Alfred),
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
