// WP-83: the memory screen's real ports. Reads go through the app, and the
// model call goes through a CLI the person already signed in to. No key is read.

import { invoke } from "@tauri-apps/api/core";
import { hasSecretText } from "../../portable/model/secrets";
import { mentionsSecret } from "../model/doc";
import { askForLessons, redactForModel } from "../backpass/ask";
import { acceptProposal, type Proposal } from "../backpass/learn";
import { anchoredHunks } from "../backpass/diff";
import { refusalFor } from "../backpass/proposalGuard";
import { instructionFiles } from "../backpass/agentsFile";
import { parseSchedule, stateAfterOffer } from "../backpass/schedule";
import {
  lessonPrompt,
  measureRun,
  parseLedger,
  parseRejections,
  type CostChat,
  type NamedFile,
} from "../backpass/run";
import { recordRejection } from "../backpass/rejection";
import { DEFAULT_BUDGET, MIN_USER_MESSAGES, charsPerChat, estimateRun, sampleOrder, type SampleChat } from "../backpass/sample";
import { chatText } from "../backpass/transcript";
import { learnModelFor } from "../backpass/model";
import { crewMemoryBrief } from "../model/crewBrief";
import { crewRouteFor } from "../../crew/model/host";
import { acceptStaged, listStaged, rejectStaged } from "../../workLog/model/retroStore";
import { HARNESSES } from "../../sessions/model/session";
import { learnableChats } from "../model/privateChat";
import { loadPrivateChatKeys } from "../../sessions/data/privateKeys";
import type {
  LearnEstimate,
  LearnPorts,
  LearnProfiles,
  LearnRunInput,
  LearnRunResult,
  ShownProposal,
} from "./LearnFromChats";
import { learnRunBusy, learnRunStatus, setLearnRunStatus, type LearnRunStatus } from "./learnRunStore";

export { learnRunStatus, subscribeLearnRun, useLearnRun, type LearnRunStatus } from "./learnRunStore";

type Listed = CostChat & SampleChat;
type Listing = { chats: Listed[]; leftOut: number; tooBig: number };
type Loaded = { revision: number; state: unknown };
type ProfileRow = LearnProfiles & {
  agents: string;
  claude: string;
  agentsSha256: string;
  claudeSha256: string;
};

/** WP-157: the id of an edit a work log retro left waiting. The retro store decides it, not this file. */
const RETRO_ID = /^retro:/;

