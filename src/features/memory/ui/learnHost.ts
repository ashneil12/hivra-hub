// WP-83: the memory screen's real ports. Reads go through the app, and the
// model call goes through a CLI the person already signed in to. No key is read.

import { invoke } from "@tauri-apps/api/core";
import { hasSecretText } from "../../portable/model/secrets";
import { mentionsSecret } from "../model/doc";
import { askForLessons, redactForModel } from "../backpass/ask";
import { acceptProposal, type Proposal } from "../backpass/learn";
import { instructionFiles } from "../backpass/agentsFile";
import { parseSchedule, stateAfterOffer } from "../backpass/schedule";
import {
  costOf,
  lessonPrompt,
  measureRun,
  parseLedger,
  parseRejections,
  type CostChat,
  type NamedFile,
} from "../backpass/run";
import { recordRejection } from "../backpass/rejection";
import { crewMemoryBrief } from "../model/crewBrief";
import { acceptStaged, listStaged, rejectStaged } from "../../workLog/model/retroStore";
import { HARNESSES } from "../../sessions/model/session";
import { learnableChats } from "../model/privateChat";
import { loadPrivateChatKeys } from "../../sessions/data/privateKeys";
import type { LearnPorts, LearnProfiles, ShownProposal } from "./LearnFromChats";

type Listed = CostChat & { id: string; mtimeMs: number };
type Loaded = { revision: number; state: unknown };
type ProfileRow = LearnProfiles & {
  agents: string;
  claude: string;
  agentsSha256: string;
  claudeSha256: string;
};

/** WP-157: the id of an edit a work log retro left waiting. The retro store decides it, not this file. */
const RETRO_ID = /^retro:/;

const MAX_CHATS = 12;
const MAX_CHAT_CHARS = 8_000;
const PLUGIN_ROOTS = ["plugins/installed", "plugins/pstack"];

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function show(proposal: Proposal): ShownProposal {
  return { id: proposal.id, title: proposal.title, diff: proposal.diff, quotes: proposal.quotes };
}

async function listedChats(): Promise<Listed[]> {
  const rows = await invoke<unknown>("learn_stores_list", { includeCursorIde: false });
  if (!Array.isArray(rows)) return [];
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
    });
  }
  // WP-111: a private chat is not offered. A failed check reads nothing this time.
  return learnableChats(out, await loadPrivateChatKeys());
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

  return {
    cost: async () => costOf(await listedChats()),
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
    run: async ({ includeUserFile }) => {
      const mine = ++ticket;
      const chats = (await listedChats()).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CHATS);
      const transcripts: { id: string; text: string }[] = [];
      let skipped = 0;
      for (const chat of chats) {
        try {
          const raw = await invoke<string>("learn_stores_read", {
            source: chat.source,
            root: chat.root,
            rel: chat.rel,
          });
          const clean = redactForModel((typeof raw === "string" ? raw : "").slice(0, MAX_CHAT_CHARS));
          if (hasSecretText(clean) || mentionsSecret(clean)) continue;
          transcripts.push({ id: chat.id, text: clean });
        } catch {
          skipped += 1;
        }
      }
      if (mine !== ticket) return [];
      if (!transcripts.length) {
        if (skipped || chats.length) throw new Error("The chats could not be read. Try again.");
        return [];
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
      const answer = await askForLessons(
        lessonPrompt(
          safeNamed.map((file) => ({ path: file.path, text: file.original })),
          transcripts,
        ),
        crewMemoryBrief(),
      );
      if (mine !== ticket) return [];
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
      if (mine !== ticket) return [];
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
      return measured.proposals.map(show);
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
      pending.delete(id);
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
      return true;
    },
  };
}
