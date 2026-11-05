// WP-89: one control for the CLI, model and effort a scope's workers use.
// "Use the default" clears that scope. The line says what is in force.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { projectKey } from "../../../shared/lib/paths";
import { CLI_ORDER, cliLabel, isCli, isEffort } from "../model/clis";
import { launchCatalog } from "../model/launchCatalog";
import type { Pick } from "../model/resolve";
import { lineRulesFor } from "../model/lineRules";
import type { CrewRule } from "../model/rules";
import { crewRuleSentence, inForceSentence } from "../model/workerChoice";
import { cleanStoredDefault } from "../model/workerDefault";
import {
  commitRoster,
  findMono,
  listMonos,
  monosSnapshot,
  subscribeMonos,
} from "../../monos/model/mono";
import {
  projectWorkerDefault,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  systemWorkerDefault,
  useWorkerPoolVersion,
} from "../../monos/model/workerPool";
import {
  modelEffortSetting,
  modelsFor,
  resolveModel,
} from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";

export type WorkerDefaultScope = "mono" | "project" | "system";

const SELECT =
  "max-w-[60%] rounded-lg border border-content/10 bg-content/5 px-2 py-1 text-[13px] text-content outline-none focus:border-content/30";

function isHarness(cli: string): cli is HarnessId {
  return (HARNESSES as readonly string[]).includes(cli);
}

/** The Mono that works on this folder, when the project popover has no Mono of its own. */
function monoOnFolder(folder: string | undefined) {
  if (!folder) return undefined;
  const key = projectKey(folder);
  return listMonos().find((mono) => mono.projects.some((path) => projectKey(path) === key));
}

type EffortOption = { value: string; label: string; unsupported?: boolean };

