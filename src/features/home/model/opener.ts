// How a line on Home opens. The app lends the way. Without it, a task or a doc still selects the screen it belongs to.

import { openDocsMode } from "../../docs/docsMode";
import { openCodingTeam } from "../../hub/model/hubNav";
import { queueHomeDoc, queueHomeTask } from "./pending";

export type HomeOpenTarget =
  | { kind: "inbox"; projectId: string; decisionKey: string }
  | { kind: "task"; projectId: string; id: string }
  | { kind: "doc"; id: string }
  | { kind: "chat"; id: string }
  | { kind: "coding"; projectId: string };

let opener: ((target: HomeOpenTarget) => void) | undefined;

export function setHomeOpener(open: (target: HomeOpenTarget) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = undefined;
  };
}

export function openFromHome(target: HomeOpenTarget): void {
  if (opener) {
    opener(target);
    return;
  }
  if (target.kind === "task") {
    queueHomeTask(target.id);
    openCodingTeam(target.projectId);
    return;
  }
  if (target.kind === "coding") {
    openCodingTeam(target.projectId);
    return;
  }
  if (target.kind === "doc") {
    queueHomeDoc(target.id);
    openDocsMode();
    window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "notes" }));
  }
}

export function targetFor(line: { kind: string; projectId: string; target: string }): HomeOpenTarget {
  if (line.kind === "decision") return { kind: "inbox", projectId: line.projectId, decisionKey: line.target };
  if (line.kind === "doc") return { kind: "doc", id: line.target };
  if (line.kind === "chat") return { kind: "chat", id: line.target };
  if (line.kind === "coding") return { kind: "coding", projectId: line.projectId };
  return { kind: "task", projectId: line.projectId, id: line.target };
}
