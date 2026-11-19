import { useEffect, useState } from "react";
import { revealPath } from "../../../platform/tauri/fs";
import {
  exportEverything,
  pickExportDestination,
  pickImportSource,
  portableInfo,
  readImport,
  restore,
  type ExportForm,
  type ExportReport,
  type PortableInfo,
} from "../model/portable";
import type { PendingImport } from "../model/importPlan";
import { ImportPreview, Tick } from "./ImportPreview";
import { forYou } from "../../hub/model/userName";
import { AshOsImportButton } from "../../hub/ui/AshOsImportButton";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

function Choice({ on, onClick, title, sub, disabled, testId }: { on: boolean; onClick?: () => void; title: string; sub?: string; disabled?: boolean; testId?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-content/5" data-portable-choice={testId}>
      <span className="pt-0.5"><Tick on={on} onClick={onClick} disabled={disabled} label={title} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-content">{title}</span>
        {sub ? <span className="block text-[13px] leading-5 text-content/60">{sub}</span> : null}
      </span>
    </div>
  );
}

function size(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function summary(report: ExportReport): string {
  const c = report.counts as Record<string, number>;
  const parts: [number | undefined, string][] = [
    [c.projects, "project"], [c.monos, "Mono"], [c.teams, "team"], [c.connectors, "connector"], [c.pages, "Hub"],
    [c.settings, "setting"], [c.memoryProjects, "memory folder"], [c.sessions, "chat"], [c.notes, "note"], [c.automations, "automation"],
  ];
  return parts.filter(([n]) => typeof n === "number" && n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`).join(", ");
}

/** Settings → Export and import: the whole setup with its memory (ticked to start), and the workspace if ticked, out and back in. */
export function PortablePage() {
  const [info, setInfo] = useState<PortableInfo | null>(null);
  // Ticked to start (21 Oct): "bring my whole setup across" carries every Mono's memory and the project memory folders.
  const [memory, setMemory] = useState(true);
  const [memoryFolders, setMemoryFolders] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState(false);
  const [monoMemory, setMonoMemory] = useState(true);
  const [workspace, setWorkspace] = useState(false);
  const [form, setForm] = useState<ExportForm>("archive");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);

  useEffect(() => {
    let live = true;
    portableInfo()
      .then((next) => {
        if (!live) return;
        setInfo(next);
        setMemoryFolders(new Set(next.memory.map((m) => m.name)));
      })
      .catch((e: unknown) => {
        if (!live) return;
        // The page still works without it; say why no memory folders are listed rather than implying there are none.
        setInfo({ memoryRoot: "", memory: [], dev: false });
        setProblem(`This copy's memory folders couldn't be read: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      live = false;
    };
  }, []);

  const doExport = async () => {
    setProblem(null);
    setReport(null);
    const destination = await pickExportDestination(form).catch(() => null);
    if (!destination) return;
    setBusy("Exporting…");
    try {
      setReport(await exportEverything({
        form,
        destination,
        memory: memory ? { projects: [...memoryFolders], history, monoMemory } : null,
        workspace,
      }));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (kind: "file" | "folder") => {
    setProblem(null);
    const path = await pickImportSource(kind).catch(() => null);
    if (!path) return;
    setBusy("Reading the export…");
    try {
      setPending(await readImport(path));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (pending) {
    return (
      <div data-portable-page>
        <ImportPreview inline pending={pending} onBack={() => setPending(null)} onRestore={(plan, choices) => restore(pending, plan, choices)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-portable-page>
      <section className="flex flex-col gap-1">
        <h2 className="pb-1 text-xs text-content/60">Export</h2>
        <p className="px-3 pb-2 text-[13px] leading-5 text-content/60">
          Your whole setup in one file or a folder: use it on another Mac or with another coding engine, or keep it as a backup. Passwords, keys and logins never go in; anything that looks like one is scrubbed.
        </p>
        <Choice testId="setup" on disabled title="Setup" sub="Projects, Monos with their souls, habits, skills and engines, teams, connectors (only where each login lives), Hubs, settings and themes." />
        <Choice testId="memory" on={memory} onClick={() => setMemory((v) => !v)} title="Memory"
          sub={info?.memory.length ? forYou`Ash OS project memory from ${info.memoryRoot}, and each Mono's own memory.` : info ? `No project memory found in ${info.memoryRoot || "this copy"}; each Mono's own memory still can go.` : forYou("Ash OS project memory, and each Mono's own memory.")} />
        {memory ? (
          <div className="flex flex-col gap-0.5 pl-7" data-portable-memory-folders>
            {info?.memory.map((m) => (
              <Choice key={m.name} testId={`memory-${m.name}`} on={memoryFolders.has(m.name)}
                onClick={() => setMemoryFolders((prev) => { const n = new Set(prev); (n.has(m.name) ? n.delete(m.name) : n.add(m.name)); return n; })}
                title={m.global ? `${m.name} (every project reads it)` : m.name} sub={`${m.files} files · ${size(m.bytes)}`} />
            ))}
            {info?.memory.some((m) => m.history) ? <Choice testId="history" on={history} onClick={() => setHistory((v) => !v)} title="With each folder's history" sub="Left out for a folder whose history holds something that looks like a secret." /> : null}
            <Choice testId="mono-memory" on={monoMemory} onClick={() => setMonoMemory((v) => !v)} title="Each Mono's own memory" />
          </div>
        ) : null}
        <Choice testId="workspace" on={workspace} onClick={() => setWorkspace((v) => !v)} title="Workspace"
          sub="Chats (with which engine each ran on), notes, automations, reminders, delegation history and group chats." />
        <div className="flex items-center gap-4 px-3 pt-3 text-[13px] text-content/75">
          <span className="text-content/60">Save as</span>
          {(["archive", "folder"] as const).map((f) => (
            <label key={f} className="flex items-center gap-2">
              <Tick on={form === f} onClick={() => setForm(f)} label={f === "archive" ? "One file" : "A folder"} />
              {f === "archive" ? "One file (.tar.gz)" : "A folder"}
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 px-3 pt-3">
          <button type="button" data-portable-export onClick={() => void doExport()} className={PRIMARY} disabled={!!busy}>Export…</button>
          {busy ? <span className="text-[13px] text-content/60">{busy}</span> : null}
        </div>
        {report ? (
          <div className="flex flex-col gap-1 px-3 pt-2 text-[13px]" data-portable-report>
            <span className="text-content">Saved {report.path}</span>
            <span className="text-content/60">{summary(report)} · {size(report.bytes)}{report.secretsRemoved ? ` · ${report.secretsRemoved} secret${report.secretsRemoved === 1 ? "" : "s"} scrubbed` : ""}</span>
            {report.notes.map((n) => <span key={n} className="text-content/60">{n}</span>)}
            <span><button type="button" onClick={() => void revealPath(report.path)} className={BTN}>Show it</button></span>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="pb-1 text-xs text-content/60">Import</h2>
        <p className="px-3 pb-2 text-[13px] leading-5 text-content/60">
          See what an export brings before anything changes. It only adds: nothing of yours is replaced unless you tick it, new Monos wait for your OK, and you sign in to connectors again. Setup files from before this version work too.
        </p>
        <div className="flex items-center gap-2 px-3">
          <button type="button" data-portable-import-file onClick={() => void doImport("file")} className={BTN} disabled={!!busy}>Import a file…</button>
          <button type="button" data-portable-import-folder onClick={() => void doImport("folder")} className={BTN} disabled={!!busy}>Import a folder…</button>
        </div>
        <AshOsImportButton />
      </section>
      {problem ? <p className="px-3 text-[13px] text-content" data-portable-problem>{problem}</p> : null}
    </div>
  );
}
