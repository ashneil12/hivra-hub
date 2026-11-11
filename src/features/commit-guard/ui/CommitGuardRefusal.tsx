import { useEffect, useState } from "react";
import { allowCommitGuardLine } from "../model/allows";
import { refusalId, refusalWords } from "../model/refusal";
import { getCommitGuardRefusal, type CommitGuardRefusalView } from "../model/refusals";

export type AllowLine = (id: string) => Promise<void>;
export type FetchRefusal = (id: string) => Promise<CommitGuardRefusalView | null>;

/**
 * A commit or push the guard refused. The banner's facts come from the app's record of the refusal (by its id), never
 * from the message. "Allow this line" appears only for a record the app holds, and it sends only the id.
 */
export function CommitGuardRefusal({
  message,
  allowLine = allowCommitGuardLine,
  fetchRefusal = getCommitGuardRefusal,
}: {
  message: string;
  allowLine?: AllowLine;
  fetchRefusal?: FetchRefusal;
}) {
  const id = refusalId(message);
  // undefined while the record is being read; null when the app holds no such refusal.
  const [view, setView] = useState<CommitGuardRefusalView | null | undefined>(undefined);
  const [state, setState] = useState<"idle" | "busy" | "allowed" | "failed">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    let live = true;
    fetchRefusal(id)
      .then((next) => live && setView(next))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [id, fetchRefusal]);

  if (!id || view === undefined) {
    return (
      <p role="alert" data-guard-refusal className="text-sm">
        {message}
      </p>
    );
  }
  if (view === null) {
    return (
      <p role="alert" data-guard-refusal className="text-sm">
        This refusal is no longer on record, so it cannot be allowed here. Run the check again.
      </p>
    );
  }

  const words = refusalWords(view);
  const allow = async () => {
    setState("busy");
    try {
      await allowLine(view.id);
      setState("allowed");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setState("failed");
    }
  };

  return (
    <div role="alert" data-guard-refusal className="flex flex-col gap-2 text-sm">
      <p>{words.headline}</p>
      <p>{words.why}</p>
      {state === "allowed" ? (
        <p data-guard-allowed>{words.allowed}</p>
      ) : (
        <button
          type="button"
          disabled={state === "busy"}
          onClick={() => void allow()}
          className="self-start rounded border px-3 py-1"
        >
          {words.button}
        </button>
      )}
      {state === "failed" ? <p>{error}</p> : null}
    </div>
  );
}
