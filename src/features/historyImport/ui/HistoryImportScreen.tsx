// WP-50: the Settings wrapper. The page itself does not import Tauri.

import { invoke } from "@tauri-apps/api/core";
import { useMemo } from "react";
import { askCrew } from "../../memory/model/crewBrief";
import type { CuratorAsk } from "../../memory/model/curator";
import { listCustomModels } from "../../sessions/model/customModels";
import { loadPrivateChatKeys } from "../../sessions/data/privateKeys";
import { importModelAsk } from "../model/askRoute";
import type { AskResult, ImportStateFile, ListReport, ProposalMeta, SourceId } from "../model/types";
import { HistoryImportPage, type HistoryPorts, type HistoryRoots, type ModelChoice } from "./HistoryImportPage";

type AskOutcome = { ok: boolean; text: string; kind: string; reason: string };

/** A timeout stays retryable, so the chat is tried again. A refusal is final. */
function fromCrew(result: CuratorAsk): AskResult {
  if (result.ok) return { ok: true, text: result.text };
  if (result.kind === "refused") return { ok: false, kind: "refused", reason: result.reason };
  return {
    ok: false,
    kind: "retryable",
    reason: result.reason || "The model didn't answer this time. It can be run again.",
  };
}

function realPorts(): HistoryPorts {
  return {
    roots: () => invoke<HistoryRoots>("history_import_roots"),
    list: (root, source: SourceId) => invoke<ListReport>("history_import_list", { root, source }),
    read: (root, path, source) => invoke<string>("history_import_read", { root, path, source }),
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
          sourceKey: meta.sourceKey,
          applied: false,
        },
      }),
    // WP-51: a signed-in CLI, unless the person picked a model. A secret never reaches either.
    ask: (model: ModelChoice | null, prompt: string) =>
      importModelAsk(model, prompt, {
        brief: async (text) => fromCrew(await askCrew(text)),
        keyed: async (chosen, text) => {
          try {
            const outcome = await invoke<AskOutcome>("history_import_ask", {
              route: {
                provider: chosen.provider,
                baseUrl: chosen.baseUrl,
                modelId: chosen.modelId,
                customModelId: chosen.id,
              },
              prompt: text,
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
      }),
    // WP-111: private chats are not offered.
    excludedChats: loadPrivateChatKeys,
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
