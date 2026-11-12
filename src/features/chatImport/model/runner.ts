// Onboarding import, run in the background: find every past chat, then bring in the ones the person picked.
//
// It lives outside any screen, so closing onboarding or Settings never stops it, and the app stays usable while it
// runs. Finding pages through each store newest first (no file cap); bringing in reads one chat at a time, a few at
// once, and saves each as soon as it is read, so chats appear in their projects while the rest are still coming.
// Cancel stops after the chats in hand. A chat that fails is counted and skipped; it never stops the run.

import { parseClaude } from "../../historyImport/model/claude";
import { parseCodex } from "../../historyImport/model/codex";
import type { Session } from "../../sessions/model/session";
import { toImportedChat, userMessages } from "./convert";
import {
  buildGroups,
  chatsToImport,
  defaultChoices,
  resolveTargets,
  type ChatSource,
  type Choices,
  type FolderInfo,
  type Group,
  type IndexedChat,
  type ProjectRef,
} from "./plan";

export type IndexPage = {
  missing: boolean;
  total: number;
  offset: number;
  chats: Omit<IndexedChat, "source" | "root">[];
  active: number;
  links: number;
  side: number;
  done: boolean;
};

export type ProseRead = { text: string; cut: boolean; longLines: number };

export type ChatImportPorts = {
  roots: () => Promise<{ claudeCode: string[]; codex: string[] }>;
  index: (root: string, source: ChatSource, offset: number, limit: number) => Promise<IndexPage>;
  folders: (paths: string[]) => Promise<FolderInfo[]>;
  /** Provider conversations the app's own chats already hold. */
  knownIds: () => Promise<string[]>;
  read: (root: string, source: ChatSource, path: string) => Promise<ProseRead>;
  projects: () => ProjectRef[];
  createProject: (name: string, folder: string, sources: ChatSource[]) => Promise<ProjectRef>;
  /** False when the chat is already here. */
  save: (session: Session, createdAt: number, updatedAt: number) => Promise<boolean>;
  /** Tells the rest of the app chats landed in these folders. */
  changed?: (folders: string[]) => void;
};

export type Phase = "idle" | "finding" | "ready" | "importing" | "done" | "cancelled" | "failed";

