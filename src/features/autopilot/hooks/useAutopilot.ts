// The app's one hook for autopilot (model/*.ts holds the rules; src-tauri/src/autopilot.rs the truth). Every window
// keeps the store live and answers "will this chat resume by itself?" for completion reports. The main window also
// acts:
// - while a switch covers a chat that waits on Ash (Today's "Waiting on you", hub/model/waitingChats.ts), its pick is
//   taken through that list's own `takePick(id, { by: "autopilot" })`, which refuses its red lines; a question with no
//   pick is handed back to the agent in words. A tool approval is allowed only when it is a read, a listed test or build
//   command, or an edit inside the chat's own folder (model/safeApproval.ts); every other one waits for Ash as usual.
//   Anything that touches Ash's red list (theirs or ours, model/redList.ts) waits for him. Each call goes in the
//   Autopilot log. A delegated worker's question is left to its Lead (H3's tasks.answer);
// - agents' chats stopped at a usage limit are armed to resume at the reset (on by default; per-project override),
//   brought back after a restart from the stored row, and marked done once a turn finishes.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { DEFAULT_TEAM_IDS } from "../../hub/model/builtInMonos";
import { hubData } from "../../hub/model/hubData";
import { leadFor } from "../../hub/model/hubLeads";
import { monoForSession, monoLook } from "../../monos/model/mono";
import type { ApprovalDecision } from "../../../integrations/harness/core/types";
import type { Session } from "../../sessions/model/session";
import {
  answerInWords,
  subscribeWaitingChats,
  takePick,
  waitingChats,
  type WaitingChat,
} from "../../hub/model/waitingChats";
import {
  autopilotBackend,
  autopilotSnapshot,
  autoResumeOn,
  coveringSwitch,
  ensureAutopilotStore,
  OPEN_CHAT_EVENT,
  useAutopilotVersion,
  type LogInput,
  type Resume,
} from "../model/autopilot";
import { clearRedHold, redHoldFor, setAutopilotProjects } from "../model/autopilotApp";
import { approvalVerdict, chatProject, handBackText } from "../model/decide";
import { formatUntil } from "../model/endTime";
import {
  pausedLabel,
  planResume,
  resumeRank,
  setAutoResumeEligibility,
  type ResumeAction,
  type Track,
} from "../model/limitResume";
import { publishPaused } from "../model/paused";
import { callText, redVerdict } from "../model/redList";

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function projectsList() {
  try {
    return hubData()
      .listProjects()
      .map((p) => ({ id: p.id, name: p.name, folder: p.folder }));
  } catch {
    return [];
  }
}

/** The hub project a chat works in (a Lead's own project; a Mono with one project; else by folder). */
export function sessionProject(session: Pick<Session, "id" | "cwd" | "worktreeCwd">): string | null {
  const mono = monoForSession(session.id);
  return chatProject(
    session,
    projectsList(),
    mono ? { projects: mono.projects, leadProjectId: leadFor(mono.id)?.projectId } : undefined,
  );
}

function who(session: Session): { monoId: string | null; who: string } {
  const mono = monoForSession(session.id);
  if (mono) return { monoId: mono.id, who: monoLook(mono).name };
  return { monoId: null, who: session.title || "Agent session" };
}

