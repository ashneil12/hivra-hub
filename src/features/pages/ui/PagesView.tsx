import { useEffect, useRef, useState, type ReactNode } from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowUp, DashboardSquare, Undo2 } from "../../../shared/ui/icons";
import { useHubSelection } from "../../hub/model/hubNav";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { undoBotChange } from "../../hub/model/botChanges";
import { allowPage, approvedPermissions, needsAllow, keepPage, keptPages, pageBlocks, pageFromSpec, usePagesVersion, type Page, type PageBlock } from "../model/pages";
import { buildPage, type BuildPageResult } from "../model/buildPage";
import { describeCapability, keyName, type BespokeSpec, type Capability } from "../model/pageSpec";
import { handleBridgeCall, type BridgeCall } from "../model/bridge";
import { SANDBOX, bespokeSrcdoc, readTokens } from "../model/sandbox";
import { loadActiveSchemeId } from "../../settings/model/themeSchemes";
import { HubChangeContent } from "../../hubChange/ui/HubChangeView";
import { FLOW_LABEL, type ChangeFlow } from "../../hubChange/model/hubChange";

/*
 * Pages: ask any Mono for a page; it shows a preview built from ready-made blocks; Keep or Throw away.
 * Every colour here is a theme token (content, surface, stroke, theme-accent, status-*), so a scheme restyles it.
 */
const card = "rounded-xl bg-surface ring-1 ring-surface-ring";
const btn = "rounded-md px-3 py-1.5 text-[12px] transition-colors";
const quietBtn = `${btn} text-content/70 hover:bg-surface-raised hover:text-content`;
const primaryBtn = `${btn} bg-content/12 text-content hover:bg-content/18`;
const STATE_DOT = { ok: "bg-status-ok", warn: "bg-status-warn", bad: "bg-status-bad" } as const;
const ASKER = "Projects Manager";
const ASKER_ID = "projects-manager";
export const PAGES_CANT = "This can't change the app's core screens, the sidebar, settings, keys or Monos.";
function Limits() {
  return <p className="text-[12px] text-content/60" data-pages-cant>{PAGES_CANT}</p>;
}

function Dot({ state }: { state: keyof typeof STATE_DOT }) {
  return <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />;
}
function BlockFrame({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`${card} p-4 ${wide ? "col-span-2" : ""}`} data-page-block>
      <div className="mb-2.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-content/60">
        <span className="flex-1">{title}</span>
        <span className="normal-case tracking-normal" data-example-data>Example data</span>
      </div>
      {children}
    </section>
  );
}

