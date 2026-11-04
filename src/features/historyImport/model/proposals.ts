// A proposal WP-51 can review. Nothing here is applied. The id is a stable hash
// of the source so two windows write the same folder and the second one loses.

import { findSecrets } from "../../portable/model/secrets";
import type { ProposalMeta, SourceId } from "./types";

export function proposalId(source: string, sourceKey: string): string {
  let hash = 2166136261;
  const text = `${source}:${sourceKey}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hi-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function proposalMeta(source: SourceId, conversationId: string, project: string): ProposalMeta {
  return {
    format: 1,
    kind: "history-import",
    status: "unreviewed",
    applied: false,
    source,
    conversationId,
    project,
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
  if (findSecrets(markdown).length > 0) throw new Error("That draft looks like it contains a secret, so it was not saved.");
}
