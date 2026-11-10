// @vitest-environment happy-dom
// The setup half of the Phase 5 acceptance: export this Mac's setup, import it into an empty copy, and get the same
// setup back (minus secrets). Rust's half (chats, notes, memory …) is src-tauri/src/portable/tests.rs.
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentFilePath } from "../../monos/model/monoFiles";

const PROJECTS = [
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/Projects/hivra" },
  { id: "vg-game", name: "EXO", shortName: "EXO", iconShape: "ghost", folder: "/Users/ash/Projects/vg-game" },
];
const ANTHROPIC = "sk-ant-api03-PLANTEDplantedPLANTED0123456789abcdefXYZ";
const GITHUB = "ghp_PLANTED0123456789abcdefghijklmnopqrstu";

/** A fresh copy of the app's modules (an empty data folder means empty stores too). */
async function app(projects = PROJECTS) {
  vi.resetModules();
  const hub = await import("../../hub/model/hubData");
  hub.setHubDataSource(undefined);
  const src = Object.create(hub.hubData());
  src.listProjects = () => projects;
  hub.setHubDataSource(src);
  return {
    mono: await import("../../monos/model/mono"),
    chats: await import("../../hub/model/hubChats"),
    connectors: await import("../../hub/model/connectors"),
    pages: await import("../../pages/model/pages"),
    models: await import("../../sessions/model/customModels"),
    souls: await import("../../hub/model/setupSouls"),
    templates: await import("../../hub/model/templates"),
    workers: await import("../../monos/model/workerPool"),
    monoTeams: await import("../../hub/model/monoTeams"),
    leads: await import("../../hub/model/hubLeads"),
    doc: await import("./setupDoc"),
    plan: await import("./importPlan"),
    secrets: await import("./secrets"),
  };
}

/** A Mono folder in memory: what `writeAgentFile` / `readAgentFile` do in the app. */
function folders() {
  const files = new Map<string, string>();
  return {
    files,
    read: async (id: string, path: AgentFilePath) => ({ text: files.get(`${id}/${path}`) ?? null }),
    write: async (id: string, path: AgentFilePath, text: string) => void files.set(`${id}/${path}`, text),
  };
}

const SOUL = "# Ada\n\n## Role\nRuns the day\n\n## Skills\n- memory-notes\n- dump-triage\n";

/** This Mac: projects, Monos (one on Codex), teams with conversations, connectors, Pages, models, settings. */
async function seed(a: Awaited<ReturnType<typeof app>>) {
  a.mono.addMono({ id: "ada", name: "Ada", role: "Runs Ash's day", mascot: "robot", color: "hsl(1 2% 3%)", projects: ["/Users/ash/Projects/hivra"], engine: "claude", engineModel: "opus" });
  a.mono.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "crab", mascotPicked: true, color: "hsl(4 5% 6%)", projects: ["/Users/ash/Projects/hivra"], engine: "codex" });
  a.leads.ensureProjectLeads([PROJECTS[0]]);
  const team = a.chats.ensureLeadership("hivra");
  a.chats.addMember(team.id, "ada");
  const conv = a.chats.startConversation(team.id, `what's left? (pasted ${GITHUB})`);
  expect(conv).toBeTruthy();
  a.connectors.addConnectors([{ id: "c-github", name: "GitHub", projectId: "hivra" }]);
  // A signed-in connector with an account: neither the account nor any secret may travel.
  localStorage.setItem("monocode:hub-connectors", JSON.stringify([{ id: "c-github", name: "GitHub", projectId: "hivra", signedIn: true, account: "ash@example.com", secret: GITHUB }]));
  a.pages.keepPage(a.pages.buildPreview("sign-ups this week", "Hivra lead", 1, "hivra"));
  localStorage.setItem("monocode:custom-models", JSON.stringify([{ id: "xai-1", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4", apiKey: ANTHROPIC }]));
  localStorage.setItem("monocode.themeScheme", "midnight");
  localStorage.setItem("monocode.accentColor", "hsl(200 50% 50%)");
  localStorage.setItem("monocode:hub-role-names", "1");
  localStorage.setItem("monocode.openaiKey", "sk-proj-PLANTEDplantedPLANTEDplanted0123456789");
  localStorage.setItem("monocode.someIntegration", JSON.stringify({ url: "https://x", token: "abcdefgh12345678" }));
  localStorage.setItem("monocode.keybindingOverrides", JSON.stringify({ "mod+k": "palette", token: "abcdefgh12345678" }));
  localStorage.setItem("monocode:hub-nav", JSON.stringify({ project: "hivra" }));
  localStorage.setItem("monocode:hub-project-prefs", JSON.stringify({ names: { hivra: "Hivra HQ" }, order: ["hivra", "vg-game"], hidden: [], icons: { hivra: { kind: "emoji", emoji: "🐝" }, "vg-game": { kind: "image", src: "asset://x", path: "/Users/ash/pic.png" } } }));
  a.templates.setTemplate("hivra", "product-saas");
}

beforeEach(() => localStorage.clear());

it("the setup goes out as files and comes back as the same document", async () => {
  const a = await app();
  await seed(a);
  const monoFiles = { "ada": { "SOUL.md": SOUL, "habits.json": "[]", "MEMORY.md": "- Ash files on Fridays" } };
  const doc = a.doc.buildSetupDoc({ monoFiles, workspace: true, now: new Date("2026-10-19T10:00:00Z") });
  const files = a.doc.setupDocToFiles(doc);
  expect(Object.keys(files)).toEqual(expect.arrayContaining([
    "setup/setup.json", "setup/projects/hivra.json", "setup/projects/vg-game.json", "setup/connectors.json",
    "setup/monos/ada/mono.json", "setup/monos/ada/SOUL.md", "setup/monos/ada/sheet.md",
    "setup/monos/ada/skills.json", "setup/monos/hivra-lead/mono.json", "workspace/hub/group-chats.json",
  ]));
  // The same document, scrubbed (the pasted token in the team's conversation goes).
  expect(a.doc.setupDocFromFiles(files)).toEqual(a.secrets.redactValue(doc).value);
  expect(JSON.stringify(a.doc.setupDocFromFiles(files))).not.toContain(GITHUB);
  // Each Mono says which engine it runs on, never assumed Claude.
  expect(doc.monos.find((m) => m.id === "hivra-lead")!.engine).toEqual({ harness: "codex" });
  expect(files["setup/monos/hivra-lead/sheet.md"]).toContain("Engine: Codex");
  expect(doc.monos.find((m) => m.id === "ada")).toMatchObject({ role: "Runs the day", skills: ["memory-notes", "dump-triage"], team: "leadership", projectIds: ["hivra"] });
  expect(doc.monos.find((m) => m.id === "hivra-lead")!.team).toBe("lead");
  // Every Mono folder has a MEMORY.md; an empty one isn't memory and doesn't travel.
  const empty = a.doc.buildSetupDoc({ monoFiles: { "hivra-lead": { "SOUL.md": "# s", "MEMORY.md": "  \n" } }, workspace: false });
  expect(empty.monos.find((m) => m.id === "hivra-lead")!.files).toEqual({ "SOUL.md": "# s" });
});

it("no secret is in the setup files: logins, keys and secret-looking settings stay home", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: {}, workspace: false });
  const text = Object.values(a.doc.setupDocToFiles(doc)).join("\n");
  for (const planted of ["ash@example.com", GITHUB, ANTHROPIC, "sk-proj-PLANTED", "abcdefgh12345678"]) expect(text).not.toContain(planted);
  expect(doc.connectors[0]).toEqual({ id: "c-github", name: "GitHub", projectId: "hivra", where: "mac", loginLivesIn: "This Mac's Keychain (monocode-hub:c-github)" });
  expect(doc.customModels[0]).not.toHaveProperty("apiKey");
  expect(doc.settings["monocode.openaiKey"]).toBeUndefined();
  // A preference with a secret-looking field keeps the rest; a key that isn't a preference doesn't travel at all.
  expect(JSON.parse(doc.settings["monocode.keybindingOverrides"])).toEqual({ "mod+k": "palette", token: "[secret removed]" });
  expect(doc.settings["monocode.someIntegration"]).toBeUndefined();
  expect(doc.settings["monocode.themeScheme"]).toBe("midnight");
  expect(doc.settings["monocode:hub-nav"]).toBeUndefined();
  expect(doc.projectPrefs.icons).toEqual({ hivra: { kind: "emoji", emoji: "🐝" } });
  expect(a.secrets.findSecrets(text)).toEqual([]);
  // Workspace unticked: the group chats' conversations stay out.
  expect(text).not.toContain("what's left?");
});

