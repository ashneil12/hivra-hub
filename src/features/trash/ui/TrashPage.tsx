// Settings → Trash. Deleted chats, Monos, projects, notes, docs and tasks, for 30 days.

import { useCallback, useEffect, useState } from "react";
import { ConfirmDelete } from "../../../shared/ui/ConfirmDelete";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { purgeProjectLocal } from "../../projects/model/projectData";
import {
  deleteForever,
  emptyTrash,
  listTrash,
  restoreTrash,
} from "../model/client";
import { restoreMonoRoster } from "../model/restore";
import {
  groupTrash,
  withItLabel,
  type TrashListItem,
} from "../model/trash";

export type TrashClient = {
  list: () => Promise<TrashListItem[]>;
  restore: (kind: string, id: string, version: number) => Promise<unknown>;
  deleteForever: (kind: string, id: string, version: number) => Promise<unknown>;
  empty: () => Promise<unknown>;
};

const liveClient: TrashClient = {
  list: listTrash,
  restore: restoreTrash,
  deleteForever,
  empty: emptyTrash,
};

function isItem(value: unknown): value is TrashListItem {
  if (!value || typeof value !== "object") return false;
  const row = value as TrashListItem;
  return (
    typeof row.kind === "string" &&
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.version === "number" &&
    typeof row.withCount === "number" &&
    typeof row.deletedAt === "number" &&
    typeof row.payload === "string"
  );
}

export function TrashPage({
  client = liveClient,
  reloadToken = 0,
  onRestoreProject,
  onPurgeProject = purgeProjectLocal,
}: {
  client?: TrashClient;
  /** Bumps when something else moved an item in, so the list is read again. */
  reloadToken?: number;
  onRestoreProject?: (path: string) => void;
  onPurgeProject?: (path: string) => Promise<void> | void;
}) {
  const [items, setItems] = useState<TrashListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<TrashListItem | "empty" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await client.list();
      if (!Array.isArray(rows)) {
        setError("Trash could not be read.");
        return;
      }
      setItems(rows.filter(isItem));
      setError(null);
    } catch {
      // Not hearing back leaves the list as it was.
      setError("Trash could not be read. It will try again.");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const fail = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
    void load();
  };

  const restore = async (item: TrashListItem) => {
    setBusy(true);
    setError(null);
    try {
      await client.restore(item.kind, item.id, item.version);
      if (item.kind === "mono") await restoreMonoRoster(item.id, item.payload);
      if (item.kind === "project") onRestoreProject?.(item.id);
      setItems((current) => current.filter((row) => row.kind !== item.kind || row.id !== item.id));
      void load();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const purge = async (item: TrashListItem) => {
    setPending(null);
    setBusy(true);
    setError(null);
    try {
      await client.deleteForever(item.kind, item.id, item.version);
      if (item.kind === "project") await onPurgeProject(item.id);
      setItems((current) => current.filter((row) => row.kind !== item.kind || row.id !== item.id));
      void load();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    const projects = items.filter((item) => item.kind === "project");
    setPending(null);
    setBusy(true);
    setError(null);
    try {
      await client.empty();
      for (const project of projects) await onPurgeProject(project.id);
      setItems([]);
      void load();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const groups = groupTrash(items);

  return (
    <section className="flex flex-col gap-4" data-trash-page>
      <div className="flex items-center justify-between gap-3 px-4">
        <p className="text-[12px] text-content/55">
          Deleted things stay here for 30 days. Then they are deleted forever.
        </p>
        {items.length > 0 ? (
          <SecondaryButton danger disabled={busy} onClick={() => setPending("empty")}>
            Empty trash
          </SecondaryButton>
        ) : null}
      </div>
      {error ? <p className="px-4 text-[12px] text-red-400">{error}</p> : null}
      {items.length === 0 ? (
        <p className="px-4 py-3.5 text-[12px] text-content/45">Trash is empty</p>
      ) : (
        groups.map((group) => (
          <div key={group.kind}>
            <h3 className="px-4 pb-1 text-[12px] font-medium text-content/45">
              {group.label}
            </h3>
            {group.items.map((item) => {
              const withIt = withItLabel(item.withCount);
              return (
                <div
                  key={`${item.kind}:${item.id}`}
                  className="flex items-center gap-3 border-b border-content/5 px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{item.title}</div>
                    {withIt ? (
                      <div className="truncate text-[11px] text-content/40">{withIt}</div>
                    ) : null}
                  </div>
                  <SecondaryButton disabled={busy} onClick={() => void restore(item)}>
                    Restore
                  </SecondaryButton>
                  <SecondaryButton danger disabled={busy} onClick={() => setPending(item)}>
                    Delete forever
                  </SecondaryButton>
                </div>
              );
            })}
          </div>
        ))
      )}
      {pending === "empty" ? (
        <ConfirmDelete
          name="the trash"
          detail={
            items.length === 1
              ? "1 item is deleted permanently."
              : `${items.length} items are deleted permanently.`
          }
          deleteLabel="Empty trash"
          onCancel={() => setPending(null)}
          onDelete={() => void empty()}
        />
      ) : null}
      {pending && pending !== "empty" ? (
        <ConfirmDelete
          name={pending.title}
          detail="It is deleted permanently."
          deleteLabel="Delete forever"
          onCancel={() => setPending(null)}
          onDelete={() => void purge(pending)}
        />
      ) : null}
    </section>
  );
}
