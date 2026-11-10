// WP-50: the chat-history screen. It takes ports so a browser test can drive it
// without Tauri. It does not import the Tauri API.

import { useEffect, useMemo, useRef, useState } from "react";
import { hasSecretText } from "../../portable/model/secrets";
import { estimateSentence } from "../model/estimate";
import { runImport, type RunSummary } from "../model/pipeline";
import { previewFrom, rangeText } from "../model/preview";
import { unitsFrom } from "../model/parse";
import {
  SOURCES,
  type AskResult,
  type ImportStateFile,
  type ListReport,
  type Preview,
  type ProposalMeta,
  type SourceId,
} from "../model/types";

const BTN =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";

export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  modelId: string;
};

export type HistoryRoots = {
  claudeCode: string[];
  codex: string[];
  hermes: string[];
  hermesDatabase: boolean;
};

export type HistoryPorts = {
  roots: () => Promise<HistoryRoots>;
  list: (root: string, source: SourceId) => Promise<ListReport>;
  read: (root: string, path: string, source: SourceId) => Promise<string>;
  loadState: () => Promise<{ revision: number; state: ImportStateFile }>;
  casState: (revision: number, state: ImportStateFile) => Promise<boolean>;
  writeProposal: (id: string, markdown: string, meta: ProposalMeta) => Promise<void>;
  /** A null model is the signed-in CLI. A model is used only when the person picked one. */
  ask: (model: ModelChoice | null, prompt: string) => Promise<AskResult>;
  models: () => Promise<ModelChoice[]>;
  /** WP-111: private chats, when the screen can see them. A throw reads nothing this time. */
  excludedChats?: () => Promise<ReadonlySet<string>>;
};

type Listed = { source: SourceId; root: string; report: ListReport };

const OFF: Record<SourceId, boolean> = { claude_code: false, codex: false, hermes: false };

function rootsOf(source: SourceId, roots: HistoryRoots): string[] {
  if (source === "claude_code") return roots.claudeCode;
  if (source === "codex") return roots.codex;
  return roots.hermes;
}

function isModel(value: unknown): value is ModelChoice {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelChoice>;
  return (
    typeof model.id === "string" &&
    model.id.length > 0 &&
    typeof model.name === "string" &&
    typeof model.provider === "string" &&
    typeof model.baseUrl === "string" &&
    typeof model.modelId === "string"
  );
}

function conversationWord(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/** Lines safe to show. A secret or a line with no source is not rendered. */
function visibleLines(markdown: string): string[] {
  return markdown.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && /\[src:\s+[A-Za-z0-9._:-]+\s+#[A-Za-z0-9._:-]+\]/.test(trimmed) && !hasSecretText(trimmed);
  });
}

