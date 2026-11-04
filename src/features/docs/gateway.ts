// The docs screen and the browser fixture talk to this. The app uses the Tauri
// commands; tests use the memory gateway, which follows the same rules as
// src-tauri/src/docs.rs. Page text is data.

import { mentionsIn, newMentions, resolveMention, type StoredMention } from "./model/mentions";
import { blocksToMarkdown, stripBlockIds } from "./model/markdown";
import { childrenOf, canMove, reorder, type TreePage } from "./model/tree";
import { planRestore, type DocState } from "./model/versions";
import type { Block, MentionTarget } from "./model/types";

export type DocRecord = {
  id: string;
  slug: string;
  title: string;
  body: string;
  blocksJson: string | null;
  parentId: string | null;
  sortOrder: number;
  version: number;
  tags: string[];
  sourceCwd: string | null;
  sourceSessionId: string | null;
  favourite: boolean;
  lastOpenedAt: number | null;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type DocMentionRecord = {
  kind: string;
  targetId: string;
  name: string;
};

export type DocWriteResult =
  | { status: "saved"; page: DocRecord; newMentions: DocMentionRecord[] }
  | { status: "conflict"; version: number };

export type DocVersionRecord = {
  id: string;
  noteId: string;
  version: number;
  title: string;
  body: string;
  blocksJson: string | null;
  kind: string;
  authorKind: string;
  authorId: string;
  authorName: string;
  createdAt: number;
};

export type DocCreateInput = {
  id: string;
  title: string;
  body: string;
  blocksJson?: string | null;
  tags?: string[];
  sourceCwd?: string | null;
  sourceSessionId?: string | null;
  parentId?: string | null;
  origin?: string;
  authorId?: string;
  authorName?: string;
};

export type DocUpdateInput = {
  id: string;
  title: string;
  body: string;
  blocksJson?: string | null;
  expectedVersion: number;
  snapshot?: boolean;
  origin?: string;
  authorId?: string;
  authorName?: string;
  tags?: string[] | null;
};

export type DocsGateway = {
  list: () => Promise<DocRecord[]>;
  get: (id: string) => Promise<DocRecord | null>;
  create: (page: DocCreateInput) => Promise<DocWriteResult>;
  update: (page: DocUpdateInput) => Promise<DocWriteResult>;
  adopt: (input: {
    id: string;
    blocksJson: string;
    body: string;
    expectedVersion: number;
  }) => Promise<DocWriteResult>;
  move: (input: {
    id: string;
    parentId: string | null;
    index: number;
    expectedVersion: number;
    /** Siblings the caller ordered against, not including the moved page. */
    siblingIds?: string[];
  }) => Promise<DocWriteResult>;
  versions: (id: string) => Promise<DocVersionRecord[]>;
  restore: (input: {
    id: string;
    version: number;
    expectedVersion: number;
    authorId?: string;
    authorName?: string;
  }) => Promise<DocWriteResult>;
  favourite: (id: string, favourite: boolean) => Promise<DocRecord>;
  touch: (id: string) => Promise<DocRecord>;
  trash: (id: string) => Promise<void>;
  resolve: (kind: string, targetId: string) => Promise<DocMentionRecord & { found: boolean }>;
  export: (request: { id: string; dest: string; tree?: boolean }) => Promise<string[]>;
};

const ID = /^[A-Za-z0-9_-]+$/;

export type MemoryGatewayOptions = {
  catalog?: readonly (MentionTarget & { slug?: string })[];
  now?: () => number;
};

type Author = { kind: "person" | "agent"; id: string; name: string };

function requireId(value: string, label: string) {
  if (!value || !ID.test(value)) throw new Error(`Invalid ${label} id`);
}

function authorOf(origin: string | undefined, id: string | undefined, name: string | undefined): Author {
  const kind = origin && origin.length > 0 ? origin : "person";
  if (kind !== "person" && kind !== "agent") throw new Error("Unknown author");
  return { kind, id: id ?? "", name: name ?? "" };
}

function normalizeBody(body: string): string {
  if (body.length > 1_000_000) throw new Error("Page text is too long");
  return body.replace(/\r\n?/g, "\n");
}

function storedTitle(title: string): string {
  const trimmed = title.trim().slice(0, 200);
  return trimmed || "Untitled";
}

function parseBlocks(json: string | null | undefined): Block[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as Block[]) : [];
  } catch {
    return [];
  }
}