export function WorkerDefaultControl({
  scope,
  monoId,
  projectId,
  projectFolder,
  title,
}: {
  scope: WorkerDefaultScope;
  monoId?: string;
  projectId?: string;
  projectFolder?: string;
  title?: string;
}) {
  useWorkerPoolVersion();
  useSyncExternalStore(subscribeMonos, monosSnapshot);
  // null: no pending choice. "": Claude Code was picked, and no model yet.
  const [pendingCli, setPendingCli] = useState<string | null>(null);
  const [problem, setProblem] = useState<string>();
  const [loadedRules, setLoadedRules] = useState<readonly CrewRule[] | null>(null);
  const loadedRulesRef = useRef<readonly CrewRule[] | null>(null);
  const catalog = launchCatalog();
  const storedMono = monoId ? findMono(monoId) : monoOnFolder(projectFolder);
  const pick =
    scope === "system"
      ? systemWorkerDefault()
      : scope === "project"
        ? projectId
          ? projectWorkerDefault(projectId)
          : undefined
        : storedMono?.workerDefault;
  const shownCli = pendingCli !== null ? pendingCli : pick?.cli && pick.cli !== "claude" ? pick.cli : "";
  const listCli = shownCli || "claude";
  const ownRules = storedMono?.crewRules ?? [];
  const folder = projectFolder?.trim() ?? "";
  // listMonos() builds a new object every read, so the effect keys on the rules' text.
  // A new object each render would fetch again forever. A late read for the previous
  // folder is dropped; a failed read leaves the line that is already showing.
  const rulesKey = `${storedMono?.id ?? ""}\0${JSON.stringify(ownRules)}`;
  useEffect(() => {
    let alive = true;
    const shown = ownRules;
    void lineRulesFor(folder || undefined, shown).then((rules) => {
      if (!alive || rules === null) return;
      const baseline = loadedRulesRef.current ?? shown;
      if (JSON.stringify(baseline) === JSON.stringify(rules)) return;
      loadedRulesRef.current = rules;
      setLoadedRules(rules);
    });
    return () => {
      alive = false;
    };
  }, [folder, rulesKey]);
  const rules = loadedRules ?? ownRules;
  const defaults =
    scope === "system"
      ? { system: systemWorkerDefault() }
      : scope === "mono"
        ? { mono: storedMono?.workerDefault, system: systemWorkerDefault() }
        : {
            mono: storedMono?.workerDefault,
            project: projectId ? projectWorkerDefault(projectId) : undefined,
            system: systemWorkerDefault(),
          };
  const line = [inForceSentence({ defaults, catalog, rules }), crewRuleSentence(rules, catalog)]
    .filter(Boolean)
    .join(" ");

  const efforts = effortOptions(listCli, pick?.model);
  const models = modelOptions(listCli);

  const write = (next: Pick | undefined) => {
    setProblem(undefined);
    if (scope === "system") {
      setSystemWorkerDefault(next);
      return;
    }
    if (scope === "project") {
      if (!projectId) return;
      if (!next?.model) {
        setProjectWorkerModel(projectId, undefined);
        return;
      }
      setProjectWorkerModel(projectId, {
        model: next.model,
        ...(next.effort ? { effort: next.effort } : {}),
        ...(next.cli && next.cli !== "claude" ? { cli: next.cli } : {}),
      });
      return;
    }
    if (!monoId) return;
    const result = commitRoster((roster) => {
      if (!roster.some((mono) => mono.id === monoId)) return null;
      return roster.map((mono) => {
        if (mono.id !== monoId) return mono;
        const copy = { ...mono };
        if (next) copy.workerDefault = next;
        else delete copy.workerDefault;
        return copy;
      });
    });
    if (result === "lost") setProblem("That change didn't stick. Try again.");
    else if (result === "missing") setProblem("That Mono isn't on this Mac.");
  };

  const onCli = (next: string) => {
    const cli = next && isCli(next) ? next : "";
    const target = cli || "claude";
    const offered = modelOptions(target).some((model) => model.id === pick?.model);
    if (scope === "project") {
      // Picking a CLI does not clear the saved default. It stays until a model is chosen.
      if (offered && pick?.model) {
        setPendingCli(null);
        write({
          cli: target,
          model: pick.model,
          ...(fits(target, pick.model, pick.effort) ? { effort: pick.effort } : {}),
        });
        return;
      }
      setPendingCli(cli);
      return;
    }
    setPendingCli(null);
    if (!cli) {
      if (offered && pick?.model) {
        write(
          cleanStoredDefault({
            cli: "claude",
            model: pick.model,
            ...(fits("claude", pick.model, pick.effort) ? { effort: pick.effort } : {}),
          }),
        );
      } else write(undefined);
      return;
    }
    if (offered && pick?.model) {
      write(
        cleanStoredDefault({
          cli,
          model: pick.model,
          ...(fits(cli, pick.model, pick.effort) ? { effort: pick.effort } : {}),
        }),
      );
      return;
    }
    write(cleanStoredDefault({ cli }));
  };

  const onModel = (modelId: string) => {
    if (!modelId) {
      setPendingCli(null);
      write(undefined);
      return;
    }
    const cli = listCli;
    const id = cli === "claude" ? resolveModel("claude", modelId).id : modelId;
    const effort = defaultEffort(cli, id);
    setPendingCli(null);
    if (scope === "project" && cli === "claude") {
      write({ model: id, ...(effort ? { effort } : {}) });
      return;
    }
    write(cleanStoredDefault({ cli, model: id, ...(effort ? { effort } : {}) }));
  };

  const onEffort = (value: string) => {
    if (!pick?.model || !isEffort(value)) return;
    const cli = pick.cli && pick.cli !== "claude" ? pick.cli : "claude";
    if (scope === "project" && cli === "claude") {
      write({ model: pick.model, effort: value });
      return;
    }
    write(cleanStoredDefault({ cli: pick.cli ?? cli, model: pick.model, effort: value }));
  };

  const clear = () => {
    setPendingCli(null);
    write(undefined);
  };

  const otherClis = CLI_ORDER.filter(
    (cli) => cli !== "claude" && isHarness(cli) && modelsFor(cli).length > 0,
  );
  const modelLabel = scope === "project" ? "Model for its workers" : "Model";
  const effortLabel = scope === "project" ? "Effort for its workers" : "Effort";

  return (
    <div className="flex flex-col gap-2" data-worker-default={scope}>
      {title ? <h3 className="text-[13px] font-medium text-content">{title}</h3> : null}
      <label className="flex items-center justify-between gap-2 text-[13px] text-content">
        CLI
        <select
          aria-label="CLI"
          className={SELECT}
          value={shownCli}
          onChange={(event) => onCli(event.target.value)}
        >
          <option value="">Claude Code</option>
          {otherClis.map((cli) => (
            <option key={cli} value={cli}>
              {cliLabel(cli)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-[13px] text-content">
        {modelLabel}
        <select
          aria-label={modelLabel}
          className={SELECT}
          value={models.some((model) => model.id === pick?.model) ? pick?.model : ""}
          data-project-worker-model={scope === "project" ? "" : undefined}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">Use the default</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      {pick?.model && efforts.length > 0 ? (
        <label className="flex items-center justify-between gap-2 text-[13px] text-content">
          Effort
          <select
            aria-label={effortLabel}
            className={SELECT}
            value={pick.effort && efforts.some((option) => option.value === pick.effort) ? pick.effort : efforts.find((option) => !option.unsupported)?.value}
            data-project-worker-effort={scope === "project" ? "" : undefined}
            onChange={(event) => onEffort(event.target.value)}
          >
            {efforts.map((option) => (
              <option key={option.value} value={option.value} disabled={option.unsupported}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="button"
        className="self-start text-[12px] text-content/55 hover:text-content"
        data-worker-default-clear=""
        onClick={clear}
      >
        Use the default
      </button>
      <p className="text-[12px] leading-4 text-content/60" data-worker-default-line>
        {line}
      </p>
      {problem ? (
        <p className="text-[12px] leading-4 text-content/70" role="alert" data-worker-default-problem>
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function modelOptions(cli: string): { id: string; name: string }[] {
  if (!isHarness(cli)) return [];
  return modelsFor(cli).map((model) => ({ id: model.id, name: model.name || model.id }));
}

function effortOptions(cli: string, modelId: string | undefined): EffortOption[] {
  if (!modelId || !isHarness(cli)) return [];
  const agent = modelsFor(cli).find((model) => model.id === modelId);
  const setting = agent ? modelEffortSetting(agent) : undefined;
  if (!setting) return [];
  return setting.options
    .filter((option) => isEffort(option.value))
    .map((option) => ({ value: option.value, label: option.label, unsupported: option.unsupported }));
}

function defaultEffort(cli: string, modelId: string): string | undefined {
  const options = effortOptions(cli, modelId).filter((option) => !option.unsupported);
  if (isHarness(cli)) {
    const agent = modelsFor(cli).find((model) => model.id === modelId);
    const setting = agent ? modelEffortSetting(agent) : undefined;
    if (setting && isEffort(setting.value) && options.some((option) => option.value === setting.value))
      return setting.value;
  }
  return options[0]?.value;
}

function fits(cli: string, modelId: string, effort: string | undefined): boolean {
  return !!effort && effortOptions(cli, modelId).some((option) => option.value === effort && !option.unsupported);
}
