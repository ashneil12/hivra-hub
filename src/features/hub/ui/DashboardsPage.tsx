import { hubData, useHubDataVersion } from "../model/hubData";
import {
  isCustomised,
  resetToTemplate,
  setTemplate,
  templateOf,
  TEMPLATES,
  useTemplatesVersion,
  wasReset,
  type TemplateId,
} from "../model/templates";

/** Settings → Dashboards: each project's template and reset. Export and import have their own page. */
export function DashboardsPage() {
  useHubDataVersion();
  useTemplatesVersion();
  const projects = hubData().listProjects();
  return (
    <div className="flex flex-col gap-8" data-hub-dashboards>
      <section className="flex flex-col gap-0.5">
        {projects.map((p) => {
          const t = templateOf(p.id);
          const custom = isCustomised(p.id) && !wasReset(p.id);
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-content/5" data-hub-dashboard={p.id}>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-content">{p.name}</div>
                <div className="text-[13px] leading-5 text-content/60">
                  {custom ? (
                    <>
                      Changed from the template (
                      <button type="button" data-hub-reset={p.id} onClick={() => resetToTemplate(p.id)}
                        className="text-content/85 underline-offset-2 hover:underline">
                        reset to default
                      </button>
                      )
                    </>
                  ) : wasReset(p.id) ? "Reset to the template just now" : "Uses the template as is"}
                  {" · Today: "}
                  {t.todayCards.join(", ")}
                </div>
              </div>
              <select
                aria-label={`${p.name} template`}
                value={t.id}
                onChange={(e) => setTemplate(p.id, e.target.value as TemplateId)}
                className="shrink-0 rounded-md bg-content/8 px-2 py-1 text-xs text-content outline-none"
              >
                {TEMPLATES.map((x) => (
                  <option key={x.id} value={x.id}>{x.label}</option>
                ))}
              </select>
            </div>
          );
        })}
      </section>
      <p className="px-3 text-[13px] text-content/60" data-hub-setup-moved>
        To save or bring back your whole setup, use Export and import in Settings.
      </p>
    </div>
  );
}
