import { useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { ArrowLeft, Play } from "../../../shared/ui/icons";
import { addNote, firstBuildExpected, getBuild, listBuilds, useHubBuildsVersion } from "../model/hubBuilds";
import { hubData } from "../model/hubData";
import type { Build } from "../model/types";
import { StatusMark } from "./StatusMark";

const ACTION =
  "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12";

function statusText(b: Build): string {
  if (b.status === "ready") return b.notes.length ? `Played · ${b.notes.length} note${b.notes.length > 1 ? "s" : ""}` : "Ready to play";
  if (b.status === "building") return "Building";
  return "Failed";
}

function BuildAction({ build }: { build: Build }) {
  if (build.status !== "ready" || !build.action) return null;
  return (
    <button type="button" onClick={(e) => e.stopPropagation()} className={ACTION}>
      {build.action === "play" ? "Play" : "Open"}
    </button>
  );
}

/** Builds to try, newest first, with playtest notes. */
export function BuildsView({ projectId, title }: { projectId: string; title: string }) {
  useHubBuildsVersion();
  const [openId, setOpenId] = useState<string | null>(null);
  const builds = listBuilds(projectId);
  const open = openId ? getBuild(openId) : undefined;
  const projectName = hubData().listProjects().find((p) => p.id === projectId)?.name ?? projectId;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-builds>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        {open ? (
          <button
            type="button"
            title="All builds"
            aria-label="All builds"
            onClick={() => setOpenId(null)}
            className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : (
          <Play className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate text-[13px] text-content">{open ? `Build ${open.version}` : title}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open ? (
          <BuildDetail build={open} />
        ) : builds.length ? (
          <BuildList builds={builds} onOpen={setOpenId} />
        ) : (
          <div className="grid h-full place-items-center px-8" data-hub-builds-empty>
            <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
              <p className="text-[13px] text-content">No builds of {projectName} yet.</p>
              <p className="text-[13px] leading-5 text-content/60">Example: the first one should turn up {firstBuildExpected(projectId)}</p>
              <p className="text-[13px] leading-5 text-content/60">It will appear here with a Play button, and you can add playtest notes to it.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BuildList({ builds, onOpen }: { builds: Build[]; onOpen: (id: string) => void }) {
  const latest = builds.find((b) => b.status === "ready");
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-5 px-8 py-8">
      {latest ? (
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] text-content">Latest build to try: {latest.version}</div>
            <div className="text-[13px] text-content/60">
              {latest.title} · built {latest.builtAt}
            </div>
          </div>
          <button type="button" className="shrink-0 rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90">
            {latest.action === "open" ? "Open" : "Start playtest"}
          </button>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        {builds.map((b) => (
          <div
            key={b.id}
            role="button"
            tabIndex={0}
            data-hub-build={b.id}
            onClick={() => onOpen(b.id)}
            onKeyDown={(e) => e.key === "Enter" && onOpen(b.id)}
            className={`flex cursor-default items-center gap-4 rounded-lg px-3 py-2.5 hover:bg-content/5`}
          >
            <span className="w-14 shrink-0 font-mono text-xs text-content/80">{b.version}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-content">{b.title}</div>
              {b.status === "failed" && b.failReason ? (
                <div className="truncate text-[13px] text-content/60">{b.failReason}</div>
              ) : null}
            </div>
            {b.stuck ? <StatusMark state={b.stuck} /> : <span className="shrink-0 text-xs text-content/60">{statusText(b)}</span>}
            <span className="w-14 shrink-0 text-right">
              <BuildAction build={b} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BuildDetail({ build }: { build: Build }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-8 py-8" data-hub-build-detail>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] text-content">
            <span className="font-mono">{build.version}</span> · {build.title}
          </div>
          <div className="text-[13px] text-content/60">Built {build.builtAt}</div>
        </div>
        {build.stuck ? <StatusMark state={build.stuck} /> : <span className="pt-1 text-xs text-content/60">{statusText(build)}</span>}
        <BuildAction build={build} />
      </div>
      {build.status === "failed" ? (
        <div className="flex items-center gap-3 rounded-lg bg-content/5 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-content/85">{build.failReason}</p>
          <button type="button" className={ACTION}>
            Take a look
          </button>
        </div>
      ) : null}
      <section className="flex flex-col gap-2">
        <h2 className="text-xs text-content/60">Playtest notes</h2>
        {build.notes.length ? (
          build.notes.map((n) => (
            <div key={n.id} className="rounded-md px-2 py-1.5 hover:bg-content/5">
              <div className="text-[13px] leading-5 text-content">{n.text}</div>
              <div className="text-[11px] text-content/60">{n.when}</div>
            </div>
          ))
        ) : (
          <p className="px-2 text-[13px] text-content/60">No notes yet.</p>
        )}
        {build.status === "ready" ? (
          <div className="flex flex-col gap-2 pt-1">
            <textarea
              data-hub-note-input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="What did you notice while playing?"
              className="resize-none rounded-md bg-content/5 px-2.5 py-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/45"
            />
            <div className="flex justify-end">
              <button
                type="button"
                data-hub-add-note
                disabled={!draft.trim()}
                onClick={() => {
                  addNote(build.id, draft);
                  setDraft("");
                }}
                className="rounded-md bg-content/12 px-3 py-1.5 text-[13px] text-content hover:bg-content/16 disabled:opacity-50"
              >
                Add note
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
