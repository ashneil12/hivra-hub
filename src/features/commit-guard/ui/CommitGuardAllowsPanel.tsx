import { useCallback, useEffect, useState } from "react";
import {
  listCommitGuardAllows,
  removeCommitGuardAllow,
  TRACKED_APPROVALS,
  type CommitGuardAllow,
} from "../model/allows";

export type ListAllows = () => Promise<CommitGuardAllow[]>;
export type RemoveAllow = (allow: CommitGuardAllow) => Promise<void>;

/** The lines the secret check lets through because a person allowed them, each with Remove. */
export function CommitGuardAllowsPanel({
  list = listCommitGuardAllows,
  remove = removeCommitGuardAllow,
}: {
  list?: ListAllows;
  remove?: RemoveAllow;
}) {
  const [allows, setAllows] = useState<CommitGuardAllow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    list()
      .then((next) => setAllows(Array.isArray(next) ? next : []))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [list]);

  useEffect(() => {
    load();
  }, [load]);

  const removeOne = async (allow: CommitGuardAllow) => {
    setError("");
    try {
      await remove(allow);
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <section aria-labelledby="commit-guard-allows-title" className="flex flex-col gap-3">
      <h3 id="commit-guard-allows-title" className="text-base font-medium">
        Allowed lines (secret check)
      </h3>
      <p className="text-sm">
        These lines passed the secret check because you allowed them. Remove one to check it again on the next push.
      </p>
      {allows === null ? <p className="text-sm">Loading the allowed lines.</p> : null}
      {allows !== null && allows.length === 0 ? <p className="text-sm">No line is allowed.</p> : null}
      {allows !== null && allows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {allows.map((allow) => (
            <li
              key={`${allow.repo}:${allow.file}:${allow.hash}`}
              data-allow-row
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span>
                {allow.file}
                {allow.hash === TRACKED_APPROVALS ? " (the whole file may stay tracked)" : ""}{" "}
                <span className="opacity-70">(repository {allow.repo.slice(0, 8)})</span>
              </span>
              <button
                type="button"
                onClick={() => void removeOne(allow)}
                className="rounded border px-3 py-1"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
