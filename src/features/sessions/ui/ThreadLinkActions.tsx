// WP-125: copy a local link, and say when one cannot be opened here.

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import {
  acceptThreadLink,
  beginThreadOpen,
  dismissThreadLink,
  reportThreadLink,
  subscribeThreadLinkNotice,
  threadLinkNotice,
  type ThreadLinkHands,
} from "../model/threadLinkOpen";
import { THREAD_LINK_MESSAGE } from "../model/threadLinks";

const COPIED_MS = 1_500;

export function CopyThreadLinkButton({
  kind,
  label,
  url,
  prepare,
}: {
  kind: "chat" | "prompt";
  label: string;
  url?: string | null;
  prepare?: () => Promise<{ url: string } | { error: string }>;
}) {
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState(url ?? "");
  const click = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setLink(url ?? "");
  }, [url]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    const mine = ++click.current;
    const run = async () => {
      try {
        const built = prepare
          ? await prepare()
          : url
            ? { url }
            : { error: THREAD_LINK_MESSAGE.copyFailed };
        if (mine !== click.current) return;
        if (!("url" in built) || !built.url) {
          setCopied(false);
          reportThreadLink("error" in built ? built.error : THREAD_LINK_MESSAGE.copyFailed);
          return;
        }
        await copyText(built.url);
        if (mine !== click.current) return;
        setLink(built.url);
        setCopied(true);
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (mine === click.current) setCopied(false);
        }, COPIED_MS);
      } catch {
        if (mine !== click.current) return;
        setCopied(false);
        reportThreadLink(THREAD_LINK_MESSAGE.copyFailed);
      }
    };
    void run();
  };

  return (
    <button
      type="button"
      data-thread-link={kind}
      data-link={link}
      data-no-drag=""
      disabled={!url && !prepare}
      aria-label={copied ? "Copied" : label}
      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-content/70 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ThreadLinkNotice() {
  const current = useSyncExternalStore(
    subscribeThreadLinkNotice,
    threadLinkNotice,
    threadLinkNotice,
  );
  if (!current) return null;
  return (
    <div
      role="status"
      data-thread-link-notice=""
      className="fixed top-14 left-1/2 z-50 w-[min(24rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-lg border border-stroke bg-surface px-3 py-2 text-sm text-content shadow-lg"
    >
      <p>{current.message}</p>
      <button
        type="button"
        className="mt-2 text-xs text-content/70 hover:text-content"
        onClick={dismissThreadLink}
      >
        Close
      </button>
    </div>
  );
}

/** One listener for copied links and for hivra: anchors. Only the workspace should mount this. */
export function useThreadLinkOpener(hands: ThreadLinkHands): void {
  const ref = useRef(hands);
  ref.current = hands;
  useEffect(() => {
    const onUrl = (url: string) => {
      void acceptThreadLink(url, ref.current);
    };
    const onEvent = (event: Event) => {
      const url = (event as CustomEvent<unknown>).detail;
      if (typeof url === "string") onUrl(url);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.toLowerCase().startsWith("hivra:")) return;
      event.preventDefault();
      onUrl(href);
    };
    window.addEventListener("hivra:open-thread-link", onEvent);
    document.addEventListener("click", onClick);
    return () => {
      beginThreadOpen();
      window.removeEventListener("hivra:open-thread-link", onEvent);
      document.removeEventListener("click", onClick);
    };
  }, []);
}
