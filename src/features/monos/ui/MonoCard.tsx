// WP-182: one card for what a Mono is. Each section is one line until it is opened.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  defaultModelId,
  modelEffortLabel,
  modelEffortSetting,
  modelsFor,
  resolveModel,
} from "../../sessions/model/models";
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { WorkerDefaultControl } from "../../crew/ui/WorkerDefaultControl";
import { noteMonoSettings } from "../model/monoCardLog";
import {
  cardNames,
  findMono,
  isProjectLeadId,
  monoRole,
  saveMonoRole,
  subscribeMonos,
  updateMono,
  type Mono,
} from "../model/mono";
import { modelOffersFast, queueCardRun, settingsForCard } from "../model/monoRun";
import { SwitchRow } from "./monoPanelParts";

export type CardOffer = { name: string; kind: "skill" | "command" };

type Props = {
  monoId: string;
  cwd: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  busy?: boolean;
  offers?: readonly CardOffer[];
  onModelChange: (harness: HarnessId, model: string) => void;
  onModelSettingsChange: (settings: Record<string, string>) => void;
};

type Run = { harness: HarnessId; model: string; settings: Record<string, string> };

const SELECT =
  "max-w-full rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-[13px] text-content outline-none focus:border-content/30";

// findMono parses the roster on every read, so a fresh object each time would loop useSyncExternalStore.
const monoCache = new Map<string, { json: string; mono: Mono | undefined }>();

function monoSnapshot(monoId: string): Mono | undefined {
  const mono = findMono(monoId);
  const json = JSON.stringify(mono ?? null);
  const prev = monoCache.get(monoId);
  if (prev && prev.json === json) return prev.mono;
  const next = { json, mono };
  monoCache.set(monoId, next);
  return mono;
}

function sameRun(a: Run, b: Run): boolean {
  return a.harness === b.harness && a.model === b.model && JSON.stringify(a.settings) === JSON.stringify(b.settings);
}

