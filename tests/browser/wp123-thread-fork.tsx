// WP-123: the real fork dialog, the message action, and the palette command.
import { useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { resolvePaletteRows } from "../../src/features/search/model/commandRegistry";
import {
  runPaletteCommand,
  type PaletteActions,
  type PaletteSideEffects,
} from "../../src/features/search/model/paletteWiring";
import {
  loadNewChatWorktree,
  saveNewChatWorktree,
  subscribeNewChatWorktree,
  type NewChatWorktree,
} from "../../src/features/settings/model/settings";
import type { Worktree } from "../../src/features/source-control/model/worktrees";
import { newSession, type Block, type Session } from "../../src/features/sessions/model/session";
import { forkFocusedChat, insertFork } from "../../src/features/sessions/model/threadFork";
import { ForkFromHereButton } from "../../src/features/sessions/ui/ForkFromHereButton";
import { ThreadForkHost } from "../../src/features/sessions/ui/ThreadForkHost";
import { askThreadFork } from "../../src/features/sessions/model/threadForkAsk";
import "../../src/styles/index.css";

const DIRTY =
  "error: Your local changes to the following files would be overwritten by checkout:\n\tfile.txt\nPlease commit your changes or stash them before you switch branches.";

const NOT_COPIED = "Uncommitted changes in this chat's worktree weren't copied.";

const PROJECT = "C:\\work\\my notes";

function message(id: string, role: Block["role"], text: string): Block {
  return { id, role, text };
}

const original: Session = {
  ...newSession("claude", PROJECT),
  id: "sess-1",
  title: "Plan",
  blocks: [
    message("u1", "user", "First"),
    message("a1", "assistant", "Answer"),
    message("u2", "user", "Later"),
  ],
};

saveNewChatWorktree("ask");

const noop = () => {};
const actions: PaletteActions = {
  onNewFocused: noop,
  onCloseOtherTabs: noop,
  onCloseAllTabs: noop,
  onCloseFocused: noop,
  onNext: noop,
  onPrev: noop,
  onVisitBack: noop,
  onVisitForward: noop,
  onSplit: noop,
  onFocusDir: noop,
  onActivate: noop,
  onToggleSidebar: noop,
  onToggleSessionSidebar: noop,
  onToggleMono: noop,
  onGoToFile: noop,
  onOpenCommandPalette: noop,
  onReload: noop,
  onFindInProject: noop,
  onOpenFinder: noop,
  onOpenInbox: noop,
  pickProject: noop,
  onNewTerminal: noop,
  onNewTerminalTab: noop,
  onToggleProjectTerminal: noop,
  onNavigateSessionList: noop,
  onNavigateProjectList: noop,
  openSettings: noop,
};

function tree(path: string): Worktree {
  return {
    path,
    branch: "mc/fork",
    head: "abc",
    isMain: false,
    locked: false,
    prunable: false,
    missing: false,
    dirty: false,
    unpushed: 0,
    sessionIds: [],
  };
}

function Page() {
  const [sessions, setSessions] = useState<Session[]>([original]);
  const [refuse, setRefuse] = useState(false);
  const [created, setCreated] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [notCopied, setNotCopied] = useState(false);
  const [hold, setHold] = useState(false);
  const release = useRef<(() => void) | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const setting = useSyncExternalStore(
    subscribeNewChatWorktree,
    loadNewChatWorktree,
    loadNewChatWorktree,
  );
  const source = sessions[0] ?? original;
  const forks = sessions.slice(1);
  const blocked = resolvePaletteRows({
    project: PROJECT,
    terminal: true,
    chat: false,
    busy: false,
    terminalFocus: false,
    pickerFocus: false,
    editor: false,
  }).find((row) => row.id === "session.fork-from-here");
  const command = resolvePaletteRows({
    project: PROJECT,
    terminal: true,
    chat: true,
    busy: false,
    terminalFocus: false,
    pickerFocus: false,
    editor: false,
  }).find((row) => row.id === "session.fork-from-here");

  const runPalette = () => {
    if (!command) return;
    const side: PaletteSideEffects = {
      run: (_name, fn) => fn(),
      stopChat: () => null,
      stop: noop,
      archiveFocused: noop,
      showHome: noop,
      showChanges: noop,
      openModelPicker: noop,
      newWindow: noop,
      zoom: noop,
      editor: noop,
      forkChat: () => forkFocusedChat(sessionsRef.current.find((item) => item.id === source.id)),
    };
    runPaletteCommand(command, actions, side);
  };

  return (
    <main>
      <h1>Fork a chat</h1>
      <p data-palette-blocked>{blocked?.blockedReason}</p>
      <label>
        New chat worktree
        <select
          aria-label="New chat worktree"
          value={setting}
          onChange={(event) => saveNewChatWorktree(event.target.value as NewChatWorktree)}
        >
          <option value="off">Off</option>
          <option value="ask">Ask</option>
          <option value="always">Always</option>
        </select>
      </label>
      <section data-original-chat>
        <h2>This chat</h2>
        {source.blocks.map((block) => (
          <p key={block.id}>
            <span data-original-message={block.id}>{block.text}</span>
            {block.role === "user" || block.role === "assistant" ? (
              <ForkFromHereButton blockId={block.id} onFork={(id) => askThreadFork(source.id, id)} />
            ) : null}
          </p>
        ))}
        <button type="button" data-palette-fork onClick={runPalette}>
          {command?.label ?? "Fork from here"}
        </button>
      </section>
      <label>
        <input
          type="checkbox"
          data-refuse-worktree
          checked={refuse}
          onChange={(event) => setRefuse(event.target.checked)}
        />
        Refuse the new worktree
      </label>
      <label>
        <input
          type="checkbox"
          data-not-copied
          checked={notCopied}
          onChange={(event) => setNotCopied(event.target.checked)}
        />
        The chat's uncommitted changes cannot be copied
      </label>
      <label>
        <input
          type="checkbox"
          data-hold-worktree
          checked={hold}
          onChange={(event) => setHold(event.target.checked)}
        />
        Hold the new worktree
      </label>
      <button type="button" data-release-worktree onClick={() => release.current?.()}>
        Release the worktree
      </button>
      <p data-created-paths>{created.join("\n")}</p>
      <p data-removed-paths>{removed.join("\n")}</p>
      <section data-forks>
        {forks.map((fork) => (
          <article key={fork.id} data-fork-chat>
            {fork.blocks.map((block) => (
              <p key={block.id} data-fork-message>
                {block.text}
              </p>
            ))}
            <p data-fork-worktree>{fork.worktreeCwd ?? ""}</p>
          </article>
        ))}
      </section>
      <ThreadForkHost
        sessionsRef={sessionsRef}
        setting={loadNewChatWorktree}
        port={{
          createWorktree: async (cwd) => {
            if (refuse) throw new Error(DIRTY);
            setCreated((paths) => [...paths, cwd]);
            if (hold) {
              await new Promise<void>((resolve) => {
                release.current = resolve;
              });
            }
            return { ...tree(`${cwd}\\wt`), ...(notCopied ? { changesNotice: NOT_COPIED } : {}) };
          },
          removeWorktree: async (_cwd, path) => {
            setRemoved((paths) => [...paths, path]);
          },
        }}
        onOpen={(session) => {
          setSessions((current) => insertFork(current, session));
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
