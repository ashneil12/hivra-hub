import { useState } from "react";
import { IS_MAC } from "../../../platform/tauri/platform";
import { Check, Plus } from "../../../shared/ui/icons";
import { addMockProject } from "../model/mockData";
import { setHubSelection } from "../model/hubNav";
import { setTemplate, TEMPLATES, type TemplateId } from "../model/templates";

/** New project: a name and a dashboard template. */
export function NewProjectView() {
  const [name, setName] = useState("");
  const [tpl, setTpl] = useState<TemplateId>("game-studio");
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const id = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    const t = TEMPLATES.find((x) => x.id === tpl)!;
    addMockProject({ id, name: n, shortName: n.split(" ")[0], iconShape: t.icon, folder: `/Users/ash/harness/${id}` });
    setTemplate(id, tpl);
    setHubSelection({ project: id, item: "inbox" });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-hub-new-project>
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <Plus className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] text-content">New project</span>
        {IS_MAC ? null : <div className="ml-auto w-[120px]" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-10">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-content/60">Name</span>
            <input
              data-hub-new-project-name
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Example: Moonrise"
              className="rounded-md bg-content/5 px-2.5 py-2 text-[13px] text-content outline-none placeholder:text-content/45"
            />
          </label>
          <TemplatePicker value={tpl} onChange={setTpl} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setHubSelection({ project: "today", item: "inbox" })}
              className="rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content">Cancel</button>
            <button type="button" data-hub-create-project disabled={!name.trim()} onClick={create}
              className="rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-40">
              Create project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TemplatePicker({ value, onChange }: { value: TemplateId; onChange: (t: TemplateId) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-content/60">Dashboard</span>
      {TEMPLATES.map((t) => {
        const on = t.id === value;
        return (
          <button key={t.id} type="button" data-hub-template={t.id} onClick={() => onChange(t.id)}
            className={`flex items-start gap-3 rounded-lg px-3 py-2.5 text-left ${on ? "bg-content/12" : "hover:bg-content/5"}`}>
            <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
              {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] text-content ${on ? "font-medium" : ""}`}>{t.label}</span>
              <span className="block text-[13px] text-content/60">{t.blurb}</span>
              <span className="block pt-1 text-xs text-content/60">
                Today: {t.todayCards.join(" · ")}
                {t.sections.length ? ` — Sidebar adds ${t.sections.map((s) => s.title).join(", ")}` : ""}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
