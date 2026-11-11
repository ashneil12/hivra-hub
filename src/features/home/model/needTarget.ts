// Where a Needs you row leads. Home and the Inbox open a row the same way.
import type { NeedsItem } from "../../needs/model/needsYou";
import type { HomeOpenTarget } from "./opener";

/** Where a Needs you row leads: the place the item names (its chat, page, decision or check), never a guess. */
export function needTarget(item: NeedsItem): HomeOpenTarget {
  const projectId = item.projectId ?? "";
  const decision = item.decisionKey?.trim();
  const gate = item.gateKey?.trim();
  const open = item.open;
  if (item.kind === "stopped") {
    return open?.where === "chat" ? { kind: "chat", id: open.id, projectId } : { kind: "task", projectId, id: open?.id || item.key };
  }
  if (open?.where === "chat") return { kind: "chat", id: open.id, projectId };
  if (open?.where === "page") return { kind: "page", id: open.id };
  if (item.kind === "check" && gate) return { kind: "inbox", projectId, decisionKey: gate };
  if (decision) return { kind: "inbox", projectId, decisionKey: decision };
  if (open?.where === "task") return { kind: "task", projectId, id: open.id };
  if (item.kind === "review" || item.kind === "question") return { kind: "task", projectId, id: item.key };
  return { kind: "inbox", projectId, decisionKey: item.key };
}
