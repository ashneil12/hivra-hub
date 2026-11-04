import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import claude from "../../src/features/historyImport/fixtures/claude.jsonl?raw";
import type { ListReport } from "../../src/features/historyImport/model/types";
import { HistoryImportPage, type HistoryPorts, type ModelChoice } from "../../src/features/historyImport/ui/HistoryImportPage";
import "../../src/styles/index.css";

const MODEL: ModelChoice = {
  id: "local",
  name: "Local",
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  modelId: "llama3.2",
};

function Harness() {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const ports = useMemo<HistoryPorts>(
    () => ({
      roots: async () => ({ claudeCode: ["/tmp/claude"], codex: [], hermes: [], hermesDatabase: false }),
      list: async (): Promise<ListReport> => ({
        missing: false,
        files: [
          {
            path: "notes/sess-1.jsonl",
            bytes: claude.length,
            mtimeMs: Date.parse("2026-01-03T10:00:00Z"),
            header: claude,
            tooBig: false,
          },
        ],
        active: 0,
        links: 0,
        database: false,
        truncated: false,
      }),
      read: async () => {
        const holder = window as unknown as { __historyReads: number };
        holder.__historyReads = (holder.__historyReads ?? 0) + 1;
        return claude;
      },
      loadState: async () => ({ revision: 0, state: { entries: {} } }),
      casState: async () => true,
      writeProposal: async () => undefined,
      ask: async () => ({
        ok: true as const,
        text: "- Likes small commits [src: sess-1 #m1]\nNo citation\n",
      }),
      models: async () => models,
    }),
    [models],
  );
  return (
    <>
      <button type="button" data-add-model onClick={() => setModels([MODEL])}>
        Use a model
      </button>
      <HistoryImportPage ports={ports} />
    </>
  );
}

(window as unknown as { __historyReads: number }).__historyReads = 0;
createRoot(document.getElementById("root")!).render(<Harness />);
