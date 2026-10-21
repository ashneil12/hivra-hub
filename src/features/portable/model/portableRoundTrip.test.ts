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

const SOUL = "# Chief of Staff\n\n## Role\nRuns the day\n\n## Skills\n- ash-os\n- dump-triage\n";

/** This Mac: projects, Monos (one on Codex), teams with conversations, connectors, Pages, models, settings. */
async function seed(a: Awaited<ReturnType<typeof app>>) {
  a.mono.addMono({ id: "chief-of-staff", name: "Chief of Staff", role: "Runs Ash's day", mascot: "robot", color: "hsl(1 2% 3%)", projects: ["/Users/ash/Projects/hivra"], engine: "claude", engineModel: "opus" });
  a.mono.addMono({ id: "hivra-lead", name: "Hivra lead", mascot: "crab", mascotPicked: true, color: "hsl(4 5% 6%)", projects: ["/Users/ash/Projects/hivra"], engine: "codex" });
  const team = a.chats.ensureLeadership("hivra");
  a.chats.addMember(team.id, "chief-of-staff");
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
  const monoFiles = { "chief-of-staff": { "SOUL.md": SOUL, "habits.json": "[]", "MEMORY.md": "- Ash files on Fridays" } };
  const doc = a.doc.buildSetupDoc({ monoFiles, workspace: true, now: new Date("2026-10-19T10:00:00Z") });
  const files = a.doc.setupDocToFiles(doc);
  expect(Object.keys(files)).toEqual(expect.arrayContaining([
    "setup/setup.json", "setup/projects/hivra.json", "setup/projects/vg-game.json", "setup/connectors.json",
    "setup/monos/chief-of-staff/mono.json", "setup/monos/chief-of-staff/SOUL.md", "setup/monos/chief-of-staff/sheet.md",
    "setup/monos/chief-of-staff/skills.json", "setup/monos/hivra-lead/mono.json", "workspace/hub/group-chats.json",
  ]));
  // The same document, scrubbed (the pasted token in the team's conversation goes).
  expect(a.doc.setupDocFromFiles(files)).toEqual(a.secrets.redactValue(doc).value);
  expect(JSON.stringify(a.doc.setupDocFromFiles(files))).not.toContain(GITHUB);
  // Each Mono says which engine it runs on, never assumed Claude.
  expect(doc.monos.find((m) => m.id === "hivra-lead")!.engine).toEqual({ harness: "codex" });
  expect(files["setup/monos/hivra-lead/sheet.md"]).toContain("Engine: Codex");
  expect(doc.monos.find((m) => m.id === "chief-of-staff")).toMatchObject({ role: "Runs the day", skills: ["ash-os", "dump-triage"], team: "leadership", projectIds: ["hivra"] });
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
    "chief-of-staff": { "SOUL.md": SOUL, "habits.json": '[{"name":"Morning"}]', "MEMORY.md": "- Ash files on Fridays", "memory/clients.md": "notes" },
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
  const pending = { name: "export", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: { "ash-os": true, "dump-triage": false } };
  const plan = b.plan.planImport(pending);
  expect(plan.monos.map((m) => [m.mono.id, m.state, m.engineLabel])).toEqual([["chief-of-staff", "new", "Claude Code · opus"], ["hivra-lead", "new", "Codex"]]);
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
  expect(disk.files.get("chief-of-staff/SOUL.md")).toBe(SOUL);
  // Its habits come back paused.
  expect(JSON.parse(disk.files.get("chief-of-staff/habits.json")!)).toEqual([{ name: "Morning", enabled: false }]);
  expect(disk.files.get("chief-of-staff/MEMORY.md")).toBe("- Ash files on Fridays");
  expect(disk.files.get("chief-of-staff/memory/clients.md")).toBe("notes");
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
  const doc = a.doc.buildSetupDoc({ monoFiles: { "chief-of-staff": { "SOUL.md": SOUL, "MEMORY.md": "- from the file" } }, workspace: true });
  const files = a.doc.setupDocToFiles(doc);

  localStorage.clear();
  const b = await app();
  // Already here: the same Chief of Staff (own soul), another Mono called "Hivra lead", the team with no
  // conversations yet, the connector, a different theme, a different template.
  b.mono.addMono({ id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "x", projects: [] });
  b.mono.addMono({ id: "someone-else", name: "Hivra lead", mascot: "robot", color: "x", projects: [] });
  b.chats.ensureLeadership("hivra");
  b.connectors.addConnectors([{ id: "c-github", name: "GitHub", projectId: "hivra" }]);
  localStorage.setItem("monocode.themeScheme", "daylight");
  b.templates.setTemplate("hivra", "org-ops");
  const disk = folders();
  disk.files.set("chief-of-staff/SOUL.md", "# my own soul");

  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  const mono = (id: string) => plan.monos.find((m) => m.mono.id === id)!;
  expect(mono("chief-of-staff").state).toBe("here");
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
  expect(disk.files.get("chief-of-staff/SOUL.md")).toBe("# my own soul");
  expect(disk.files.get("chief-of-staff/MEMORY.md")).toBe("- from the file");
  expect(b.mono.findMono("chief-of-staff")!.projects).toEqual(["/Users/ash/Projects/hivra"]);
  expect(b.mono.monoEngine(b.mono.findMono("chief-of-staff")!)).toEqual({ harness: "claude", model: "opus" });
  expect(b.mono.findMono("someone-else")!.name).toBe("Hivra lead");
  expect(b.chats.getChat("hivra:leadership")!.conversations).toHaveLength(1);
  expect(b.connectors.allConnectors()).toHaveLength(1);

  // Ticked on purpose: the file's soul and the file's settings.
  const again = b.plan.planImport(pending);
  const all = { ...b.plan.defaultChoices(again), settings: "all" as const, replaceSouls: new Set(["chief-of-staff"]) };
  await b.plan.applyImport(pending, again, all, { agentFiles: { read: disk.read, write: disk.write } });
  expect(disk.files.get("chief-of-staff/SOUL.md")).toBe(SOUL);
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
  const doc = a.doc.buildSetupDoc({ monoFiles: { "chief-of-staff": { "SOUL.md": SOUL, "habits.json": habits }, "hivra-lead": { "SOUL.md": "# s", "habits.json": habits } }, workspace: false });
  const files = a.doc.setupDocToFiles(doc);

  // Here already: Chief of Staff, with no habits of its own yet. Hivra lead is new.
  localStorage.clear();
  const b = await app();
  b.mono.addMono({ id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "x", projects: [] });
  const disk = folders();
  const pending = { name: "x", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { agentFiles: { read: disk.read, write: disk.write } });
  await b.souls.seatWaitingSoul("hivra-lead", disk.write, undefined, disk.read);

  const { parseHabits } = await import("../../monos/model/monoHabits");
  for (const id of ["chief-of-staff", "hivra-lead"]) {
    const written = parseHabits(disk.files.get(`${id}/habits.json`));
    expect(written.map((h) => h.id), id).toEqual(["h1", "h2"]);
    expect(written.every((h) => !h.enabled && !h.runRequested), id).toBe(true);
    expect(written[0].instructions).toBe("Summarise the night");
  }
});