function canonicalBlocks(json: string | null | undefined): string {
  return JSON.stringify(stripBlockIds(parseBlocks(json)));
}

function sameBlocks(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left && !right) return true;
  return canonicalBlocks(left) === canonicalBlocks(right);
}

function slugify(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
  let slug = base;
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function stateOf(title: string, body: string, blocksJson: string | null): DocState {
  return { title, body, blocks: parseBlocks(blocksJson) };
}

/** In-memory docs store for the browser fixture and unit tests. */
export function memoryGateway(options: MemoryGatewayOptions = {}): DocsGateway {
  const pages = new Map<string, DocRecord>();
  const versions = new Map<string, DocVersionRecord[]>();
  const mentions = new Map<string, StoredMention[]>();
  const now = options.now ?? (() => Date.now());
  let clock = 0;
  const stamp = () => {
    clock += 1;
    return options.now ? now() : clock;
  };

  function saved(page: DocRecord, fresh: DocMentionRecord[]): DocWriteResult {
    return { status: "saved", page: { ...page }, newMentions: fresh };
  }

  function requirePage(id: string): DocRecord {
    const page = pages.get(id);
    if (!page) throw new Error("Page was not found");
    return page;
  }

  function parentLoops(parentId: string): boolean {
    const seen = new Set<string>();
    let current: string | null = parentId;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      const parent: string | null = pages.get(current)?.parentId ?? null;
      current = parent;
    }
    return false;
  }

  function tree(): TreePage[] {
    return [...pages.values()].filter((page) => !page.trashedAt);
  }

  function replaceMentions(id: string, blocksJson: string | null): DocMentionRecord[] {
    const before = mentions.get(id) ?? [];
    const after = mentionsIn(parseBlocks(blocksJson));
    mentions.set(id, after);
    return newMentions(before, after);
  }

  function newest(id: string): DocVersionRecord | null {
    const rows = versions.get(id) ?? [];
    return rows.length ? rows[rows.length - 1] : null;
  }

  function sameAsNewest(title: string, body: string, blocksJson: string | null, id: string): boolean {
    const row = newest(id);
    if (!row) return false;
    return row.title === title && row.body === body && sameBlocks(row.blocksJson, blocksJson);
  }

  function insertVersion(
    pageId: string,
    title: string,
    body: string,
    blocksJson: string | null,
    kind: string,
    author: Author,
  ) {
    const rows = versions.get(pageId) ?? [];
    const version = (rows[rows.length - 1]?.version ?? 0) + 1;
    const row: DocVersionRecord = {
      id: `${pageId}-v-${version}-${kind}`,
      noteId: pageId,
      version,
      title,
      body,
      blocksJson,
      kind,
      authorKind: author.kind,
      authorId: author.id,
      authorName: author.name,
      createdAt: stamp(),
    };
    versions.set(pageId, [...rows, row]);
  }

  function catalog(): (MentionTarget & { slug?: string })[] {
    const fromPages = [...pages.values()]
      .filter((page) => !page.trashedAt)
      .map((page) => ({ kind: "page" as const, id: page.id, name: page.title, slug: page.slug }));
    return [...(options.catalog ?? []), ...fromPages];
  }

  return {
    async list() {
      return [...pages.values()]
        .filter((page) => !page.trashedAt)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
        .map((page) => ({ ...page }));
    },
    async get(id) {
      requireId(id, "page");
      const page = pages.get(id);
      return page ? { ...page } : null;
    },
    async create(input) {
      requireId(input.id, "page");
      const author = authorOf(input.origin, input.authorId, input.authorName);
      const body = normalizeBody(input.body);
      const blocksJson = input.blocksJson ?? null;
      if (blocksJson && blocksJson.length > 2_000_000) throw new Error("Page text is too long");
      const title = storedTitle(input.title);
      const blank = input.title.trim() === "" && body.trim() === "";
      if (input.parentId) {
        requireId(input.parentId, "page");
        if (!pages.has(input.parentId) || pages.get(input.parentId)?.trashedAt) {
          throw new Error("Page was not found");
        }
        if (parentLoops(input.parentId)) throw new Error("This page tree has a cycle");
      }
      const existing = pages.get(input.id);
      if (existing) {
        if (existing.title === title && existing.body === body) return saved(existing, []);
        throw new Error("This page already exists");
      }
      const taken = new Set([...pages.values()].map((page) => page.slug));
      const siblings = childrenOf(tree(), input.parentId ?? null);
      const at = stamp();
      const page: DocRecord = {
        id: input.id,
        slug: slugify(title, taken),
        title,
        body,
        blocksJson,
        parentId: input.parentId ?? null,
        sortOrder: siblings.length,
        version: blank ? 0 : 1,
        tags: input.tags ?? [],
        sourceCwd: input.sourceCwd ?? null,
        sourceSessionId: input.sourceSessionId ?? null,
        favourite: false,
        lastOpenedAt: null,
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      pages.set(page.id, page);
      if (!blank) insertVersion(page.id, title, body, blocksJson, author.kind === "agent" ? "agent" : "auto", author);
      return saved(page, replaceMentions(page.id, blocksJson));
    },
    async update(input) {
      requireId(input.id, "page");
      const author = authorOf(input.origin, input.authorId, input.authorName);
      const page = requirePage(input.id);
      if (page.version !== input.expectedVersion) return { status: "conflict", version: page.version };
      const body = normalizeBody(input.body);
      const blocksJson = input.blocksJson === undefined ? page.blocksJson : input.blocksJson;
      const title = storedTitle(input.title);
      const blank = input.title.trim() === "" && body.trim() === "";
      const tags = input.tags ?? page.tags;
      const same =
        page.title === title && page.body === body && sameBlocks(page.blocksJson, blocksJson) &&
        JSON.stringify(page.tags) === JSON.stringify(tags);
      if (same) {
        if (input.snapshot && !blank && !sameAsNewest(title, body, blocksJson, page.id)) {
          insertVersion(page.id, title, body, blocksJson, author.kind === "agent" ? "agent" : "auto", author);
        }
        return saved(page, []);
      }
      page.title = title;
      page.body = body;
      page.blocksJson = blocksJson;
      page.tags = tags;
      page.version += 1;
      page.updatedAt = stamp();
      if (input.snapshot && !blank && !sameAsNewest(title, body, blocksJson, page.id)) {
        insertVersion(page.id, title, body, blocksJson, author.kind === "agent" ? "agent" : "auto", author);
      }
      return saved(page, replaceMentions(page.id, blocksJson));
    },
    async adopt(input) {
      requireId(input.id, "page");
      const page = requirePage(input.id);
      if (page.blocksJson != null) return saved(page, []);
      if (page.body !== input.body) throw new Error("The page changed before it could be converted");
      if (page.version !== input.expectedVersion) return { status: "conflict", version: page.version };
      page.blocksJson = input.blocksJson;
      page.version += 1;
      page.updatedAt = stamp();
      return saved(page, replaceMentions(page.id, page.blocksJson));
    },
    async move(input) {
      requireId(input.id, "page");
      const page = requirePage(input.id);
      if (page.version !== input.expectedVersion) return { status: "conflict", version: page.version };
      if (input.parentId) {
        requireId(input.parentId, "page");
        if (!pages.has(input.parentId)) throw new Error("Page was not found");
      }
      if (!canMove(tree(), input.id, input.parentId)) throw new Error("A page cannot move into itself");
      // A list the caller built before a sibling moved is not applied.
      if (Array.isArray(input.siblingIds)) {
        const fresh = childrenOf(tree(), input.parentId ?? null)
          .map((item) => item.id)
          .filter((id) => id !== input.id);
        if (input.siblingIds.join("\0") !== fresh.join("\0")) {
          return { status: "conflict", version: page.version };
        }
      }
      const oldParent = page.parentId;
      const currentIndex = childrenOf(tree(), oldParent).findIndex((item) => item.id === input.id);
      const without = childrenOf(tree(), input.parentId)
        .map((item) => item.id)
        .filter((id) => id !== input.id);
      const index = Math.max(0, Math.min(input.index, without.length));
      if ((oldParent ?? null) === (input.parentId ?? null) && currentIndex === index) return saved(page, []);
      page.parentId = input.parentId;
      const next = reorder(without, input.id, index);
      next.forEach((id, order) => {
        const sibling = pages.get(id);
        if (sibling) sibling.sortOrder = order;
      });
      if ((oldParent ?? null) !== (input.parentId ?? null)) {
        childrenOf(tree(), oldParent).forEach((item, order) => {
          const sibling = pages.get(item.id);
          if (sibling) sibling.sortOrder = order;
        });
      }
      page.version += 1;
      page.updatedAt = stamp();
      return saved(page, []);
    },
    async versions(id) {
      requireId(id, "page");
      requirePage(id);
      return (versions.get(id) ?? []).map((row) => ({ ...row }));
    },
    async restore(input) {
      requireId(input.id, "page");
      const page = requirePage(input.id);
      if (page.version !== input.expectedVersion) return { status: "conflict", version: page.version };
      const row = (versions.get(input.id) ?? []).find((item) => item.version === input.version);
      if (!row) throw new Error("That version was not found");
      const author = authorOf("person", input.authorId, input.authorName);
      const current = stateOf(page.title, page.body, page.blocksJson);
      const restored = stateOf(row.title, row.body, row.blocksJson);
      const latest = newest(input.id);
      const plan = planRestore(current, latest ? stateOf(latest.title, latest.body, latest.blocksJson) : null, restored);
      if (!plan.restore) return saved(page, []);
      if (plan.keepCurrent) insertVersion(page.id, page.title, page.body, page.blocksJson, "auto", author);
      page.title = row.title;
      page.body = row.body;
      page.blocksJson = row.blocksJson;
      page.version += 1;
      page.updatedAt = stamp();
      insertVersion(page.id, row.title, row.body, row.blocksJson, "restore", author);
      return saved(page, replaceMentions(page.id, page.blocksJson));
    },
    async favourite(id, favourite) {
      requireId(id, "page");
      const page = requirePage(id);
      page.favourite = favourite;
      return { ...page };
    },
    async touch(id) {
      requireId(id, "page");
      const page = requirePage(id);
      page.lastOpenedAt = stamp();
      return { ...page };
    },
    async trash(id) {
      requireId(id, "page");
      requirePage(id);
      const seen = new Set<string>();
      const queue = [id];
      const at = stamp();
      while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        const page = pages.get(current);
        if (page) page.trashedAt = at;
        for (const child of childrenOf([...pages.values()], current)) queue.push(child.id);
      }
    },
    async resolve(kind, targetId) {
      const mention = { kind: kind as StoredMention["kind"], targetId, name: targetId };
      if (kind !== "page" && kind !== "task" && kind !== "chat" && kind !== "mono") {
        return { ...mention, kind, found: false };
      }
      const hit = resolveMention(mention, catalog());
      return { kind: hit.kind, targetId: hit.targetId, name: hit.name, found: hit.found };
    },
    async export() {
      throw new Error("Export writes files from the app");
    },
  };
}

/** Markdown the editor stores beside the blocks, so the two cannot drift. */
export function markdownOf(blocks: readonly Block[]): string {
  return blocksToMarkdown(blocks);
}