it("imported into an empty copy, the setup comes back the same, minus secrets, with Monos waiting for Ash's OK", async () => {
  const a = await app();
  await seed(a);
  const monoFiles = {
    "ada": { "SOUL.md": SOUL, "habits.json": '[{"name":"Morning"}]', "MEMORY.md": "- Ash files on Fridays", "memory/clients.md": "notes" },
    "hivra-lead": { "SOUL.md": "# Hivra lead\n" },
  };
  const doc = a.doc.buildSetupDoc({ monoFiles, workspace: true });
  const files = a.doc.setupDocToFiles(doc);
  const before = {
    roster: a.mono.listMonos().map(({ sessionId: _, ...m }) => m),
    chats: a.chats.exportChats(),
    pages: a.pages.allKeptPages().map((p) => p.id),
    models: a.models.listCustomModels(),
    theme: localStorage.getItem("monocode.themeScheme"),
  };

  // The empty copy: nothing in storage, fresh stores, this Mac's own folders for the same projects.
  localStorage.clear();
  const here = [{ ...PROJECTS[0], folder: "/Volumes/New/hivra" }, PROJECTS[1]];
  const b = await app(here);
  expect(b.mono.listMonos()).toEqual([]);
  const pending = { name: "export", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: { "memory-notes": true, "dump-triage": false } };
  const plan = b.plan.planImport(pending);
  expect(plan.monos.map((m) => [m.mono.id, m.state, m.engineLabel])).toEqual([["ada", "new", "Claude Code · opus"], ["hivra-lead", "new", "Codex"]]);
  expect(plan.monos[0].folders).toEqual(["/Volumes/New/hivra"]);
  expect(plan.monos[0].skillsMissing).toEqual(["dump-triage"]);
  expect(plan.projects.every((p) => p.state === "here")).toBe(true);
  const choices = b.plan.defaultChoices(plan);
  const registerProject = vi.fn(async () => true);
  const summary = await b.plan.applyImport(pending, plan, choices, { registerProject });
  expect(registerProject).not.toHaveBeenCalled();
  expect(summary.lines.join(" ")).toContain("2 Monos waiting for your OK");
  // Never seated by a file.
  expect(b.mono.listMonos()).toEqual([]);
  const disk = folders();
  for (const w of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(w.monoId, disk.write, undefined, disk.read);

  const after = b.mono.listMonos().map(({ sessionId: _, ...m }) => m);
  expect(after).toEqual(before.roster.map((m) => ({ ...m, projects: ["/Volumes/New/hivra"] })));
  expect(disk.files.get("ada/SOUL.md")).toBe(SOUL);
  // Its habits come back paused.
  expect(JSON.parse(disk.files.get("ada/habits.json")!)).toEqual([{ name: "Morning", enabled: false }]);
  expect(disk.files.get("ada/MEMORY.md")).toBe("- Ash files on Fridays");
  expect(disk.files.get("ada/memory/clients.md")).toBe("notes");
  const scrub = (v: unknown) => b.secrets.redactValue(v).value;
  expect(b.chats.exportChats()).toEqual(scrub(before.chats));
  expect(b.pages.allKeptPages().map((p) => p.id)).toEqual(before.pages);
  expect(b.models.listCustomModels()).toEqual(before.models.map(({ id, name, provider, baseUrl, modelId }) => ({ id, name, provider, baseUrl, modelId })));
  expect(JSON.stringify(b.models.listCustomModels())).not.toContain("PLANTED");
  expect(localStorage.getItem("monocode.themeScheme")).toBe(before.theme);
  expect(localStorage.getItem("monocode.openaiKey")).toBeNull();
  expect(b.connectors.allConnectors()).toEqual([{ id: "c-github", name: "GitHub", projectId: "hivra", signedIn: false }]);
  expect(b.templates.templateOf("hivra").id).toBe("product-saas");
  expect(JSON.parse(localStorage.getItem("monocode:hub-project-prefs")!)).toEqual({ names: { hivra: "Hivra HQ" }, order: ["hivra", "vg-game"], hidden: [], icons: { hivra: { kind: "emoji", emoji: "🐝" } } });
});

it("the preview shows each conflict, and the restore keeps what is already here", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL, "MEMORY.md": "- from the file" } }, workspace: true });
  const files = a.doc.setupDocToFiles(doc);

  localStorage.clear();
  const b = await app();
  // Already here: the same Ada (own soul), another Mono called "Hivra lead", the team with no
  // conversations yet, the connector, a different theme, a different template.
  b.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  b.mono.addMono({ id: "someone-else", name: "Hivra lead", mascot: "robot", color: "x", projects: [] });
  b.chats.ensureLeadership("hivra");
  b.connectors.addConnectors([{ id: "c-github", name: "GitHub", projectId: "hivra" }]);
  localStorage.setItem("monocode.themeScheme", "daylight");
  b.templates.setTemplate("hivra", "org-ops");
  const disk = folders();
  disk.files.set("ada/SOUL.md", "# my own soul");

  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const mono = (id: string) => plan.monos.find((m) => m.mono.id === id)!;
  expect(mono("ada").state).toBe("here");
  expect(mono("hivra-lead")).toMatchObject({ state: "new", nameClash: "Hivra lead" });
  expect(plan.teams[0]).toMatchObject({ state: "here", newConversations: 1 });
  expect(plan.connectors[0].state).toBe("here");
  expect(plan.settings.differ).toContain("monocode.themeScheme");
  expect(plan.settings.add).toContain("monocode.accentColor");

  const choices = b.plan.defaultChoices(plan);
  expect(choices.settings).toBe("missing");
  expect(choices.replaceSouls.size).toBe(0);
  await b.plan.applyImport(pending, plan, choices, { agentFiles: { read: disk.read, write: disk.write } });
  expect(localStorage.getItem("monocode.themeScheme")).toBe("daylight");
  expect(localStorage.getItem("monocode.accentColor")).toBe("hsl(200 50% 50%)");
  expect(b.templates.templateOf("hivra").id).toBe("org-ops");
  expect(disk.files.get("ada/SOUL.md")).toBe("# my own soul");
  expect(disk.files.get("ada/MEMORY.md")).toBe("- from the file");
  // A file never adds to a seated Mono's project list by default: a folder there is where it may start sessions.
  expect(b.mono.findMono("ada")!.projects).toEqual([]);
  expect(b.mono.monoEngine(b.mono.findMono("ada")!)).toEqual({ harness: "claude", model: "opus" });
  expect(b.mono.findMono("someone-else")!.name).toBe("Hivra lead");
  expect(b.chats.getChat("hivra:leadership")!.conversations).toHaveLength(1);
  expect(b.connectors.allConnectors()).toHaveLength(1);

  // Ticked on purpose: the file's soul and the file's settings.
  const again = b.plan.planImport(pending);
  // Ticked on purpose too: its projects, as this Mac's own project folders.
  const all = { ...b.plan.defaultChoices(again), settings: "all" as const, replaceSouls: new Set(["ada"]), monoProjects: new Set(["ada"]) };
  await b.plan.applyImport(pending, again, all, { agentFiles: { read: disk.read, write: disk.write } });
  expect(b.mono.findMono("ada")!.projects).toEqual(["/Users/ash/Projects/hivra"]);
  expect(disk.files.get("ada/SOUL.md")).toBe(SOUL);
  expect(localStorage.getItem("monocode.themeScheme")).toBe("midnight");
});