export function HistoryImportPage({ ports }: { ports: HistoryPorts }) {
  const [on, setOn] = useState<Record<SourceId, boolean>>(OFF);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [modelId, setModelId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const [note, setNote] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const listed = useRef<Listed[]>([]);
  const cancelRef = useRef(false);
  const previewGen = useRef(0);
  const runGen = useRef(0);

  useEffect(() => {
    let live = true;
    ports
      .models()
      .then((list) => {
        if (live) setModels(list.filter(isModel));
      })
      .catch(() => {
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
  }, [ports]);

  const anyOn = SOURCES.some((source) => on[source.id]);
  const chosen = models?.find((model) => model.id === modelId) ?? null;

  const estimate = useMemo(() => {
    if (!chosen || !preview) return null;
    let bytes = 0;
    for (const item of listed.current) {
      if (!on[item.source]) continue;
      for (const file of item.report.files) {
        if (!file.tooBig && Number.isFinite(file.bytes) && file.bytes > 0) bytes += file.bytes;
      }
    }
    return estimateSentence(bytes, chosen.provider, null);
  }, [chosen, preview, previewTick, on]);

  async function onPreview() {
    const gen = previewGen.current + 1;
    previewGen.current = gen;
    setNote("");
    setSummary(null);
    const enabled = SOURCES.filter((source) => on[source.id]).map((source) => source.id);
    try {
      const roots = await ports.roots();
      if (gen !== previewGen.current) return;
      const next: Listed[] = [];
      const parts: Preview[] = [];
      for (const source of enabled) {
        const reports: ListReport[] = [];
        const folders = rootsOf(source, roots);
        if (folders.length === 0) {
          reports.push({ missing: true, files: [], active: 0, links: 0, database: false, truncated: false });
        }
        for (const root of folders) {
          const report = await ports.list(root, source);
          if (gen !== previewGen.current) return;
          reports.push(report);
          next.push({ source, root, report });
        }
        const part = previewFrom(source, reports);
        if (source === "hermes") part.database = part.database || roots.hermesDatabase;
        parts.push(part);
      }
      if (gen !== previewGen.current) return;
      listed.current = next;
      setPreview(mergePreviews(parts));
      setPreviewTick((tick) => tick + 1);
    } catch {
      if (gen !== previewGen.current) return;
      setNote("Couldn't look at those chats. You can try again.");
    }
  }

  async function onRun() {
    if (!chosen || !preview) return;
    const gen = runGen.current + 1;
    runGen.current = gen;
    cancelRef.current = false;
    setRunning(true);
    setSummary(null);
    setNote("");
    setProgress("Starting.");
    try {
      let excludedKeys = new Set<string>();
      if (ports.excludedChats) {
        try {
          excludedKeys = new Set(await ports.excludedChats());
        } catch {
          if (gen !== runGen.current) return;
          setProgress("");
          setNote("Couldn't check which chats are private. Nothing was read. You can run it again.");
          return;
        }
      }
      if (gen !== runGen.current) return;
      const units = [];
      for (const item of listed.current) {
        if (!on[item.source]) continue;
        for (const file of item.report.files) {
          if (cancelRef.current) break;
          if (file.tooBig) continue;
          let text = "";
          try {
            text = await ports.read(item.root, file.path, item.source);
          } catch {
            units.push({ kind: "unreadable" as const, source: item.source, sourceKey: file.path });
            continue;
          }
          if (gen !== runGen.current) return;
          units.push(...unitsFrom(item.source, file.path, text));
        }
      }
      const loaded = await ports.loadState();
      if (gen !== runGen.current) return;
      const result = await runImport({
        units,
        excludedKeys,
        state: loaded.state,
        revision: loaded.revision,
        ask: (prompt) => ports.ask(chosen, prompt),
        loadState: ports.loadState,
        casState: ports.casState,
        writeProposal: ports.writeProposal,
        cancelled: () => cancelRef.current,
        onProgress: (event) => {
          if (gen === runGen.current) setProgress(`${event.current} of ${event.total}`);
        },
      });
      if (gen !== runGen.current) return;
      setSummary(result);
      setProgress("");
    } catch {
      if (gen !== runGen.current) return;
      setNote("The run didn't finish. Nothing was applied. You can run it again.");
    } finally {
      if (gen === runGen.current) setRunning(false);
    }
  }

  const canRun = !running && anyOn && preview != null;

  return (
    <section className="flex max-w-xl flex-col gap-4" data-history-import>
      <div>
        <h2 className="text-[15px] font-medium text-content">Chat history</h2>
        <p className="mt-1 text-[13px] leading-5 text-content/60">
          Turn on a source, preview it, then run. A draft is saved for you to review. Nothing is applied.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        {SOURCES.map((source) => (
          <label key={source.id} className="flex items-center gap-2 text-[13px] text-content">
            <input
              type="checkbox"
              checked={on[source.id]}
              data-source={source.id}
              onChange={() => setOn((current) => ({ ...current, [source.id]: !current[source.id] }))}
            />
            {source.label}
          </label>
        ))}
      </div>
      <div>
        <button type="button" className={BTN} disabled={!anyOn || running} onClick={() => void onPreview()}>
          Preview
        </button>
      </div>
      {preview ? <PreviewBlock preview={preview} /> : null}
      <p className="text-[13px] text-content/70">This uses your signed-in CLI, unless you pick a model.</p>
      {models && models.length > 0 ? (
        <label className="flex flex-col gap-1 text-[13px] text-content">
          Model
          <select
            aria-label="Model"
            className="rounded-md bg-content/8 px-2 py-1"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          >
            <option value="">Signed-in CLI</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {estimate ? (
        <p className="text-[13px] text-content/70" data-estimate>
          {estimate}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button type="button" className={PRIMARY} disabled={!canRun} onClick={() => void onRun()}>
          Run
        </button>
        {running ? (
          <button type="button" className={BTN} onClick={() => (cancelRef.current = true)}>
            Cancel
          </button>
        ) : null}
      </div>
      {progress ? <p className="text-[13px] text-content/60">{progress}</p> : null}
      {note ? <p className="text-[13px] text-content/70">{note}</p> : null}
      {summary ? <Result summary={summary} /> : null}
    </section>
  );
}

function mergePreviews(parts: Preview[]): Preview {
  const merged: Preview = {
    missing: parts.length === 0 || parts.every((part) => part.missing),
    conversations: 0,
    from: null,
    to: null,
    projects: [],
    files: [],
    active: 0,
    duplicates: 0,
    secretsNote: 0,
    tooBig: 0,
    links: 0,
    database: false,
    truncated: false,
  };
  const projects = new Map<string, number>();
  for (const part of parts) {
    merged.conversations += part.conversations;
    merged.active += part.active;
    merged.duplicates += part.duplicates;
    merged.tooBig += part.tooBig;
    merged.links += part.links;
    merged.database = merged.database || part.database;
    merged.truncated = merged.truncated || part.truncated;
    merged.files.push(...part.files);
    if (part.from != null) merged.from = merged.from == null ? part.from : Math.min(merged.from, part.from);
    if (part.to != null) merged.to = merged.to == null ? part.to : Math.max(merged.to, part.to);
    for (const project of part.projects) {
      projects.set(project.name, (projects.get(project.name) ?? 0) + project.conversations);
    }
  }
  merged.projects = [...projects.entries()]
    .map(([name, conversations]) => ({ name, conversations }))
    .sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name));
  return merged;
}

function PreviewBlock({ preview }: { preview: Preview }) {
  return (
    <div className="flex flex-col gap-1 text-[13px] text-content" data-preview>
      {preview.missing && preview.conversations === 0 ? (
        <p>No chats were found.</p>
      ) : (
        <>
          <p>{conversationWord(preview.conversations)}</p>
          <p>{rangeText(preview.from, preview.to)}</p>
          <ul>
            {preview.projects.map((project) => (
              <li key={project.name} data-project={project.name}>
                {project.name}
              </li>
            ))}
          </ul>
        </>
      )}
      {preview.active > 0 ? <p>{preview.active} chats are still being written, so they were left out.</p> : null}
      {preview.tooBig > 0 ? <p>{preview.tooBig} chats are too big to read in one go.</p> : null}
      {preview.links > 0 ? <p>{preview.links} links were left out.</p> : null}
      {preview.database ? <p>Hermes also keeps chats in its database. Those are not read from here.</p> : null}
      {preview.truncated ? (
        <p>There are more chats than this pass lists. Chats already read are left out, so the next run continues.</p>
      ) : null}
      {preview.duplicates > 0 ? <p>{preview.duplicates} copies of a chat were skipped.</p> : null}
    </div>
  );
}

function Result({ summary }: { summary: RunSummary }) {
  return (
    <div className="flex flex-col gap-2" data-result>
      {summary.cancelled ? <p className="text-[13px] text-content/70">Stopped. A chat that was only part way through was not kept.</p> : null}
      {summary.proposals.map((proposal) => (
        <pre key={proposal.id} className="whitespace-pre-wrap text-[13px] text-content" data-proposal>
          {visibleLines(proposal.markdown).join("\n")}
        </pre>
      ))}
      {summary.secrets > 0 ? (
        <p className="text-[13px] text-content/70">
          {summary.secrets === 1 ? "1 message was left out because it looked like a secret." : `${summary.secrets} messages were left out because they looked like a secret.`}
        </p>
      ) : null}
      {summary.droppedLines > 0 ? (
        <p className="text-[13px] text-content/70">
          {summary.droppedLines === 1 ? "1 line had no source, so it was left out." : `${summary.droppedLines} lines had no source, so they were left out.`}
        </p>
      ) : null}
      <p className="text-[13px] font-medium text-content">Not applied</p>
    </div>
  );
}
