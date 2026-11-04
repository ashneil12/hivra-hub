import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TrashPage, type TrashClient } from "../../src/features/trash/ui/TrashPage";
import type { TrashListItem } from "../../src/features/trash/model/trash";
import "../../src/styles/index.css";

const chat: TrashListItem = {
  kind: "chat",
  id: "chat-1",
  title: "Notes about the plan",
  deletedAt: 1,
  version: 1,
  withCount: 0,
  payload: "{}",
};

function Fixture() {
  const items = useRef<TrashListItem[]>([]);
  const [token, setToken] = useState(0);
  const client = useMemo<TrashClient>(
    () => ({
      list: async () => items.current,
      restore: async (kind, id) => {
        items.current = items.current.filter((item) => item.kind !== kind || item.id !== id);
        return [];
      },
      deleteForever: async (kind, id) => {
        items.current = items.current.filter((item) => item.kind !== kind || item.id !== id);
        return 1;
      },
      empty: async () => {
        const purged = items.current.length;
        items.current = [];
        return { purged };
      },
    }),
    [],
  );
  return (
    <div className="text-content">
      <button
        type="button"
        onClick={() => {
          items.current = [...items.current, chat];
          setToken((current) => current + 1);
        }}
      >
        Delete chat
      </button>
      <TrashPage client={client} reloadToken={token} onPurgeProject={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