export function Block({ block }: { block: PageBlock }) {
  switch (block.kind) {
    case "status":
      return (
        <BlockFrame title={block.title}>
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
        <BlockFrame title={block.title}>
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
      return (
        <BlockFrame title={block.title}>
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
      return (
        <BlockFrame title={block.title}>
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
        <BlockFrame title={block.title}>
          <p className="text-[13px] leading-6 text-content/85">{block.text}</p>
        </BlockFrame>
      );
    case "calendar": {
      const cells = [...Array(block.firstWeekday).fill(null), ...Array.from({ length: block.days }, (_, i) => i + 1)];
      return (
        <BlockFrame title={`${block.title} · ${block.month}`}>
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

function PageBody({ page, live }: { page: Page; live?: boolean }) {
  if (page.spec.kind === "bespoke") return <BespokeFrame pageId={page.id} spec={page.spec} live={live} />;
  return (
    <div className="grid grid-cols-2 gap-3">
      {pageBlocks(page).map((b, i) => <Block key={`${b.kind}-${i}`} block={b} />)}
    </div>
  );
}

/**
 * A bespoke page in its sandbox: sandbox="allow-scripts" only, a strict CSP, the theme tokens injected. Its only way
 * out is hub.call over postMessage; the host answers only what Ash approved (none in preview), via the bridge.
 */
export function BespokeFrame({ pageId, spec, live }: { pageId: string; spec: BespokeSpec; live?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const scheme = loadActiveSchemeId();
  const [doc] = useState(() => bespokeSrcdoc(spec, readTokens(), document.documentElement.classList.contains("theme-light") ? "light" : "dark"));
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = e.data as { type?: string } & BridgeCall;
      if (m?.type !== "hub:call") return;
      const approved = live ? approvedPermissions(pageId) : [];
      void handleBridgeCall(m, approved, {}).then((reply) => ref.current?.contentWindow?.postMessage({ type: "hub:reply", ...reply }, "*"));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pageId, live]);
  return <iframe ref={ref} key={scheme} title={spec.title} sandbox={SANDBOX} srcDoc={doc} data-bespoke-page className="h-[460px] w-full rounded-xl border-0 bg-transparent" />;
}

/** The asks a bespoke page makes, in plain words. Key asks get their own card on top. */
function Permissions({ asks }: { asks: Capability[] }) {
  const keys = asks.map(keyName).filter((k): k is string => !!k);
  const rest = asks.filter((a) => !keyName(a));
  if (!asks.length) return null;
  return (
    <div className="flex flex-col gap-2" data-page-permissions>
      {keys.length ? (
        <div className={`${card} px-4 py-3`} data-page-key-asks>
          <div className="text-[13px] font-medium text-content">Reads your keys</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {keys.map((k) => <span key={k} className="rounded-md bg-surface-raised px-2 py-0.5 text-[12px] text-content">{k}</span>)}
          </div>
        </div>
      ) : null}
      {rest.length ? (
        <div className={`${card} px-4 py-3`}>
          <div className="mb-1 text-[12px] text-content/70">This page asks to:</div>
          <ul className="flex flex-col gap-0.5 text-[13px] text-content/90">
            {rest.map((a) => <li key={a}>· {describeCapability(a)}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** About a second before Keep and allow works when keys are asked for, so a quick click can't approve them. */
export const KEY_CONFIRM_DELAY_MS = 1000;
export function useKeyDelay(hasKeyAsk: boolean): boolean {
  const [ready, setReady] = useState(!hasKeyAsk);
  useEffect(() => {
    if (!hasKeyAsk) return setReady(true);
    setReady(false);
    const t = window.setTimeout(() => setReady(true), KEY_CONFIRM_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [hasKeyAsk]);
  return ready;
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

/** An imported page asks again: the same list and Keep and allow, with the key delay. Until then it can do nothing. */
function AllowAgain({ page, asks }: { page: Page; asks: Capability[] }) {
  const ready = useKeyDelay(asks.some((a) => !!keyName(a)));
  return (
    <div className="mb-4 flex flex-col gap-2" data-pages-allow-again>
      <div className="text-[12px] text-content/70">This page came from a setup file. It can't do anything until you allow what it asks for.</div>
      <Permissions asks={asks} />
      <div className="flex justify-end">
        <button type="button" data-pages-allow disabled={!ready} className={`${primaryBtn} disabled:opacity-40`} onClick={() => allowPage(page.id)}>Allow</button>
      </div>
    </div>
  );
}

function AskBox({ onAsk }: { onAsk: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim()) { onAsk(text.trim()); setText(""); } };
  return (
    <form className={`${card} flex items-center gap-2 px-3 py-2`} onSubmit={(e) => { e.preventDefault(); send(); }}>
      <input
        aria-label="Ask a Mono to build a page"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask a Mono to build a page…"
        className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-content outline-none placeholder:text-content/60"
      />
      <button type="submit" aria-label="Send to a Mono" disabled={!text.trim()} className="grid size-7 place-items-center rounded-full bg-content/12 text-content hover:bg-content/18 disabled:opacity-40">
        <ArrowUp className="size-3.5" strokeWidth={2} />
      </button>
    </form>
  );
}

type Build = { prompt: string } & ({ state: "building" } | BuildPageResult);

export function PagesContent() {
  usePagesVersion();
  useHubDataVersion();
  const projectId = useHubSelection().project;
  const projectName = projectId === "today" ? "all projects" : hubData().listProjects().find((p) => p.id === projectId)?.name ?? projectId;
  const [build, setBuild] = useState<Build>();
  const [open, setOpen] = useState<string>();
  const [kept, setKept] = useState<string>();
  const [sentBack, setSentBack] = useState<string>();
  const pages = keptPages(projectId);
  const shown = pages.find((p) => p.id === open);

  const ask = (prompt: string) => {
    setBuild({ prompt, state: "building" });
    setSentBack(undefined);
    void buildPage({ projectId, monoId: ASKER_ID, prompt }).then((result) => setBuild({ prompt, ...result }));
  };
  const preview = build && "status" in build && build.status === "ready" ? pageFromSpec(build.spec, build.prompt, ASKER, projectId, build.warnings) : undefined;
  const asks = preview?.spec.kind === "bespoke" ? preview.spec.permissions : [];
  const keyReady = useKeyDelay(asks.some((a) => !!keyName(a)));

  if (build && !preview) {
    return (
      <div className="mx-auto w-full max-w-2xl px-8 py-10" data-pages-build-state={"status" in build ? build.status : "building"}>
        <div className="mb-1 text-[12px] text-content/60">“{build.prompt}” · asked {ASKER}</div>
        {"status" in build ? (
          build.status === "not-connected" ? (
            <div className={`${card} p-5`} data-pages-not-connected>
              <div className="text-[14px] text-content">Not connected yet</div>
              <p className="mt-1 text-[13px] leading-5 text-content/70">{build.reason} Once it's wired, {ASKER} builds the page here and you see a preview first.</p>
            </div>
          ) : (
            <div className="rounded-lg px-3 py-2.5" data-pages-turned-down>
              <div className="text-[13px] text-content">{build.status === "turned-down" ? "Sent back to " + ASKER : "That didn't work"}</div>
              <div className="text-[13px] leading-5 text-content/60">Turned down automatically: {"reason" in build ? build.reason : ""}</div>
            </div>
          )
        ) : (
          <div className={`${card} flex items-center gap-3 p-5 text-[13px] text-content/80`} role="status">
            <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-content/20 border-t-content/70" />
            {ASKER} is building your page…
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button type="button" className={quietBtn} onClick={() => setBuild(undefined)}>Back to Pages</button>
          {"status" in build && build.status !== "turned-down" ? <button type="button" className={primaryBtn} onClick={() => ask(build.prompt)}>Try again</button> : null}
        </div>
      </div>
    );
  }

  if (preview) {
    const keepLabel = asks.length ? "Keep and allow" : "Keep";
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-6" data-pages-preview>
        <div className="mb-1 text-[12px] text-content/60">“{preview.request}” · {preview.by} built this preview</div>
        <h1 className="text-[17px] font-medium text-content">{preview.title}</h1>
        <div className="mb-4 mt-1"><Limits /></div>
        {asks.length ? <div className="mb-3"><Permissions asks={asks} /></div> : null}
        {preview.warnings?.length ? (
          <div className={`${card} mb-3 flex flex-col gap-2 px-4 py-3`} data-pages-warnings>
            {preview.warnings.map((w) => (
              <div key={w.rule} className="flex items-start gap-3 text-[13px]">
                <span className="min-w-0 flex-1 leading-5 text-content/85">{w.plain}</span>
                <button type="button" className={quietBtn} onClick={() => setSentBack(w.plain)}>Fix it</button>
              </div>
            ))}
            {sentBack ? <div className="text-[12px] text-content/70" role="status">Sent back to {ASKER}: “{sentBack}”</div> : null}
          </div>
        ) : null}
        <div className="relative rounded-xl border border-dashed border-content/30 p-4">
          <div aria-hidden className="pointer-events-none absolute inset-0 grid select-none place-items-center overflow-hidden rounded-xl">
            <span className="-rotate-12 text-[64px] font-semibold tracking-widest text-content/[0.05]">Preview</span>
          </div>
          <div className="relative"><PageBody page={preview} /></div>
        </div>
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-content/20 bg-background-base/90 px-5 py-3 backdrop-blur">
          <span className="text-[12px] text-content/70">This is a preview. Nothing is saved until you keep it.</span>
          <span className="ml-auto" />
          <button type="button" className={quietBtn} onClick={() => setBuild(undefined)}>Throw away</button>
          <button type="button" data-pages-keep disabled={!keyReady} className={`${primaryBtn} disabled:opacity-40`} onClick={() => { keepPage(preview); setKept(preview.title); setOpen(preview.id); setBuild(undefined); }}>{keepLabel}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {pages.length ? (
        <aside className="flex w-[240px] shrink-0 flex-col gap-0.5 border-r border-stroke p-2" aria-label="Your pages">
          <div className="px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-content/60">Pages · {projectName}</div>
          {pages.map((p) => (
            <button key={p.id} type="button" onClick={() => setOpen(p.id)}
              className={`truncate rounded-md px-2 py-1.5 text-left text-[13px] ${p.id === shown?.id ? "bg-selection text-content" : "text-content/80 hover:bg-selection-hover"}`}>
              {p.title}
            </button>
          ))}
          <button type="button" onClick={() => setOpen(undefined)} className="mt-1 rounded-md px-2 py-1.5 text-left text-[13px] text-content/70 hover:bg-selection-hover">+ New page</button>
        </aside>
      ) : null}
      <div className="min-w-0 flex-1 overflow-auto">
        {shown ? (
          <div className="mx-auto w-full max-w-3xl px-8 py-6">
            <h1 className="text-[17px] font-medium text-content">{shown.title}</h1>
            <div className="mt-1 text-[12px] text-content/60">Kept · by {shown.by} · “{shown.request}”{shown.permissions.length ? <> · <AllowedLine key={shown.id} asks={shown.permissions} /></> : null}</div>
            <div className="mb-4 mt-1"><Limits /></div>
            {kept === shown.title ? (
              <div className={`${card} mb-4 flex items-center gap-2 px-3 py-2 text-[12px] text-content/80`} role="status">
                <span className="min-w-0 flex-1">Kept.</span>
                <button type="button" data-pages-undo-keep className={`${quietBtn} flex items-center gap-1.5`} onClick={() => { const id = shown.id; setKept(undefined); setOpen(undefined); void undoBotChange([`page:${id}`]); }}>
                  <Undo2 className="size-3.5 text-content/60" />Undo
                </button>
              </div>
            ) : null}
            {needsAllow(shown) && shown.spec.kind === "bespoke" ? <AllowAgain key={shown.id} page={shown} asks={shown.spec.permissions} /> : null}
            <PageBody page={shown} live />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center" data-pages-empty>
            <DashboardSquare className="size-8 text-content/60" strokeWidth={1.5} />
            <div>
              <div className="text-[17px] font-medium text-content">{pages.length ? "Make another page" : `No pages for ${projectName} yet`}</div>
              <div className="mt-1 text-[13px] text-content/70">Just ask any Mono. It builds a page, from the hub's blocks or its own design, and shows you a preview first.</div>
              <div className="mt-2"><Limits /></div>
            </div>
            <div className="w-full max-w-[560px]"><AskBox onAsk={ask} /></div>
            <div className="flex flex-wrap justify-center gap-2">
              {["A dashboard for EXO bugs", "My schedule this week", "Hivra sign-ups and sales"].map((s) => (
                <button key={s} type="button" className={`${card} ${btn} text-content/80 hover:bg-surface-raised`} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PagesView({ onClose, onToggleSidebar, besideRail = true, compactRail = false }: { onClose: () => void; onToggleSidebar?: () => void; besideRail?: boolean; compactRail?: boolean }) {
  const [tab, setTab] = useState<"pages" | ChangeFlow>("pages");
  const projectId = useHubSelection().project;
  const tabs: ["pages" | ChangeFlow, string][] = [["pages", "Pages"], ["hub", FLOW_LABEL.hub], ["today", FLOW_LABEL.today], ["connect", FLOW_LABEL.connect]];
  return (
    <div role="region" aria-label="Pages" data-app-pages className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail || !onToggleSidebar ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <DashboardSquare className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Pages</span>
          <div role="tablist" aria-label="Pages and changes" className="ml-3 flex gap-0.5">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={`rounded-md px-2 py-0.5 text-[12px] ${tab === id ? "bg-selection text-content" : "text-content/70 hover:bg-selection-hover"}`}>{label}</button>
            ))}
          </div>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {tab === "pages" ? <PagesContent /> : <div className="min-h-0 flex-1 overflow-auto"><HubChangeContent key={tab} flow={tab} projectId={projectId} /></div>}
    </div>
  );
}