it("settings come back only as real preferences: never this install's state, a path, or anything that looks like a secret", async () => {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  // A crafted export: its setup.json says whatever it likes.
  const setup = JSON.parse(files["setup/setup.json"]) as { settings: Record<string, string> };
  const crafted = {
    "monocode:hub-bot-changes": "[]",
    "monocode:hub-lead-adopted": "{}",
    "monocode.lastModel": "x",
    "monocode.chatBackgroundPath": "/Users/someone/pic.png",
    "monocode.projectLocations": "{}",
    "monocode.claudePromptCache": "{}",
    "monocode.quickComposerShortcut": ANTHROPIC,
    "monocode.githubToken": "abcdefgh12345678",
  };
  setup.settings = { ...setup.settings, ...crafted };
  files["setup/setup.json"] = JSON.stringify(setup);

  localStorage.clear();
  const b = await app();
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect([...plan.settings.add].sort()).toEqual(["monocode.accentColor", "monocode.keybindingOverrides", "monocode.themeScheme", "monocode:hub-role-names", "monocode:hub-user-name"]);
  // Even a plan that names them can't write them.
  plan.settings.add.push(...Object.keys(crafted));
  pending.doc.settings = { ...pending.doc.settings, ...crafted };
  await b.plan.applyImport(pending, plan, { ...b.plan.defaultChoices(plan), settings: "all" });
  for (const key of Object.keys(crafted)) expect(localStorage.getItem(key), key).toBeNull();
  expect(localStorage.getItem("monocode.themeScheme")).toBe("midnight");
});

it("imported habits come back paused, with no run waiting, for a new Mono and for one already here", async () => {
  const a = await app();
  await seed(a);
  const habit = { id: "h1", name: "Morning", instructions: "Summarise the night", schedule: { scheduleKind: "daily", time: "09:00", minute: 0, dayOfWeek: 1 }, createdAt: 1, nextRunAt: 2 };
  const habits = JSON.stringify([{ ...habit, enabled: true, runRequested: true }, { ...habit, id: "h2" }]);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL, "habits.json": habits }, "hivra-lead": { "SOUL.md": "# s", "habits.json": habits } }, workspace: false });
  const files = a.doc.setupDocToFiles(doc);

  // Here already: Ada, with no habits of its own yet. Hivra lead is new.
  localStorage.clear();
  const b = await app();
  b.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  const disk = folders();
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: disk.read, write: disk.write } });
  await b.souls.seatWaitingSoul("hivra-lead", disk.write, undefined, disk.read);

  const { parseHabits } = await import("../../monos/model/monoHabits");
  for (const id of ["ada", "hivra-lead"]) {
    const written = parseHabits(disk.files.get(`${id}/habits.json`));
    expect(written.map((h) => h.id), id).toEqual(["h1", "h2"]);
    expect(written.every((h) => !h.enabled && !h.runRequested), id).toBe(true);
    expect(written[0].instructions).toBe("Summarise the night");
  }
});

