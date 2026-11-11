import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowUp, DashboardSquare, MoreHorizontal, Pin, Undo2 } from "../../../shared/ui/icons";
import { useHubSelection } from "../../hub/model/hubNav";
import { leadFor } from "../../hub/model/hubLeads";
import { listMonos, monoWorksOn } from "../../monos/model/mono";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { recordPageSource, undoBotChange } from "../../hub/model/botChanges";
import { allPages, noteShownPage, shownPageId, pagesListRequests, clearPagesProblem, pagesProblem, pendingOpenPage, setPinned, takeOpenRequest, allowPage, approvedPermissions, needsAllow, keepPage, pageBlocks, pageFromSpec, usePagesVersion, newAsks, useNewVersion, dropNewVersion, type Page, type PageBlock } from "../model/pages";
import { buildPage, rebuildPage, type BuildPageResult } from "../model/buildPage";
import type { PageSpec } from "../model/pageSpec";
import { READY_BY, READY_PAGES, readyWhat, withReadySpec, type ReadyPage } from "../model/readyPages";
import { checkBespokePage } from "../model/designCheck";
import { describeCapability, type BespokeSpec, type Capability } from "../model/pageSpec";
import { PageBridgeHost } from "../model/pageBridgeHost";
import { pageCapabilityHandlers } from "../model/pageCapabilities";
import { connectSource, disconnectSource, hostLabel, usePageGrants } from "../model/pageGrants";
import { clearSourceToken, hasSourceToken, pageHttpHandlers, setSourceToken } from "../model/pageHttp";
import { pageSessionsHandlers } from "../model/pageSessions";
import { pageWriteHandlers } from "../model/pageWrites";
import { pageActionLog, pageActionRunning, usePageActionsVersion } from "../model/pageActions";
import { appPageSources } from "../model/pageSources";
import { SANDBOX, bespokeSrcdoc, newFrameNonce, readTokens, specKey } from "../model/sandbox";
import { frameKey, pageFrameUrl } from "../model/pageFrame";
import { SessionStateContext } from "../../sessions/model/sessionStateStore";
import { useNow } from "../../hub/model/liveJobs";
import { loadActiveSchemeId } from "../../settings/model/themeSchemes";
import { HubChangeContent } from "../../hubChange/ui/HubChangeView";
import { setChatPreviewShown, settleChatPreview, useChatPagePreview } from "../../selfBuild/model/pagesChat";
import { OPEN_EDIT_TODAY, todayPreviewWaiting } from "../../selfBuild/model/todayChat";
import { FLOW_LABEL, type ChangeFlow } from "../../hubChange/model/hubChange";
import { CalendarBlock, monthOf } from "./CalendarBlock";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { agentsPageUsesBoard, isAgentsPage } from "../../agents-board/model/place";
import { AgentsBoardScreen } from "../../agents-board/ui/AgentsBoardScreen";

/*
 * Pages: one list of every page (by project), each with a pin. New page is a prompt to a seated Mono; it shows a
 * preview, Apply or Discard. The bundled blocks are helpers the Mono builds with, not something Ash picks.
 * Every colour here is a theme token (content, surface, stroke, theme-accent, status-*), so a scheme restyles it.
 */
const card = "rounded-xl bg-surface ring-1 ring-surface-ring";
const btn = "rounded-md px-3 py-1.5 text-[12px] transition-colors";
const quietBtn = `${btn} text-content/70 hover:bg-surface-raised hover:text-content`;
const primaryBtn = `${btn} bg-content/12 text-content hover:bg-content/18`;
const STATE_DOT = { ok: "bg-status-ok", warn: "bg-status-warn", bad: "bg-status-bad" } as const;
export const NOT_TIED = "Not tied to a project";
/** The project's lead if one is seated, else the first seated Mono. */
export function defaultBuilder(projectId: string, seated: { id: string }[]): string {
  const folder = hubData().listProjects().find((p) => p.id === projectId)?.folder;
  const lead = folder ? listMonos().find((m) => leadFor(m.id) && monoWorksOn(m, folder)) : undefined;
  if (lead && seated.some((m) => m.id === lead.id)) return lead.id;
  return seated[0]?.id ?? "";
}
export const PAGES_CANT = "This can't change the app's core screens, the sidebar, settings, keys or Monos.";
function Limits() {
  return <p className="text-[12px] text-content/60" data-pages-cant>{PAGES_CANT}</p>;
}

function Dot({ state }: { state: keyof typeof STATE_DOT }) {
  return <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />;
}
/** A block the Mono filled with made-up data says so (the contract: made-up data is labelled "Example:"). */
export function isExampleBlock(block: PageBlock): boolean {
  return JSON.stringify(block).includes("Example:");
}
function BlockFrame({ title, children, wide, example }: { title: string; children: ReactNode; wide?: boolean; example?: boolean }) {
  return (
    <section className={`${card} p-4 ${wide ? "col-span-2" : ""}`} data-page-block>
      <div className="mb-2.5 flex items-center gap-2 text-[12px] font-medium text-content/60" data-block-title>
        <span className="flex-1">{title}</span>
        {example ? <span className="font-normal" data-example-data>Example data</span> : null}
      </div>
      {children}
    </section>
  );
}

/** An honest empty block: no real data for it yet. */
function NothingYet() {
  return <div className="py-2 text-[13px] text-content/60" data-block-empty>Nothing here yet</div>;
}

