// Export… and Import… (Phase 5, docs/PORTABLE.md): the webview builds the setup files, Rust reads what lives on disk
// (each Mono's files, the project memory, the database's chats, notes, automations, reminders and delegations), writes
// the folder or archive, and on import reads one back for the preview and restores what Ash ticked.
import { recordRestoredSouls } from "../../hub/model/soulTamper";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { railFolders } from "./railFolders";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useSyncExternalStore } from "react";
import { appIdentity } from "../../../app/model/appIdentity";
import { listMonos } from "../../monos/model/mono";
import { examplesOn } from "../../hub/model/examples";
import { SHAPES } from "../../hub/model/hubProjects";
import { appHubTransport } from "../../hub/model/localHub/localTransport";
import { skillsOf } from "../../hub/model/setupSouls";
import { parseSetup } from "../../hub/model/setupFile";
import {
  applyImport,
  type Choices,
  type ImportSummary,
  type Inspection,
  type PendingImport,
  type Plan,
  type RustImportReport,
  type RustImportRequest,
} from "./importPlan";
import { buildSetupDoc, migrateV1, setupCounts, setupDocFromFiles, setupDocToFiles, type PortableProject, type SetupDoc, type SkillRef } from "./setupDoc";

export type MemoryFolder = { name: string; files: number; bytes: number; history: boolean; global: boolean };
export type PortableInfo = { memoryRoot: string; memory: MemoryFolder[]; dev: boolean };
export type ExportForm = "folder" | "archive";
export type ExportOptions = {
  form: ExportForm;
  destination: string;
  memory: { projects: string[]; history: boolean; monoMemory: boolean } | null;
  workspace: boolean;
};
export type ExportReport = {
  path: string;
  form: ExportForm;
  counts: Record<string, unknown>;
  secretsRemoved: number;
  files: number;
  bytes: number;
  notes: string[];
};

export function portableInfo(): Promise<PortableInfo> {
  return invoke<PortableInfo>("portable_info");
}

/** `monocode-hub-export-2026-10-19`. */
export function defaultExportName(now = new Date()): string {
  const d = (n: number) => String(n).padStart(2, "0");
  return `monocode-hub-export-${now.getFullYear()}-${d(now.getMonth() + 1)}-${d(now.getDate())}`;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

/** Dev only (src/dev/portableProof.ts, a scripted round trip in a dev slot): answers the pickers instead of the dialogs. */
type ProofPicker = { export?: (form: ExportForm) => string; import?: (kind: "file" | "folder") => string };
let proofPicker: ProofPicker | null = null;
export function setProofPicker(next: ProofPicker | null): void {
  proofPicker = import.meta.env.DEV ? next : null;
}

/** Where the export goes: a file for the archive, a new folder (picked parent + a free name) for the folder form. */
export async function pickExportDestination(form: ExportForm): Promise<string | null> {
  if (proofPicker?.export) return proofPicker.export(form);
  const name = defaultExportName();
  if (form === "archive") {
    const path = await save({ title: "Save the export", defaultPath: `${name}.tar.gz`, filters: [{ name: "MonoCode Hub export", extensions: ["gz", "tgz"] }] });
    return typeof path === "string" ? path : null;
  }
  const dir = await open({ directory: true, multiple: false, title: "Choose where the export folder goes" });
  if (typeof dir !== "string") return null;
  const candidates = [name, ...Array.from({ length: 20 }, (_, i) => `${name} ${i + 2}`)].map((n) => joinPath(dir, n));
  const exists = await invoke<Record<string, boolean>>("portable_paths_exist", { paths: candidates });
  return candidates.find((c) => !exists[c]) ?? candidates[0];
}

/** Builds the setup files and has Rust write the whole export. */
export async function exportEverything(options: ExportOptions): Promise<ExportReport> {
  const monos = listMonos();
  const monoFiles = await invoke<Record<string, Record<string, string>>>("portable_mono_files", {
    monos: monos.map((m) => ({ id: m.id, legacyProject: m.legacyProject ?? null })),
    memory: !!options.memory?.monoMemory,
  });
  const sessions = await invoke<Record<string, { harness: string; model: string }>>("portable_session_engines", {
    ids: monos.flatMap((m) => (m.sessionId ? [m.sessionId] : [])),
  });
  const engines = Object.fromEntries(monos.flatMap((m) => (m.sessionId && sessions[m.sessionId] ? [[m.id, sessions[m.sessionId]]] : [])));
  const skillNames = [...new Set(Object.values(monoFiles).flatMap((f) => skillsOf(f["SOUL.md"] ?? "")))];
  const refs = skillNames.length ? await invoke<SkillRef[]>("portable_find_skills", { names: skillNames }) : [];
  const doc = buildSetupDoc({ monoFiles, engines, skillRefs: Object.fromEntries(refs.map((r) => [r.name, r])), workspace: options.workspace });
  const id = appIdentity();
  return invoke<ExportReport>("portable_export", {
    request: {
      destination: options.destination,
      form: options.form,
      files: setupDocToFiles(doc),
      memory: options.memory ? { projects: options.memory.projects, history: options.memory.history } : null,
      workspace: options.workspace,
      counts: setupCounts(doc),
      app: id ? { product: "MonoCode Hub", version: id.version, kind: id.kind, build: id.stamp } : { product: "MonoCode Hub" },
    },
  });
}

/** Picks an export to import: a .tar.gz (or a v1 .json) or a folder. */
export async function pickImportSource(kind: "file" | "folder"): Promise<string | null> {
  if (proofPicker?.import) return proofPicker.import(kind);
  const path =
    kind === "folder"
      ? await open({ directory: true, multiple: false, title: "Choose an export folder" })
      : await open({ multiple: false, title: "Choose an export", filters: [{ name: "MonoCode Hub export", extensions: ["gz", "tgz", "json"] }] });
  return typeof path === "string" ? path : null;
}

/** Which of these project folders Rust refuses to adopt, with why (the home folder, `/`, the app's data folder ...). */
export function projectFolderChecks(paths: string[]): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("portable_project_folder_checks", { paths });
}

