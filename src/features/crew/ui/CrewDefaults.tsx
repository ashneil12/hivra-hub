// WP-141: one screen for the crew default, the three roles, the lock and the fallback order.
// The worker default stays in the WP-89 store. Roles are ordinary crew rules. The lock lives beside them.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CLI_ORDER, EFFORTS, cliLabel, isCli } from "../model/clis";
import { launchCatalog } from "../model/launchCatalog";
import {
  CREW_SAVED_EVENT,
  EMPTY_POLICY,
  ROLE_SLOTS,
  cliIdOf,
  placeRoleSlots,
  roleSlotName,
  roleSlotsWithExtraRules,
  roleSlotsFrom,
  sanitizePolicy,
  type CrewPolicy,
  type RoleSlot,
  type SlotPick,
} from "../model/policy";
import type { Presence } from "../model/resolve";
import { sanitizeRule, type CrewRule } from "../model/rules";
import { crewRuleSentence, inForceSentence } from "../model/workerChoice";
import { projectWorkerDefault, systemWorkerDefault } from "../../monos/model/workerPool";
import { WorkerDefaultControl } from "./WorkerDefaultControl";

type Loaded = {
  rules?: unknown;
  revision?: number;
  policy?: unknown;
  /** False when this scope has no policy of its own, so `policy` is the one it inherits. */
  policyOwn?: boolean;
  signedIn?: Presence[];
};

export type CrewDefaultsInitial = {
  policy: CrewPolicy;
  rules: CrewRule[];
  revision: number;
  signedIn: Presence[];
};

type Props = {
  cwd?: string;
  /** Hub project id, when this folder is a project. The project worker default shows only then. */
  projectId?: string;
  /** When set, the screen never calls the app. The browser spec and tests use this. */
  initial?: CrewDefaultsInitial;
};

function placeFor(
  choice: "project" | "system",
  folder: string,
): { scope: "project" | "system"; scopeId: string } {
  if (choice === "project" && folder) return { scope: "project", scopeId: folder };
  return { scope: "system", scopeId: "system" };
}

function asRules(value: unknown): CrewRule[] {
  if (!Array.isArray(value)) return [];
  const out: CrewRule[] = [];
  for (const entry of value) {
    const rule = sanitizeRule(entry, "person");
    if (!rule) continue;
    out.push(rule);
    if (out.length >= 40) break;
  }
  return out;
}