it("the ticks decide: no memory leaves the Monos' memory out, no workspace leaves the conversations and Rust out", async () => {
  const a = await app();
  await seed(a);
  const doc = a.doc.buildSetupDoc({ monoFiles: { "chief-of-staff": { "SOUL.md": SOUL, "MEMORY.md": "- private" } }, workspace: true });
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
  expect(b.souls.waitingSouls().find((s) => s.monoId === "chief-of-staff")!.memory).toBe("");
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
    workspace: { sessions: ["s1"], sessionCopies: [], notes: [], noteCopies: [], automations: [], reminders: false, delegations: false },
  });
  expect(c.souls.waitingSouls().find((s) => s.monoId === "chief-of-staff")!.memory).toBe("- private");
});

it("the souls a restore wrote (Rust's included) are handed over to be recorded as the app's own saves", async () => {
  const a = await app();
  await seed(a);
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: { "chief-of-staff": { "SOUL.md": SOUL } }, workspace: false }));
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

it("a Mono's own role label travels: set, cleared, or left to the built-in one", async () => {
  const a = await app();
  a.mono.addMono({ id: "chief-of-staff", name: "Chief of Staff", role: "Runs Ash's day", mascot: "robot", color: "x", projects: [] });
  a.mono.addMono({ id: "frank", name: "Frank", role: "", mascot: "robot", color: "x", projects: [] });
  a.mono.addMono({ id: "alfred", name: "Alfred", mascot: "robot", color: "x", projects: [] });
  const files = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  const mono = (id: string) => JSON.parse(files[`setup/monos/${id}/mono.json`]);
  expect(mono("chief-of-staff").roleLabel).toBe("Runs Ash's day");
  expect(mono("frank").roleLabel).toBe("");
  expect("roleLabel" in mono("alfred")).toBe(false);

  localStorage.clear();
  const b = await app();
  const pending = { name: "export", path: null, doc: b.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = b.plan.planImport(pending);
  await b.plan.applyImport(pending, plan, b.plan.defaultChoices(plan), { registerProject: vi.fn(async () => true) });
  const disk = folders();
  for (const w of b.souls.waitingSouls()) await b.souls.seatWaitingSoul(w.monoId, disk.write, undefined, disk.read);
  const role = (id: string) => b.mono.monoRole(b.mono.findMono(id)!);
  expect(role("chief-of-staff")).toBe("Runs Ash's day");
  expect(role("frank")).toBeUndefined();
  expect(role("alfred")).toBe("Team setup");
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

it("A10: deleted Monos stay deleted, after a restart and after an import", async () => {
  const a = await app();
  const built = await import("../../hub/model/builtInMonos");
  built.ensureBuiltInMonos();
  a.mono.addMono({ id: "scout", name: "Scout", mascot: "crab", color: "hsl(4 5% 6%)", projects: ["/Users/ash/Projects/hivra"] });
  const ids = (list: { id: string }[]) => list.map((m) => m.id);
  expect(ids(a.mono.listMonos())).toEqual(expect.arrayContaining(["alfred", "scout"]));
  const before = a.doc.setupDocToFiles(a.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  a.mono.removeMono("alfred");
  a.mono.removeMono("scout");

  // Restart: the default-team repair runs again and brings back neither.
  const r = await app();
  (await import("../../hub/model/builtInMonos")).ensureBuiltInMonos();
  expect(ids(r.mono.listMonos())).not.toContain("alfred");
  expect(ids(r.mono.listMonos())).not.toContain("scout");
  expect(ids(r.mono.listMonos())).toContain("frank");

  // An older export that still has them: imported here, neither is ticked, so neither comes back.
  const old = { name: "old", path: null, doc: r.doc.setupDocFromFiles(before), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const oldPlan = r.plan.planImport(old);
  const oldChoices = r.plan.defaultChoices(oldPlan);
  expect(oldChoices.monos.has("scout")).toBe(false);
  expect(oldChoices.monos.has("alfred")).toBe(false);
  await r.plan.applyImport(old, oldPlan, oldChoices);
  expect(ids(r.mono.listMonos())).not.toContain("alfred");
  expect((await import("../../hub/model/setupSouls")).waitingSouls().map((s) => s.monoId)).not.toContain("scout");

  // Today's export into a fresh install, whose first launch seeded the default team (Alfred too): Alfred goes again.
  const files = r.doc.setupDocToFiles(r.doc.buildSetupDoc({ monoFiles: {}, workspace: false }));
  localStorage.clear();
  const fresh = await app();
  (await import("../../hub/model/builtInMonos")).ensureBuiltInMonos();
  expect(ids(fresh.mono.listMonos())).toContain("alfred");
  const pending = { name: "x", path: null, doc: fresh.doc.setupDocFromFiles(files), inspection: null, fromV1: false, folders: {}, skillsHere: {} };
  const plan = fresh.plan.planImport(pending);
  await fresh.plan.applyImport(pending, plan, fresh.plan.defaultChoices(plan));
  expect(ids(fresh.mono.listMonos())).not.toContain("alfred");
  expect(ids(fresh.mono.listMonos())).toContain("frank");
  // And it stays gone on the fresh copy's next launch.
  const next = await app();
  (await import("../../hub/model/builtInMonos")).ensureBuiltInMonos();
  expect(ids(next.mono.listMonos())).not.toContain("alfred");
});
