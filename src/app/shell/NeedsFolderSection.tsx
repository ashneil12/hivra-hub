// The sidebar's "Needs a folder" group: chats that came in from an export with no folder (docs/PORTABLE.md), listed
// together so none of them is findable only through search. Opening one shows the chat, which asks for a folder.
import { useEffect, useState } from "react";
import { listFolderlessSessions, type SessionSummary } from "../../features/sessions/data/sessionStore";
import { sessionDisplayTitle } from "../../features/sessions/model/session";
import { FOLDERLESS_CHANGED, hasChatFolder } from "../../integrations/harness/core/chatFolder";
import { relinkApply, relinkCandidates, type Relink } from "../../features/portable/model/relink";
import { basename } from "../../platform/tauri/fs";

export function NeedsFolderSection({
  onSelect,
  activeSessionId,
  openSessions,
  list = listFolderlessSessions,
  offers = relinkCandidates,
  apply = relinkApply,
  onRelinked,
}: {
  onSelect: (sessionId: string) => void;
  activeSessionId?: string;
  /** Open chats as the window has them: one that was just given a folder leaves the group at once. */
  openSessions?: readonly Pick<SessionSummary, "id" | "cwd">[];
  list?: () => Promise<SessionSummary[]>;
  /** The chats whose file-named folder can be given back now (Rust decides), and how to give them back. */
  offers?: () => Promise<Relink[]>;
  apply?: (sessionIds: string[]) => Promise<Relink[]>;
  /** A chat the window has open was given its folder: set it there too, so the open copy doesn't save a blank over it. */
  onRelinked?: (sessionId: string, folder: string) => void;
}) {
  const [rows, setRows] = useState<SessionSummary[]>([]);
  const [relinks, setRelinks] = useState<Relink[]>([]);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  // The window's own copies decide: reading again when they change picks up a chat that was given a folder or came in.
  const openKey = (openSessions ?? []).map((s) => `${s.id}:${hasChatFolder(s.cwd)}`).join("|");
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener(FOLDERLESS_CHANGED, again);
    return () => window.removeEventListener(FOLDERLESS_CHANGED, again);
  }, []);
  useEffect(() => {
    let live = true;
    offers()
      .then((next) => live && setRelinks(next))
      .catch(() => live && setRelinks([]));
    list()
      .then((next) => live && setRows(next))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [list, offers, tick, openKey]);
  const withFolderNow = new Set((openSessions ?? []).filter((s) => hasChatFolder(s.cwd)).map((s) => s.id));
  const shown = rows.filter((row) => !withFolderNow.has(row.id));
  if (!shown.length) return null;
  // One "Relink all" per project or Mono: the chats here whose file-named folder can be given back now.
  const shownIds = new Set(shown.map((row) => row.id));
  const groups = new Map<string, Relink[]>();
  for (const relink of relinks.filter((r) => shownIds.has(r.sessionId))) groups.set(relink.group, [...(groups.get(relink.group) ?? []), relink]);
  const relinkAll = async (group: Relink[]) => {
    setBusy(true);
    try {
      const done = await apply(group.map((r) => r.sessionId));
      for (const r of done) onRelinked?.(r.sessionId, r.folder);
      setTick((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-needs-folder="" className="px-2 pt-2">
      <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-content/50">
        Needs a folder <span className="font-normal">({shown.length})</span>
      </p>
      {[...groups].map(([group, members]) => (
        <button
          key={group}
          type="button"
          data-relink-all={group}
          disabled={busy}
          title={group}
          onClick={() => void relinkAll(members)}
          className="mb-1 block w-full truncate rounded-md border border-stroke px-2 py-1 text-left text-[12px] text-content hover:bg-content/5 disabled:opacity-40"
        >
          Relink all {members.length} to {basename(group)}
        </button>
      ))}
      <ul className="flex flex-col gap-px">
        {shown.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              data-needs-folder-chat={row.id}
              aria-current={row.id === activeSessionId ? "true" : undefined}
              onClick={() => onSelect(row.id)}
              className={`block w-full truncate rounded-md px-2 py-1 text-left text-[13px] text-content/80 hover:bg-content/5 hover:text-content ${
                row.id === activeSessionId ? "bg-selection text-content" : ""
              }`}
            >
              {sessionDisplayTitle(row.title, row.harness)}
            </button>
          </li>
        ))}
      </ul>
      <p className="px-2 pt-1 text-[11px] leading-4 text-content/50">Open one to choose its project folder.</p>
    </div>
  );
}