export function MonoCard({
  monoId,
  cwd,
  harness,
  model,
  modelSettings,
  busy = false,
  offers,
  onModelChange,
  onModelSettingsChange,
}: Props) {
  const mono = useSyncExternalStore(subscribeMonos, () => monoSnapshot(monoId), () => monoSnapshot(monoId));
  const [loaded, setLoaded] = useState<readonly CardOffer[] | null>(null);
  const [override, setOverride] = useState<Run | null>(null);
  const fromProps: Run = { harness, model, settings: modelSettings };
  const run = override ?? fromProps;

  useEffect(() => {
    if (override && sameRun(override, fromProps)) setOverride(null);
  }, [override, harness, model, modelSettings]);

  useEffect(() => {
    if (offers) return;
    let gone = false;
    // The same slash catalog the composer uses. A harness command is kind "command"; a file skill stays a skill.
    void import("../../skills/model/skills")
      .then((mod) => mod.loadSkills({ harness, cwd }))
      .then((rows) => {
        if (gone) return;
        setLoaded(rows.map((row) => ({ name: row.name, kind: row.kind === "native" ? ("command" as const) : ("skill" as const) })));
      })
      .catch(() => {
        if (!gone) setLoaded([]);
      });
    return () => {
      gone = true;
    };
  }, [cwd, harness, offers]);

  const catalog = offers ?? loaded ?? [];
  const resolved = resolveModel(run.harness, run.model);
  const fastOn = modelOffersFast(resolved);
  const effort = modelEffortSetting(resolved);
  const effortLabel = modelEffortLabel(resolved, run.settings);
  const fast = fastOn && run.settings.fast === "true";

  function commit(next: Run, engineFast: boolean | undefined, summary: string) {
    const chosen = resolveModel(next.harness, next.model);
    const storedFast = modelOffersFast(chosen) ? engineFast : undefined;
    const settings = settingsForCard(chosen, next.settings, storedFast);
    const shown: Run = { harness: next.harness, model: chosen.id, settings };
    setOverride(shown);
    updateMono(monoId, (current) => {
      const updated = { ...current, engine: shown.harness, engineModel: shown.model };
      if (typeof storedFast === "boolean") updated.engineFast = storedFast;
      else delete updated.engineFast;
      return updated;
    });
    if (busy) {
      queueCardRun({
        monoId,
        harness: shown.harness,
        model: shown.model,
        settings,
        ...(typeof storedFast === "boolean" ? { engineFast: storedFast } : {}),
      });
    } else {
      onModelChange(shown.harness, shown.model);
      onModelSettingsChange(settings);
    }
    noteMonoSettings(monoId, summary);
  }

  function onHarness(nextHarness: HarnessId) {
    const nextModel = resolveModel(nextHarness, defaultModelId(nextHarness));
    const keptFast = modelOffersFast(nextModel) ? mono?.engineFast : undefined;
    commit(
      { harness: nextHarness, model: nextModel.id, settings: run.settings },
      keptFast,
      `Runs on ${HARNESS_TITLE[nextHarness] ?? nextHarness}.`,
    );
  }

  function onModel(nextModel: string) {
    const chosen = resolveModel(run.harness, nextModel);
    const setting = modelEffortSetting(chosen);
    const kept = setting && run.settings[setting.id] && setting.options.some((option) => option.value === run.settings[setting.id])
      ? run.settings[setting.id]
      : setting?.value;
    const settings = { ...run.settings };
    if (setting && kept) settings[setting.id] = kept;
    const keptFast = modelOffersFast(chosen) ? mono?.engineFast : undefined;
    commit(
      { harness: run.harness, model: chosen.id, settings },
      keptFast,
      `Runs on ${chosen.name}.`,
    );
  }

  function onEffort(value: string) {
    if (!effort) return;
    commit(
      { ...run, settings: { ...run.settings, [effort.id]: value } },
      mono?.engineFast,
      `Effort set to ${effort.options.find((option) => option.value === value)?.label ?? value}.`,
    );
  }

  function onFast(on: boolean) {
    commit({ ...run, settings: run.settings }, on, on ? "Fast mode on." : "Fast mode off.");
  }

  const harnesses = HARNESSES.filter((id) => id === run.harness || modelsFor(id).length > 0);
  const models = modelsFor(run.harness);
  const role = mono ? monoRole(mono) : undefined;
  const lead = isProjectLeadId(monoId);

  return (
    <div data-mono-card={monoId} className="mb-6 flex flex-col border-y border-stroke">
      <Section id="role" title="Role" summary={role || "No role"}>
        {lead ? (
          <p className="text-[13px] text-content/70">{role}</p>
        ) : (
          <RoleField monoId={monoId} role={mono?.role ?? ""} />
        )}
      </Section>
      <Section
        id="runs"
        title="Runs on"
        summary={[HARNESS_TITLE[run.harness] ?? run.harness, resolved.name, effortLabel, fast ? "fast" : undefined]
          .filter(Boolean)
          .join(", ")}
      >
        <div data-mono-card-runs className="flex flex-col gap-2">
          <label className="flex items-center justify-between gap-3 text-[13px] text-content/80">
            CLI
            <select aria-label="CLI" className={SELECT} value={run.harness} onChange={(event) => onHarness(event.target.value as HarnessId)}>
              {harnesses.map((id) => (
                <option key={id} value={id}>
                  {HARNESS_TITLE[id] ?? id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-[13px] text-content/80">
            Model
            <select aria-label="Model" className={SELECT} value={resolved.id} onChange={(event) => onModel(event.target.value)}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              {models.some((item) => item.id === resolved.id) ? null : <option value={resolved.id}>{resolved.name}</option>}
            </select>
          </label>
          {effort ? (
            <label className="flex items-center justify-between gap-3 text-[13px] text-content/80">
              Effort
              <select aria-label="Effort" className={SELECT} value={run.settings[effort.id] ?? effort.value} onChange={(event) => onEffort(event.target.value)}>
                {effort.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {fastOn ? <SwitchRow label="Fast" description="Answers sooner on this model." on={fast} onChange={onFast} /> : null}
        </div>
      </Section>
      <Section id="workers" title="Its workers" summary="What its workers run on">
        <div data-mono-card-workers>
          <WorkerDefaultControl scope="mono" monoId={monoId} />
        </div>
      </Section>
      <Section id="fallback" title="Fallback" summary="Not set up yet.">
        <p data-mono-card-fallback className="text-[13px] text-content/60">
          Not set up yet.
        </p>
      </Section>
      <Section
        id="skills"
        title="Skills and commands"
        summary={mono?.skills?.length || mono?.commands?.length ? [...(mono.skills ?? []), ...(mono.commands ?? [])].join(", ") : "Everything installed"}
      >
        <OfferList
          monoId={monoId}
          kind="skill"
          label="Skills"
          saved={mono?.skills ?? []}
          offers={catalog.filter((item) => item.kind === "skill").map((item) => item.name)}
        />
        <OfferList
          monoId={monoId}
          kind="command"
          label="Commands"
          saved={mono?.commands ?? []}
          offers={catalog.filter((item) => item.kind === "command").map((item) => item.name)}
        />
      </Section>
    </div>
  );
}

function RoleField({ monoId, role }: { monoId: string; role: string }) {
  const [value, setValue] = useState(role);
  return (
    <input
      aria-label="Role"
      value={value}
      maxLength={40}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        const next = value.trim().slice(0, 40);
        if (next === role.trim()) return;
        saveMonoRole(monoId, next);
        noteMonoSettings(monoId, next ? `Role set to ${next}.` : "Role cleared.");
      }}
      className="w-full rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-[13px] text-content outline-none focus:border-content/30"
    />
  );
}

function OfferList({
  monoId,
  kind,
  label,
  saved,
  offers,
}: {
  monoId: string;
  kind: "skill" | "command";
  label: string;
  saved: readonly string[];
  offers: readonly string[];
}) {
  const names = [...offers];
  for (const name of saved) if (!names.includes(name)) names.push(name);
  function toggle(name: string) {
    const next = saved.includes(name) ? saved.filter((item) => item !== name) : [...saved, name];
    const clean = cardNames([...next]);
    updateMono(monoId, (current) => {
      const updated = { ...current };
      if (clean) updated[kind === "skill" ? "skills" : "commands"] = clean;
      else delete updated[kind === "skill" ? "skills" : "commands"];
      return updated;
    });
    noteMonoSettings(
      monoId,
      clean ? `${label} set to ${clean.join(", ")}.` : `${label} cleared. Everything installed is offered.`,
    );
  }
  return (
    <div className="mb-2" data-mono-card-offers={kind}>
      <p className="pb-1 text-[12px] text-content/45">{saved.length ? label : `${label}: everything installed is offered`}</p>
      {names.length ? (
        <ul className="flex flex-col gap-1">
          {names.map((name) => {
            const missing = !offers.includes(name);
            return (
              <li key={name}>
                <label className="flex items-center gap-2 text-[13px] text-content/85">
                  <input
                    type="checkbox"
                    aria-label={`${label} ${name}`}
                    checked={saved.includes(name)}
                    onChange={() => toggle(name)}
                  />
                  <span>{name}</span>
                  {missing ? <span className="text-[12px] text-content/45">not installed here</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-content/55">Nothing installed to pick from yet.</p>
      )}
    </div>
  );
}


function Section({
  id,
  title,
  summary,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-stroke last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        data-mono-card-section={id}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline gap-3 px-1 py-2 text-left"
      >
        <span className="w-40 shrink-0 text-[13px] text-content">{title}</span>
        <span className="min-w-0 truncate text-[13px] text-content/50">{summary}</span>
      </button>
      {open ? <div className="px-1 pb-3">{children}</div> : null}
    </section>
  );
}
