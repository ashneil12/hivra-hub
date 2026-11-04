// WP-50: the Settings wrapper. The page itself does not import Tauri.

import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { listCustomModels } from "../../sessions/model/customModels";
import type { AskResult, ImportStateFile, ListReport, ProposalMeta, SourceId } from "../model/types";
import { HistoryImportPage, type HistoryPorts, type HistoryRoots, type ModelChoice } from "./HistoryImportPage";

type AskOutcome = { ok: boolean; text: string; kind: string; reason: string };

function realPorts(): HistoryPorts {
  return {
    roots: () => invoke<HistoryRoots>("history_import_roots"),
    list: (root, source: SourceId) => invoke<ListReport>("history_import_list", { root, source }),
    read: (root, path) => invoke<string>("history_import_read", { root, path }),
    loadState: () => invoke<{ revision: number; state: ImportStateFile }>("history_import_load_state"),
    casState: (revision, state) => invoke<boolean>("history_import_cas_state", { revision, state }),
    writeProposal: (id, markdown, meta: ProposalMeta) =>
      invoke("history_import_write_proposal", {
        proposal: {
          id,
          markdown,
          source: meta.source,
          conversationId: meta.conversationId,
          project: meta.project,
          applied: false,
        },
      }),
    ask: async (model: ModelChoice, prompt: string): Promise<AskResult> => {
      try {
        const outcome = await invoke<AskOutcome>("history_import_ask", {
          route: {
            provider: model.provider,
            baseUrl: model.baseUrl,
            modelId: model.modelId,
            customModelId: model.id,
          },
          prompt,
        });
        if (outcome.ok && typeof outcome.text === "string") return { ok: true, text: outcome.text };
        return {
          ok: false,
          kind: outcome.kind === "retryable" ? "retryable" : "refused",
          reason: "The model didn't answer this time. It can be run again.",
        };
      } catch {
        return { ok: false, kind: "retryable", reason: "The model didn't answer this time. It can be run again." };
      }
    },
    models: async () =>
      listCustomModels()
        .filter((model) => typeof model.provider === "string" && typeof model.baseUrl === "string")
        .map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          baseUrl: model.baseUrl,
          modelId: model.modelId,
        })),
  };
}

export function HistoryImportScreen() {
  const ports = useMemo(() => realPorts(), []);
  return <HistoryImportPage ports={ports} />;
}
