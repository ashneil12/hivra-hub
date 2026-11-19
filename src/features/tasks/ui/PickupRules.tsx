// WP-250: a first mate picks up unassigned tasks that match its rule, without being assigned each one.

import { useEffect, useState } from "react";
import { listMonos, monoLook } from "../../monos/model/mono";
import {
  describeRule,
  firstMatesFor,
  loadPickupRules,
  removePickupRule,
  savePickupRule,
  splitNames,
  type PickupRule,
} from "../model/pickupRules";

const field = "rounded-md border border-stroke bg-transparent px-2 py-1 text-[12px] text-content";

export function PickupRules({ project, folder }: { project: string; folder: string }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<PickupRule[] | null>(null);
  const [note, setNote] = useState("");

  const reload = () =>
    loadPickupRules()
      .then(setRules)
      .catch(() => setNote("Couldn't read the pickup rules."));

  useEffect(() => {
    if (open) void reload();
  }, [open]);

  if (!open) {
    return (
      <button type="button" className="mt-2 block text-[12px] text-content/70" onClick={() => setOpen(true)}>
        Pickup rules
      </button>
    );
  }

  let mates: { session: string; name: string }[] = [];
  try {
    mates = firstMatesFor(listMonos(), project, folder, (mono) => monoLook(mono).name);
  } catch {
    mates = [];
  }
  const nameOf = (session: string) => mates.find((mate) => mate.session === session)?.name;

  return (
    <section aria-label="Pickup rules" className="mt-3 rounded-md border border-stroke p-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-medium text-content/80">Pickup rules</h3>
        <button type="button" className="text-[12px] text-content/60" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="mt-1 text-[12px] text-content/50">
        A first mate takes an unassigned task that matches its rule, and hears about it once.
      </p>
      {note ? <p className="mt-1 text-[12px] text-content/70">{note}</p> : null}
      <ul className="mt-2 flex flex-col gap-1">
        {(rules ?? []).map((rule) => (
          <li key={rule.ownerSession} className="flex items-center gap-2 text-[12px] text-content/80">
            <span className="min-w-0 flex-1">
              <span className="text-content">{nameOf(rule.ownerSession) ?? "A chat not in this project"}</span>:{" "}
              {describeRule(rule, project)}
            </span>
            <button
              type="button"
              hidden={!rule.project}
              className="text-content/60"
              onClick={() =>
                void savePickupRule({ ...rule, enabled: !rule.enabled })
                  .then(reload)
                  .catch((error) => setNote(String(error)))
              }
            >
              {rule.enabled ? "Turn off" : "Turn on"}
            </button>
            <button
              type="button"
              className="text-content/60"
              onClick={() =>
                void removePickupRule(rule.ownerSession)
                  .then(reload)
                  .catch((error) => setNote(String(error)))
              }
            >
              Remove
            </button>
          </li>
        ))}
        {rules && rules.length === 0 ? <li className="text-[12px] text-content/50">No rules yet.</li> : null}
      </ul>
      {mates.length === 0 ? <p className="mt-2 text-[12px] text-content/60">No first mates work on this project yet.</p> : null}
      <form
        hidden={mates.length === 0 || !project}
        aria-label="New pickup rule"
        className="mt-2 flex flex-wrap gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const owner = String(data.get("owner") ?? "").trim();
          if (!owner) return;
          const statuses = splitNames(String(data.get("statuses") ?? ""));
          const labels = splitNames(String(data.get("labels") ?? ""));
          void savePickupRule({
            ownerSession: owner,
            project,
            statuses,
            labels,
            enabled: true,
          })
            .then(() => {
              form.reset();
              setNote("");
              return reload();
            })
            .catch((error) => setNote(String(error)));
        }}
      >
        <select name="owner" aria-label="First mate" className={`w-36 ${field}`} defaultValue="">
          <option value="" disabled>
            First mate
          </option>
          {mates.map((mate) => (
            <option key={mate.session} value={mate.session}>
              {mate.name}
            </option>
          ))}
        </select>
        <input name="statuses" aria-label="Statuses" placeholder="Statuses, e.g. Todo" className={`w-36 ${field}`} />
        <input name="labels" aria-label="Labels" placeholder="Labels, e.g. bug" className={`w-32 ${field}`} />
        <button type="submit" className="text-[12px] text-content/70">
          Save rule
        </button>
      </form>
    </section>
  );
}
