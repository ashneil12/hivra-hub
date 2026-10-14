import { useRef, useState } from "react";
import { hubData } from "../model/hubData";
import {
  exportSetup,
  isCustomised,
  resetToTemplate,
  restoreSetup,
  setTemplate,
  templateOf,
  TEMPLATES,
  useTemplatesVersion,
  wasReset,
  type TemplateId,
} from "../model/templates";

const BTN = "shrink-0 rounded-md bg-content/8 px-2.5 py-1 text-xs text-content/85 hover:bg-content/12";

/** Settings → Dashboards: each project's template, reset, export and restore. */
export function DashboardsPage() {
  useTemplatesVersion();
  const projects = hubData().listProjects();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  const doExport = () => {
    const blob = new Blob([exportSetup(projects.map((p) => p.id))], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "monocode-setup.json";
    a.click();
    URL.revokeObjectURL(a.href);
    setNote("Saved monocode-setup.json. Keep it somewhere safe; Restore setup brings it all back.");
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const n = restoreSetup(await f.text());
      setNote(`Restored ${n} project${n === 1 ? "" : "s"} from ${f.name}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't read that file.");
    }
  };

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
                  {custom ? "Changed from the template" : wasReset(p.id) ? "Reset to the template just now" : "Uses the template as is"}
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
              {custom ? (
                <button type="button" data-hub-reset={p.id} onClick={() => resetToTemplate(p.id)} className={BTN}>
                  Reset to default
                </button>
              ) : null}
            </div>
          );
        })}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-xs text-content/60">Your whole setup</h2>
        <p className="text-[13px] leading-5 text-content/60">
          Projects, their dashboards and which Monos are on them, saved as files. Restore on a new Mac to get everything back.
        </p>
        <div className="flex items-center gap-2">
          <button type="button" data-hub-export onClick={doExport} className={BTN}>Export setup</button>
          <button type="button" data-hub-restore onClick={() => fileRef.current?.click()} className={BTN}>Restore setup</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {note ? <p className="text-[13px] text-content/60" data-hub-setup-note>{note}</p> : null}
      </section>
    </div>
  );
}