export function Block({ block }: { block: PageBlock }) {
  const example = isExampleBlock(block);
  switch (block.kind) {
    case "status":
      return (
        <BlockFrame title={block.title} example={example}>
          <div className="flex items-center gap-3">
            <Dot state={block.state} />
            <div className="min-w-0">
              <div className="text-[14px] text-content">{block.line}</div>
              <div className="text-[12px] text-content/60">{block.detail}</div>
            </div>
          </div>
        </BlockFrame>
      );
    case "list":
      return (
        <BlockFrame title={block.title} example={example}>
          {!block.rows.length ? <NothingYet /> : null}
          {block.rows.map((r) => (
            <div key={r.text} className="flex items-center gap-2 border-t border-stroke py-2 text-[13px] first:border-0">
              <span className="min-w-0 flex-1 truncate text-content/90">{r.text}</span>
              <span className="flex items-center gap-1.5 text-[12px] text-content/60"><Dot state={r.state} />{r.label}</span>
            </div>
          ))}
        </BlockFrame>
      );
    case "chart": {
      const max = Math.max(...block.bars.map((b) => b.value), 1);
      if (!block.bars.length) return <BlockFrame title={block.title}><NothingYet /></BlockFrame>;
      return (
        <BlockFrame title={block.title} example={example}>
          <div className="flex h-28 items-end gap-3" role="img" aria-label={`${block.title}: ${block.bars.map((b) => `${b.label} ${b.value}`).join(", ")}`}>
            {block.bars.map((b) => (
              <div key={b.label} className="flex flex-1 flex-col items-center gap-1.5">
                <div className="w-full rounded-t-md bg-theme-accent/35" style={{ height: `${(b.value / max) * 88}px` }} />
                <span className="text-[11px] text-content/60">{b.label}</span>
              </div>
            ))}
          </div>
        </BlockFrame>
      );
    }
    case "barlist": {
      // Restyled from Tremor's BarList (tremorlabs/tremor, Apache-2.0): bars sized by value, label on the bar,
      // value at the end. Theme tokens only: the accent tints the bars, content draws the text.
      const max = Math.max(...block.rows.map((r) => r.value), 1);
      if (!block.rows.length) return <BlockFrame title={block.title}><NothingYet /></BlockFrame>;
      return (
        <BlockFrame title={block.title} example={example}>
          <div className="flex flex-col gap-1.5" data-block-barlist>
            {block.rows.map((r) => (
              <div key={r.label} className="flex items-center gap-3 text-[13px]">
                <div className="relative h-7 min-w-0 flex-1">
                  <div className="absolute inset-y-0 left-0 rounded-md bg-theme-accent/20" style={{ width: `${Math.max(4, (r.value / max) * 100)}%` }} />
                  <span className="relative flex h-full items-center truncate px-2 text-content/90">{r.label}</span>
                </div>
                <span className="w-10 shrink-0 text-right tabular-nums text-content/75">{r.value}</span>
              </div>
            ))}
          </div>
        </BlockFrame>
      );
    }
    case "note":
      return (
        <BlockFrame title={block.title} example={example}>
          <p className="text-[13px] leading-6 text-content/85">{block.text}</p>
        </BlockFrame>
      );
    case "calendar": {
      const month = monthOf(block.month);
      if (month)
        return (
          <BlockFrame title={`${block.title} · ${block.month}`} example={example}>
            <CalendarBlock month={month} marked={block.marked} />
            <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-content/60">
              {block.marked.map((m) => <span key={m.day}>{m.day}: {m.text}</span>)}
            </div>
          </BlockFrame>
        );
      // A month the picker can't read ("Sprint 4"): the plain grid from the block's own first weekday and length.
      const cells = [...Array(block.firstWeekday).fill(null), ...Array.from({ length: block.days }, (_, i) => i + 1)];
      return (
        <BlockFrame title={`${block.title} · ${block.month}`} example={example}>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px]">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <span key={i} className="pb-1 text-content/60">{d}</span>)}
            {cells.map((d, i) => {
              const mark = block.marked.find((m) => m.day === d);
              return (
                <span key={i} title={mark?.text} className={`grid h-6 place-items-center rounded-md ${d === null ? "" : mark ? "bg-theme-accent/20 text-content ring-1 ring-theme-accent/40" : "text-content/75"}`}>
                  {d ?? ""}
                </span>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-content/60">
            {block.marked.map((m) => <span key={m.day}>{m.day}: {m.text}</span>)}
          </div>
        </BlockFrame>
      );
    }
  }
}

export function PageBody({ page, live }: { page: Page; live?: boolean }) {
  // WP-219: the ready-made Agents page is the one board, not its own tree.
  if (agentsPageUsesBoard(IS_HUB_BUNDLE) && isAgentsPage(page)) return <AgentsBoardScreen />;
  if (page.spec.kind === "bespoke") return <BespokeFrame key={`${page.id}:${specKey(page.spec)}`} pageId={page.id} spec={page.spec} live={live} title={page.title} />;
  return (
    <div className="grid grid-cols-2 gap-3">
      {pageBlocks(page).map((b, i) => <Block key={`${b.kind}-${i}`} block={b} />)}
    </div>
  );
}

/** Ash's tap inside the frame is fresh: the browser's own user activation (a click in a frame activates the window that
 * holds it), or, without that API, the frame holding the focus. */
export function tappedInside(frame: HTMLIFrameElement | null): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (activation?.isActive) return true;
  // r61: WebKit does not always pass a tap inside the sandboxed frame on to the app's own activation, so a page's Send
  // was refused on the Mac. The frame holding the focus in the app's focused window means Ash's tap or typing is in it.
  return !!frame && document.activeElement === frame && document.hasFocus();
}

/**
 * A bespoke page in its sandbox: sandbox="allow-scripts" only, a strict CSP, the theme tokens injected. Its only way
 * out is postMessage to its bridge (pageBridgeHost.ts): reads and live watches of what it asked for (a preview reads the
 * live data it asked for, nothing else), and its taps only on a kept page and only on Ash's tap. A frame that navigates
 * away from its own page is cut off and reloaded (the app's frame-src already refuses the trip).
 */
export function BespokeFrame({ pageId, spec, live, title }: { pageId: string; spec: BespokeSpec; live?: boolean; title?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const scheme = loadActiveSchemeId();
  const sessions = useContext(SessionStateContext);
  // The nonce is built into this frame's document: only that document can say hello with it (pageBridgeHost.ts).
  const [nonce] = useState(newFrameNonce);
  const [doc] = useState(() => bespokeSrcdoc(spec, readTokens(), document.documentElement.classList.contains("theme-light") ? "light" : "dark", nonce));
  const [height, setHeight] = useState(460);
  const [generation, setGeneration] = useState(0);
  // In the app the document is served from the app's frame scheme with the page's own policy (a srcdoc frame would
  // inherit the app's script-src 'self' and its scripts would never run: C3 live 22 Oct). "srcdoc" outside the app.
  const [src, setSrc] = useState<string | "srcdoc" | undefined>(undefined);
  useEffect(() => {
    let gone = false;
    setSrc(undefined);
    void pageFrameUrl(frameKey(pageId, specKey(spec), generation, scheme), doc).then((url) => {
      if (!gone) setSrc(url ?? "srcdoc");
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the document is fixed for a frame
  }, [pageId, doc, generation, scheme]);
  // The bridge lives as long as the frame: a re-render (the record read again) must not drop the page's watches.
  const named = useRef(title ?? spec.title);
  named.current = title ?? spec.title;
  // A layout effect, so the bridge listens in the same task that puts the frame in the page. A passive effect runs after
  // paint, and a fast document (WebKit, a rebuilt frame) could hello and make its first call before anyone listened: the
  // ping below brings the hello back, but that call was gone and the page waited on it for good.
  useLayoutEffect(() => {
    const frame = ref.current;
    const host = new PageBridgeHost({
      pageId, title: named.current, live: !!live, asks: spec.permissions,
      approved: () => (live ? approvedPermissions(pageId) : []),
      tapped: () => tappedInside(ref.current),
      post: (message) => {
        const win = ref.current?.contentWindow;
        if (!win) return false;
        win.postMessage(message, "*");
      },
      sources: appPageSources(sessions),
      // Built per frame: each handler is the page's own (its key, its grants, its title on a Bot changes row).
      handlers: {
        ...pageCapabilityHandlers(),
        ...pageSessionsHandlers(sessions, () => hubData().listProjects()),
        ...pageHttpHandlers(pageId),
        ...pageWriteHandlers(named.current),
      },
      onSize: setHeight,
      nonce,
      onLost: () => setGeneration((g) => g + 1),
    });
    // A frame keeps one contentWindow across navigations, so a window can't tell a page that navigated away from WebKit's
    // duplicate load of the same srcdoc. Every load asks the document for its nonce again (host.loaded()); one that
    // can't answer left its page: a fresh frame, a fresh bridge.
    const onLoad = () => host.loaded();
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow || e.origin !== "null") return;
      host.receive(e.data);
    };
    frame?.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    // In case the document spoke before this ran after all (a frame React kept while the bridge was rebuilt), ask it to
    // hello once now; no timer, so a frame still loading isn't counted as lost, and its own load asks again.
    ref.current?.contentWindow?.postMessage({ type: "hub:ping" }, "*");
    return () => {
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
      host.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one bridge per frame: the spec is fixed for a frame (a new spec is a new frame)
  }, [pageId, live, sessions, generation, src]);
  if (!src) return <div style={{ height }} className="w-full rounded-xl" data-bespoke-page-loading />;
  return src === "srcdoc" ? (
    <iframe ref={ref} key={`${scheme}:${generation}`} title={spec.title} sandbox={SANDBOX} srcDoc={doc} data-bespoke-page
      style={{ height }} className="w-full rounded-xl border-0 bg-transparent" />
  ) : (
    <iframe ref={ref} key={`${scheme}:${generation}:src`} title={spec.title} sandbox={SANDBOX} src={src} data-bespoke-page data-bespoke-page-src
      style={{ height }} className="w-full rounded-xl border-0 bg-transparent" />
  );
}

/**
 * r61 (PM's blind C3): the newest tap on this page, at the top where Ash is looking: "Sending…" while it runs, then
 * "Sent Chief of Staff" or, in red, why it didn't go through. Shown by the app, so a page that ignores its reply still
 * tells Ash what happened. Gone after a minute; the full list stays under the page.
 */
function PageTapStatus({ pageId }: { pageId: string }) {
  usePageActionsVersion();
  const now = useNow(15_000);
  const running = pageActionRunning(pageId);
  const last = pageActionLog(pageId)[0];
  const fresh = last && now - last.at < 60_000;
  if (!running && !fresh) return null;
  const failed = !running && last?.ok === false;
  return (
    <div role="status" aria-live="polite" data-page-tap-status={running ? "sending" : failed ? "failed" : "done"}
      className={`${card} mb-3 px-3 py-2 text-[12px] ${failed ? "text-red-400" : "text-content/80"}`}>
      {running ? "Sending…" : last!.line}
    </div>
  );
}

/** What this page did on Ash's taps (answered, sent, stopped), newest first: who did it is the page. */
function PageActivity({ pageId, title }: { pageId: string; title: string }) {
  usePageActionsVersion();
  const now = useNow(30_000);
  const log = pageActionLog(pageId).slice(0, 3);
  if (!log.length) return null;
  return (
    <div className="mt-3 flex flex-col gap-0.5 px-1 text-[12px] text-content/60" data-page-activity>
      {log.map((e) => (
        <div key={`${e.at}-${e.line}`} className={`truncate ${e.ok === false ? "text-red-400/80" : ""}`}>{e.line} · from the {/\bpage$/i.test(title) ? title : `${title} page`} · {agoLabel(e.at, now)}</div>
      ))}
    </div>
  );
}
function agoLabel(at: number, now: number): string {
  const m = Math.floor((now - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

/** The asks a bespoke page makes, in plain words. A page can never read a key, so there is no key card to draw. */
function Permissions({ asks }: { asks: Capability[] }) {
  if (!asks.length) return null;
  return (
    <div className="flex flex-col gap-2" data-page-permissions>
      <div className={`${card} px-4 py-3`}>
        <div className="mb-1 text-[12px] text-content/70">This page asks to:</div>
        <ul className="flex flex-col gap-0.5 text-[13px] text-content/90">
          {asks.map((a) => <li key={a}>· {describeCapability(a)}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** "Allowed: N things" under a kept page's title; the full list opens behind it. */
export function allowedLabel(n: number): string {
  return `Allowed: ${n} ${n === 1 ? "thing" : "things"}`;
}
function AllowedLine({ asks }: { asks: Capability[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span data-pages-allowed>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded px-1 text-content/70 underline decoration-content/30 underline-offset-2 hover:bg-surface-raised hover:text-content">
        {allowedLabel(asks.length)}
      </button>
      {open ? (
        <ul className={`${card} mt-1.5 flex flex-col gap-0.5 px-3 py-2 text-[12px] text-content/90`} data-pages-allowed-list>
          {asks.map((a) => <li key={a}>· {describeCapability(a)}</li>)}
        </ul>
      ) : null}
    </span>
  );
}

/**
 * What a kept page may read that isn't the hub's own data: the web sources Ash connected it to. A page has no internet of
 * its own (`connect-src 'none'`), so every request goes through the app, which checks the address against this list and
 * adds the source's token from the Keychain (the page never sees the token). Connecting and disconnecting are Bot changes
 * rows too, so Undo is a second way to take one back; a token isn't kept for a source that is disconnected.
 */
function PageConnections({ page }: { page: Page }) {
  const grants = usePageGrants(page.id);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const originOf = (raw: string) => {
    try {
      return new URL(raw).origin;
    } catch {
      return "";
    }
  };
  useEffect(() => {
    let gone = false;
    const next: Record<string, boolean> = {};
    void Promise.all(
      grants.map(async (g) => {
        const origin = originOf(g.url);
        if (!origin) return;
        try {
          if (await hasSourceToken(page.id, origin)) next[origin] = true;
        } catch {
          /* the app couldn't check the Keychain: the row simply doesn't say a token is saved */
        }
      }),
    ).then(() => {
      if (!gone) setSaved(next);
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grants decide what to ask about
  }, [page.id, grants]);

  const connect = () => {
    setError(undefined);
    const out = connectSource(page.id, url, label);
    if (!out.ok) return setError(out.error);
    const done = () => {
      recordPageSource({ by: page.title, pageId: page.id, url: out.grant.url, connected: true });
      setUrl("");
      setLabel("");
      setToken("");
    };
    if (!token.trim()) return done();
    void setSourceToken(page.id, originOf(out.grant.url), token)
      .then(done)
      .catch(() => {
        // A source whose token didn't save would refuse the page's requests anyway: don't leave a grant that can't work.
        disconnectSource(page.id, out.grant.url);
        setError("The Keychain didn't save the token, so the source wasn't connected.");
      });
  };
  const disconnect = (g: { url: string }) => {
    if (!disconnectSource(page.id, g.url)) return;
    const origin = originOf(g.url);
    if (origin) void clearSourceToken(page.id, origin).catch(() => undefined);
    recordPageSource({ by: page.title, pageId: page.id, url: g.url, connected: false });
  };

  return (
    <section className={`${card} mt-3 px-4 py-3`} data-page-connections>
      <div className="flex items-center gap-2 text-[12px] text-content/70">
        <span className="flex-1">Web sources</span>
        <span data-page-sources-count>{grants.length ? `${grants.length} connected` : "None connected"}</span>
      </div>
      <p className="mt-1 text-[12px] leading-5 text-content/60">
        A page has no internet of its own. It reads the hub things you allowed above, and only the web sources you connect
        here, through the app. If a source needs a token, the app keeps it and the page never sees it.
      </p>
      {grants.length ? (
        <div className="mt-2 flex flex-col" data-page-sources>
          {grants.map((g) => (
            <div key={g.url} className="flex items-center gap-2 border-t border-stroke py-1.5 text-[13px] first:border-0" data-page-source={g.url}>
              <span className="min-w-0 flex-1 truncate text-content/90">
                {g.label}
                {saved[originOf(g.url)] ? <span className="ml-1.5 text-[11px] text-content/60">token saved</span> : null}
              </span>
              <span className="shrink-0 text-[12px] text-content/60">{hostLabel(g.url)}</span>
              <button type="button" className={quietBtn} data-page-source-disconnect={g.url} onClick={() => disconnect(g)}>Disconnect</button>
            </div>
          ))}
        </div>
      ) : null}
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); connect(); }}>
        <input aria-label="Source address" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1/"
          className="min-w-[200px] flex-1 rounded-md bg-surface-raised px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/50" data-page-source-url />
        <input aria-label="What to call the source" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it (optional)"
          className="w-[150px] rounded-md bg-surface-raised px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/50" data-page-source-label />
        <input aria-label="Token for the source" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token (optional)"
          className="w-[150px] rounded-md bg-surface-raised px-2 py-1.5 text-[12px] text-content outline-none placeholder:text-content/50" data-page-source-token />
        <button type="submit" className={`${primaryBtn} disabled:opacity-40`} disabled={!url.trim()} data-page-source-connect>Connect</button>
      </form>
      {error ? <div className="mt-2 text-[12px] leading-5 text-content/80" role="alert" data-page-source-error>{error}</div> : null}
    </section>
  );
}

/** An imported page asks again: the same list and Allow. Until then it can do nothing. */
function AllowAgain({ page, asks }: { page: Page; asks: Capability[] }) {
  return (
    <div className="mb-4 flex flex-col gap-2" data-pages-allow-again>
      <div className="text-[12px] text-content/70" data-pages-allow-note>{page.by === READY_BY ? "This page comes with the app." : "This page came from a setup file."} It can't do anything until you allow what it asks for. The page below is greyed out until then.</div>
      <Permissions asks={asks} />
      <div className="flex justify-end">
        <button type="button" data-pages-allow className={`${primaryBtn} disabled:opacity-40`} onClick={() => allowPage(page.id)}>Allow</button>
      </div>
    </div>
  );
}

function AskBox({ onAsk, monos, monoId, onPick, placeholder, label = "Describe the page" }: { onAsk: (text: string) => void; monos: { id: string; name: string }[]; monoId: string; onPick: (id: string) => void; placeholder: string; label?: string }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) { onAsk(text.trim()); setText(""); } };
  return (
    <form className={`${card} flex items-center gap-2 px-3 py-2`} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <input
        aria-label={label}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-content outline-none placeholder:text-content/60"
      />
      <select aria-label="Mono that builds it" data-pages-mono-picker value={monoId} onChange={(e) => onPick(e.target.value)}
        className="max-w-[160px] shrink-0 truncate rounded-md bg-surface-raised px-2 py-1 text-[12px] text-content outline-none">
        {monos.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <button type="submit" aria-label="Send to a Mono" disabled={!text.trim()} className="grid size-7 place-items-center rounded-full bg-content/12 text-content hover:bg-content/18 disabled:opacity-40">
        <ArrowUp className="size-3.5" strokeWidth={2} />
      </button>
    </form>
  );
}

/** A build in flight or back; `ready` marks a ready-made page (its preview, with nothing built). */
/** `chat`: a page a Mono built from its own chat (selfBuild/model/pagesChat.ts), previewed here like any other. */
type Build = { prompt: string; ready?: boolean; chat?: Page } & ({ state: "building" } | BuildPageResult);

/** Ash OS refused or couldn't take the last page tap: one quiet line with OK. */
function PagesProblem() {
  usePagesVersion();
  const problem = pagesProblem();
  if (!problem) return null;
  return (
    <div className={`${card} mb-3 flex items-center gap-2 px-3 py-2 text-[12px] text-content/80`} role="alert" data-pages-problem>
      <span className="min-w-0 flex-1">{problem}</span>
      <button type="button" className={quietBtn} onClick={clearPagesProblem}>OK</button>
    </div>
  );
}

/** The preview Page for a ready build: one object per build (its id is the record's pageId when Ash OS built it). */
function usePreview(ready: ({ prompt: string; ready?: boolean } & Extract<BuildPageResult, { status: "ready" }>) | undefined, by: string, monoId: string, projectId: string): Page | undefined {
  return useMemo(
    () => (ready ? (ready.ready
      ? pageFromSpec(ready.spec, ready.prompt, READY_BY, "today", ready.warnings, Date.now())
      : pageFromSpec(ready.spec, ready.prompt, by, projectId, ready.warnings, Date.now(), ready.pageId, monoId)) : undefined),
    [ready, by, monoId, projectId],
  );
}

/** Ready-made pages not kept yet: a row each, with Add (its preview, then Keep and allow like any page). */
function ReadyMade({ offers, onAdd, compact }: { offers: readonly ReadyPage[]; onAdd: (r: ReadyPage) => void; compact?: boolean }) {
  if (!offers.length) return null;
  return (
    <section data-pages-ready className={compact ? "w-full max-w-[560px] text-left" : ""}>
      <h2 className="px-2 pb-1 text-xs text-content/60">Ready-made</h2>
      <div className="flex flex-col gap-px">
        {offers.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-selection-hover" data-pages-ready-row={r.id}>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] text-content">{r.title}</span>
              <span className="text-[12px] leading-5 text-content/60">{r.what}</span>
            </div>
            <button type="button" className={quietBtn} data-pages-ready-add={r.id} onClick={() => onAdd(r)}>Add</button>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PagesContent() {
  usePagesVersion();
  useHubDataVersion();
  const selected = useHubSelection().project;
  const projects = hubData().listProjects();
  const nameOf = (id: string) => (id === "today" ? NOT_TIED : projects.find((p) => p.id === id)?.name ?? id);
  const [filter, setFilter] = useState<string>("all");
  const [build, setBuild] = useState<Build>();
  const [open, setOpen] = useState<string>();
  const [newPage, setNewPage] = useState(false);
  const [kept, setKept] = useState<string>();
  const [sentBack, setSentBack] = useState<string>();
  const [rebuilding, setRebuilding] = useState<string>();
  // The sidebar's pinned pages open here.
  const requested = pendingOpenPage();
  useEffect(() => {
    if (requested) { setOpen(takeOpenRequest()); setBuild(undefined); setNewPage(false); }
  }, [requested]);
  // Dropwave: the sidebar's Pages row asks for the list itself.
  const listAsked = pagesListRequests();
  const listSeen = useRef(listAsked);
  useEffect(() => {
    if (listSeen.current === listAsked) return;
    listSeen.current = listAsked;
    setOpen(undefined); setBuild(undefined); setNewPage(false);
  }, [listAsked]);
  // Dropwave: the sidebar marks a pinned page as open while it is the one shown here.
  useEffect(() => {
    noteShownPage(open);
    return () => noteShownPage(undefined);
  }, [open]);
  const pages = allPages();
  const shown = pages.find((p) => p.id === open);
  // A new page belongs to the filtered project, else the one selected in the hub.
  const projectId = filter !== "all" ? filter : selected;

  // Who builds it: any seated Mono (never a temporary worker), the project's lead first.
  const seated = listMonos().map((m) => ({ id: m.id, name: m.name ?? m.id }));
  const [picked, setPicked] = useState<string>();
  const askerId = picked && seated.some((m) => m.id === picked) ? picked : defaultBuilder(projectId, seated);
  const asker = seated.find((m) => m.id === askerId)?.name ?? "A Mono";

  const ask = (prompt: string) => {
    setBuild({ prompt, state: "building" });
    setSentBack(undefined);
    void buildPage({ projectId, monoId: askerId, prompt }).then((result) => setBuild({ prompt, ...result }));
  };
  const ready = build && "status" in build && build.status === "ready" ? build : undefined;
  const offers = READY_PAGES.filter((r) => !pages.some((p) => p.request === r.request));
  const addReady = (r: ReadyPage) => {
    setSentBack(undefined);
    setBuild({ prompt: r.request, ready: true, status: "ready", spec: r.spec, warnings: checkBespokePage(r.spec).warnings });
  };
  const built = usePreview(ready, asker, askerId, projectId);
  const preview = ready?.chat ?? built;
  // A page a Mono built from its chat shows here; once it is kept (by Ash or on his okay) or thrown away, it goes.
  const chat = useChatPagePreview();
  useEffect(() => {
    if (chat) { setBuild({ prompt: chat.page.request, status: "ready", spec: chat.page.spec, warnings: chat.page.warnings ?? [], chat: chat.page }); setOpen(undefined); setNewPage(false); }
    else setBuild((b) => (b?.chat ? undefined : b));
  }, [chat?.previewId]);
  // On this screen, the chat-built preview is in front of Ash: the bar at the bottom doesn't offer See it again.
  const showingChat = preview && ready?.chat ? ready.chat.id : undefined;
  useEffect(() => {
    setChatPreviewShown(showingChat);
    return () => setChatPreviewShown(undefined);
  }, [showingChat]);
  const asks = preview?.spec.kind === "bespoke" ? preview.spec.permissions : [];

  if (build && !preview) {
    return (
      <div className="w-full px-6 py-10 xl:px-8" data-pages-build-state={"status" in build ? build.status : "building"}>
        <div className="mb-1 text-[12px] text-content/60">“{build.prompt}” · asked {asker}</div>
        {"status" in build ? (
          build.status === "building" ? (
            <div className={`${card} flex items-center gap-3 p-5 text-[13px] text-content/80`} role="status" data-pages-still-building>
              <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
              <span className="min-w-0 flex-1 leading-5">{build.reason}</span>
            </div>
          ) : build.status === "not-connected" ? (
            <div className={`${card} p-5`} data-pages-not-connected>
              <div className="text-[14px] text-content">Not connected yet</div>
              <p className="mt-1 text-[13px] leading-5 text-content/70">{build.reason} When it's back, {asker} builds the page here and you see a preview first.</p>
            </div>
          ) : (
            <div className="rounded-lg px-3 py-2.5" data-pages-turned-down>
              <div className="text-[13px] text-content">{build.status === "turned-down" ? "Sent back to " + asker : "That didn't work"}</div>
              <div className="text-[13px] leading-5 text-content/60">{build.status === "turned-down" ? "Turned down automatically: " : ""}{"reason" in build ? build.reason : ""}</div>
            </div>
          )
        ) : (
          <div className={`${card} flex items-center gap-3 p-5 text-[13px] text-content/80`} role="status">
            <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
            {asker} is building your page…
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button type="button" className={quietBtn} onClick={() => { setBuild(undefined); setNewPage(false); }}>Back to Pages</button>
          {"status" in build && build.status !== "turned-down" ? <button type="button" className={primaryBtn} data-pages-try-again onClick={() => ask(build.prompt)}>Try again</button> : null}
        </div>
      </div>
    );
  }

  if (preview) {
    // The same words as a hub change (ChangeBar): Discard and Apply, and Undo in Bot changes after.
    const keepLabel = asks.length ? "Apply and allow" : "Apply";
    return (
      <div className="w-full px-6 py-6 xl:px-8" data-pages-preview>
        <div className="mb-1 text-[12px] text-content/60">{ready?.ready ? "Ready-made page · built on the same bridge a Mono's page uses, so you can ask for your own" : <>“{preview.request}” · {preview.by} built this preview</>}</div>
        <h1 className="text-[17px] font-medium text-content">{preview.title}</h1>
        <div className="mb-4 mt-1"><Limits /></div>
        {asks.length ? <div className="mb-3"><Permissions asks={asks} /></div> : null}
        {preview.warnings?.length ? (
          <div className={`${card} mb-3 flex flex-col gap-2 px-4 py-3`} data-pages-warnings>
            {preview.warnings.map((w) => (
              <div key={w.rule} className="flex items-start gap-3 text-[13px]">
                <span className="min-w-0 flex-1 leading-5 text-content/85">{w.plain}</span>
                <button type="button" className={quietBtn} onClick={() => { setSentBack(w.plain); ask(`${preview.request}\n\nFix this in the page: ${w.plain}`); }}>Fix it</button>
              </div>
            ))}
            {sentBack ? <div className="text-[12px] text-content/70" role="status">Sent back to {asker}: “{sentBack}”</div> : null}
          </div>
        ) : null}
        <div className="relative rounded-xl border border-dashed border-content/30 p-4" data-pages-preview-frame>
          <div className="relative"><PageBody page={preview} /></div>
        </div>
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-content/20 bg-background-base/90 px-5 py-3 backdrop-blur">
          <span className="text-[12px] text-content/70" data-pages-preview-note>This is a preview. Nothing is saved until you apply it. Undo later in Bot changes.</span>
          <span className="ml-auto" />
          <button type="button" className={quietBtn} data-pages-discard onClick={() => { if (ready?.chat) settleChatPreview(ready.chat.id); setBuild(undefined); }}>Discard</button>
          <button type="button" data-pages-keep className={`${primaryBtn} disabled:opacity-40`} onClick={() => {
            const pin = !!ready?.pin;
            void keepPage(preview).then((ok) => { if (ok && pin) setPinned(preview.id, true, preview.by); });
            if (ready?.chat) settleChatPreview(ready.chat.id);
            setKept(preview.title); setOpen(preview.id); setBuild(undefined);
          }}>{keepLabel}</button>
        </div>
      </div>
    );
  }

  if (shown) {
    const gated = needsAllow(shown) && shown.spec.kind === "bespoke";
    // r63 (Critiquito, C8): a ready-made page's request is its own title ("Ready-made: Agents"), so the line read "by
    // Ready-made · “Ready-made: Agents”". Its one-line what says what it is; the request only shows for a page Ash asked for.
    const request = readyWhat(shown.request) ? null : shown.request;
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="w-full px-6 py-6 xl:px-8" data-pages-open>
          <PagesProblem />
          {/* Dropwave (Ash, 11 Nov): a page just shows up. What you can do with it sits behind one three-dot menu, and
              a change is something you ask a Mono for. */}
          <div className="flex items-center gap-2">
            <h1 className="min-w-0 flex-1 truncate text-[17px] font-medium text-content">{shown.title}</h1>
            <DotMenu label={`${shown.title} options`} items={[
              { id: "rebuild", label: rebuilding === shown.id ? "Never mind the change" : "Ask for a change", onPick: () => setRebuilding(rebuilding === shown.id ? undefined : shown.id) },
              { id: "pin", label: shown.pinned ? "Unpin from the sidebar" : "Pin to the sidebar", onPick: () => setPinned(shown.id, !shown.pinned) },
              { id: "all", label: "All pages", onPick: () => setOpen(undefined) },
            ]} />
          </div>
          {readyWhat(shown.request) ? <p className="mt-1 text-[13px] leading-5 text-content/70" data-pages-what>{readyWhat(shown.request)}</p> : null}
          {/* "Kept" says itself once, with Undo, in the bar below; this line is just where it lives and who built it. */}
          <div className="mt-1 text-[12px] text-content/60" data-pages-meta>{nameOf(shown.projectId ?? "today")} · by {shown.by}{request ? <> · “{request}”</> : null}{shown.permissions.length ? <> · <AllowedLine key={shown.id} asks={shown.permissions} /></> : null}</div>
          <div className="mb-4" />
          {kept === shown.title ? (
            <div className={`${card} mb-4 flex items-center gap-2 px-3 py-2 text-[12px] text-content/80`} role="status">
              <span className="min-w-0 flex-1">Kept.</span>
              <button type="button" data-pages-undo-keep aria-label={`Undo: kept ${shown.title}`} className={`${quietBtn} flex items-center gap-1.5`} onClick={() => { const id = shown.id; setKept(undefined); setOpen(undefined); void undoBotChange([`page:${id}`]); }}>
                <Undo2 className="size-3.5 text-content/60" />Undo
              </button>
            </div>
          ) : null}
          {/* r63 (PM's blind C8): the Allow card and the page below once had the same key, so every live re-render added
              another Allow card (4+ on the Agents page). Each sibling has its own key now; until Allow the page is shown
              greyed with a line that says why it can't be used yet. */}
          {gated ? <AllowAgain key={`allow:${shown.id}`} page={shown} asks={shown.spec.kind === "bespoke" ? shown.spec.permissions : []} /> : null}
          <PageRebuild key={`rebuild:${shown.id}`} page={shown} asking={rebuilding === shown.id} onDone={() => setRebuilding(undefined)} seated={seated} projectId={shown.projectId ?? "today"}>
            <PageTapStatus pageId={shown.id} />
            {gated ? (
              <div className="pointer-events-none select-none opacity-50" aria-disabled="true" inert data-pages-gated>
                <PageBody page={withReadySpec(shown)} live />
              </div>
            ) : (
              <PageBody page={withReadySpec(shown)} live />
            )}
            <PageActivity pageId={shown.id} title={shown.title} />
            {shown.spec.kind === "bespoke" ? <PageConnections page={shown} /> : null}
          </PageRebuild>
        </div>
      </div>
    );
  }

  if (newPage || !pages.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center" data-pages-new>
        <div>
          <div className="text-[17px] font-medium text-content">{pages.length ? "New page" : "No pages yet"}</div>
          <div className="mt-1 text-[13px] text-content/70">Describe the page. {asker} builds it and shows you a preview first.</div>
          <div className="mt-2"><Limits /></div>
        </div>
        <div className="w-full max-w-[560px]"><AskBox onAsk={ask} monos={seated} monoId={askerId} onPick={setPicked} placeholder="Describe the page…" /></div>
        {pages.length ? <button type="button" className={quietBtn} onClick={() => setNewPage(false)}>Back to all pages</button> : null}
        <ReadyMade offers={offers} onAdd={addReady} compact />
      </div>
    );
  }

  const groups = (filter === "all" ? [...new Set(pages.map((p) => p.projectId ?? "today"))] : [filter])
    .map((id) => [id, pages.filter((p) => (p.projectId ?? "today") === id)] as const)
    .filter(([, list]) => list.length);
  // Every project gets a tab, pages or not; "Not tied to a project" for pages that belong to none.
  const withPages = [...projects.map((p) => p.id), "today"];
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="w-full px-6 py-6 xl:px-8" data-pages-list>
        <PagesProblem />
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 text-[17px] font-medium text-content">Pages</h1>
          <button type="button" data-pages-new-button className={primaryBtn} onClick={() => setNewPage(true)}>New page</button>
        </div>
        <div className="mt-1"><Limits /></div>
        <div role="tablist" aria-label="Filter by project" className="mt-4 flex flex-wrap gap-1">
          {["all", ...withPages].map((id) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}
              className={`rounded-md px-2 py-0.5 text-[12px] ${filter === id ? "bg-selection text-content" : "text-content/70 hover:bg-selection-hover"}`}>
              {id === "all" ? "All" : nameOf(id)}
            </button>
          ))}
        </div>
        {!groups.length ? (
          <div className="mt-8 flex flex-col items-center gap-3 text-center" data-pages-filter-empty>
            <div className="text-[14px] text-content">No pages yet</div>
            <div className="text-[13px] text-content/70">Nothing for {nameOf(filter)} so far.</div>
            <button type="button" className={primaryBtn} onClick={() => setNewPage(true)}>New page</button>
          </div>
        ) : null}
        <div className="mt-4 flex flex-col gap-5">
          {groups.map(([id, list]) => (
            <section key={id} data-pages-group={id}>
              <h2 className="px-2 pb-1 text-xs text-content/60">{nameOf(id)}</h2>
              <div className="flex flex-col gap-px">
                {list.map((p) => (
                  <div key={p.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-selection-hover" data-pages-row={p.id}>
                    <button type="button" className="flex min-w-0 flex-1 flex-col text-left" onClick={() => setOpen(p.id)}>
                      <span className="truncate text-[13px] text-content">{p.title}</span>
                      {readyWhat(p.request) ? <span className="truncate text-[12px] text-content/70" data-pages-what>{readyWhat(p.request)}</span> : null}
                      <span className="truncate text-[12px] text-content/60">by {p.by}{p.pinned ? ` · pinned by ${p.pinnedBy ?? "you"}` : ""}</span>
                    </button>
                    <PinToggle page={p} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <ReadyMade offers={offers} onAdd={addReady} />
        </div>
      </div>
    </div>
  );
}

type Rebuild = { prompt: string; monoId: string; by: string } & ({ state: "building" } | BuildPageResult);

/**
 * Rebuild: Ash says what should change ("add a column for stuck time") and a seated Mono (the one that built it, unless
 * he picks another) changes the page as it is now. The new version shows as a preview with what it would keep and what it
 * newly asks; the page runs as it is until he uses it (same page, pin and place on Today) or throws it away. A Mono's
 * rebuild from its chat (ash_page_rebuild) waits on the page the same way.
 */
function PageRebuild({ page, asking, onDone, seated, projectId, children }: { page: Page; asking: boolean; onDone: () => void; seated: { id: string; name: string }[]; projectId: string; children: ReactNode }) {
  const [run, setRun] = useState<Rebuild>();
  const [viewing, setViewing] = useState<{ id?: string; spec: PageSpec; request: string; by: string }>();
  const [picked, setPicked] = useState<string>();
  const [busy, setBusy] = useState(false);
  const builderId = picked && seated.some((m) => m.id === picked) ? picked : page.monoId && seated.some((m) => m.id === page.monoId) ? page.monoId : defaultBuilder(projectId, seated);
  const builder = seated.find((m) => m.id === builderId)?.name ?? page.by;
  const ask = (prompt: string, monoId = builderId, by = builder) => {
    setRun({ prompt, monoId, by, state: "building" });
    void rebuildPage({ pageId: page.id, monoId, prompt, current: page.spec }).then((result) => {
      setRun({ prompt, monoId, by, ...result });
      if (result.status === "ready") {
        setViewing({ id: result.pageId, spec: result.spec, request: prompt, by });
        onDone();
      }
    });
  };
  const close = () => { setViewing(undefined); setRun(undefined); };

  if (viewing) {
    const added = newAsks(page, viewing.spec);
    const keeps = viewing.spec.kind === "bespoke" ? viewing.spec.permissions.filter((a) => page.permissions.includes(a)) : [];
    const preview: Page = { ...page, spec: viewing.spec, title: viewing.spec.title, newVersion: undefined };
    const use = (allowNew: boolean) => {
      setBusy(true);
      void useNewVersion(page, viewing, { allowNew }).then((ok) => { setBusy(false); if (ok) close(); });
    };
    return (
      <div data-pages-new-version>
        <div className="mb-1 text-[12px] text-content/60">“{viewing.request}” · {viewing.by} built a new version</div>
        <div className="mb-3 text-[12px] text-content/70" data-pages-new-version-keeps>
          {keeps.length ? `It keeps what you allowed it (${allowedLabel(keeps.length).replace(/^Allowed: /, "")}).` : "The page stays as it is until you use this version."}
        </div>
        {added.length ? <div className="mb-3"><div className="mb-1 text-[12px] text-content/70">The new version also asks:</div><Permissions asks={added} /></div> : null}
        <div className="relative rounded-xl border border-dashed border-content/30 p-4" data-pages-preview-frame>
          <div className="relative"><PageBody page={preview} /></div>
        </div>
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-content/20 bg-background-base/90 px-5 py-3 backdrop-blur">
          <span className="text-[12px] text-content/70">This is the new version. Your page stays as it is until you use it.</span>
          <span className="ml-auto" />
          <button type="button" className={quietBtn} disabled={busy} onClick={() => { if (viewing.id) void dropNewVersion(page, viewing.id); close(); }}>Discard</button>
          <button type="button" data-pages-use-version disabled={busy} className={`${primaryBtn} disabled:opacity-40`} onClick={() => use(added.length > 0)}>
            {added.length ? "Use it and allow" : "Use this version"}
          </button>
        </div>
      </div>
    );
  }

  const waiting = page.newVersion;
  return (
    <>
      {asking && !run ? (
        <div className="mb-4" data-pages-rebuild-ask>
          <div className="mb-1.5 text-[12px] text-content/70">Say what should change. {builder} changes the page and shows you the new version first.</div>
          <AskBox onAsk={(text) => ask(text)} monos={seated} monoId={builderId} onPick={setPicked} placeholder="What should change? Like “add a column for stuck time”…" label="What should change" />
        </div>
      ) : null}
      {run ? (
        <div className="mb-4" data-pages-rebuild-state={"status" in run ? run.status : "building"}>
          <div className="mb-1 text-[12px] text-content/60">“{run.prompt}” · asked {run.by}</div>
          {!("status" in run) || run.status === "building" ? (
            <div className={`${card} flex items-center gap-3 p-4 text-[13px] text-content/80`} role="status">
              <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
              <span className="min-w-0 flex-1 leading-5">{"status" in run ? run.reason : `${run.by} is changing the page…`}</span>
              {"status" in run ? <button type="button" className={primaryBtn} onClick={() => ask(run.prompt, run.monoId, run.by)}>Try again</button> : null}
            </div>
          ) : run.status === "not-connected" ? (
            <div className={`${card} p-4`}>
              <div className="text-[14px] text-content">Not connected yet</div>
              <p className="mt-1 text-[13px] leading-5 text-content/70">{run.reason}</p>
            </div>
          ) : run.status !== "ready" ? (
            <div className="rounded-lg px-3 py-2.5">
              <div className="text-[13px] text-content">{run.status === "turned-down" ? `Sent back to ${run.by}` : "That didn't work"}</div>
              <div className="text-[13px] leading-5 text-content/60">{run.status === "turned-down" ? "Turned down automatically: " : ""}{run.reason}</div>
            </div>
          ) : null}
          {"status" in run && run.status !== "ready" ? (
            <div className="mt-2 flex gap-2">
              <button type="button" className={quietBtn} onClick={() => setRun(undefined)}>Back to the page</button>
              {run.status === "error" ? <button type="button" className={primaryBtn} onClick={() => ask(run.prompt, run.monoId, run.by)}>Try again</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {waiting && !run ? (
        <div className={`${card} mb-4 flex items-center gap-2 px-3 py-2 text-[12px] text-content/80`} data-pages-version-waiting>
          <span className="min-w-0 flex-1 truncate">New version from {waiting.by}: “{waiting.request}”</span>
          <button type="button" className={quietBtn} onClick={() => setViewing({ id: waiting.id, spec: waiting.spec, request: waiting.request, by: waiting.by })}>See it</button>
        </div>
      ) : null}
      {children}
    </>
  );
}
/** One three-dot menu: what you can do with what's on screen, out of the way until asked for. */
export function DotMenu({ label, items }: { label: string; items: { id: string; label: string; onPick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0" data-pages-menu>
      <button type="button" aria-label={label} title="More" aria-haspopup="menu" aria-expanded={open} data-pages-menu-button
        onClick={() => setOpen((o) => !o)}
        className={`grid size-7 place-items-center rounded-md text-content/70 hover:bg-surface-raised hover:text-content ${open ? "bg-surface-raised text-content" : ""}`}>
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
      {open ? (
        <div role="menu" className="popover-glass absolute right-0 top-8 z-20 min-w-[190px] rounded-lg p-1 shadow-lg ring-1 ring-surface-ring">
          {items.map((item) => (
            <button key={item.id} type="button" role="menuitem" data-pages-menu-item={item.id} {...(item.id === "rebuild" ? { "data-pages-rebuild": "" } : {})}
              onClick={() => { setOpen(false); item.onPick(); }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-content/85 hover:bg-selection-hover hover:text-content">{item.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Pin or unpin a page; pinned pages show in the sidebar. */
/** Unpinned: hidden until the row is hovered (always shown, at 70% content, beside an open page's title). Pinned: solid. */
function PinToggle({ page, inHeader }: { page: Page; inHeader?: boolean }) {
  return (
    <button type="button" aria-pressed={!!page.pinned} aria-label={page.pinned ? `Unpin ${page.title}` : `Pin ${page.title}`} title={page.pinned ? "Unpin from the sidebar" : "Pin to the sidebar"}
      data-pages-pin onClick={() => setPinned(page.id, !page.pinned)}
      className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-surface-raised ${page.pinned ? "text-content" : inHeader ? "text-content/70 hover:text-content" : "text-content/70 opacity-0 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"}`}>
      <Pin className="size-3.5" strokeWidth={page.pinned ? 2.25 : 1.75} />
    </button>
  );
}

export function PagesView({ onClose, onToggleSidebar, besideRail = true, compactRail = false }: { onClose: () => void; onToggleSidebar?: () => void; besideRail?: boolean; compactRail?: boolean }) {
  const [tab, setTab] = useState<"pages" | ChangeFlow>(() => todayPreviewWaiting() ?? "pages");
  const projectId = useHubSelection().project;
  // See it on a Today change a Mono built from its chat opens Edit Today.
  useEffect(() => {
    const open = (e: Event) => { const d = (e as CustomEvent).detail; if (d === "today" || d === "hub" || d === "connect" || d === "pages") setTab(d); };
    window.addEventListener(OPEN_EDIT_TODAY, open);
    return () => window.removeEventListener(OPEN_EDIT_TODAY, open);
  }, []);
  // Dropwave (Ash, 11 Nov): no row of tabs up here. A page just shows; "Change the hub", "Edit Today" and "Connect
  // data" wait behind the list's three-dot menu.
  usePagesVersion();
  const listAsked = pagesListRequests();
  useEffect(() => { if (listAsked) setTab("pages"); }, [listAsked]);
  const pageShown = tab === "pages" && !!shownPageId() && allPages().some((p) => p.id === shownPageId());
  const flows: ChangeFlow[] = ["hub", "today", "connect"];
  return (
    <div role="region" aria-label="Pages" data-app-pages className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail || !onToggleSidebar ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          {pageShown ? null : tab === "pages" ? (
            <>
              <DashboardSquare className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate text-content">Pages</span>
              <DotMenu label="More for Pages" items={flows.map((flow) => ({ id: flow, label: FLOW_LABEL[flow], onPick: () => setTab(flow) }))} />
            </>
          ) : (
            <>
              <button type="button" data-pages-back className="rounded-md px-2 py-0.5 text-[12px] text-content/70 hover:bg-selection-hover hover:text-content" onClick={() => setTab("pages")}>← Pages</button>
              <span className="min-w-0 truncate text-content">{FLOW_LABEL[tab]}</span>
            </>
          )}
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {tab === "pages" ? <PagesContent /> : <div className="min-h-0 flex-1 overflow-auto"><HubChangeContent key={tab} flow={tab} projectId={projectId} /></div>}
    </div>
  );
}