async function withLocalFacts(doc: SetupDoc): Promise<Pick<PendingImport, "folders" | "folderChecks" | "skillsHere">> {
  const projectFolders = [...new Set(doc.projects.flatMap((p) => (p.folder ? [p.folder] : [])))];
  const paths = [...new Set([...projectFolders, ...doc.monos.flatMap((m) => m.projects)])];
  const names = [...new Set(doc.monos.flatMap((m) => m.skills))];
  const [folders, refs, folderChecks] = await Promise.all([
    paths.length ? invoke<Record<string, boolean>>("portable_paths_exist", { paths }).catch(() => ({})) : Promise.resolve({}),
    names.length ? invoke<SkillRef[]>("portable_find_skills", { names }).catch(() => [] as SkillRef[]) : Promise.resolve([] as SkillRef[]),
    // Every folder a Mono or project names is checked, so the preview shows the refusals and a Mono never adopts one.
    paths.length ? projectFolderChecks(paths).catch(() => Object.fromEntries(paths.map((path) => [path, "it couldn't be checked"]))) : Promise.resolve({}),
  ]);
  return { folders, folderChecks, skillsHere: Object.fromEntries(refs.map((r) => [r.name, r.path !== null])) };
}

/** Reads an export (folder, archive or v1 file) for the preview. Nothing changes yet. */
export async function readImport(path: string): Promise<PendingImport> {
  const inspection = await invoke<Inspection>("portable_inspect", { path });
  const fromV1 = inspection.format === "v1";
  const doc = fromV1 ? migrateV1(parseSetup(inspection.v1 ?? "")) : setupDocFromFiles(inspection.files);
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
  return { name, path, doc, inspection, fromV1, ...(await withLocalFacts(doc)) };
}

/**
 * For the hub's Restore page (onboarding, the empty Today): the desktop app's picker and reader. "browser" means
 * there is no desktop app here: the caller opens its own file input and uses `readImportText`.
 */
export async function pickExportForRestore(): Promise<PendingImport | null | "browser"> {
  if (!isTauri()) return "browser";
  const path = await pickImportSource("file");
  return path ? readImport(path) : null;
}

/** Without the desktop app (a browser preview): a v1 setup file read as text. */
export function readImportText(name: string, text: string): PendingImport {
  return { name, path: null, doc: migrateV1(parseSetup(text)), inspection: null, fromV1: true, folders: {}, skillsHere: {} };
}

/** Registers a new project in the hub's local store. A folder that is here is adopted where it is; none is ever made. */
async function registerProject(project: PortableProject, folderHere: boolean): Promise<boolean> {
  if (examplesOn()) return false;
  await appHubTransport().call("project-create", {
    name: project.name,
    project_id: project.id,
    folder: folderHere && project.folder ? project.folder : "",
    short_name: project.shortName,
    ...(SHAPES.includes(project.iconShape) ? { icon_shape: project.iconShape } : {}),
  });
  return true;
}

/** The restore: Rust's part (memory, workspace), then the setup. */
export function restore(p: PendingImport, plan: Plan, choices: Choices): Promise<ImportSummary> {
  return applyImport(p, plan, choices, {
    rustImport: (request: RustImportRequest) => invoke<RustImportReport>("portable_import", { request }),
    registerProject,
    knownFolders: railFolders,
    knownMonos: () => listMonos().map((m) => m.id),
    checkFolders: projectFolderChecks,
    recordSouls: (ids) => recordRestoredSouls(ids),
  });
}

// ---- the export picked for the hub's Restore page (onboarding, the empty Today) ------------------------------------------

let pending: PendingImport | null = null;
let version = 0;
const EVENT = "monocode:portable-pending-changed";
export function setPendingImport(next: PendingImport | null): void {
  pending = next;
  version++;
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function pendingImport(): PendingImport | null {
  return pending;
}
export function usePendingImport(): PendingImport | null {
  useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    () => version,
    () => version,
  );
  return pending;
}
