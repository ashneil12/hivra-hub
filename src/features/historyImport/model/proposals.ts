// A proposal WP-51 can review. Nothing here is applied. The id is a SHA-256 of
// the source, so two chats do not share a folder. A 32-bit hash did.

import { hasSecretText } from "../../portable/model/secrets";
import { sha256Hex } from "./hash";
import type { ProposalMeta, SourceId } from "./types";

export function proposalId(source: string, sourceKey: string): string {
  return `hi-${sha256Hex(`${source}:${sourceKey}`)}`;
}

export function proposalMeta(
  source: SourceId,
  conversationId: string,
  project: string,
  sourceKey: string,
): ProposalMeta {
  return {
    format: 1,
    kind: "history-import",
    status: "unreviewed",
    applied: false,
    source,
    conversationId,
    project,
    sourceKey,
  };
}

/** Throws when the draft must not be saved. The Rust command checks again. */
export function assertProposal(id: string, markdown: string): void {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error("That draft id can't be used.");
  if (!markdown.trim()) throw new Error("The model didn't cite a chat, so nothing was kept.");
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim() && !/\[src:\s+[A-Za-z0-9._:-]+\s+#[A-Za-z0-9._:-]+\]/.test(line)) {
      throw new Error("A line without a source was left in.");
    }
  }
  if (hasSecretText(markdown)) throw new Error("That draft looks like it contains a secret, so it was not saved.");
}
