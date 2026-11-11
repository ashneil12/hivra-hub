import { useState } from "react";
import { allowCommitGuardLine } from "../model/allows";
import { secretFinding } from "../model/refusal";

export type AllowLine = (repo: string, file: string, line: number) => Promise<void>;

/**
 * A commit or push the guard refused. A possible secret on a file line gets "Allow this line": a person's click is the
 * only thing that allows it, and only that line of that file in that repository. Other refusals show their text.
 */
export function CommitGuardRefusal({
  message,
  repo,
  allowLine = allowCommitGuardLine,
}: {
  message: string;
  repo: string;
  allowLine?: AllowLine;
}) {
  const finding = secretFinding(message);
  const [state, setState] = useState<"idle" | "busy" | "allowed" | "failed">("idle");
  const [error, setError] = useState("");

  if (!finding) {
    return (
      <p role="alert" data-guard-refusal className="text-sm">
        {message}
      </p>
    );
  }

  const allow = async () => {
    setState("busy");
    try {
      await allowLine(repo, finding.file, finding.line);
      setState("allowed");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setState("failed");
    }
  };

  return (
    <div role="alert" data-guard-refusal className="flex flex-col gap-2 text-sm">
      <p>
        Blocked: a possible secret is on line {finding.line} of {finding.file}. The value is not shown.
      </p>
      <p>If it is a test value, allow this line. Nothing else in the file is allowed.</p>
      {state === "allowed" ? (
        <p data-guard-allowed>Allowed. The next push checks this line again and lets it through.</p>
      ) : (
        <button
          type="button"
          disabled={state === "busy"}
          onClick={() => void allow()}
          className="self-start rounded border px-3 py-1"
        >
          Allow this line
        </button>
      )}
      {state === "failed" ? <p>{error}</p> : null}
    </div>
  );
}