/** One chat that does not open in this long is skipped and counted; it never stalls the run. */
const READ_TIMEOUT_MS = 30_000;
/** Chats tried, as a multiple of the budget, before the run settles for what it has. */
const TRY_FACTOR = 2;
/** The two profile files and the instructions around the chats, in tokens. */
const PROMPT_OVERHEAD_TOKENS = 1_500;
const PLUGIN_ROOTS = ["plugins/installed", "plugins/pstack"];
const EMPTY: LearnRunResult = { proposals: [], chats: 0 };

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function show(proposal: Proposal): ShownProposal {
  return { id: proposal.id, title: proposal.title, diff: proposal.diff, quotes: proposal.quotes };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("That chat took too long to open.")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The newest chats the app lists (newest first), and how many it left out or found too big. */
async function listedChats(): Promise<Listing> {
  const found = await invoke<unknown>("learn_stores_list", { includeCursorIde: false });
  const wrapped = asObject(found);
  const rows = Array.isArray(found) ? found : wrapped?.chats;
  const leftOut = count(wrapped?.leftOut);
  const tooBig = count(wrapped?.tooBig);
  if (!Array.isArray(rows)) return { chats: [], leftOut, tooBig };
  const out: Listed[] = [];
  for (const row of rows) {
    const item = asObject(row);
    if (!item || typeof item.source !== "string" || typeof item.root !== "string" || typeof item.rel !== "string") {
      continue;
    }
    if (typeof item.id !== "string" || !item.id) continue;
    out.push({
      source: item.source,
      root: item.root,
      rel: item.rel,
      id: item.id,
      bytes: typeof item.bytes === "number" ? item.bytes : 0,
      mtimeMs: typeof item.mtimeMs === "number" ? item.mtimeMs : 0,
      cwd: typeof item.cwd === "string" ? item.cwd : null,
    });
  }
  // WP-111: a private chat is not offered. A failed check reads nothing this time.
  return { chats: learnableChats(out, await loadPrivateChatKeys()), leftOut, tooBig };
}

type RunPlan = { picked: Listed[]; order: Listed[]; budget: number; leftOut: number; tooBig: number };

async function planRun(input: Pick<LearnRunInput, "fromMs" | "projects" | "budget">): Promise<RunPlan> {
  const listing = await listedChats();
  const budget = Math.max(1, Math.floor(input.budget ?? DEFAULT_BUDGET));
  const plan = sampleOrder(listing.chats, {
    fromMs: input.fromMs,
    projects: input.projects,
    budget,
  });
  const order = plan.order as Listed[];
  return {
    picked: order.slice(0, budget),
    order,
    budget,
    leftOut: listing.leftOut,
    tooBig: listing.tooBig + plan.tooBig,
  };
}

/** Before a run: how many chats, about how many tokens, and which model answers. */
async function estimateFor(input: Pick<LearnRunInput, "fromMs" | "projects" | "budget">): Promise<LearnEstimate> {
  const plan = await planRun(input);
  const run = estimateRun(plan.picked);
  let model: string | null = null;
  try {
    model = learnModelFor(await crewRouteFor({ labels: ["memory"], paths: [] }))?.label ?? null;
  } catch {
    model = null;
  }
  return {
    chats: run.chats,
    tokens: run.tokens + (run.chats > 0 ? PROMPT_OVERHEAD_TOKENS : 0),
    model,
    leftOut: plan.leftOut,
    tooBig: plan.tooBig,
  };
}

async function loadState(): Promise<Loaded> {
  const loaded = await invoke<Loaded>("learn_state_load");
  return {
    revision: typeof loaded?.revision === "number" ? loaded.revision : 0,
    state: asObject(loaded?.state) ?? {},
  };
}

async function saveState(revision: number, state: Record<string, unknown>): Promise<boolean> {
  const text = JSON.stringify(state);
  if (hasSecretText(text) || mentionsSecret(text)) {
    throw new Error("That looks like a secret, so it was not saved.");
  }
  return invoke<boolean>("learn_state_cas", { revision, state });
}

async function loadProfileRow(): Promise<ProfileRow> {
  const row = await invoke<ProfileRow>("learn_profile_load");
  return {
    opinions: typeof row?.opinions === "string" ? row.opinions : "",
    voice: typeof row?.voice === "string" ? row.voice : "",
    agents: typeof row?.agents === "string" ? row.agents : "",
    claude: typeof row?.claude === "string" ? row.claude : "",
    opinionsSha256: typeof row?.opinionsSha256 === "string" ? row.opinionsSha256 : "",
    voiceSha256: typeof row?.voiceSha256 === "string" ? row.voiceSha256 : "",
    agentsSha256: typeof row?.agentsSha256 === "string" ? row.agentsSha256 : "",
    claudeSha256: typeof row?.claudeSha256 === "string" ? row.claudeSha256 : "",
  };
}

function whichOf(file: string): "opinions" | "voice" | "agents" | null {
  if (file === "opinions.md") return "opinions";
  if (file === "voice.md") return "voice";
  if (file === "AGENTS.md") return "agents";
  return null;
}

export function learnPorts(now: () => string = () => new Date().toISOString()): LearnPorts {
  const pending = new Map<string, Proposal>();
  let originals = new Map<string, string>();
  let ticket = 0;

  const runLearn = async (
    { includeUserFile, fromMs, projects, budget: asked }: LearnRunInput,
    alive: () => boolean,
  ): Promise<LearnRunResult> => {
    setLearnRunStatus({ phase: "listing", read: 0, target: 0, chats: 0, proposals: [], leftOut: 0, tooBig: 0, note: "" });
    const plan = await planRun({ fromMs, projects, budget: asked });
    if (!alive()) return EMPTY;
    const target = Math.min(plan.budget, plan.order.length);
    const perChat = charsPerChat(target);
    setLearnRunStatus({ phase: "reading", target, leftOut: plan.leftOut, tooBig: plan.tooBig });
    const transcripts: { id: string; text: string }[] = [];
    let skipped = 0;
    let tried = 0;
    // Walk the sampling order until the budget is met. A chat that will not open, or has almost
    // nothing the person said, is passed over; it never fails the run.
    for (const chat of plan.order) {
      if (transcripts.length >= plan.budget || tried >= plan.budget * TRY_FACTOR) break;
      if (!alive()) return EMPTY;
      tried += 1;
      try {
        const raw = await withTimeout(
          invoke<string>("learn_stores_read", { source: chat.source, root: chat.root, rel: chat.rel }),
          READ_TIMEOUT_MS,
        );
        const chatRead = chatText(chat.source, chat.id, typeof raw === "string" ? raw : "", perChat);
        if (chatRead.userMessages < MIN_USER_MESSAGES) continue;
        const clean = redactForModel(chatRead.text);
        if (!clean || hasSecretText(clean) || mentionsSecret(clean)) continue;
        transcripts.push({ id: chat.id, text: clean });
        setLearnRunStatus({ read: transcripts.length });
      } catch {
        skipped += 1;
      }
    }
    if (!alive()) return EMPTY;
    if (!transcripts.length) {
      if (skipped) throw new Error("The chats could not be read. Try again.");
      setLearnRunStatus({ phase: "done", chats: 0, proposals: [], note: "No chats to learn from yet." });
      return EMPTY;
    }
      const profiles = await loadProfileRow();
      const named: NamedFile[] = [
        { path: "opinions.md", role: "opinions", original: profiles.opinions },
        { path: "voice.md", role: "voice", original: profiles.voice },
      ];
      if (includeUserFile) {
        named.push({ path: "AGENTS.md", role: "user", original: profiles.agents, picked: true });
      }
      const safeNamed = named.filter((file) => !hasSecretText(file.original) && !mentionsSecret(file.original));
      const loaded = await loadState();
      const state = asObject(loaded.state) ?? {};
      setLearnRunStatus({ phase: "asking", read: transcripts.length });
      const answer = await askForLessons(
        lessonPrompt(
          safeNamed.map((file) => ({ path: file.path, text: file.original })),
          transcripts,
        ),
        crewMemoryBrief(),
      );
      if (!alive()) return EMPTY;
      if (!answer.ok) {
        throw new Error(
          answer.kind === "timeout" || answer.kind === "unreachable"
            ? "The model didn't answer. Try again."
            : answer.reason,
        );
      }
      let measured;
      const base = {
        named: safeNamed,
        modelText: answer.text,
        transcripts,
        rejections: parseRejections(state.rejections),
        pluginRoots: PLUGIN_ROOTS,
        now: now(),
      };
      try {
        measured = measureRun({ ...base, ledger: parseLedger(state.ledger) });
      } catch {
        measured = measureRun({ ...base, ledger: parseLedger(null) });
      }
      if (!alive()) return EMPTY;
      const saved = await saveState(loaded.revision, {
        ...state,
        ledger: measured.ledger,
        rejections: base.rejections,
      });
      if (!saved) throw new Error("Those lessons changed. Try again.");
      if (measured.refused && measured.proposals.length === 0) throw new Error(measured.refused);
      pending.clear();
      originals = new Map(safeNamed.map((file) => [file.path, file.original]));
      for (const proposal of measured.proposals) pending.set(proposal.id, proposal);
      const shown = measured.proposals.map(show);
      setLearnRunStatus({ phase: "done", chats: transcripts.length, proposals: shown, note: "" });
      return { proposals: shown, chats: transcripts.length };
  };

  return {
    cost: async () => (await estimateFor({})).tokens,
    loadProfiles: loadProfileRow,
    schedule: async () => {
      const loaded = await loadState();
      return parseSchedule(asObject(loaded.state)?.schedule);
    },
    setWeekly: async (weekly) => {
      const loaded = await loadState();
      const state = asObject(loaded.state) ?? {};
      const schedule = parseSchedule(state.schedule);
      return saveState(loaded.revision, { ...state, schedule: { ...schedule, weekly } });
    },
    markOffered: async (at) => {
      const loaded = await loadState();
      const state = asObject(loaded.state) ?? {};
      const next = stateAfterOffer(state, at);
      if (!next.changed) return true;
      return saveState(loaded.revision, next.state);
    },
    saveProfile: (which, text, expectedSha256) =>
      invoke<boolean>("learn_profile_save", { which, expectedSha256, next: text }),
    run: async (input) => {
      const mine = ++ticket;
      try {
        return await runLearn(input, () => mine === ticket);
      } catch (error) {
        if (mine === ticket) {
          setLearnRunStatus({
            phase: "failed",
            note: error instanceof Error && error.message ? error.message : "The chats could not be read. Try again.",
          });
        }
        throw error;
      }
    },
    estimate: (input) => estimateFor(input ?? {}),
    batch: () => {
      const status = learnRunStatus();
      return status.phase === "done" && status.proposals.length > 0
        ? { proposals: status.proposals, chats: status.chats }
        : null;
    },
    staged: () => listStaged(),
    accept: async (id) => {
      if (RETRO_ID.test(id)) return acceptStaged(id);
      const proposal = pending.get(id);
      const which = proposal ? whichOf(proposal.file) : null;
      const original = proposal ? originals.get(proposal.file) : undefined;
      if (!proposal || !which || original === undefined) return false;
      const profiles = await loadProfileRow();
      const current =
        which === "opinions" ? profiles.opinions : which === "voice" ? profiles.voice : profiles.agents;
      const sha =
        which === "opinions"
          ? profiles.opinionsSha256
          : which === "voice"
            ? profiles.voiceSha256
            : profiles.agentsSha256;
      let next: string;
      try {
        next = acceptProposal(original, proposal);
      } catch {
        return false;
      }
      if (current !== original && current !== next) return false;
      // WP-101: the proposal was checked when it was measured; this checks what would actually be written, so an
      // edit that slipped something in after that (a hand-edited store, a changed file) is caught here too.
      const guarded = refusalFor(anchoredHunks(current, next));
      if (guarded) throw new Error(guarded);
      if (hasSecretText(next) || mentionsSecret(next)) {
        throw new Error("That edit looks like it contains a secret, so it was not saved.");
      }
      if (current !== next) {
        const ok = await invoke<boolean>("learn_profile_save", { which, expectedSha256: sha, next });
        if (!ok) return false;
      }
      if (which === "agents") {
        const imported = instructionFiles(next, HARNESSES).find((file) => file.path === "CLAUDE.md");
        if (imported && profiles.claude !== imported.text) {
          const wrote = await invoke<boolean>("learn_profile_save", {
            which: "claude",
            expectedSha256: profiles.claudeSha256,
            next: imported.text,
          });
          if (!wrote) return false;
        }
      }
      // The next suggestion for this file is measured against what is on disk now.
      originals.set(proposal.file, next);
      pending.delete(id);
      forgetShown(id);
      return true;
    },
    reject: async (id) => {
      if (RETRO_ID.test(id)) return rejectStaged(id);
      const proposal = pending.get(id);
      if (!proposal) return false;
      const loaded = await loadState();
      const state = asObject(loaded.state) ?? {};
      const rejections = parseRejections(state.rejections);
      recordRejection(
        {
          kind: proposal.kind,
          file: proposal.file,
          title: proposal.title,
          transcripts: proposal.transcripts,
          hunks: proposal.hunks,
          gapIds: proposal.gapIds,
        },
        rejections,
        now(),
        "disagree",
      );
      const ok = await saveState(loaded.revision, { ...state, rejections });
      if (!ok) return false;
      pending.delete(id);
      forgetShown(id);
      return true;
    },
  };
}

function forgetShown(id: string): void {
  const status = learnRunStatus();
  if (status.proposals.some((row) => row.id === id)) {
    setLearnRunStatus({ proposals: status.proposals.filter((row) => row.id !== id) });
  }
}

let shared: LearnPorts | null = null;

/** One set of ports for the whole app, so a run started anywhere is decided in the same place. */
export function sharedLearnPorts(): LearnPorts {
  shared ??= learnPorts();
  return shared;
}

/**
 * Start a sampled run: the entry point for a later onboarding step. It reads a spread of recent
 * chats (default about 60, one project after another, newest first), asks the cheap signed-in
 * model, and leaves the suggestions waiting. Nothing is written until each one is accepted.
 * Read the run with `learnRunStatus()` / `useLearnRun()`; decide the suggestions with
 * `sharedLearnPorts().accept(id)` and `.reject(id)`, as the Settings screen does.
 */
export function startLearnRun(
  options: { fromMs?: number; projects?: string[]; budget?: number; includeUserFile?: boolean } = {},
): Promise<LearnRunStatus> {
  if (learnRunBusy()) return currentRun ?? Promise.resolve(learnRunStatus());
  const run = sharedLearnPorts()
    .run({ includeUserFile: options.includeUserFile ?? false, fromMs: options.fromMs, projects: options.projects, budget: options.budget })
    .then(
      () => learnRunStatus(),
      () => learnRunStatus(),
    )
    .finally(() => {
      if (currentRun === run) currentRun = null;
    });
  currentRun = run;
  return run;
}

let currentRun: Promise<LearnRunStatus> | null = null;
