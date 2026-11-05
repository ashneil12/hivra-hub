// Docs, on the notes screen (WP-72). Pages are notes. A version is kept when the
// editor goes idle or the page closes. A timeout leaves the text where it is.

import { useEffect, useRef, useState } from "react";
import { takeHomeDoc } from "../../home/model/pending";
import { inProjectScope } from "../../projects/model/projectScope";
import type { DocsGateway, DocRecord, DocVersionRecord } from "../gateway";
import { markdownOf } from "../gateway";
import { toStoredContent } from "../model/content";
import { mentionCatalog } from "../model/mentionCatalog";
import { migrateNote } from "../model/migrate";
import { DocSaveQueue, SaveConflict, type SaveResult } from "../model/saveQueue";
import { canMove, childrenOf, dropToMove, type DropZone } from "../model/tree";
import { emptyParagraph, type Block, type MentionTarget } from "../model/types";
import { BlockEditor } from "./BlockEditor";

const SAVE_WAIT_MS = 8_000;

type Draft = {
  title: string;
  blocks: Block[];
  dirty: boolean;
  ready: boolean;
  version: number;
  /** A save lost a compare-and-swap. Do not write this draft until the user edits again. */
  conflicted: boolean;
};

type Props = {
  cwd?: string;
  scopeProject?: string;
  onClose: () => void;
  gateway: DocsGateway;
  catalog?: readonly MentionTarget[];
  idleMs?: number;
  saveFiles?: (pageId: string, files: File[]) => Promise<{ name: string; markdownPath: string }[]>;
  pickFolder?: () => Promise<string | null>;
};

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function blocksFrom(page: DocRecord): Block[] {
  const migrated = migrateNote({ body: page.body, blocksJson: page.blocksJson });
  if (migrated.blocks && migrated.blocks.length > 0) return migrated.blocks;
  return [emptyParagraph(newId("b"))];
}

