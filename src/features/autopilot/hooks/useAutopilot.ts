// The app's one hook for autopilot (model/*.ts holds the rules; src-tauri/src/autopilot.rs the truth). Every window
// keeps the store live and answers "will this chat resume by itself?" for completion reports. The main window also
// acts:
// - while a switch covers a chat that waits on Ash (Today's "Waiting on you", hub/model/waitingChats.ts), its pick is
//   taken through that list's own `takePick(id, { by: "autopilot" })`, which refuses its red lines; a question with no
//   pick is handed back to the agent in words. A tool approval is allowed only when it is a read, or an edit inside the
//   chat's own folder (model/safeApproval.ts); every other one waits for Ash as usual.
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
import type { Block, Session } from "../../sessions/model/session";
import {
  answerInWords,
  chatQuestionVeto,
  subscribeWaitingChats,
  setCaptainDoor,
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
import { appCaptainDoor, clearRedHold, redHoldFor, setAutopilotProjects } from "../model/autopilotApp";
import { captainAnswerHeld } from "../../chief/model/captain";
import { approvalVerdict, approvalWhat, chatProject, handBackText } from "../model/decide";
import { appWiredServers, type WiredServersReader } from "../model/mcpTrust";
import { placeStaysInside, type Canonical, type Locate } from "../model/safeApproval";
import { gitCanonicalPaths, gitLocateFiles } from "../../../platform/tauri/fs";
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
  /** WP-243: an allow names the frozen action (the card's actionHash) it was judged on. */
  approve: (sessionId: string, requestId: number, decision: ApprovalDecision, actionHash?: string) => void;
  /** Open a stored chat in this window, for a resume armed before a restart. */
  openSession: (id: string) => Promise<Session | null>;
  /** A session someone delegated (an open delegation row). */
  isDelegated: (sessionId: string) => boolean;
  /** Show a chat (the log's "Open chat"). */
  openChat: (sessionId: string) => void;
  /** Where paths really are, links followed (the app's git_locate_files); tests pass their own. */
  locate?: Locate;
  /** Canonical paths, every link followed, for a chat outside git (round 7); tests pass their own. */
  canonical?: Canonical;
  /** The MCP servers Hivra wired from installed plugins for a chat, read fresh for each decision (mcpTrust.ts). */
  wiredServers?: WiredServersReader;
}): void {
  const latest = useRef(options);
  latest.current = options;
  const version = useAutopilotVersion();
  const main = useRef(isMainWindow());
  /** Calls already decided (key → its chat), so a streamed change doesn't decide them twice. Pruned each pass. */
  const handled = useRef(new Map<string, string>());
  /** A waiting chat whose answer couldn't be delivered: tried again after this time, not on every streamed word. */
  const retryAt = useRef(new Map<string, number>());
  const tracks = useRef(new Map<string, Track>());
  const busyIds = useRef(new Set<string>());
  /** Limits already sent to be armed (key → chat and reset). Pruned each pass. */
  const triedArm = useRef(new Map<string, { id: string; resetsAt: number }>());
  const loaded = useRef(false);
  const [booted, setBooted] = useState(0);
  const [waiting, setWaiting] = useState(0);
  // The waiting list changes on its own schedule (a chat asks, Ash answers from Today): look again each time.
  useEffect(() => subscribeWaitingChats(() => setWaiting((n) => n + 1)), []);

  // Every window: the store, where projects come from, and the completion report's question.
  useEffect(() => {
    const stopStore = ensureAutopilotStore();
    const stopProjects = setAutopilotProjects(projectsList);
    const stopDoor = setCaptainDoor(appCaptainDoor);
    const stopEligibility = setAutoResumeEligibility((session) => eligible(session));
    return () => {
      stopStore();
      stopDoor();
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
    pruneAutopilotMemory(
      { handled: handled.current, retryAt: retryAt.current, triedArm: triedArm.current },
      sessions,
      handled.current.size ? waitingChats().map((chat) => chat.sessionId) : [],
      now,
    );

    // 1. Calls a switch covers. Questions come from Today's waiting list (both shapes: an AskUserQuestion and a
    // "Needs Ash:" line); approvals from the chats' latest blocks, as this runs on every streamed change.
    if (status?.switches.length) {
      for (const chat of waitingChats()) {
        // A delegated worker's question is its Lead's to answer (H3's tasks.answer), not Ash's: autopilot leaves it.
        if (latest.current.isDelegated(chat.sessionId)) continue;
        // r77: a held tool call is in the waiting list too; the approvals loop below decides it, not the words path.
        if (chat.source === "permission") continue;
        const covering = coveringSwitch(status, chat.projectId, now);
        if (!covering) continue;
        const key = `w:${chat.sessionId}:${chat.requestId ?? "line"}:${hash(`${chat.question}|${chat.pick ?? ""}`)}`;
        if (handled.current.has(key)) {
          const again = retryAt.current.get(key);
          if (again === undefined || again > now) continue;
          retryAt.current.delete(key);
        }
        handled.current.set(key, chat.sessionId);
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
          const key = approvalKey(session.id, block);
          if (handled.current.has(key)) continue;
          handled.current.set(key, session.id);
          const requestId = block.approval.requestId;
          const folder = session.worktreeCwd || session.cwd;
          // It waits for Ash in the chat, as when autopilot is off; the log says why. A reason is read before the
          // verdict's own words, so a held decision that throws still logs plainly.
          const hold = (red: string | null, why: string) =>
            void log({ ...base, kind: "approval", outcome: "held", what: approvalWhat(block), red, detail: `Not allowed by itself: ${why}`, dedupe: `${key}:${block.id}` });
          // Which MCP servers are the ones Hivra wired for this chat is read fresh for each call; a failure to read it
          // reads as none, so every MCP call then waits (mcpTrust.ts).
          void (latest.current.wiredServers ?? appWiredServers)(folder ?? "", session.id)
            .catch(() => new Set<string>())
            .then((trusted) => {
              const verdict = approvalVerdict(block, folder, redHoldFor(session.id, now), trusted);
              if (verdict.kind === "held") return hold(verdict.red, verdict.why);
              // An edit its words allow is allowed only once the app has found where it really lands (links followed).
              return placeStaysInside(block.approval!.call, folder, latest.current.locate ?? gitLocateFiles, latest.current.canonical ?? gitCanonicalPaths).then((why) => {
                if (why) return hold(null, why);
                return log({ ...base, kind: "approval", outcome: "taken", what: verdict.what, recommendation: "Allowed", dedupe: `${key}:${block.id}` }).then(
                  () => latest.current.approve(session.id, requestId, "allow", block.approval?.actionHash),
                );
              });
            })
            .catch((error) => {
              // A decision that can't be made holds: never allow on an error (WP-101, fail closed).
              console.warn("Autopilot approval:", error);
              hold(null, "the app couldn't decide it");
            });
        }
      }
    }

    /** One waiting chat under autopilot: held on a red line (either list's), its pick taken, or handed back. */
    async function decideWaiting(chat: WaitingChat, untilLabel: string, key: string) {
      // WP-101 fix round 2, item F: every read of a saved chat is kept inside a try. A shape this build can't read
      // holds the question with its plain reason; it never becomes an exception that leaves the chat undecided.
      try {
        await decideWaitingInner(chat, untilLabel, key);
      } catch (error) {
        console.warn("Autopilot waiting chat:", error);
        void log({
          project: chat?.projectId ?? null,
          chatId: chat?.sessionId,
          who: chat?.chatName,
          what: "A waiting question",
          kind: "question",
          outcome: "held",
          detail: "Not allowed by itself: the app couldn't read this question, so it waits for Ash",
          dedupe: key,
        });
      }
    }

    async function decideWaitingInner(chat: WaitingChat, untilLabel: string, key: string) {
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
      if (chat.gate?.kind === "action") {
        // A sign-in, a code or a payment: only Ash can do it, so neither Autopilot nor the Lead can take it.
        void log({ ...base, kind: "question", outcome: "held" });
        return;
      }
      // WP-101: the rule a reviewed approval follows, on this door too. Taking the pick answers the question, and
      // the question (or an option it points back to) can be the action itself. The veto itself never throws now; the
      // wrapper above is the second wall, so a shape that slips past it still holds rather than rejects.
      if (chatQuestionVeto(chat)) {
        void log({ ...base, kind: "question", outcome: "held" });
        return;
      }
      if (chat.pick) {
        const taken = await takePick(chat.sessionId, { by: "autopilot" }).catch((error: unknown) => {
          // A delivery that throws is a failed delivery, never an answer.
          console.warn("Autopilot take pick:", error);
          return { ok: false as const, reason: "the app couldn't answer this one" };
        });
        if (taken.ok) void log({ ...base, kind: "question", outcome: "taken" });
        else if (captainAnswerHeld(taken.reason)) void log({ ...base, kind: "question", outcome: "held", detail: taken.reason });
        else {
          // The captain is still waiting (the engine is down). One row, then try again, so the 10 minute pass-up
          // gets its own row. A failed delivery stays a retry with no row, as before.
          if (/engine is down|turn did not finish/i.test(taken.reason)) {
            void log({ ...base, kind: "question", outcome: "held", detail: taken.reason, dedupe: `${key}:waiting` });
          }
          retryAt.current.set(key, Date.now() + RETRY_MS);
        }
        return;
      }
      const handed = await answerInWords(chat.sessionId, handBackText(untilLabel)).catch((error: unknown) => {
        console.warn("Autopilot hand back:", error);
        return { ok: false as const, reason: "the app couldn't answer this one" };
      });
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
            triedArm.current.set(tried, { id, resetsAt: action.resetsAt });
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

/** The key autopilot remembers an approval by. */
function approvalKey(sessionId: string, block: Block): string {
  return `a:${sessionId}:${block.approval?.requestId}:${hash(block.tool?.title ?? block.text)}`;
}

export type AutopilotMemory = {
  handled: Map<string, string>;
  retryAt: Map<string, number>;
  triedArm: Map<string, { id: string; resetsAt: number }>;
};

/**
 * Forget what can't come back, so the hook's memory doesn't grow for the app's life: an approval no longer waiting
 * (decided, or its chat closed), a question whose chat is neither open nor on the waiting list, and an arm for a reset
 * already past or a closed chat (planResume never arms either). A question still listed is kept, so the same question
 * isn't answered twice.
 */
export function pruneAutopilotMemory(
  memory: AutopilotMemory,
  sessions: readonly Session[],
  waitingSessionIds: readonly string[],
  now: number,
): void {
  const open = new Set(sessions.map((s) => s.id));
  const listed = new Set(waitingSessionIds);
  let pending: Set<string> | undefined;
  for (const [key, sessionId] of memory.handled) {
    const gone = key.startsWith("a:")
      ? !(pending ??= new Set(sessions.flatMap((s) => recentApprovals(s).map((block) => approvalKey(s.id, block))))).has(key)
      : !open.has(sessionId) && !listed.has(sessionId);
    if (gone) {
      memory.handled.delete(key);
      memory.retryAt.delete(key);
    }
  }
  for (const [key, tried] of memory.triedArm) if (!open.has(tried.id) || tried.resetsAt <= now) memory.triedArm.delete(key);
}

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