export function useAutopilot(options: {
  sessions: Session[];
  sessionsRef: MutableRefObject<Session[]>;
  updateSession: (id: string, change: (session: Session) => Session) => void;
  approve: (sessionId: string, requestId: number, decision: ApprovalDecision) => void;
  /** Open a stored chat in this window, for a resume armed before a restart. */
  openSession: (id: string) => Promise<Session | null>;
  /** A session someone delegated (an open delegation row). */
  isDelegated: (sessionId: string) => boolean;
  /** Show a chat (the log's "Open chat"). */
  openChat: (sessionId: string) => void;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const version = useAutopilotVersion();
  const main = useRef(isMainWindow());
  const handled = useRef(new Set<string>());
  /** A waiting chat whose answer couldn't be delivered: tried again after this time, not on every streamed word. */
  const retryAt = useRef(new Map<string, number>());
  const tracks = useRef(new Map<string, Track>());
  const busyIds = useRef(new Set<string>());
  const triedArm = useRef(new Set<string>());
  const loaded = useRef(false);
  const [booted, setBooted] = useState(0);
  const [waiting, setWaiting] = useState(0);
  // The waiting list changes on its own schedule (a chat asks, Ash answers from Today): look again each time.
  useEffect(() => subscribeWaitingChats(() => setWaiting((n) => n + 1)), []);

  // Every window: the store, where projects come from, and the completion report's question.
  useEffect(() => {
    const stopStore = ensureAutopilotStore();
    const stopProjects = setAutopilotProjects(projectsList);
    const stopEligibility = setAutoResumeEligibility((session) => eligible(session));
    return () => {
      stopStore();
      stopProjects();
      stopEligibility();
    };
  }, []);

  function agentOwned(session: Session): boolean {
    if (session.ephemeral || session.inboxAsk) return false;
    return (
      !!monoForSession(session.id) ||
      !!session.sidebarHidden ||
      !!session.orchestrationLeadId ||
      latest.current.isDelegated(session.id)
    );
  }

  function eligible(session: Session): boolean {
    return agentOwned(session) && autoResumeOn(autopilotSnapshot()?.autoResume, sessionProject(session));
  }

  function rankOf(session: Session) {
    return resumeRank(
      monoForSession(session.id)?.id,
      (id) => DEFAULT_TEAM_IDS.includes(id),
      (id) => !!leadFor(id),
    );
  }

  function log(entry: LogInput): Promise<unknown> {
    return autopilotBackend()?.log(entry).catch((error) => console.warn("Autopilot log:", error)) ?? Promise.resolve();
  }

  // Boot (main window): bring back the resumes armed before a restart.
  useEffect(() => {
    if (!main.current || loaded.current) return;
    const backend = autopilotBackend();
    if (!backend) return;
    loaded.current = true;
    void backend
      .resumes()
      .then(async (rows: Resume[]) => {
        for (const row of rows) {
          if (row.state === "cancelled") continue;
          tracks.current.set(row.sessionId, {
            state: row.state,
            resetsAt: row.resetsAt,
            resumeAt: row.resumeAt,
            attempts: row.attempts,
            applied: false,
            sawBusy: false,
            since: row.updatedAt,
          });
          if (!latest.current.sessionsRef.current.some((s) => s.id === row.sessionId)) {
            const opened = await latest.current.openSession(row.sessionId).catch(() => null);
            if (!opened) {
              tracks.current.delete(row.sessionId);
              void backend.settle(row.sessionId, "cancelled").catch(() => {});
            }
          }
        }
        setBooted((n) => n + 1);
      })
      .catch((error) => console.warn("Autopilot resumes:", error));
  }, []);

  // The log's "Open chat" (AutopilotView dispatches it).
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string" && id) latest.current.openChat(id);
    };
    window.addEventListener(OPEN_CHAT_EVENT, open);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, open);
  }, []);

  // Paused Monos for Being built (every window).
  useEffect(() => {
    const now = Date.now();
    const paused = new Map<string, string>();
    for (const session of options.sessions) {
      const label = pausedLabel(session.usageLimit, now);
      const mono = label ? monoForSession(session.id) : undefined;
      if (label && mono) paused.set(monoLook(mono).name, label);
    }
    publishPaused(paused);
  }, [options.sessions]);

  // Main window: act on every change of chats or switches.
  useEffect(() => {
    if (!main.current) return;
    const backend = autopilotBackend();
    if (!backend) return;
    const now = Date.now();
    const status = autopilotSnapshot();
    const { sessions } = options;

    // 1. Calls a switch covers. Questions come from Today's waiting list (both shapes: an AskUserQuestion and a
    // "Needs Ash:" line); approvals from the chats' latest blocks, as this runs on every streamed change.
    if (status?.switches.length) {
      for (const chat of waitingChats()) {
        // A delegated worker's question is its Lead's to answer (H3's tasks.answer), not Ash's: autopilot leaves it.
        if (latest.current.isDelegated(chat.sessionId)) continue;
        const covering = coveringSwitch(status, chat.projectId, now);
        if (!covering) continue;
        const key = `w:${chat.sessionId}:${chat.requestId ?? "line"}:${hash(`${chat.question}|${chat.pick ?? ""}`)}`;
        if (handled.current.has(key)) {
          const again = retryAt.current.get(key);
          if (again === undefined || again > now) continue;
          retryAt.current.delete(key);
        }
        handled.current.add(key);
        void decideWaiting(chat, formatUntil(covering.untilMs, now), key);
      }
      for (const session of sessions) {
        if (session.worktreeRemoved) continue;
        const pending = recentApprovals(session);
        if (!pending.length) continue;
        const covering = coveringSwitch(status, sessionProject(session), now);
        if (!covering) continue;
        const base = { project: sessionProject(session), chatId: session.id, ...who(session) };
        for (const block of pending) {
          if (!block.approval || block.approval.decided) continue;
          const key = `a:${session.id}:${block.approval.requestId}:${hash(block.tool?.title ?? block.text)}`;
          if (handled.current.has(key)) continue;
          handled.current.add(key);
          const requestId = block.approval.requestId;
          const verdict = approvalVerdict(block, session.worktreeCwd || session.cwd, redHoldFor(session.id, now));
          if (verdict.kind === "held") {
            // It waits for Ash in the chat, as when autopilot is off; the log says why.
            void log({ ...base, kind: "approval", outcome: "held", what: verdict.what, red: verdict.red, detail: `Not allowed by itself: ${verdict.why}`, dedupe: key });
          } else {
            void log({ ...base, kind: "approval", outcome: "taken", what: verdict.what, recommendation: "Allowed", dedupe: key }).then(
              () => latest.current.approve(session.id, requestId, "allow"),
            );
          }
        }
      }
    }

    /** One waiting chat under autopilot: held on a red line (either list's), its pick taken, or handed back. */
    async function decideWaiting(chat: WaitingChat, untilLabel: string, key: string) {
      const base = {
        project: chat.projectId,
        chatId: chat.sessionId,
        monoId: chat.monoId ?? null,
        who: chat.chatName,
        what: chat.question,
        recommendation: chat.pick ?? null,
        dedupe: key,
      };
      const forced = redHoldFor(chat.sessionId, now);
      const red = forced ?? redVerdict(callText(chat.question, chat.pick));
      if (red || chat.redLine) {
        if (forced) clearRedHold(chat.sessionId);
        // It stays in Waiting on you for Ash.
        void log({ ...base, kind: "question", outcome: "held", red: red ?? null });
        return;
      }
      if (chat.pick) {
        const taken = await takePick(chat.sessionId, { by: "autopilot" });
        if (taken.ok) void log({ ...base, kind: "question", outcome: "taken" });
        else if (/red line/i.test(taken.reason)) void log({ ...base, kind: "question", outcome: "held" });
        // Couldn't deliver (the chat is busy or gone): try again in a while.
        else retryAt.current.set(key, Date.now() + RETRY_MS);
        return;
      }
      const handed = await answerInWords(chat.sessionId, handBackText(untilLabel));
      if (handed.ok)
        void log({ ...base, kind: "question", outcome: "handed_back", recommendation: "Told to decide itself" });
      else retryAt.current.set(key, Date.now() + RETRY_MS);
    }

    // 2. Auto-resume at the limit's reset.
    const ids = new Set([...sessions.map((s) => s.id), ...tracks.current.keys()]);
    for (const id of ids) {
      if (busyIds.current.has(id)) continue;
      const session = sessions.find((s) => s.id === id);
      const track = tracks.current.get(id);
      // Nothing to do for a chat that isn't limited and isn't tracked.
      if (!track && !session?.usageLimit) continue;
      const action = planResume(session, track, {
        now,
        eligible: !!session && eligible(session),
        rank: session ? rankOf(session) : 2,
      });
      if (!action) continue;
      void runResume(id, session, track, action);
    }

    async function runResume(id: string, session: Session | undefined, track: Track | undefined, action: ResumeAction) {
      const b = autopilotBackend();
      if (!b) return;
      const apply = (resetsAt: number, resumeAt: number) =>
        latest.current.updateSession(id, (s) =>
          s.usageLimit || !s.busy
            ? { ...s, usageLimit: { ...(s.usageLimit ?? {}), resetsAt, resumeAt, resumeAtReset: true, auto: true } }
            : s,
        );
      busyIds.current.add(id);
      try {
        switch (action.type) {
          case "arm": {
            const tried = `${id}:${action.resetsAt}`;
            if (triedArm.current.has(tried)) return;
            triedArm.current.add(tried);
            const result = await b.arm({
              sessionId: id,
              resetsAt: action.resetsAt,
              resumeAt: action.resumeAt,
              ...(session ? { title: who(session).who } : {}),
            });
            const row = result.resume;
            const base = session ? { project: sessionProject(session), chatId: id, ...who(session) } : { chatId: id };
            if (result.armed && row) {
              tracks.current.set(id, {
                state: "armed",
                resetsAt: row.resetsAt,
                resumeAt: row.resumeAt,
                attempts: row.attempts,
                applied: true,
                sawBusy: false,
                since: Date.now(),
              });
              apply(row.resetsAt, row.resumeAt);
              void log({
                ...base,
                kind: "resume",
                outcome: "armed",
                what: `Paused at a usage limit until ${formatUntil(row.resumeAt, Date.now())}; resumes by itself`,
                detail: row.attempts > 1 ? `Try ${row.attempts} of 3 in a row` : null,
                dedupe: `arm:${id}:${row.resetsAt}`,
              });
            } else if (row?.state === "gave_up") {
              tracks.current.set(id, {
                state: "gave_up",
                resetsAt: row.resetsAt,
                resumeAt: row.resumeAt,
                attempts: row.attempts,
                applied: false,
                sawBusy: false,
                since: Date.now(),
              });
              void log({
                ...base,
                kind: "resume",
                outcome: "gave_up",
                what: result.reason ?? "Stopped resuming by itself",
                dedupe: `gaveup:${id}:${row.resetsAt}`,
              });
            }
            return;
          }
          case "apply": {
            apply(action.resetsAt, action.resumeAt);
            if (track) tracks.current.set(id, { ...track, applied: true });
            return;
          }
          case "resumed": {
            await b.settle(id, "resumed");
            if (track) tracks.current.set(id, { ...track, state: "resumed", sawBusy: !!session?.busy, since: Date.now() });
            if (session)
              void log({
                project: sessionProject(session),
                chatId: id,
                ...who(session),
                kind: "resume",
                outcome: "resumed",
                what: "Resumed by itself after the usage limit reset",
                dedupe: `resumed:${id}:${track?.resetsAt ?? 0}`,
              });
            return;
          }
          case "cancelled": {
            await b.settle(id, "cancelled");
            tracks.current.delete(id);
            return;
          }
          case "sawBusy": {
            if (track) tracks.current.set(id, { ...track, sawBusy: true });
            return;
          }
          case "finished": {
            await b.settle(id, "finished");
            tracks.current.delete(id);
            return;
          }
        }
      } catch (error) {
        console.warn("Autopilot resume:", error);
      } finally {
        busyIds.current.delete(id);
      }
    }
  }, [options.sessions, version, booted, waiting]);
}

const APPROVAL_LOOKBACK = 200;
const RETRY_MS = 30_000;

/** Undecided approvals among a chat's latest blocks. */
function recentApprovals(session: Session) {
  const out = [];
  const start = Math.max(0, session.blocks.length - APPROVAL_LOOKBACK);
  for (let i = session.blocks.length - 1; i >= start; i--) {
    const block = session.blocks[i];
    if (block.approval && !block.approval.decided) out.push(block);
  }
  return out;
}