it("the ticks decide: no memory leaves the Monos' memory out, no workspace leaves the conversations and Rust out", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL, "MEMORY.md": "- private" } }, workspace: true });
  const files = a.doc.setupDocToFiles(doc);
  localStorage.clear();
  const b = await app();
  const inspection = {
    format: "v2" as const, v1: null, manifest: null, files, memoryTarget: "/m",
    memory: [{ name: "hivra", targetExists: false, history: true, files: [{ path: "MEMORY.md", status: "new" as const }] }],
    workspace: { sessions: [{ id: "s1", title: "t", cwd: "/x", harness: "codex", model: "m", blocks: 2, updatedAt: 1, archived: false, monoTranscript: false, status: "new" as const }], notes: [], automations: [], reminders: 0, delegations: [] },
  };
  const pending = { name: "x", path: "/tmp/export", doc: b.doc.setupDocFromFiles(files), inspection, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const rustImport = vi.fn(async () => ({ sessionsAdded: 0, sessionsCopied: 0, notesAdded: 0, notesCopied: 0, automationsAdded: 0, remindersAdded: 0, delegationsAdded: 0, memoryFilesAdded: 0, memoryFilesBeside: 0, memoryHistory: [], kept: 0, renamed: {}, notes: [] }));
  const choices = b.plan.defaultChoices(plan);
  choices.memory.on = false;
  choices.workspace.on = false;
  await b.plan.applyImport(pending, plan, choices, { rustImport });
  expect(rustImport).not.toHaveBeenCalled();
  expect(b.souls.waitingSouls().find((s) => s.monoId === "ada")!.memory).toBe("");
  expect(b.chats.getChat("hivra:leadership")!.conversations).toEqual([]);

  // Both ticked: Rust gets exactly what was ticked.
  localStorage.clear();
  const c = await app();
  const plan2 = c.plan.planImport(pending);
  const ticked = c.plan.defaultChoices(plan2);
  await c.plan.applyImport(pending, plan2, ticked, { rustImport });
  expect(rustImport).toHaveBeenCalledWith({
    path: "/tmp/export",
    memory: { projects: ["hivra"], keepBoth: false, history: true },
    workspace: { sessions: ["s1"], sessionCopies: [], notes: [], noteCopies: [], automations: [], reminders: false, delegations: false, knownFolders: [], knownMonos: expect.any(Array), folderMap: expect.any(Array) },
  });
  expect(c.souls.waitingSouls().find((s) => s.monoId === "ada")!.memory).toBe("- private");
});

it("sends Rust the folders the window lists as projects, and says what it cleared in plain words", async () => {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: true }));
  localStorage.clear();
  const b = await app();
  const inspection = {
    format: "v2" as const, v1: null, manifest: null, files, memoryTarget: "/m", memory: [],
    workspace: { sessions: [{ id: "s1", title: "t", cwd: "/x", harness: "codex", model: "m", blocks: 2, updatedAt: 1, archived: false, monoTranscript: false, status: "new" as const }], notes: [], automations: [], reminders: 0, delegations: [] },
  };
  const pending = { name: "x", path: "/tmp/export", doc: b.doc.setupDocFromFiles(files), inspection, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const report = { sessionsAdded: 3, sessionsCopied: 0, notesAdded: 0, notesCopied: 0, automationsAdded: 2, remindersAdded: 0, delegationsAdded: 0, memoryFilesAdded: 0, memoryFilesBeside: 0, memoryHistory: [], kept: 0, renamed: {}, notes: [], foldersCleared: 2, automationFoldersCleared: 1 };
  const rustImport = vi.fn(async () => report);
  const out = await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { rustImport, knownFolders: () => ["/Users/me/code/app"] });
  expect(rustImport.mock.calls[0][0]).toMatchObject({ workspace: { knownFolders: ["/Users/me/code/app"] } });
  expect(out.lines).toContain("2 chats came in without a folder, because their folder isn't inside a project on this Mac. Each asks you to choose a project before it runs.");
  expect(out.lines).toContain("1 automation lost a folder that isn't inside a project on this Mac. Choose a project for it before turning it on.");
  expect(out.lines.join(" ")).not.toMatch(/[\u2013\u2014]/);
});

// ---- project folders: unticked by default, registered before the chats are judged ----------------------------------------

/** An export of the two PROJECTS, imported into a copy with no projects; the calls the restore makes, in order. */
async function restoreProjects(
  tick: (choices: ReturnType<typeof import("./importPlan").defaultChoices>) => void,
  deps: Record<string, unknown> = {},
  folderChecks?: Record<string, string>,
) {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: true }));
  localStorage.clear();
  const b = await app([]);
  const inspection = {
    format: "v2" as const, v1: null, manifest: null, files, memoryTarget: "/m", memory: [],
    workspace: { sessions: [{ id: "s1", title: "t", cwd: PROJECTS[0].folder, harness: "codex", model: "m", blocks: 2, updatedAt: 1, archived: false, monoTranscript: false, status: "new" as const }], notes: [], automations: [], reminders: 0, delegations: [] },
  };
  const here = Object.fromEntries(PROJECTS.map((p) => [p.folder, true]));
  const pending = { name: "x", path: "/tmp/export", doc: b.doc.setupDocFromFiles(files), inspection, fromV1: false, folders: here, skillsHere: {}, ...(folderChecks ? { folderChecks } : {}) };
  const plan = b.plan.planImport(pending);
  const choices = b.plan.defaultChoices(plan);
  tick(choices);
  const calls: string[] = [];
  const rustRequests: Array<{ workspace?: { knownFolders: string[] } }> = [];
  const report = { sessionsAdded: 1, sessionsCopied: 0, notesAdded: 0, notesCopied: 0, automationsAdded: 0, remindersAdded: 0, delegationsAdded: 0, memoryFilesAdded: 0, memoryFilesBeside: 0, memoryHistory: [], kept: 0, renamed: {}, notes: [] };
  const summary = await b.plan.applyImport(pending, plan, choices, {
    registerProject: async (project: { id: string }, adopt: boolean) => { calls.push(`register:${project.id}:${adopt}`); return true; },
    checkFolders: async () => ({}),
    rustImport: async (request: { workspace?: { knownFolders: string[] } }) => { calls.push("rust"); rustRequests.push(request); return report; },
    ...deps,
  });
  return { b, plan, choices, calls, rustRequests, summary };
}

it("starts every project folder unticked: the preview never ticks one for you", async () => {
  const { plan, choices } = await restoreProjects(() => undefined);
  expect(plan.projects.filter((x) => x.state === "new" && x.folderHere).length).toBe(PROJECTS.length);
  expect(choices.projectFolders.size).toBe(0);
  // The projects themselves are still ticked: they come in, without a code folder.
  expect(choices.projects.size).toBe(PROJECTS.length);
});

it("an unticked project folder is not registered, and its chats go to Rust with no folder vouching for them", async () => {
  const { calls, rustRequests } = await restoreProjects(() => undefined);
  expect(calls).toEqual(["register:hivra:false", "register:vg-game:false", "rust"]);
  expect(rustRequests[0].workspace?.knownFolders).toEqual([]);
});

it("a ticked project folder is registered first, so its chats keep their folders", async () => {
  const { calls, rustRequests } = await restoreProjects((choices) => choices.projectFolders.add("hivra"));
  expect(calls).toEqual(["register:hivra:true", "register:vg-game:false", "rust"]);
  expect(rustRequests[0].workspace?.knownFolders).toEqual([PROJECTS[0].folder]);
});

