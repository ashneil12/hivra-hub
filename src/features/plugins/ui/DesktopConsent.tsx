import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { projectBase, type ConsentState } from "../../../../plugins/desktop-control/bin/consent.mjs";

type Props = {
  consent: ConsentState;
  /** False when the plugin switch is off and it is not enabled for any project. */
  on: boolean;
  busy?: boolean;
  onAllow: (project: string, app: string) => void;
  onRefuse: (project: string, app: string) => void;
  onVisible: (project: string, visible: boolean) => void;
};

function projectsOf(consent: ConsentState): string[] {
  const seen = new Set<string>(Object.keys(consent.projects));
  for (const item of consent.pending) seen.add(item.project);
  return [...seen];
}

/** The allow list for desktop control. It edits nothing itself: the parent writes the next document. */
export function DesktopConsent({ consent, on, busy = false, onAllow, onRefuse, onVisible }: Props) {
  const projects = projectsOf(consent);
  const anyApp = Object.values(consent.projects).some(
    (record) => record.apps.length > 0 || record.refused.length > 0,
  );
  return (
    <section aria-label="Desktop consent" className="mt-3 flex flex-col gap-2">
      {!on ? (
        <p className="text-[13px] text-content/70">
          Desktop control is off. Turn it on above. An agent cannot use an app until you do.
        </p>
      ) : null}
      {on && consent.pending.length === 0 && !anyApp ? (
        <p className="text-[13px] text-content/60">No app has asked yet.</p>
      ) : null}
      {consent.pending.map((item) => (
        <div key={item.id} className="flex flex-col gap-1">
          <p className="text-[13px] text-content">{item.app} is asking to be used in this project.</p>
          <p className="text-[12px] text-content/60" title={item.project}>
            In {projectBase(item.project)}.
          </p>
          <div className="flex gap-2">
            <SecondaryButton disabled={busy} onClick={() => onAllow(item.project, item.app)}>
              Allow
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={() => onRefuse(item.project, item.app)}>
              Don't allow
            </SecondaryButton>
          </div>
        </div>
      ))}
      <ul aria-label="Allowed apps" className="flex flex-col gap-1">
        {Object.entries(consent.projects).flatMap(([project, record]) =>
          record.apps.map((app) => (
            <li key={`${project}/${app}`} className="text-[13px] text-content">
              {app}
            </li>
          )),
        )}
      </ul>
      <ul aria-label="Refused apps" className="flex flex-col gap-1">
        {Object.entries(consent.projects).flatMap(([project, record]) =>
          record.refused.map((app) => (
            <li key={`${project}/${app}`} className="text-[13px] text-content">
              {app}
            </li>
          )),
        )}
      </ul>
      {projects.map((project) => {
        const visible = consent.projects[project]?.visible === true;
        const label = projects.length > 1 ? `Allow visible control in ${projectBase(project)}` : "Allow visible control";
        return (
          <button
            key={project}
            type="button"
            role="switch"
            aria-checked={visible}
            aria-label={label}
            disabled={busy}
            onClick={() => onVisible(project, !visible)}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              visible ? "bg-accent" : "bg-content/20"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
                visible ? "left-4.5" : "left-0.5"
              }`}
            />
          </button>
        );
      })}
      <p className="text-[12px] text-content/60">
        Headless until you allow it. Visible control moves the pointer and takes focus.
      </p>
    </section>
  );
}
