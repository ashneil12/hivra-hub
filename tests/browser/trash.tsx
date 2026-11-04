import { createRoot } from "react-dom/client";
import { deleteSession } from "../../src/features/sessions/data/sessionStore";
import { SettingsView } from "../../src/features/settings/ui/SettingsView";
import "../../src/styles/index.css";
import { installFakeTauri } from "./fakeTauri";

type Row = {
  kind: "chat";
  id: string;
  title: string;
  deletedAt: number;
  version: number;
  withCount: number;
  payload: string;
};

const items: Row[] = [];

const tauri = installFakeTauri("main", (command, args) => {
  if (command === "session_delete") {
    items.push({
      kind: "chat",
      id: String(args.sessionId ?? ""),
      title: "Notes about the plan",
      deletedAt: 1,
      version: 1,
      withCount: 0,
      payload: "{}",
    });
    queueMicrotask(() => tauri.emit("monocode:trash", null));
    return null;
  }
  if (command === "trash_list") return items.map((item) => ({ ...item }));
  if (command === "trash_restore") {
    const index = items.findIndex(
      (item) => item.kind === args.kind && item.id === args.id && item.version === args.version,
    );
    if (index >= 0) items.splice(index, 1);
    return [];
  }
  if (command === "trash_delete_forever") return 1;
  if (command === "trash_empty") {
    const purged = items.length;
    items.splice(0, items.length);
    return { purged };
  }
  return null;
});

function Page() {
  return (
    <div className="text-content">
      <button type="button" onClick={() => void deleteSession("chat-1")}>
        Delete chat
      </button>
      <SettingsView
        section="trash"
        cwd="~"
        sessions={[]}
        onClose={() => undefined}
        onOpenSession={() => undefined}
        onArchiveSession={() => undefined}
        onDeleteSession={() => undefined}
        onOpenWhatsNew={() => undefined}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