it("a folder Rust refuses is never registered, even ticked, and the restore says so", async () => {
  const refused = { [PROJECTS[0].folder]: "it is your home folder, or a folder that holds it, so it can't be a project's folder" };
  // Refused already in the preview (the plan's fact) ...
  const inPreview = await restoreProjects((choices) => choices.projectFolders.add("hivra"), {}, refused);
  expect(inPreview.calls).toEqual(["register:hivra:false", "register:vg-game:false", "rust"]);
  expect(inPreview.rustRequests[0].workspace?.knownFolders).toEqual([]);
  // ... and asked again at the moment of registering, so a stale preview or a tick can't get past Rust.
  const asked: string[][] = [];
  const atRegistration = await restoreProjects((choices) => choices.projectFolders.add("hivra"), {
    checkFolders: async (paths: string[]) => { asked.push(paths); return refused; },
  });
  expect(asked).toEqual([[PROJECTS[0].folder]]);
  expect(atRegistration.calls).toEqual(["register:hivra:false", "register:vg-game:false", "rust"]);
  expect(atRegistration.summary.problems.join(" ")).toContain("home folder");
  // When Rust can't be asked, nothing is adopted.
  const failed = await restoreProjects((choices) => choices.projectFolders.add("hivra"), {
    checkFolders: async () => { throw new Error("no"); },
  });
  expect(failed.calls).toEqual(["register:hivra:false", "register:vg-game:false", "rust"]);
});

it("a missing checker adopts nothing: it refuses everything, it never allows it", async () => {
  const noChecker = await restoreProjects((choices) => choices.projectFolders.add("hivra"), { checkFolders: undefined });
  expect(noChecker.calls).toEqual(["register:hivra:false", "register:vg-game:false", "rust"]);
  expect(noChecker.rustRequests[0].workspace?.knownFolders).toEqual([]);
  expect(noChecker.summary.problems.join(" ")).toContain("couldn't be checked");
});

it("a Mono takes no folder from a file just because it exists here: only this Mac's own project folders", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: false });
  // A crafted file: ada's projects name places that exist but are no project's.
  const crafted = { ...doc, monos: doc.monos.map((m) => (m.id === "ada" ? { ...m, projectIds: [], projects: ["/System/Volumes/Data", "/Users/ash/.claude"] } : m)) };
  localStorage.clear();
  const b = await app();
  b.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  const pending = { name: "x", path: null, doc: crafted, inspection: null, fromV1: false, folders: { "/System/Volumes/Data": true, "/Users/ash/.claude": true }, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const ada = plan.monos.find((m) => m.mono.id === "ada")!;
  expect(ada.folders).toEqual([]);
  expect(ada.missingFolders).toEqual(["/System/Volumes/Data", "/Users/ash/.claude"]);
  const disk = folders();
  // Even ticked, a folder that isn't one of this Mac's projects is not added.
  await b.plan.applyImport(pending, plan, { ...b.plan.defaultChoices(plan), monoProjects: new Set(["ada"]) }, { agentFiles: { read: disk.read, write: disk.write } });
  expect(b.mono.findMono("ada")!.projects).toEqual([]);
});

it("a Mono's team folder is made before Rust brings the chats in", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: true });
  const files = a.doc.setupDocToFiles(doc);
  localStorage.clear();
  const b = await app();
  b.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  const inspection = {
    format: "v2" as const, v1: null, manifest: null, files, memoryTarget: "/m", memory: [],
    workspace: { sessions: [{ id: "s1", title: "t", cwd: "/x", harness: "codex", model: "m", blocks: 2, updatedAt: 1, archived: false, monoTranscript: false, status: "new" as const }], notes: [], automations: [], reminders: 0, delegations: [] },
  };
  const parsed = b.doc.setupDocFromFiles(files);
  parsed.settings = { ...parsed.settings, "monocode:mono-teams": JSON.stringify({ ada: { folder: "/other-mac/mono-teams/ada", createdAt: 5 } }) };
  const pending = { name: "x", path: "/tmp/export", doc: parsed, inspection, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const calls: string[] = [];
  const report = { sessionsAdded: 0, sessionsCopied: 0, notesAdded: 0, notesCopied: 0, automationsAdded: 0, remindersAdded: 0, delegationsAdded: 0, memoryFilesAdded: 0, memoryFilesBeside: 0, memoryHistory: [], kept: 0, renamed: {}, notes: [] };
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), {
    makeTeamFolder: async () => { calls.push("team"); return "/data/mono-teams/ada"; },
    rustImport: async () => { calls.push("rust"); return report; },
  });
  expect(calls).toEqual(["team", "rust"]);
});

it("sends Rust the seated Monos, and pairs each exported project's folder with this Mac's own by project id", async () => {
  const { rustRequests, b } = await restoreProjects(() => undefined, { knownMonos: () => ["ada"] });
  expect(rustRequests[0].workspace).toMatchObject({ knownMonos: expect.arrayContaining(["ada"]) });
  // Another user or home: the file's folder maps to this Mac's folder for the same project id; a project that isn't
  // here (or has no folder here) maps nothing.
  const exported = [{ ...PROJECTS[0], template: "product-saas" as const }, { ...PROJECTS[1], template: "product-saas" as const }];
  const hereProjects = [{ ...PROJECTS[0], folder: "/Users/new/Projects/hivra" }, { ...PROJECTS[1], folder: null }];
  expect(b.plan.folderMapFor(exported, { projects: hereProjects })).toEqual([
    { projectId: "hivra", from: PROJECTS[0].folder, to: "/Users/new/Projects/hivra" },
    // No folder here yet: the pair still goes, so a relink can map the chat once the project gets one.
    { projectId: "vg-game", from: PROJECTS[1].folder, to: "" },
  ]);
});

it("the Mono tick adds exactly the folders the preview listed, and a team folder waits for a Mono that is seated or ticked", async () => {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: false }));
  localStorage.clear();
  const b = await app();
  b.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  const parsed = b.doc.setupDocFromFiles(files);
  parsed.settings = { ...parsed.settings, "monocode:mono-teams": JSON.stringify({ ada: { folder: "/o/ada", createdAt: 1 }, stranger: { folder: "/o/stranger", createdAt: 1 } }) };
  const pending = { name: "x", path: null, doc: parsed, inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const shown = plan.monos.find((m) => m.mono.id === "ada")!.folders;
  const made: string[] = [];
  const disk = folders();
  await b.plan.applyImport(pending, plan, { ...b.plan.defaultChoices(plan), monoProjects: new Set(["ada"]) }, {
    agentFiles: { read: disk.read, write: disk.write },
    makeTeamFolder: async () => { made.push("made"); return "/data/mono-teams/x"; },
  });
  // What the tick shows is what it adds.
  expect(b.mono.findMono("ada")!.projects).toEqual(shown);
  // The team folder is made for the seated Mono only; "stranger" is neither seated nor ticked.
  expect(made).toHaveLength(1);
});

