// Translated from Raven raven/importer/orchestrator.py run_import and
// _feed_session (Apache-2.0). The upstream file does not carry a separate
// copyright line. Licence: src/features/historyImport/vendor/raven-LICENSE.
//
// The checkpoint is per chat, not per batch: a cancel between batches leaves
// the chat unsubmitted and the next run sends it from the start. Raven retries
// every failure on 30s, 60s and 120s. A refused call (the model turned it down)
// is not a rate limit, so it is not made to wait those out; it is still not
// marked submitted. A timeout or an unreachable model is deferred, not a final
// failure, and is not marked submitted.

import { citeKey, dropLinesWithoutSource } from "./provenance";
import { batchesOf, slicePause } from "./batch";
import { batchPrompt, sendable } from "./prompt";
import { assertProposal, proposalId, proposalMeta } from "./proposals";
import { entry, isSubmitted, withEntry } from "./state";
import { RETRY_BACKOFF_MS, type AskResult, type ImportStateFile, type ProposalMeta, type Unit } from "./types";

export type ProgressEvent = {
  sourceKey: string;
  status: "skipped" | "submitted" | "failed" | "deferred" | "cancelled";
  current: number;
  total: number;
  error?: string;
};

export type RunSummary = {
  total: number;
  submitted: number;
  skipped: number;
  failed: number;
  deferred: number;
  cancelled: boolean;
  secrets: number;
  droppedLines: number;
  proposals: { id: string; markdown: string; meta: ProposalMeta }[];
};

export type RunInput = {
  units: Unit[];
  state: ImportStateFile;
  revision: number;
  ask: (prompt: string) => Promise<AskResult>;
  loadState: () => Promise<{ state: ImportStateFile; revision: number }>;
  casState: (revision: number, state: ImportStateFile) => Promise<boolean>;
  writeProposal: (id: string, markdown: string, meta: ProposalMeta) => Promise<void>;
  cancelled: () => boolean;
  pause?: (ms: number, cancelled: () => boolean) => Promise<boolean>;
  now?: () => number;
  onProgress?: (event: ProgressEvent) => void;
};

type Stop = { status: "failed" | "deferred"; reason: string };

async function flushBatch(
  prompt: string,
  ask: RunInput["ask"],
  pause: (ms: number, cancelled: () => boolean) => Promise<boolean>,
  cancelled: () => boolean,
): Promise<string> {
  const waits: (number | null)[] = [...RETRY_BACKOFF_MS, null];
  let reason = "The model didn't answer this time. It can be run again.";
  for (let attempt = 0; attempt < waits.length; attempt++) {
    let result: AskResult;
    try {
      result = await ask(prompt);
    } catch {
      result = { ok: false, kind: "retryable", reason };
    }
    if (result.ok) return result.text;
    reason = result.reason || reason;
    if (result.kind === "refused") {
      const stop: Stop = { status: "failed", reason };
      throw stop;
    }
    const wait = waits[attempt];
    if (wait == null) {
      const stop: Stop = { status: "deferred", reason };
      throw stop;
    }
    if (!(await pause(wait, cancelled))) {
      const stop: Stop = { status: "deferred", reason: "cancelled" };
      throw stop;
    }
  }
  const stop: Stop = { status: "deferred", reason };
  throw stop;
}

function isStop(value: unknown): value is Stop {
  return !!value && typeof value === "object" && "status" in value && "reason" in value;
}

