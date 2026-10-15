import { useState, type ReactNode } from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowUp, DashboardSquare, Undo2 } from "../../../shared/ui/icons";
import { useHubSelection } from "../../hub/model/hubNav";
import { hubData, useHubDataVersion } from "../../hub/model/hubData";
import { buildPreview, keepPage, keptPages, usePagesVersion, type Page, type PageBlock } from "../model/pages";

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

function PageBody({ page }: { page: Page }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {page.blocks.map((b, i) => <Block key={`${b.kind}-${i}`} block={b} />)}
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

export function PagesContent() {
  usePagesVersion();
  useHubDataVersion();
  const projectId = useHubSelection().project;
  const projectName = projectId === "today" ? "all projects" : hubData().listProjects().find((p) => p.id === projectId)?.name ?? projectId;
  const [preview, setPreview] = useState<Page>();
  const [open, setOpen] = useState<string>();
  const [kept, setKept] = useState<string>();
  const pages = keptPages(projectId);
  const shown = pages.find((p) => p.id === open);

  if (preview) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-6" data-pages-preview>
        <div className="mb-1 text-[12px] text-content/60">“{preview.request}” · {preview.by} built this preview</div>
        <h1 className="text-[17px] font-medium text-content">{preview.title}</h1>
        <div className="mb-4 mt-1"><Limits /></div>
        <div className="relative rounded-xl border border-dashed border-content/30 p-4">
          <div aria-hidden className="pointer-events-none absolute inset-0 grid select-none place-items-center overflow-hidden rounded-xl">
            <span className="-rotate-12 text-[64px] font-semibold tracking-widest text-content/[0.05]">Preview</span>
          </div>
          <div className="relative"><PageBody page={preview} /></div>
        </div>
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-xl border border-dashed border-content/20 bg-background-base/90 px-5 py-3 backdrop-blur">
          <span className="text-[12px] text-content/70">This is a preview. Nothing is saved until you keep it.</span>
          <span className="ml-auto" />
          <button type="button" className={quietBtn} onClick={() => setPreview(undefined)}>Throw away</button>
          <button type="button" className={primaryBtn} onClick={() => { keepPage(preview); setKept(preview.title); setOpen(preview.id); setPreview(undefined); }}>Keep</button>
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
            <div className="mt-1 text-[12px] text-content/60">Kept · by {shown.by} · “{shown.request}”</div>
            <div className="mb-4 mt-1"><Limits /></div>
            {kept === shown.title ? (
              <div className={`${card} mb-4 flex items-center gap-2 px-3 py-2 text-[12px] text-content/80`} role="status">
                <Undo2 className="size-3.5 text-content/60" />Kept. Changed your mind? Undo it any time in Settings → Changes → Bot changes.
              </div>
            ) : null}
            <PageBody page={shown} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center" data-pages-empty>
            <DashboardSquare className="size-8 text-content/60" strokeWidth={1.5} />
            <div>
              <div className="text-[17px] font-medium text-content">{pages.length ? "Make another page" : `No pages for ${projectName} yet`}</div>
              <div className="mt-1 text-[13px] text-content/70">Just ask any Mono. It builds a page from ready-made blocks and shows you a preview first.</div>
              <div className="mt-2"><Limits /></div>
            </div>
            <div className="w-full max-w-[560px]"><AskBox onAsk={(t) => setPreview(buildPreview(t, ASKER, Date.now(), projectId))} /></div>
            <div className="flex flex-wrap justify-center gap-2">
              {["A dashboard for EXO bugs", "My schedule this week", "Hivra sign-ups and sales"].map((s) => (
                <button key={s} type="button" className={`${card} ${btn} text-content/80 hover:bg-surface-raised`} onClick={() => setPreview(buildPreview(s, ASKER, Date.now(), projectId))}>{s}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PagesView({ onClose, onToggleSidebar, besideRail = true, compactRail = false }: { onClose: () => void; onToggleSidebar?: () => void; besideRail?: boolean; compactRail?: boolean }) {
  return (
    <div role="region" aria-label="Pages" data-app-pages className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail || !onToggleSidebar ? null : <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <DashboardSquare className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
          <span className="min-w-0 truncate text-content">Pages</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      <PagesContent />
    </div>
  );
}
