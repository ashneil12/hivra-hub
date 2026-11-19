import { useSyncExternalStore } from "react";
import type { DesignIssue } from "../../pages/model/designCheck";
import type { PageSpec } from "../../pages/model/pageSpec";

/**
 * G15: New page and Change on the Pages screen ask the chosen first mate in its own chat (buildPage.ts), and its
 * page_build there (pagesChat.ts) is the answer. One open ask per first mate; a newer ask replaces it. The card waits a
 * bounded time; an ask stays open a while longer, so a page that comes late still lands where it was asked for: a new
 * page as the usual chat preview, a change as a new version waiting on its kept page.
 */
export type PageAsk = {
  id: string;
  monoId: string;
  /** The hub project it is for, when it is one. */
  projectId?: string;
  prompt: string;
  at: number;
  /** Change on a kept page: the page it changes. */
  change?: { pageId: string; title: string };
};
export type PageAskAnswer = { spec: PageSpec; warnings: DesignIssue[]; request: string; by: string; previewId?: string };
/** A change a first mate built from the card's ask, waiting on its kept page for Use this version or Discard. */
export type ChatPageVersion = { spec: PageSpec; request: string; by: string; monoId: string; at: number };

/** How long an ask stays open for a late page_build after it was sent. */
export const ASK_OPEN_MS = 15 * 60_000;

type Open = { ask: PageAsk; settle: (answer: PageAskAnswer | undefined) => void };
const open = new Map<string, Open>();
const versions = new Map<string, ChatPageVersion>();
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  subs.forEach((f) => f());
};

/** Open an ask for its first mate (replacing any it had). Resolves with its page_build, or undefined once closed. */
export function openPageAsk(ask: PageAsk): Promise<PageAskAnswer | undefined> {
  open.get(ask.monoId)?.settle(undefined);
  return new Promise((resolve) => open.set(ask.monoId, { ask, settle: resolve }));
}

/** The card is done with it (its turn ended without a page): a later page_build is an ordinary chat build. */
export function closePageAsk(id: string): void {
  for (const [monoId, entry] of open)
    if (entry.ask.id === id) {
      open.delete(monoId);
      entry.settle(undefined);
    }
}

/** The first mate's open ask, if one is still open. */
export function pageAskFor(monoId: string, now = Date.now()): PageAsk | undefined {
  const entry = open.get(monoId);
  if (!entry) return undefined;
  if (now - entry.ask.at > ASK_OPEN_MS) {
    open.delete(monoId);
    entry.settle(undefined);
    return undefined;
  }
  return entry.ask;
}

/** The first mate's page_build answers its open ask. A change also waits on its kept page. */
export function answerPageAsk(monoId: string, answer: PageAskAnswer, now = Date.now()): PageAsk | undefined {
  const ask = pageAskFor(monoId, now);
  const entry = open.get(monoId);
  if (!ask || !entry) return undefined;
  open.delete(monoId);
  if (ask.change) {
    versions.set(ask.change.pageId, { spec: answer.spec, request: answer.request, by: answer.by, monoId, at: now });
    changed();
  }
  entry.settle(answer);
  return ask;
}

export function chatPageVersion(pageId: string): ChatPageVersion | undefined {
  return versions.get(pageId);
}
export function useChatPageVersion(pageId: string): ChatPageVersion | undefined {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
  return versions.get(pageId);
}
/** Used or thrown away. */
export function dropChatPageVersion(pageId: string): void {
  if (versions.delete(pageId)) changed();
}

export function resetPageAsksForTest(): void {
  for (const entry of open.values()) entry.settle(undefined);
  open.clear();
  versions.clear();
  changed();
}
