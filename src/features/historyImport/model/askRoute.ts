// WP-51: an import briefs a signed-in CLI. A configured model is used only when
// the person picked one. A secret is dropped before either path, and no key is
// read or stored on the CLI path.

import type { ModelChoice } from "../ui/HistoryImportPage";
import { mentionsSecret } from "../../memory/model/doc";
import type { AskResult } from "./types";

export type ImportAskDeps = {
  brief: (prompt: string) => Promise<AskResult>;
  keyed: (model: ModelChoice, prompt: string) => Promise<AskResult>;
  /** Present so a caller can prove a key stays untouched unless a model was chosen. */
  readKey?: () => Promise<unknown>;
  storeKey?: (key: string) => void;
};

const SECRET_REFUSAL = "That chat contained a secret, so it was not sent.";

/** The CLI path when `model` is null. The key path only when the person chose a model. */
export async function importModelAsk(
  model: ModelChoice | null,
  prompt: string,
  deps: ImportAskDeps,
): Promise<AskResult> {
  if (mentionsSecret(prompt)) return { ok: false, kind: "refused", reason: SECRET_REFUSAL };
  if (model) return deps.keyed(model, prompt);
  return deps.brief(prompt);
}