it("the souls a restore wrote (Rust's included) are handed over to be recorded as the app's own saves", async () => {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: { "ada": { "SOUL.md": SOUL } }, workspace: false }));
  localStorage.clear();
  const b = await app();
  const inspection = {
    format: "v2" as const, v1: null, manifest: null, files, memoryTarget: "/m",
    memory: [{ name: "monos", targetExists: true, history: false, files: [{ path: "hivra-lead/SOUL.md", status: "new" as const }] }],
    workspace: null,
  };
  const pending = { name: "x", path: "/tmp/export", doc: b.doc.setupDocFromFiles(files), inspection, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const report = { sessionsAdded: 0, sessionsCopied: 0, notesAdded: 0, notesCopied: 0, automationsAdded: 0, remindersAdded: 0, delegationsAdded: 0, memoryFilesAdded: 1, memoryFilesBeside: 0, memoryHistory: [], kept: 0, renamed: {}, notes: [], soulsRestored: ["hivra-lead"] };
  const recordSouls = vi.fn(async (_ids: string[]) => undefined);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { rustImport: async () => report, recordSouls });
  expect(recordSouls).toHaveBeenCalledTimes(1);
  expect(recordSouls.mock.calls[0][0]).toEqual(["hivra-lead"]);

  // Nothing written to any soul: nothing to record.
  recordSouls.mockClear();
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { rustImport: async () => ({ ...report, soulsRestored: [] }), recordSouls });
  expect(recordSouls).not.toHaveBeenCalled();
});

it("a v1 setup file still imports: its bots and souls wait, its chats, Pages and connectors come back", async () => {
  const b = await app();
  const v1 = {
    format: "monocode-hub-setup", version: 1,
    projects: [{ ...PROJECTS[0], template: "product-saas" }],
    bots: [{ id: "scout", name: "Scout", role: "Finds work", projectId: "hivra", team: "coding", skills: 0, mascot: "robot" }],
    souls: [{ monoId: "ledger", name: "Ledger", role: "Keeps the books", rules: "# Ledger", memory: "- m", workflows: "[]", skills: ["receipts"] }],
    chats: [{ id: "hivra:leadership", projectId: "hivra", name: "Leadership team", isDefault: true, memberIds: ["ledger"], conversations: [{ id: "c1", when: "Today", title: "Hi", messages: [{ id: "m1", from: "ash", text: "hello" }] }] }],
    connectors: [{ id: "c-linear", name: "Linear", projectId: "hivra" }],
    pages: [{ ...b.pages.buildPreview("sign-ups", "PM", 1, "hivra"), permissions: [] }],
  };
  const { parseSetup } = await import("../../hub/model/setupFile");
  const doc = b.doc.migrateV1(parseSetup(JSON.stringify(v1)));
  const pending = { name: "monocode-setup.json", path: null, doc, inspection: null, fromV1: true, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan));
  expect(b.souls.waitingSouls().map((s) => s.monoId).sort()).toEqual(["ledger", "scout"]);
  expect(b.souls.waitingSouls().find((s) => s.monoId === "ledger")).toMatchObject({ rules: "# Ledger", memory: "- m", workflows: "[]", projects: ["/Users/ash/Projects/hivra"] });
  expect(b.chats.getChat("hivra:leadership")!.conversations[0].messages[0].text).toBe("hello");
  expect(b.pages.allKeptPages()).toHaveLength(1);
  expect(b.connectors.allConnectors().map((c) => c.id)).toEqual(["c-linear"]);
  expect(b.mono.listMonos()).toEqual([]);
});

it("a newer setup is refused in plain words, and so is a damaged one", async () => {
  const b = await app();
  expect(() => b.doc.setupDocFromFiles({ "setup/setup.json": JSON.stringify({ format: "monocode-hub-setup", version: 3 }) })).toThrow("newer MonoCode Hub");
  expect(() => b.doc.setupDocFromFiles({ "setup/setup.json": "{oops" })).toThrow("damaged");
  expect(() => b.doc.setupDocFromFiles({})).toThrow("no setup");
});

it("a Mono's own role label travels: set, cleared, or none", async () => {
  const a = await app();
  a.mono.addMono({ id: "ada", name: "Ada", role: "Runs Ash's day", mascot: "robot", color: "x", projects: [] });
  a.mono.addMono({ id: "ed", name: "Ed", role: "", mascot: "robot", color: "x", projects: [] });
  a.mono.addMono({ id: "cam", name: "Cam", mascot: "robot", color: "x", projects: [] });
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  const mono = (id: string) => JSON.parse(files[`setup/monos/${id}/mono.json`]);
  expect(mono("ada").roleLabel).toBe("Runs Ash's day");
  expect(mono("ed").roleLabel).toBe("");
  expect("roleLabel" in mono("cam")).toBe(false);

  localStorage.clear();
  const b = await app();
  const pending = { name: "export", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { registerProject: vi.fn(async () => true) });
  const disk = folders();
  for (const w of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(w.monoId, disk.write, undefined, disk.read);
  const role = (id: string) => b.mono.monoRole(b.mono.findMono(id)!);
  expect(role("ada")).toBe("Runs Ash's day");
  expect(role("ed")).toBeUndefined();
  expect(role("cam")).toBeUndefined();
});

// A10 (Ash, 21 Oct 20:40, "transferable"): the whole setup moves into a fresh MonoCode. Two preferences used to stay
// behind: what the team calls the user (G5's onboarding name, so a fresh copy fell back to "the user") and how long a
// quiet worker may sit before it counts as stalled.
it("a fresh copy gets the user's name and the stall minutes back with the rest of the setup", async () => {
  const a = await app();
  await seed(a);
  localStorage.setItem("monocode:hub-user-name", "Sam");
  localStorage.setItem("monocode:stall-minutes", "12");
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  localStorage.clear();
  const b = await app();
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.settings.add).toEqual(expect.arrayContaining(["monocode:hub-user-name", "monocode:stall-minutes"]));
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan));
  expect(localStorage.getItem("monocode:hub-user-name")).toBe("Sam");
  expect(localStorage.getItem("monocode:stall-minutes")).toBe("12");
});

