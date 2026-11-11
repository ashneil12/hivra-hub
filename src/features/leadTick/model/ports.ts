// WP-160: the lead tick's ports in the app. Each one is a call the app already makes for the First Mate: the programme
// store as a first mate (WP-159), the worker limits and builder health (WP-161), the First Mate's own delegate_task
// (which keeps the fresh-eyes hold of WP-144 and the worker queue), the PR watch, delivery's one merge path as the
// First Mate (never as the person), the activity log (WP-78) and the work log (WP-157).

import { builderLaunchAllowed, type BuilderHealth, type BuilderScale } from "../../monos/model/builderScale";
import type { WorkerLimits } from "../../monos/model/workerPool";
import { collectProgramme, readPackage, type ProgrammePackage, type ProgrammeStatus } from "../../programme/model/programme";
import type { LeadContext } from "./schedule";
import type { LeadTickPorts, SlotAnswer, TickMergeOutcome, TickWatch } from "./tick";

export type SlotFacts = {
  limits: Pick<WorkerLimits, "workers">;
  /** The project's workers running or asking now. */
  running: number;
  /** The project's workers waiting in the worker queue. */
  waiting: number;
  /** The programme's packages already building (a held brief has no worker yet but takes a slot). */
  inFlight: number;
  health: BuilderHealth | null | undefined;
  scale: BuilderScale;
  /** The spend verdict for a new builder on this project (WP-176). Over the limit takes no slot. */
  spend?: { status: string; reason: string };
};

/** A new builder may start when the project is under its worker limit, under its spend limit and the machine is not paused (WP-161). */
export function slotAnswer(facts: SlotFacts): SlotAnswer {
  const used = Math.max(facts.running + facts.waiting, facts.inFlight);
  if (used >= facts.limits.workers) {
    return { ok: false, reason: `all ${facts.limits.workers} builder slots for this project are in use.` };
  }
  if (facts.spend?.status === "over") return { ok: false, reason: facts.spend.reason };
  const gate = builderLaunchAllowed(facts.health, facts.scale);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  return { ok: true };
}

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type PortHost = {
  invoke: Invoke;
  slot(projectKey: string, inFlight: number): SlotAnswer;
  delegate(ownerSession: string, requestId: string, input: Record<string, unknown>): Promise<unknown>;
};

const SUMMARY_MAX = 480;

function rowOf(value: unknown): ProgrammePackage {
  const row = readPackage(value);
  if (!row) throw new Error("The programme answered with a row it couldn't read.");
  return row;
}

/** merge.rs `MergeOutcome`: the tag is camelCase, the fields keep Rust's names. */
export function outcomeOf(value: unknown): TickMergeOutcome {
  const raw = (value ?? {}) as Record<string, unknown>;
  const head = raw.head_sha ?? raw.headSha;
  if (raw.outcome === "merged" && typeof head === "string") {
    return { outcome: "merged", headSha: head, allowedBy: String(raw.allowed_by ?? raw.allowedBy ?? "") };
  }
  if (raw.outcome === "needsYou" && typeof head === "string") {
    return { outcome: "needsYou", headSha: head, question: String(raw.question ?? "") };
  }
  return { outcome: "refused", reason: typeof raw.reason === "string" ? raw.reason : "The merge path gave no answer." };
}

export function appPorts(host: PortHost, folder: string, context: LeadContext): LeadTickPorts {
  const actor = { id: context.lead.sessionId, project: context.projectId, kind: "first-mate" };
  return {
    async list() {
      // The same read the Home card makes: rows best first (the tick starts the first queued one), and a read that
      // fails or doesn't answer with a list is "unavailable", which the tick reports and retries next time.
      const loaded = await collectProgramme([context.projectId], () => host.invoke("programme_list", { actor }));
      if ("unavailable" in loaded) throw new Error("The programme isn't available.");
      return loaded.rows;
    },
    async setStatus(id: string, version: number, status: ProgrammeStatus) {
      return rowOf(await host.invoke("programme_set_status", { actor, input: { id, version, status } }));
    },
    slot: (inFlight) => host.slot(context.projectId, inFlight),
    delegate: (requestId, input) => host.delegate(context.lead.sessionId, requestId, input),
    async watches() {
      const list = await host.invoke("pr_watch_list", { ownerSession: null });
      return Array.isArray(list) ? (list as TickWatch[]) : [];
    },
    async merge(repo, number) {
      return outcomeOf(
        await host.invoke("delivery_merge", {
          input: { repo, number, caller: { kind: "agent", session: context.lead.sessionId }, method: "merge" },
        }),
      );
    },
    note(line) {
      const summary = line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 3)}...` : line;
      void host
        .invoke("activity_note", {
          kind: "lead.tick",
          summary,
          project: context.projectId,
          target: folder,
          actorId: context.lead.monoId,
          actorName: context.lead.name,
        })
        .catch(() => undefined);
    },
    outcome(line) {
      void host
        .invoke("work_log_add", { session: context.lead.sessionId, project: folder, kind: "outcome", line })
        .catch(() => undefined);
    },
    // WP-215: the chat is the Lead's own, not a field the tick can set.
    noteDecision(input) {
      void host
        .invoke("decisions_note", {
          project: input.project,
          session: context.lead.sessionId,
          what: input.what,
          reason: input.reason,
        })
        .catch(() => undefined);
    },
  };
}