export async function runImport(input: RunInput): Promise<RunSummary> {
  const pause = input.pause ?? ((ms, cancelled) => slicePause(ms, cancelled, (n) => new Promise((resolve) => setTimeout(resolve, n))));
  const now = input.now ?? (() => Date.now());
  let state = input.state;
  let revision = input.revision;
  const summary: RunSummary = {
    total: input.units.length,
    submitted: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
    cancelled: false,
    secrets: 0,
    droppedLines: 0,
    proposals: [],
  };

  const commit = async (platform: string, sourceKey: string, status: "submitted" | "failed" | "deferred", error: string | null): Promise<boolean> => {
    const nextEntry = entry(status, now(), error);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (status === "submitted" && isSubmitted(state, platform, sourceKey)) return false;
      const next = withEntry(state, platform, sourceKey, nextEntry);
      if (await input.casState(revision, next)) {
        state = next;
        revision += 1;
        return true;
      }
      const fresh = await input.loadState();
      state = fresh.state;
      revision = fresh.revision;
    }
    return false;
  };

  for (let index = 0; index < input.units.length; index++) {
    if (input.cancelled()) {
      summary.cancelled = true;
      break;
    }
    const unit = input.units[index];
    const platform = unit.kind === "chat" ? unit.conversation.source : unit.source;
    const sourceKey = unit.kind === "chat" ? unit.conversation.sourceKey : unit.sourceKey;
    const progress = (status: ProgressEvent["status"], error?: string) => {
      input.onProgress?.({ sourceKey, status, current: index + 1, total: input.units.length, error });
    };

    if (isSubmitted(state, platform, sourceKey)) {
      summary.skipped += 1;
      progress("skipped");
      continue;
    }

    if (unit.kind === "empty") {
      if (await commit(platform, sourceKey, "submitted", null)) summary.submitted += 1;
      progress("submitted");
      continue;
    }
    if (unit.kind === "unreadable") {
      const reason = "Could not read this chat.";
      if (await commit(platform, sourceKey, "failed", reason)) summary.failed += 1;
      progress("failed", reason);
      continue;
    }

    const conversation = unit.conversation;
    summary.secrets += conversation.secrets;
    const messages = sendable(conversation.messages);
    if (messages.length === 0) {
      if (await commit(platform, sourceKey, "submitted", null)) summary.submitted += 1;
      progress("submitted");
      continue;
    }

    const allowed = new Set(messages.map((message) => citeKey(message.conversationId, message.messageId)));
    const batches = batchesOf(messages);
    const parts: string[] = [];
    let cancelledMid = false;
    let stop: Stop | null = null;
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      if (input.cancelled()) {
        cancelledMid = true;
        break;
      }
      try {
        parts.push(await flushBatch(batchPrompt(conversation, batches[batchIndex]), input.ask, pause, input.cancelled));
      } catch (error) {
        if (isStop(error) && error.reason === "cancelled") {
          cancelledMid = true;
          break;
        }
        if (isStop(error)) {
          stop = error;
          break;
        }
        stop = { status: "deferred", reason: "The model didn't answer this time. It can be run again." };
        break;
      }
    }

    if (cancelledMid) {
      summary.cancelled = true;
      progress("cancelled");
      break;
    }
    if (stop) {
      if (await commit(platform, sourceKey, stop.status, stop.reason)) {
        if (stop.status === "failed") summary.failed += 1;
        else summary.deferred += 1;
      }
      progress(stop.status, stop.reason);
      continue;
    }

    const dropped = dropLinesWithoutSource(parts.join("\n"), allowed);
    summary.droppedLines += dropped.dropped;
    if (!dropped.text.trim()) {
      const reason = "The model didn't cite a chat, so nothing was kept.";
      if (await commit(platform, sourceKey, "failed", reason)) summary.failed += 1;
      progress("failed", reason);
      continue;
    }

    const id = proposalId(platform, sourceKey);
    const meta = proposalMeta(conversation.source, conversation.id, conversation.project);
    try {
      assertProposal(id, dropped.text);
      await input.writeProposal(id, dropped.text, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/already/i.test(message)) {
        const reason = message || "The draft could not be saved.";
        if (await commit(platform, sourceKey, "failed", reason)) summary.failed += 1;
        progress("failed", reason);
        continue;
      }
    }
    if (await commit(platform, sourceKey, "submitted", null)) {
      summary.submitted += 1;
      summary.proposals.push({ id, markdown: dropped.text, meta });
    }
    progress("submitted");
  }

  return summary;
}
