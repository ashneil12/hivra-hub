// Dev only: the Phase 5 round trip, scripted through the real Settings → Export and import page of a dev slot, so it can
// be re-proved without anyone clicking (docs/PORTABLE.md, "Prove it in dev slots"). Loaded by main.tsx only in dev and
// only when hub:dev was started with VITE_PORTABLE_PROOF; it refuses to run in anything but a dev copy.
//
//   VITE_PORTABLE_PROOF="export|<file.tar.gz>|<memory folder>,<memory folder>" node scripts/hub-dev.mjs --seed --memory <dir>
//   VITE_PORTABLE_PROOF="import|<file.tar.gz>" node scripts/hub-dev.mjs            (from a second, fresh worktree)
//
// Each step titles the window "PROOF <n> <step>" for a few seconds, so a window capture can be taken of each one
// (`screencapture -l <window id>`); it never brings the window forward. The native file dialogs are all it skips.
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appIdentity } from "../app/model/appIdentity";
import { setProofPicker } from "../features/portable/model/portable";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(find: () => T | null | undefined, what: string, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) throw new Error(`portable proof: no ${what}`);
    await wait(250);
  }
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const button = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent?.trim() === text);

async function step(n: number, label: string): Promise<void> {
  // Never takes focus: a dev copy stays out of Ash's way (hub:dev runs it as a background app).
  await getCurrentWindow().setTitle(`PROOF ${n} ${label}`).catch(() => undefined);
  console.info(`[portable proof] ${n} ${label}`);
  await wait(4_000);
}

async function openPage(): Promise<void> {
  // A fresh slot greets with onboarding first.
  $("[data-hub-onboarding-skip]")?.click();
  await wait(500);
  await emit("open_settings");
  (await until(() => button("Export and import"), "Export and import in the Settings rail")).click();
  await until(() => $("[data-portable-page]"), "Export and import page");
  await wait(1_500);
}

/** Proof data in the source slot: a Mono on another engine with its own soul and memory, its team, a connector. */
async function prepare(): Promise<void> {
  const { addMono, findMono, updateMono } = await import("../features/monos/model/mono");
  const { writeAgentFile } = await import("../features/monos/model/monoFiles");
  const { createChat, listChats, startConversation } = await import("../features/hub/model/hubChats");
  const { addConnectors } = await import("../features/hub/model/connectors");
  if (!findMono("proof-marketing")) {
    addMono({ id: "proof-marketing", name: "Marketing", mascot: "robot", color: "hsl(30 60% 60%)", projects: [], engine: "codex" });
    await writeAgentFile("proof-marketing", "SOUL.md", "# Marketing\n\n## Role\nWrites the launch posts\n\n## Skills\n- ash-copywriting\n- human-writing\n");
    await writeAgentFile("proof-marketing", "MEMORY.md", "- The launch is on Friday (proof data)\n");
  }
  updateMono("proof-marketing", (m) => ({ ...m, engine: "codex" }));
  if (!listChats("hivra").some((c) => c.name === "Marketing")) {
    const team = createChat("hivra", "Marketing", ["proof-marketing"]);
    startConversation(team.id, "Draft the launch post (proof data)");
  }
  addConnectors([{ id: "proof-github", name: "GitHub", projectId: "hivra" }]);
}

async function exportRun(file: string, folders: string[]): Promise<void> {
  await prepare();
  await openPage();
  await step(1, "export page");
  $("[data-portable-choice=memory] [role=checkbox]")?.click();
  await until(() => $("[data-portable-memory-folders]"), "memory folders");
  for (const row of document.querySelectorAll<HTMLElement>("[data-portable-choice^='memory-']")) {
    const name = row.dataset.portableChoice!.slice("memory-".length);
    if (!folders.includes(name)) row.querySelector<HTMLElement>("[role=checkbox]")?.click();
  }
  $("[data-portable-choice=history] [role=checkbox]")?.click();
  $("[data-portable-choice=workspace] [role=checkbox]")?.click();
  await wait(500);
  await step(2, "ticked");
  $("[data-portable-export]")?.click();
  await until(() => $("[data-portable-report]") ?? $("[data-portable-problem]"), "export result");
  ($("[data-portable-report]") ?? $("[data-portable-problem]"))?.scrollIntoView({ block: "center" });
  await step(3, $("[data-portable-report]") ? "exported" : "export failed");
  void file;
}

async function importRun(): Promise<void> {
  await openPage();
  $("[data-portable-import-file]")?.click();
  await until(() => $("[data-portable-preview]") ?? $("[data-portable-problem]"), "the preview");
  await step(4, $("[data-portable-preview]") ? "preview" : "read failed");
  $("[data-portable-section=monos]")?.scrollIntoView({ block: "start" });
  await step(41, "preview monos and teams");
  $("[data-portable-section=memory]")?.scrollIntoView({ block: "start" });
  await step(5, "preview memory and workspace");
  $("[data-portable-restore]")?.click();
  await until(() => $("[data-portable-restored]") ?? $("[data-portable-error]"), "the restore");
  await step(6, $("[data-portable-restored]") ? "restored" : "restore failed");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await until(() => $("[data-souls-waiting]"), "Monos waiting for an OK", 20_000).catch(() => null);
  await step(7, "waiting for your OK");
  // OK on the proof's own Mono (another engine, its own soul and memory): it is seated only now.
  const row = [...document.querySelectorAll<HTMLElement>("[data-souls-waiting] > div")].find((r) => r.textContent?.includes("Marketing"));
  [...(row?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) => b.textContent === "OK")?.click();
  await wait(2_000);
  await step(8, "Marketing seated");
}

async function run(): Promise<void> {
  if (appIdentity()?.kind !== "dev") return;
  const [mode, file, folders = ""] = String(import.meta.env.VITE_PORTABLE_PROOF).split("|");
  if (!file) return;
  setProofPicker({ export: () => file, import: () => file });
  const original = await getCurrentWindow().title().catch(() => "");
  await wait(8_000);
  try {
    if (mode === "export") await exportRun(file, folders.split(",").filter(Boolean));
    else if (mode === "import") await importRun();
    await getCurrentWindow().setTitle(`PROOF done ${mode}`);
  } catch (e) {
    console.error(e);
    await getCurrentWindow().setTitle(`PROOF failed ${e instanceof Error ? e.message : String(e)}`).catch(() => undefined);
  } finally {
    setProofPicker(null);
    await wait(4_000);
    if (original) await getCurrentWindow().setTitle(original).catch(() => undefined);
  }
}

void run();