export type ImportState = {
  phase: Phase;
  /** Files seen while finding, and how many the stores hold. */
  seen: number;
  total: number;
  /** Per tool: none found, or the folder isn't there. */
  missing: ChatSource[];
  /** Left out while finding: still being written, links, another agent's trace. */
  active: number;
  links: number;
  side: number;
  groups: Group[];
  choices: Choices | null;
  /** While bringing in. */
  toImport: number;
  done: number;
  imported: number;
  alreadyHere: number;
  oneShots: number;
  failed: number;
  /** Chats longer than the read cap that came in with their start only. */
  cut: number;
  projectsMade: number;
  /** The app chats made this run, for the style reading that follows. */
  importedIds: string[];
  /** The folders those chats are in. */
  importedFolders: string[];
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

const PAGE = 1000;
const FOLDER_BATCH = 500;
const READERS = 4;

function empty(): ImportState {
  return {
    phase: "idle",
    seen: 0,
    total: 0,
    missing: [],
    active: 0,
    links: 0,
    side: 0,
    groups: [],
    choices: null,
    toImport: 0,
    done: 0,
    imported: 0,
    alreadyHere: 0,
    oneShots: 0,
    failed: 0,
    cut: 0,
    projectsMade: 0,
    importedIds: [],
    importedFolders: [],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";
}

export class ChatImportRun {
  private state: ImportState = empty();
  private listeners = new Set<() => void>();
  private chats: IndexedChat[] = [];
  private folders = new Map<string, FolderInfo>();
  private known = new Set<string>();
  private stop = false;
  private emitQueued = false;

  constructor(private readonly ports: ChatImportPorts) {}

  get = (): ImportState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ImportState>, now = false): void {
    this.state = { ...this.state, ...patch };
    if (now) {
      this.emitQueued = false;
      for (const listener of this.listeners) listener();
      return;
    }
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      if (!this.emitQueued) return;
      this.emitQueued = false;
      for (const listener of this.listeners) listener();
    });
  }

  get busy(): boolean {
    return this.state.phase === "finding" || this.state.phase === "importing";
  }

  cancel(): void {
    if (this.busy) this.stop = true;
  }

  /** Back to the start, keeping nothing. Not while a run is going. */
  reset(): void {
    if (this.busy) return;
    this.chats = [];
    this.folders.clear();
    this.known.clear();
    this.set(empty(), true);
  }

  /** Finds every chat in both tools' folders. */
  async find(fromMs: number | null = null): Promise<void> {
    if (this.busy) return;
    this.stop = false;
    this.chats = [];
    this.folders.clear();
    this.set({ ...empty(), phase: "finding", startedAt: Date.now() }, true);
    try {
      const roots = await this.ports.roots();
      const stores: [ChatSource, string[]][] = [
        ["claude_code", roots.claudeCode],
        ["codex", roots.codex],
      ];
      const totals = new Map<string, number>();
      const found = new Set<ChatSource>();
      for (const [source, list] of stores) {
        for (const root of list) {
          let offset = 0;
          for (;;) {
            if (this.stop) return this.finishCancelled();
            const page = await this.ports.index(root, source, offset, PAGE);
            if (page.missing) break;
            if (offset === 0) {
              this.set({
                active: this.state.active + page.active,
                links: this.state.links + page.links,
                side: this.state.side + page.side,
              });
            }
            totals.set(`${source}:${root}`, page.total);
            for (const chat of page.chats) this.chats.push({ ...chat, source, root });
            if (page.chats.length) found.add(source);
            offset += page.chats.length;
            this.set({ seen: this.chats.length, total: [...totals.values()].reduce((a, b) => a + b, 0) });
            if (page.done || page.chats.length === 0) break;
          }
        }
      }
      const cwds = [...new Set(this.chats.map((chat) => chat.cwd).filter((cwd): cwd is string => !!cwd))];
      for (let at = 0; at < cwds.length; at += FOLDER_BATCH) {
        if (this.stop) return this.finishCancelled();
        for (const info of await this.ports.folders(cwds.slice(at, at + FOLDER_BATCH))) {
          this.folders.set(info.path.replace(/\\/g, "/").replace(/\/+$/, ""), info);
        }
      }
      // Repo roots are folders too: whether they are still here.
      const roots2 = [...new Set([...this.folders.values()].map((info) => info.repoRoot).filter((root): root is string => !!root))]
        .filter((root) => !this.folders.has(root));
      for (let at = 0; at < roots2.length; at += FOLDER_BATCH) {
        for (const info of await this.ports.folders(roots2.slice(at, at + FOLDER_BATCH))) {
          this.folders.set(info.path.replace(/\\/g, "/").replace(/\/+$/, ""), info);
        }
      }
      this.known = new Set(await this.ports.knownIds().catch(() => [] as string[]));
      const fresh = this.chats.filter((chat) => !(chat.sessionId && this.known.has(chat.sessionId)));
      const groups = buildGroups(fresh, this.folders, this.ports.projects(), fromMs);
      this.set(
        {
          phase: "ready",
          missing: stores.map(([source]) => source).filter((source) => !found.has(source)),
          groups,
          choices: defaultChoices(groups, fromMs),
        },
        true,
      );
    } catch (error) {
      this.set({ phase: "failed", error: errorText(error), finishedAt: Date.now() }, true);
    }
  }

  /** New choices, e.g. a different start date: the groups are counted again from what was found. */
  choose(choices: Choices): void {
    if (this.state.phase !== "ready") return;
    const fromChanged = choices.fromMs !== this.state.choices?.fromMs;
    if (!fromChanged) {
      this.set({ choices }, true);
      return;
    }
    const fresh = this.chats.filter((chat) => !(chat.sessionId && this.known.has(chat.sessionId)));
    const groups = buildGroups(fresh, this.folders, this.ports.projects(), choices.fromMs);
    const base = defaultChoices(groups, choices.fromMs);
    for (const group of groups) {
      const kept = choices.groups[group.key];
      if (kept) base.groups[group.key] = kept;
    }
    this.set({ groups, choices: { ...base, skipOneShots: choices.skipOneShots } }, true);
  }

  /** Brings in what the choices say. */
  async bringIn(): Promise<void> {
    const choices = this.state.choices;
    if (this.state.phase !== "ready" || !choices) return;
    this.stop = false;
    const projects = this.ports.projects();
    const targets = resolveTargets(this.state.groups, choices, projects);
    const work = chatsToImport(this.chats, this.folders, targets, choices.fromMs, this.known);
    this.set({ phase: "importing", toImport: work.length, done: 0, startedAt: Date.now() }, true);
    // Projects first, one each, so every chat has its home before it lands.
    const homes = new Map<string, string>();
    try {
      const made = new Map<string, string>();
      for (const [key, target] of targets) {
        if (this.stop) return this.finishCancelled();
        if (target.kind === "existing") {
          if (target.project.folder) homes.set(key, target.project.folder);
          continue;
        }
        let folder = made.get(target.key);
        if (!folder) {
          const sources = this.state.groups.find((group) => group.key === target.key)?.sources ?? [];
          const project = await this.ports.createProject(target.name, target.folder, sources);
          folder = project.folder ?? target.folder;
          made.set(target.key, folder);
          this.set({ projectsMade: made.size });
        }
        homes.set(key, folder);
      }
    } catch (error) {
      this.set({ phase: "failed", error: errorText(error), finishedAt: Date.now() }, true);
      return;
    }
    const ids: string[] = [];
    const folders = new Set<string>();
    let next = 0;
    const reader = async () => {
      while (!this.stop) {
        const item = work[next++];
        if (!item) return;
        const folder = homes.get(item.groupKey);
        if (!folder) {
          this.set({ done: this.state.done + 1, failed: this.state.failed + 1 });
          continue;
        }
        try {
          const read = await this.ports.read(item.chat.root, item.chat.source, item.chat.path);
          const conversation =
            item.chat.source === "codex" ? parseCodex(item.chat.path, read.text, true) : parseClaude(item.chat.path, read.text, true);
          if (!conversation || userMessages(conversation) === 0) {
            this.set({ done: this.state.done + 1, oneShots: this.state.oneShots + 1 });
            continue;
          }
          if (choices.skipOneShots && userMessages(conversation) < 2) {
            this.set({ done: this.state.done + 1, oneShots: this.state.oneShots + 1 });
            continue;
          }
          const chat = toImportedChat(conversation, item.chat, folder);
          if (!chat) {
            this.set({ done: this.state.done + 1, oneShots: this.state.oneShots + 1 });
            continue;
          }
          const saved = await this.ports.save(chat.session, chat.createdAt, chat.updatedAt);
          if (saved) {
            ids.push(chat.session.id);
            folders.add(folder);
          }
          this.set({
            done: this.state.done + 1,
            imported: this.state.imported + (saved ? 1 : 0),
            alreadyHere: this.state.alreadyHere + (saved ? 0 : 1),
            cut: this.state.cut + (read.cut ? 1 : 0),
          });
        } catch {
          this.set({ done: this.state.done + 1, failed: this.state.failed + 1 });
        }
      }
    };
    await Promise.all(Array.from({ length: READERS }, reader));
    this.ports.changed?.([...folders]);
    this.set(
      {
        phase: this.stop ? "cancelled" : "done",
        importedIds: ids,
        importedFolders: [...folders],
        finishedAt: Date.now(),
      },
      true,
    );
  }

  private finishCancelled(): void {
    this.set({ phase: "cancelled", finishedAt: Date.now() }, true);
  }
}
