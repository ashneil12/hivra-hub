// A chat that came in from an export with a folder that isn't a project on this Mac has none (docs/PORTABLE.md). Nothing
// starts for it until one is chosen, so it says so here, in the words the refusal uses, and offers the folder picker.
import { useEffect, useState } from "react";
import { relinkCandidate } from "../../portable/model/relink";
import { pickFolders } from "../../../platform/tauri/fs";
import { CHAT_NEEDS_FOLDER, hasChatFolder } from "../../../integrations/harness/core/chatFolder";
import type { Session } from "../model/session";

export function ChatFolderBanner({
  session,
  onChoose,
  pick = async () => (await pickFolders("Choose a project folder for this chat"))[0],
  offer = relinkCandidate,
}: {
  session: Pick<Session, "cwd"> & { id?: string };
  onChoose: (cwd: string) => void;
  /** The folder picker; tests pass their own. Nothing back means it was cancelled. */
  pick?: () => Promise<string | undefined>;
  /** The folder this chat's file named, once it exists here and passes the import's checks (Rust decides). */
  offer?: (sessionId: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [offered, setOffered] = useState<string | null>(null);
  const blank = !hasChatFolder(session.cwd);
  useEffect(() => {
    if (!blank || !session.id) return;
    let live = true;
    offer(session.id)
      .then((folder) => live && setOffered(folder))
      .catch(() => live && setOffered(null));
    return () => {
      live = false;
    };
  }, [blank, session.id, offer]);
  if (!blank) return null;
  const choose = async () => {
    setBusy(true);
    try {
      const folder = await pick();
      if (folder) onChoose(folder);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      data-chat-needs-folder=""
      className="flex shrink-0 items-center gap-3 border-b border-stroke px-3 py-2 text-xs text-content/80"
    >
      <span className="min-w-0 flex-1">{CHAT_NEEDS_FOLDER}</span>
      {offered ? (
        <button
          type="button"
          data-chat-relink=""
          title={offered}
          onClick={() => onChoose(offered)}
          className="min-w-0 max-w-[40%] shrink truncate rounded-md border border-stroke px-2 py-1 text-content hover:bg-content/5"
        >
          Use {offered}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => void choose()}
        className="shrink-0 rounded-md border border-stroke px-2 py-1 text-content hover:bg-content/5 disabled:opacity-40"
      >
        Choose folder…
      </button>
    </div>
  );
}