export function CrewDefaults({ cwd, projectId, initial }: Props) {
  const folder = cwd?.trim() ?? "";
  // "For this project" needs a project: a folder that is not one (a Mono home, ~) has no project place.
  const projectPlace = Boolean(folder && projectId);
  const [scopeChoice, setScopeChoice] = useState<"project" | "system">(projectPlace ? "project" : "system");
  const place = placeFor(scopeChoice, projectPlace ? folder : "");
  const [policy, setPolicy] = useState<CrewPolicy>(() => sanitizePolicy(initial?.policy ?? EMPTY_POLICY));
  const [slots, setSlots] = useState(() => roleSlotsFrom(initial?.rules ?? []));
  const [rules, setRules] = useState<CrewRule[]>(() => asRules(initial?.rules ?? []));
  const [signedIn, setSignedIn] = useState<Presence[]>(initial?.signedIn ?? []);
  const [revision, setRevision] = useState(initial?.revision ?? 0);
  const [policyOwn, setPolicyOwn] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [neverDraft, setNeverDraft] = useState("");
  const [fallbackCli, setFallbackCli] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const dirty = useRef(false);
  // Only an edit to the lock or the lists writes the policy. A save of roles alone leaves the scope's policy as it was.
  const policyEdited = useRef(false);
  const saving = useRef(false);
  const loadGen = useRef(0);
  const placeNow = useRef(place);
  placeNow.current = place;

  function apply(got: Loaded) {
    const loaded = asRules(got.rules);
    setRules(loaded);
    setSlots(roleSlotsFrom(loaded));
    setPolicy(sanitizePolicy(got.policy));
    setPolicyOwn(got.policyOwn !== false);
    policyEdited.current = false;
    if (Array.isArray(got.signedIn)) setSignedIn(got.signedIn);
    setRevision(typeof got.revision === "number" ? got.revision : 0);
  }

  useEffect(() => {
    if (initial) return;
    dirty.current = false;
    const mine = ++loadGen.current;
    const asked = place;
    let alive = true;
    invoke<Loaded | undefined>("crew_rules_get", { scope: asked.scope, scopeId: asked.scopeId, project: cwd ?? null })
      .then((got) => {
        if (!alive || mine !== loadGen.current || !got || typeof got !== "object") return;
        if (dirty.current || saving.current) return;
        if (placeNow.current.scope !== asked.scope || placeNow.current.scopeId !== asked.scopeId) return;
        apply(got);
      })
      .catch(() => {
        if (alive && mine === loadGen.current) {
          setNotice("The saved settings couldn't be read. You can still edit, and saving will try again.");
        }
      });
    return () => {
      alive = false;
    };
  }, [initial, place.scope, place.scopeId, cwd, reloadTick]);

  useEffect(() => {
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; scopeId?: string }>).detail;
      if (!detail || dirty.current || saving.current) return;
      if (detail.scope !== placeNow.current.scope || detail.scopeId !== placeNow.current.scopeId) return;
      setReloadTick((tick) => tick + 1);
    };
    window.addEventListener(CREW_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(CREW_SAVED_EVENT, onSaved);
  }, []);

  function chooseScope(next: "project" | "system") {
    if (next === "project" && !projectPlace) return;
    if (next === place.scope) return;
    dirty.current = false;
    setNotice(null);
    setScopeChoice(next);
  }

  function editPolicy(next: CrewPolicy) {
    dirty.current = true;
    policyEdited.current = true;
    setPolicy(sanitizePolicy(next));
    setNotice(null);
  }

  function editSlot(role: RoleSlot, patch: Partial<SlotPick>) {
    dirty.current = true;
    setNotice(null);
    setSlots((current) => {
      const merged = { ...current[role], ...patch };
      const cleaned: SlotPick = {};
      if (merged.cli && isCli(merged.cli)) cleaned.cli = merged.cli;
      if (merged.model?.trim()) cleaned.model = merged.model;
      if (merged.effort) cleaned.effort = merged.effort;
      const copy = { ...current };
      if (!cleaned.cli && !cleaned.model && !cleaned.effort) delete copy[role];
      else copy[role] = cleaned;
      return copy;
    });
  }

  function addNever() {
    const raw = neverDraft;
    setNeverDraft("");
    if (!raw.trim()) return;
    // Only a CLI from the list is added. A typed name is mapped to its id ("Codex" is "codex"), so it matches a route.
    const accepted = cliIdOf(raw);
    if (!accepted) {
      setNotice("That isn't a CLI on the list, so it wasn't added. Pick one.");
      return;
    }
    if (policy.neverUse.includes(accepted)) {
      setNotice("That is already on the list.");
      return;
    }
    editPolicy({ ...policy, neverUse: [...policy.neverUse, accepted] });
  }

  function addFallback() {
    if (!fallbackCli) return;
    editPolicy({ ...policy, fallback: [...policy.fallback, fallbackCli] });
    setFallbackCli("");
  }

  function moveFallback(index: number, by: number) {
    const list = [...policy.fallback];
    const to = index + by;
    if (to < 0 || to >= list.length) return;
    const [item] = list.splice(index, 1);
    if (!item) return;
    list.splice(to, 0, item);
    editPolicy({ ...policy, fallback: list });
  }

  async function save() {
    const clean = sanitizePolicy(policy);
    setPolicy(clean);
    if (initial) {
      dirty.current = false;
      setNotice("Saved.");
      return;
    }
    const asked = place;
    const sent = placeRoleSlots(rules, slots).map((rule) => ({
      labels: rule.labels,
      paths: rule.paths,
      cli: rule.cli ?? null,
      model: rule.model ?? null,
      effort: rule.effort ?? null,
    }));
    const expected = revision;
    saving.current = true;
    try {
      const wrote = await invoke<Loaded | undefined>("crew_rules_set", {
        scope: asked.scope,
        scopeId: asked.scopeId,
        project: cwd ?? null,
        rules: sent,
        revision: expected,
        budget: null,
      });
      if (placeNow.current.scopeId !== asked.scopeId) {
        setNotice("Those settings were saved for the other place. Reload to see them.");
        return;
      }
      if (!wrote || typeof wrote.revision !== "number") {
        setNotice("Those settings couldn't be saved.");
        return;
      }
      if (!policyEdited.current) {
        // The lock and lists were not touched: keep what the scope had, and apply what the roles save returned.
        apply(wrote);
        dirty.current = false;
        window.dispatchEvent(new CustomEvent(CREW_SAVED_EVENT, { detail: { scope: asked.scope, scopeId: asked.scopeId } }));
        setNotice("Saved.");
        return;
      }
      const stored = await invoke<Loaded | undefined>("crew_policy_set", {
        scope: asked.scope,
        scopeId: asked.scopeId,
        project: cwd ?? null,
        policy: clean,
        revision: wrote.revision,
      });
      if (placeNow.current.scopeId !== asked.scopeId) {
        setNotice("Those settings were saved for the other place. Reload to see them.");
        return;
      }
      if (!stored || typeof stored.revision !== "number") {
        setNotice("The lock and the lists couldn't be saved. The roles were saved.");
        return;
      }
      apply(stored);
      dirty.current = false;
      window.dispatchEvent(new CustomEvent(CREW_SAVED_EVENT, { detail: { scope: asked.scope, scopeId: asked.scopeId } }));
      setNotice("Saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Those settings couldn't be saved.");
    } finally {
      saving.current = false;
    }
  }

  const catalog = launchCatalog();
  const shown = placeRoleSlots(rules, slots);
  // WP-141 L10: a second rule for a role still applies. The row shows the first, so the screen names the others.
  const extraRoles = roleSlotsWithExtraRules(rules);
  // WP-141 L9: the sentence names the lock and Never use, so a person sees what is in force beside the roles.
  const line = [inForceSentence({ defaults: { system: systemWorkerDefault(), ...(projectId ? { project: projectWorkerDefault(projectId) } : {}) }, catalog, rules: shown, policy }), crewRuleSentence(shown, catalog)]
    .filter(Boolean)
    .join(" ");
  const installed = signedIn.filter((row) => row.installed).map((row) => row.cli);
  const choices = (installed.length ? CLI_ORDER.filter((cli) => installed.includes(cli)) : [...CLI_ORDER]).filter(
    (cli) => !policy.fallback.includes(cli),
  );

  return (
    <section className="flex flex-col gap-4" data-setting-id="crew-defaults">
      <h2 className="text-sm font-medium text-content">Crew defaults</h2>
      <p className="text-[13px] text-content/70">What the crew uses unless a task names something else.</p>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[13px] font-medium text-content">Where this is saved</legend>
        <label className="flex items-center gap-2 text-[13px] text-content">
          <input
            type="radio"
            name="crew-defaults-scope"
            aria-label="For this project"
            checked={place.scope === "project"}
            disabled={!projectPlace}
            onChange={() => chooseScope("project")}
          />
          For this project
        </label>
        <label className="flex items-center gap-2 text-[13px] text-content">
          <input
            type="radio"
            name="crew-defaults-scope"
            aria-label="For everything"
            checked={place.scope === "system"}
            onChange={() => chooseScope("system")}
          />
          For everything
        </label>
      </fieldset>
      <WorkerDefaultControl scope="system" title="Default for every worker" projectFolder={cwd} />
      {projectId ? (
        <WorkerDefaultControl scope="project" projectId={projectId} projectFolder={cwd} title="Default for this project" />
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-content">Roles</h3>
        {ROLE_SLOTS.map((role) => {
          const name = roleSlotName(role);
          const pick = slots[role] ?? {};
          return (
            <div key={role} className="flex flex-wrap items-end gap-2" data-role-slot={role}>
              <span className="w-24 text-[13px] text-content">{name}</span>
              <Select label={`${name} CLI`} value={pick.cli ?? ""} options={CLI_ORDER.map((cli) => [cli, cliLabel(cli)])} onChange={(cli) => editSlot(role, { cli })} />
              <Field label={`${name} model`} value={pick.model ?? ""} onChange={(model) => editSlot(role, { model })} />
              <Select label={`${name} effort`} value={pick.effort ?? ""} options={EFFORTS.map((effort) => [effort, effort])} onChange={(effort) => editSlot(role, { effort })} />
            </div>
          );
        })}
      </div>
      {extraRoles.length ? (
        <p className="text-[12px] text-content/70" data-role-extra={extraRoles.join(",")}>
          {extraRoles.map((role) => roleSlotName(role)).join(" and ")} {extraRoles.length === 1 ? "has" : "have"} a second rule on the rules page. It still applies, so it is named here rather than hidden.
        </p>
      ) : null}
      {place.scope === "project" && !policyOwn ? (
        <p className="text-[12px] text-content/70" data-policy-inherited>
          From everything. The lock and lists below are the system's until this project changes them.
        </p>
      ) : null}
      <label className="flex items-center gap-2 text-[13px] text-content">
        <input
          type="checkbox"
          role="switch"
          aria-label="Always use my default"
          checked={policy.lockDefault}
          onChange={(event) => editPolicy({ ...policy, lockDefault: event.target.checked })}
        />
        Always use my default
      </label>
      <p className="text-[13px] text-content/70">When this is on, a task cannot switch away from the default.</p>
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-content">Never use</h3>
        <p className="text-[13px] text-content/70">A CLI or a Mono that is never chosen.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label="Never use"
            value={neverDraft}
            options={CLI_ORDER.map((cli) => [cli, cliLabel(cli)])}
            onChange={setNeverDraft}
          />
          <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" onClick={addNever}>
            Add
          </button>
        </div>
        <ul className="flex flex-col gap-1">
          {policy.neverUse.map((id) => (
            <li key={id} data-never-use={id} className="flex items-center gap-2 text-[13px] text-content">
              {isCli(id) ? cliLabel(id) : id}
              <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Remove ${id} from never use`} onClick={() => editPolicy({ ...policy, neverUse: policy.neverUse.filter((item) => item !== id) })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium text-content">Fallback order</h3>
        <p className="text-[13px] text-content/70">Tried in this order when the first one cannot take the work.</p>
        <ol className="flex flex-col gap-1">
          {policy.fallback.map((cli, index) => (
            <li key={cli} data-fallback={cli} className="flex items-center gap-2 text-[13px] text-content">
              {cliLabel(cli)}
              <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Move ${cliLabel(cli)} up`} disabled={index === 0} onClick={() => moveFallback(index, -1)}>
                Move up
              </button>
              <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Move ${cliLabel(cli)} down`} disabled={index === policy.fallback.length - 1} onClick={() => moveFallback(index, 1)}>
                Move down
              </button>
              <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" aria-label={`Remove ${cliLabel(cli)} from fallback`} onClick={() => editPolicy({ ...policy, fallback: policy.fallback.filter((item) => item !== cli) })}>
                Remove
              </button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-end gap-2">
          <Select label="Fallback CLI" value={fallbackCli} options={choices.map((cli) => [cli, cliLabel(cli)])} onChange={setFallbackCli} />
          <button type="button" className="rounded-md bg-content/8 px-2 py-1 text-xs" onClick={addFallback}>
            Add to fallback
          </button>
        </div>
      </div>
      <p className="text-[13px] text-content/80" data-crew-defaults-line>
        {line}
      </p>
      {notice ? <p className="text-[13px] text-content/80">{notice}</p> : null}
      <button type="button" className="self-start rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base" onClick={() => void save()}>
        Save
      </button>
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-content/70">
      {label}
      <input aria-label={label} className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[13px] text-content" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-content/70">
      {label}
      <select aria-label={label} className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[13px] text-content" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Any</option>
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
