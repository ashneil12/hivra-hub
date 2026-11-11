import { usePagesVersion, keptPages, requestOpenPage } from "../../pages/model/pages";
import { IS_MAC } from "../../../platform/tauri/platform";
import { DashboardSquare } from "../../../shared/ui/icons";

/**
 * A product project's "Dashboards" section (its template's `project-pages` section): the pages kept for that project,
 * newest kept first, each opening in Pages. Nothing here is example data: empty until a Mono keeps a page for it.
 */
export function ProjectPagesView({ projectId, title }: { projectId: string; title: string }) {
  usePagesVersion();
  const pages = keptPages(projectId);
  const open = (id: string) => {
    requestOpenPage(id);
    window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" }));
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-project-pages>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <DashboardSquare className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="min-w-0 truncate text-[13px] text-content">{title}</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pages.length ? (
          <div className="flex w-full flex-col gap-1 px-6 py-8 xl:px-8" data-hub-project-pages-list>
            {pages.map((p) => (
              <button key={p.id} type="button" onClick={() => open(p.id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-2 text-left hover:bg-content/5">
                <span className="min-w-0 max-w-full truncate text-[13px] text-content/85">{p.title}</span>
                <span className="max-w-full truncate text-[12px] text-content/60">{p.request || `Kept by ${p.by}`}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid h-full place-items-center px-8" data-hub-project-pages-empty>
            <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
              <p className="text-[13px] text-content">No dashboards yet.</p>
              <p className="text-[13px] leading-5 text-content/60">A Mono can build one for this project from Hubs. Hubs you keep for it show up here.</p>
              <button type="button" data-hub-project-pages-open
                onClick={() => window.dispatchEvent(new CustomEvent("monocode:home-open", { detail: "pages" }))}
                className="mt-1 rounded-md bg-content/12 px-3 py-1.5 text-[13px] text-content hover:bg-content/16">
                Open Hubs
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