export function DocsScreen({
  cwd,
  scopeProject,
  onClose,
  gateway,
  catalog = [],
  idleMs = 800,
  saveFiles,
  pickFolder,
}: Props) {
  const [pages, setPages] = useState<DocRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [blocks, setBlocks] = useState<Block[]>(() => [emptyParagraph(newId("b"))]);
  const [versions, setVersions] = useState<DocVersionRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const drafts = useRef(new Map<string, Draft>());
  const queues = useRef(new Map<string, DocSaveQueue<DocRecord>>());
  const flushing = useRef(new Set<string>());
  const retryTimers = useRef(new Map<string, number>());
  const selectedRef = useRef<string | null>(null);
  const tokenRef = useRef(0);
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  // Pages on this screen, plus chats, Monos and tasks the caller knows.
  const targets = mentionCatalog({
    pages: pages.filter((page) => page.id !== selectedId),
    extra: catalog,
  });
  selectedRef.current = selectedId;

  function ensure(id: string): Draft {
    let draft = drafts.current.get(id);
    if (!draft) {
      draft = {
        title: "",
        blocks: [emptyParagraph(newId("b"))],
        dirty: false,
        ready: false,
        version: 0,
        conflicted: false,
      };
      drafts.current.set(id, draft);
    }
    return draft;
  }

  function queueFor(id: string, version: number): DocSaveQueue<DocRecord> {
    let queue = queues.current.get(id);
    if (!queue) {
      queue = new DocSaveQueue(version);
      queues.current.set(id, queue);
    }
    return queue;
  }

  async function refresh() {
    const listed = await gatewayRef.current.list();
    setPages(listed.filter((page) => inProjectScope(page.sourceCwd, scopeProject)));
  }

  function scheduleRetry(id: string, delay: number) {
    const existing = retryTimers.current.get(id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      retryTimers.current.delete(id);
      void flushRef.current(id);
    }, delay);
    retryTimers.current.set(id, timer);
  }

  async function flush(id: string): Promise<void> {
    // One update at a time. A second call while the first is in flight waits for it to finish.
    if (flushing.current.has(id)) return;
    const draft = drafts.current.get(id);
    // A conflicted draft is the text that lost. Leaving the page must not write it.
    if (!draft?.ready || !draft.dirty || draft.conflicted) return;
    flushing.current.add(id);
    const savedTitle = draft.title;
    const savedBlocks = draft.blocks;
    const stored = toStoredContent(savedBlocks);
    const body = markdownOf(stored);
    const blocksJson = JSON.stringify(stored);
    const queue = queueFor(id, draft.version);
    // The timer only says the save is still waiting. It does not abandon the request.
    const banner = window.setTimeout(() => {
      if (selectedRef.current === id) setWaiting(true);
    }, SAVE_WAIT_MS);
    try {
      const saved = await queue.enqueue((expectedVersion) =>
        gatewayRef.current
          .update({
            id,
            title: savedTitle,
            body,
            blocksJson,
            expectedVersion,
            snapshot: true,
            origin: "person",
            authorName: "You",
          })
          .then((result): SaveResult<DocRecord> => {
            if (result.status === "conflict") throw new SaveConflict(result.version);
            return { version: result.page.version, value: result.page };
          }),
      );
      window.clearTimeout(banner);
      const current = drafts.current.get(id);
      if (current) current.version = saved.version;
      const stillThisEdit = current && current.blocks === savedBlocks && current.title === savedTitle;
      if (stillThisEdit) current.dirty = false;
      if (selectedRef.current === id) {
        setWaiting(false);
        const rows = await gatewayRef.current.versions(id);
        if (selectedRef.current === id) setVersions(rows);
      }
      if (current?.dirty && !current.conflicted) scheduleRetry(id, 0);
    } catch (err) {
      window.clearTimeout(banner);
      if (err instanceof SaveConflict) {
        const current = drafts.current.get(id);
        if (current) {
          current.version = err.currentVersion;
          current.conflicted = true;
        }
        if (selectedRef.current === id) {
          setWaiting(false);
          setError("The page changed somewhere else");
        }
        return;
      }
      // A thrown save is not finished. Try the same edit again.
      scheduleRetry(id, 500);
    } finally {
      flushing.current.delete(id);
    }
  }

  const flushRef = useRef(flush);
  flushRef.current = flush;

  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // WP-73: a doc opened from Home waits until this list has it.
  useEffect(() => {
    const id = takeHomeDoc(pages.map((page) => page.id));
    if (id) setSelectedId(id);
  }, [pages]);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Pages could not be loaded");
    });
    // The list is this screen's own store. Reload when the scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProject]);

  useEffect(() => {
    const id = selectedId;
    return () => {
      if (id) void flushRef.current(id);
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => void flushRef.current(selectedId), idleMs);
    return () => window.clearTimeout(timer);
  }, [blocks, title, selectedId, idleMs]);

  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    const token = ++tokenRef.current;
    const draft = drafts.current.get(id);
    if (draft?.ready) {
      setTitle(draft.title);
      setBlocks(draft.blocks);
      void gatewayRef.current.versions(id).then((rows) => {
        if (token === tokenRef.current) setVersions(rows);
      });
      return;
    }
    // The previous page stays on screen until this one loads. Clear it so a
    // keystroke cannot be saved as the page that is still opening.
    setTitle("");
    setBlocks([emptyParagraph(newId("b"))]);
    void (async () => {
      try {
        let page = await gatewayRef.current.get(id);
        if (!page || token !== tokenRef.current) return;
        if (page.blocksJson == null && page.body.trim()) {
          const migrated = migrateNote(page, targets);
          if (!migrated.failed && migrated.blocks) {
            const adopted = await gatewayRef.current.adopt({
              id,
              blocksJson: JSON.stringify(toStoredContent(migrated.blocks)),
              body: page.body,
              expectedVersion: page.version,
            });
            if (token !== tokenRef.current) return;
            if (adopted.status === "conflict") {
              setError("The page changed before it could be converted");
              return;
            }
            page = adopted.page;
          }
        }
        if (token !== tokenRef.current) return;
        const next = ensure(id);
        if (!next.ready) {
          next.title = page.title === "Untitled" ? "" : page.title;
          next.blocks = blocksFrom(page);
          next.version = page.version;
          next.dirty = false;
          next.ready = true;
        }
        queueFor(id, next.version);
        setTitle(next.title);
        setBlocks(next.blocks);
        const rows = await gatewayRef.current.versions(id);
        if (token === tokenRef.current) setVersions(rows);
        void gatewayRef.current.touch(id).then(() => refresh());
      } catch (err) {
        if (token === tokenRef.current) {
          setError(err instanceof Error ? err.message : "The page could not be opened");
        }
      }
    })();
    // catalog is a prop the caller keeps stable. Reloading on every new array
    // would drop an edit that arrived while the page was opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function editTitle(value: string) {
    if (!selectedId) return;
    const draft = drafts.current.get(selectedId);
    if (!draft?.ready) return;
    draft.title = value;
    draft.dirty = true;
    draft.conflicted = false;
    setTitle(value);
  }

  function editBlocks(next: Block[]) {
    if (!selectedId) return;
    const draft = drafts.current.get(selectedId);
    if (!draft?.ready) return;
    draft.blocks = next;
    draft.dirty = true;
    draft.conflicted = false;
    setBlocks(next);
  }

  async function createPage(parentId: string | null) {
    setError(null);
    const id = newId("page");
    const draft = ensure(id);
    draft.title = "";
    draft.blocks = [emptyParagraph(newId("b"))];
    draft.dirty = false;
    draft.ready = true;
    draft.version = 0;
    draft.conflicted = false;
    try {
      const result = await gateway.create({
        id,
        title: "",
        body: "",
        parentId,
        origin: "person",
        sourceCwd: scopeProject ?? cwd ?? null,
      });
      if (result.status === "conflict") return;
      draft.version = result.page.version;
      queueFor(id, result.page.version);
      await refresh();
      setVersions([]);
      setTitle("");
      setBlocks(draft.blocks);
      setSelectedId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The page could not be created");
    }
  }

  async function movePage(id: string, parentId: string | null, index: number, siblingIds: string[]) {
    const draft = ensure(id);
    const queue = queueFor(id, draft.version);
    try {
      const saved = await queue.enqueue(async (expectedVersion) => {
        const result = await gateway.move({ id, parentId, index, expectedVersion, siblingIds });
        if (result.status === "conflict") throw new SaveConflict(result.version);
        return { version: result.page.version, value: result.page };
      });
      draft.version = saved.version;
      setError(null);
      await refresh();
    } catch (err) {
      if (err instanceof SaveConflict) {
        draft.version = err.currentVersion;
        setError("The page changed somewhere else");
        return;
      }
      setError(err instanceof Error ? err.message : "The page could not be moved");
    }
  }

  function onDrop(targetId: string, zone: DropZone) {
    if (!dragId || dragId === targetId) return;
    const visible = pages.map((page) => ({ id: page.id, parentId: page.parentId, sortOrder: page.sortOrder }));
    const move = dropToMove(visible, dragId, targetId, zone);
    if (!move) {
      const parentId = zone === "inside" ? targetId : (pages.find((page) => page.id === targetId)?.parentId ?? null);
      if (!canMove(visible, dragId, parentId)) setError("A page cannot move into itself");
      return;
    }
    const siblingIds = childrenOf(visible, move.parentId)
      .map((item) => item.id)
      .filter((item) => item !== dragId);
    void movePage(dragId, move.parentId, move.index, siblingIds);
  }

  async function restore(version: number) {
    if (!selectedId) return;
    const id = selectedId;
    const draft = ensure(id);
    // A restore is not an edit. Mark it clean before the editor re-renders, so
    // the idle timer does not snapshot the restored text again.
    draft.dirty = false;
    const queue = queueFor(id, draft.version);
    try {
      const saved = await queue.enqueue(async (expectedVersion) => {
        const result = await gateway.restore({
          id,
          version,
          expectedVersion,
          authorName: "You",
        });
        if (result.status === "conflict") throw new SaveConflict(result.version);
        return { version: result.page.version, value: result.page };
      });
      draft.dirty = false;
      draft.version = saved.version;
      draft.title = saved.value.title === "Untitled" ? "" : saved.value.title;
      draft.blocks = blocksFrom(saved.value);
      draft.ready = true;
      draft.conflicted = false;
      queues.current.set(id, new DocSaveQueue(saved.version));
      setTitle(draft.title);
      setBlocks(draft.blocks);
      setWaiting(false);
      const rows = await gateway.versions(id);
      if (selectedRef.current === id) setVersions(rows);
      await refresh();
    } catch (err) {
      draft.dirty = true;
      setError(err instanceof Error ? err.message : "That version could not be restored");
    }
  }

  async function toggleFavourite(page: DocRecord) {
    try {
      await gateway.favourite(page.id, !page.favourite);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The page could not be updated");
    }
  }

  async function exportPages(tree: boolean) {
    if (!selectedId) return;
    if (!pickFolder) {
      setError("A folder is needed");
      return;
    }
    const dest = await pickFolder();
    if (!dest) return;
    try {
      await gateway.export({ id: selectedId, dest, tree });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The page could not be exported");
    }
  }

  const favourites = pages.filter((page) => page.favourite);
  const recent = [...pages]
    .filter((page) => page.lastOpenedAt != null)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
    .slice(0, 8);
  const selected = pages.find((page) => page.id === selectedId) ?? null;

  return (
    <div data-docs-root data-doc-id={selectedId ?? ""} data-doc-versions={String(versions.length)} className="flex h-full min-h-0 bg-background-base text-content">
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-r border-content/15 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm">Docs</span>
          <button type="button" className="rounded px-2 py-1 text-sm hover:bg-content/10" onClick={onClose}>
            Close
          </button>
        </div>
        <button type="button" className="rounded bg-content/10 px-2 py-1 text-left text-sm hover:bg-content/15" onClick={() => void createPage(null)}>
          New page
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-left text-sm hover:bg-content/10 disabled:opacity-40"
          disabled={!selectedId}
          onClick={() => selectedId && void createPage(selectedId)}
        >
          Add page inside
        </button>
        {favourites.length > 0 ? (
          <section>
            <h2 className="mb-1 text-xs text-content/60">Favourites</h2>
            {favourites.map((page) => (
              <PageButton key={page.id} page={page} selected={page.id === selectedId} onSelect={setSelectedId} />
            ))}
          </section>
        ) : null}
        {recent.length > 0 ? (
          <section>
            <h2 className="mb-1 text-xs text-content/60">Recent</h2>
            {recent.map((page) => (
              <PageButton key={`recent-${page.id}`} page={page} selected={page.id === selectedId} onSelect={setSelectedId} />
            ))}
          </section>
        ) : null}
        <section>
          <h2 className="mb-1 text-xs text-content/60">Pages</h2>
          <PageTree
            pages={pages}
            parentId={null}
            depth={0}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDrag={setDragId}
            onDrop={onDrop}
          />
        </section>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        {error ? (
          <p role="alert" className="rounded bg-content/10 px-2 py-1 text-sm">
            {error}
          </p>
        ) : null}
        {waiting ? (
          <p role="status" className="rounded bg-content/10 px-2 py-1 text-sm">
            Saving is still waiting
          </p>
        ) : null}
        {selectedId ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Title"
                value={title}
                placeholder="Untitled"
                className="min-w-0 flex-1 bg-transparent text-lg text-content outline-none"
                onChange={(event) => editTitle(event.target.value)}
              />
              <button type="button" className="rounded px-2 py-1 text-sm hover:bg-content/10" onClick={() => setHistoryOpen((open) => !open)}>
                History
              </button>
              {selected ? (
                <button type="button" className="rounded px-2 py-1 text-sm hover:bg-content/10" onClick={() => void toggleFavourite(selected)}>
                  {selected.favourite ? "Unfavourite" : "Favourite"}
                </button>
              ) : null}
              <button type="button" className="rounded px-2 py-1 text-sm hover:bg-content/10" onClick={() => void exportPages(false)}>
                Export page
              </button>
              <button type="button" className="rounded px-2 py-1 text-sm hover:bg-content/10" onClick={() => void exportPages(true)}>
                Export tree
              </button>
            </div>
            <BlockEditor
              blocks={blocks}
              onChange={editBlocks}
              catalog={targets}
              onSubpage={() => void createPage(selectedId)}
              onSaveFiles={saveFiles ? (files) => saveFiles(selectedId, files) : undefined}
            />
            {historyOpen ? (
              <div data-doc-history className="rounded border border-content/15 p-2">
                {versions.length === 0 ? <p className="text-sm text-content/60">No versions yet</p> : null}
                {versions.map((row) => (
                  <div key={row.id} data-doc-version={row.version} className="flex items-center justify-between gap-2 py-1 text-sm">
                    <span>
                      Version {row.version}
                      {row.kind === "restore" ? " restored" : ""}
                      {row.authorName ? ` by ${row.authorName}` : ""}
                    </span>
                    <button type="button" className="rounded px-2 py-1 hover:bg-content/10" onClick={() => void restore(row.version)}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-content/60">Create a page to start writing.</p>
        )}
      </main>
    </div>
  );
}

function PageButton({ page, selected, onSelect }: { page: DocRecord; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className={`block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-content/10 ${selected ? "bg-content/10" : ""}`}
      onClick={() => onSelect(page.id)}
    >
      {page.title}
    </button>
  );
}

function PageTree({
  pages,
  parentId,
  depth,
  selectedId,
  onSelect,
  onDrag,
  onDrop,
}: {
  pages: DocRecord[];
  parentId: string | null;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDrag: (id: string | null) => void;
  onDrop: (targetId: string, zone: DropZone) => void;
}) {
  const tree = pages.map((page) => ({ id: page.id, parentId: page.parentId, sortOrder: page.sortOrder }));
  return (
    <>
      {childrenOf(tree, parentId).map((item) => {
        const page = pages.find((candidate) => candidate.id === item.id);
        if (!page) return null;
        return (
          <div key={page.id} style={{ paddingLeft: depth * 12 }}>
            <button
              type="button"
              draggable
              data-parent-id={page.parentId ?? ""}
              className={`block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-content/10 ${page.id === selectedId ? "bg-content/10" : ""}`}
              onClick={() => onSelect(page.id)}
              onDragStart={() => onDrag(page.id)}
              onDragEnd={() => onDrag(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const y = event.clientY - rect.top;
                const zone: DropZone = y < rect.height * 0.25 ? "before" : y > rect.height * 0.75 ? "after" : "inside";
                onDrop(page.id, zone);
              }}
            >
              {page.title}
            </button>
            <PageTree
              pages={pages}
              parentId={page.id}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onDrag={onDrag}
              onDrop={onDrop}
            />
          </div>
        );
      })}
    </>
  );
}