// A10 (Ash, 21 Oct, "transferable"): the two settings whose truth isn't this window's storage. A project's worker limits
// live in the app database (writing the old storage key would be ignored: that one-time import has already run), and a
// Mono's own team is an absolute folder belonging to this Mac. Both must come back on a fresh copy — the limits as they
// were, the team at the new Mac's own path — and a Mono Ash doesn't bring in gets no folder.
it("A10: a project's worker limits and a Mono's own team come back on a fresh copy", async () => {
  const a = await app();
  await seed(a);
  a.mono.addMono({ id: "scout", name: "Scout", mascot: "crab", color: "hsl(4 5% 6%)", projects: [] });
  const oldFolder = async (monoId: string) => `/Volumes/Old/mono-teams/${monoId}`;
  a.workers.setWorkerLimits("hivra", { workers: 20, heavy: 5 });
  await a.monoTeams.ensureMonoTeam("ada", oldFolder, 1000);
  await a.monoTeams.ensureMonoTeam("scout", oldFolder, 1000);

  const doc = a.doc.buildSetupDoc({ monoFiles: {}, workspace: false });
  expect(JSON.parse(doc.settings["monocode.workerLimits.v1"])).toEqual({ hivra: { workers: 20, heavy: 5 } });
  expect(JSON.parse(doc.settings["monocode:mono-teams"])).toMatchObject({
    "ada": { folder: "/Volumes/Old/mono-teams/ada", createdAt: 1000 },
  });
  const files = a.doc.setupDocToFiles(doc);
  localStorage.clear();

  // The fresh copy, with Ash bringing Ada in and leaving the Scout out.
  const b = await app();
  const made: string[] = [];
  const makeTeamFolder = async (monoId: string) => {
    const folder = `/Volumes/New/mono-teams/${monoId}`;
    made.push(folder);
    return folder;
  };
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.settings.add).toEqual(expect.arrayContaining(["monocode.workerLimits.v1", "monocode:mono-teams"]));
  const choices = b.plan.defaultChoices(plan);
  choices.monos.delete("scout");
  await b.plan.applyImport(pending, plan, choices, { makeTeamFolder });

  // The limits are what the app reads, not just a key in storage.
  expect(b.workers.workerLimits("hivra")).toEqual({ workers: 20, heavy: 5 });
  expect(b.workers.workerLimits("vg-game")).toEqual({ workers: 6, heavy: 2 });
  // The team is this Mac's folder, with the day it was first made.
  expect(b.monoTeams.monoTeam("ada")).toEqual({ monoId: "ada", folder: "/Volumes/New/mono-teams/ada", createdAt: 1000 });
  expect(b.monoTeams.monoTeam("scout")).toBeUndefined();
  expect(made).toEqual(["/Volumes/New/mono-teams/ada"]);
  expect(localStorage.getItem("monocode:mono-teams")).not.toContain("/Volumes/Old");
});

it("A10: deleted Monos stay deleted, after a restart and after an import", async () => {
  const a = await app();
  const built = await import("../../hub/model/builtInMonos");
  expect(built.ensureBuiltInMonos()).toBe(0);
  for (const [id, name] of [["ada", "Ada"], ["bo", "Bo"], ["ed", "Ed"], ["cam", "Cam"]] as const)
    a.mono.addMono({ id, name, mascot: "robot", color: "x", projects: [] });
  a.mono.addMono({ id: "scout", name: "Scout", mascot: "crab", color: "hsl(4 5% 6%)", projects: ["/Users/ash/Projects/hivra"] });
  const ids = (list: { id: string }[]) => list.map((m) => m.id);
  expect(ids(a.mono.listMonos())).toEqual(expect.arrayContaining(["cam", "ed", "scout"]));
  const before = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  a.mono.removeMono("cam");
  a.mono.removeMono("scout");

  // Restart: nothing puts a removed Mono back, and one that is still here stays.
  const r = await app();
  expect((await import("../../hub/model/builtInMonos")).ensureBuiltInMonos()).toBe(0);
  expect(ids(r.mono.listMonos())).not.toContain("cam");
  expect(ids(r.mono.listMonos())).not.toContain("scout");
  expect(ids(r.mono.listMonos())).toContain("ed");

  // An older export that still has them: imported here, neither is ticked, so neither comes back.
  const old = { name: "old", path: null, doc: r.doc.setupDocFromFiles(before), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const oldPlan = r.plan.planImport(old);
  const oldChoices = r.plan.defaultChoices(oldPlan);
  expect(oldChoices.monos.has("scout")).toBe(false);
  expect(oldChoices.monos.has("cam")).toBe(false);
  await r.plan.applyImport(old, oldPlan, oldChoices);
  expect(ids(r.mono.listMonos())).not.toContain("cam");
  expect((await import("../../hub/model/setupSouls")).waitingSouls().map((s) => s.monoId)).not.toContain("scout");

  // Today's export into a fresh install. Nothing is seeded. Ed is in the file and waits; Cam stays deleted.
  const files = r.doc.setupDocToFiles(r.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  localStorage.clear();
  const fresh = await app();
  const freshBuilt = await import("../../hub/model/builtInMonos");
  expect(freshBuilt.ensureBuiltInMonos()).toBe(0);
  expect(ids(fresh.mono.listMonos())).toEqual([]);
  const pending = { name: "x", path: null, doc: fresh.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = fresh.plan.planImport(pending);
  await fresh.plan.applyImport(pending, plan, fresh.plan.defaultChoices(plan));
  const souls = await import("../../hub/model/setupSouls");
  const waiting = souls.waitingSouls().map((s) => s.monoId);
  expect(waiting).toContain("ed");
  expect(waiting).not.toContain("cam");
  expect(waiting).not.toContain("scout");
  expect(ids(fresh.mono.listMonos())).not.toContain("cam");
  expect(freshBuilt.isMonoRemovedByUser("cam")).toBe(true);
  const disk = folders();
  await souls.seatWaitingSoul("ed", disk.write, undefined, disk.read);
  expect(ids(fresh.mono.listMonos())).toContain("ed");
  expect(ids(fresh.mono.listMonos())).not.toContain("cam");
  // And it stays gone on the fresh copy's next launch.
  const next = await app();
  expect((await import("../../hub/model/builtInMonos")).ensureBuiltInMonos()).toBe(0);
  expect(ids(next.mono.listMonos())).not.toContain("cam");
  expect(ids(next.mono.listMonos())).toContain("ed");
});

// WP-89: a Mono's worker default and the app-wide one travel with the setup. Import only adds: a Mono or a
// system default already set here is left as it is, unless Ash ticks the file's copy. A value that isn't a
// real CLI, or that carries a line break, is dropped and never repeated.
it("WP-89: export and import carry the Mono and system worker defaults, and import only adds", async () => {
  const adaDefault = { cli: "cursor", model: "cursor:composer", effort: "medium" };
  const systemDefault = { cli: "claude", model: "claude:opus-4-7", effort: "high" };
  const a = await app();
  a.mono.addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "hsl(1 2% 3%)",
    projects: ["/Users/ash/Projects/hivra"],
    workerDefault: adaDefault,
  });
  a.mono.addMono({ id: "ed", name: "Ed", mascot: "robot", color: "x", projects: [] });
  a.workers.setSystemWorkerDefault(systemDefault);
  a.workers.setProjectWorkerModel("hivra", adaDefault);
  // An old project row: a Claude model and effort, no CLI. It still reads as Claude after the round trip.
  a.workers.setProjectWorkerModel("vg-game", { model: "claude:opus-4-7", effort: "low" });

  const doc = a.doc.buildSetupDoc({ monoFiles: {}, workspace: false });
  expect(doc.monos.find((m) => m.id === "ada")?.workerDefault).toEqual(adaDefault);
  expect(doc.monos.find((m) => m.id === "ed")?.workerDefault).toBeUndefined();
  expect(JSON.parse(doc.settings["monocode.workerDefault.v1"])).toEqual(systemDefault);
  const limits = JSON.parse(doc.settings["monocode.workerLimits.v1"]) as Record<string, { cli?: string; model?: string; effort?: string }>;
  expect(limits.hivra).toMatchObject(adaDefault);
  expect(limits["vg-game"]).not.toHaveProperty("cli");
  expect(limits["vg-game"]).toMatchObject({ model: "claude:opus-4-7", effort: "low" });

  const files = a.doc.setupDocToFiles(doc);
  expect(files["setup/monos/ada/mono.json"]).toContain("cursor:composer");
  expect(files["setup/setup.json"]).toContain("monocode.workerDefault.v1");
  localStorage.clear();

  const b = await app();
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  expect(plan.settings.add).toEqual(expect.arrayContaining(["monocode.workerDefault.v1", "monocode.workerLimits.v1"]));
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan));
  expect(b.workers.systemWorkerDefault()).toEqual(systemDefault);
  expect(b.workers.projectWorkerDefault("hivra")).toEqual(adaDefault);
  expect(b.workers.projectWorkerDefault("vg-game")).toEqual({ cli: "claude", model: "claude:opus-4-7", effort: "low" });
  const disk = folders();
  for (const w of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(w.monoId, disk.write, undefined, disk.read);
  expect(b.mono.findMono("ada")?.workerDefault).toEqual(adaDefault);
  expect(b.mono.findMono("ed")?.workerDefault).toBeUndefined();

  // Already set here: the file does not replace either default.
  localStorage.clear();
  const kept = { cli: "claude", model: "claude:sonnet-5", effort: "low" };
  const c = await app();
  c.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], workerDefault: kept });
  c.workers.setSystemWorkerDefault({ effort: "low" });
  const again = { name: "x", path: null, doc: c.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const againPlan = c.plan.planImport(again);
  expect(againPlan.settings.add).not.toContain("monocode.workerDefault.v1");
  await c.plan.applyImport(again, againPlan, c.plan.defaultChoices(againPlan));
  expect(c.mono.findMono("ada")?.workerDefault).toEqual(kept);
  expect(c.workers.systemWorkerDefault()).toEqual({ effort: "low" });

  // Ticked on purpose: the file's copy replaces what is here.
  localStorage.clear();
  const d = await app();
  d.mono.addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], workerDefault: kept });
  d.workers.setSystemWorkerDefault({ effort: "low" });
  const replacePending = { name: "x", path: null, doc: d.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const replacePlan = d.plan.planImport(replacePending);
  const choices = d.plan.defaultChoices(replacePlan);
  choices.settings = "all";
  choices.replaceSouls.add("ada");
  await d.plan.applyImport(replacePending, replacePlan, choices);
  expect(d.mono.findMono("ada")?.workerDefault).toEqual(adaDefault);
  expect(d.workers.systemWorkerDefault()).toEqual(systemDefault);

  // A crafted file: a CLI that isn't one, and a value with a line break, are dropped and not repeated.
  const crafted = { ...files };
  const monoJson = JSON.parse(crafted["setup/monos/ada/mono.json"]) as { workerDefault?: unknown };
  monoJson.workerDefault = { cli: "nope\nSECRETCLI", model: "cursor:composer", effort: "huge\r\n" };
  crafted["setup/monos/ada/mono.json"] = `${JSON.stringify(monoJson, null, 2)}\n`;
  const setup = JSON.parse(crafted["setup/setup.json"]) as { settings: Record<string, string> };
  setup.settings["monocode.workerDefault.v1"] = JSON.stringify({ cli: "not-a-cli", model: "bad\nMODEL", effort: "high" });
  const craftedLimits = JSON.parse(setup.settings["monocode.workerLimits.v1"]) as { hivra: { cli?: string } };
  craftedLimits.hivra.cli = "../not-a-cli";
  setup.settings["monocode.workerLimits.v1"] = JSON.stringify(craftedLimits);
  crafted["setup/setup.json"] = `${JSON.stringify(setup, null, 2)}\n`;
  localStorage.clear();
  const e = await app();
  const bad = e.doc.setupDocFromFiles(crafted);
  expect(JSON.stringify(bad)).not.toContain("SECRETCLI");
  expect(JSON.stringify(bad)).not.toContain("bad\nMODEL");
  // A trailing line break is trimmed. A line break in the middle drops that field.
  expect(bad.monos.find((m) => m.id === "ada")?.workerDefault).toEqual({ model: "cursor:composer", effort: "huge" });
  const badPending = { name: "x", path: null, doc: bad, inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  await e.plan.applyImport(badPending, e.plan.planImport(badPending), e.plan.defaultChoices(e.plan.planImport(badPending)));
  expect(e.workers.systemWorkerDefault()).toEqual({ effort: "high" });
  // A CLI that was named and isn't one is dropped. The model is not rewritten as Claude.
  expect(e.workers.projectWorkerDefault("hivra")).toBeUndefined();
  expect(e.workers.workerLimits("hivra").workers).toBeGreaterThan(0);
  expect(JSON.stringify(e.workers.workerLimits("hivra"))).not.toContain("not-a-cli");
  for (const w of e.souls.waitingSouls()) await e.souls.seatWaitingSoul(w.monoId, disk.write, undefined, disk.read);
  expect(e.mono.findMono("ada")?.workerDefault).toEqual({ model: "cursor:composer", effort: "huge" });
  expect(JSON.stringify(e.mono.findMono("ada"))).not.toContain("SECRETCLI");
});
