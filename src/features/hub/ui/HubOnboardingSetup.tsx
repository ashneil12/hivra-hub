import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Loader } from "../../../shared/ui/icons";
import { pickFolders } from "../../../platform/tauri/fs";
import { hubData } from "../model/hubData";
import {
  checkHubSetup,
  defaultWorkFolders,
  recordedSetupChecks,
  rememberSetupFolder,
  SETUP_FACT_IDS,
  type SetupCheck,
  type SetupFactId,
} from "../model/setupProof";

/** The four checks in the words a first-time user reads (the ids stay technical for the code). */
const LABELS: Record<SetupFactId, string> = {
  installed: "Claude Code is installed",
  signedIn: "Claude Code is signed in",
  folder: "A folder is ready to work in",
  roundTrip: "A first reply comes back",
};

const WHAT_IF: Record<SetupFactId, string> = {
  installed: "MonoCode runs on Claude Code, which lives on your Mac like any other app.",
  signedIn: "Claude Code needs an account before it can answer.",
  folder: "This is where your projects' files will live.",
  roundTrip: "One real message, sent and answered, proves the whole chain works.",
};

/**
 * The setup a first launch has to actually reach (H7): four checks run for real, each written down when it passes, so
 * a proven setup is never asked about again. Nothing here is a question the person has to answer from memory.
 */
export function HubOnboardingSetup({
  onProvedChange,
  folder: initialFolder,
}: {
  onProvedChange: (proved: boolean) => void;
  /** A folder already picked outside this card. */
  folder?: string | null;
}) {
  const [checks, setChecks] = useState<SetupCheck[]>(recordedSetupChecks);
  const [folder, setFolder] = useState<string | null>(initialFolder ?? null);
  const [running, setRunning] = useState(true);
  const runId = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const run = useCallback(
    async (options: { refresh?: boolean; folder?: string | null } = {}) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      const id = ++runId.current;
      setRunning(true);
      let knownFolders: string[] = [];
      try {
        knownFolders = hubData()
          .listProjects()
          .map((project) => project.folder)
          .filter((path): path is string => Boolean(path));
      } catch {
        /* no projects yet, or the store is not up: the picker below is the way in */
      }
      const result = await checkHubSetup({
        folder: options.folder ?? folder,
        knownFolders,
        fallbackFolders: await defaultWorkFolders(),
        refresh: options.refresh === true,
        signal: controller.signal,
        onCheck: (next) => {
          if (id === runId.current && !controller.signal.aborted) setChecks(next);
        },
      });
      if (id !== runId.current || controller.signal.aborted) return;
      setChecks(result.checks);
      setRunning(false);
      onProvedChange(result.proved);
    },
    [folder, onProvedChange],
  );

  // One run when the card opens. Deferred a tick so StrictMode's development remount does not start it twice; the
  // cleanup aborts a run the remount replaces, so a slow CLI check never lands on an unmounted card.
  useEffect(() => {
    const timer = setTimeout(() => void run(), 0);
    return () => {
      clearTimeout(timer);
      inFlight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the first run only; "Check again" runs the rest
  }, []);

  const pick = async () => {
    try {
      const [picked] = await pickFolders("Choose a folder for your work");
      if (!picked) return;
      setFolder(picked);
      rememberSetupFolder(picked);
      await run({ folder: picked });
    } catch {
      /* the picker was closed, or the system refused: nothing changes */
    }
  };

  const proved = checks.length > 0 && SETUP_FACT_IDS.every((id) => checks.find((c) => c.id === id)?.state === "proved");

  return (
    <div className="flex flex-col gap-4" data-hub-setup data-proved={proved ? "yes" : "no"}>
      <div className="flex flex-col gap-1">
        <h1 className="text-[18px] text-content">Let's make sure it works</h1>
        <p className="text-[13px] leading-5 text-content/75">
          MonoCode checks the four things a chat needs, for real, before you start. It only asks again next launch for
          anything that did not pass.
        </p>
      </div>

      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li
            key={check.id}
            data-hub-setup-row={check.id}
            data-state={check.state}
            className="flex items-start gap-3 rounded-lg px-3 py-2"
          >
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
              {check.state === "proved" ? (
                <Check className="size-3.5" strokeWidth={2.5} />
              ) : check.state === "missing" ? (
                <CircleAlert className="size-3.5" />
              ) : (
                <Loader className="size-3.5 animate-spin motion-reduce:animate-none" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-content">{LABELS[check.id]}</span>
              <span className="block text-xs leading-5 text-content/60">
                {check.state === "checking" ? "Checking…" : check.detail || WHAT_IF[check.id]}
              </span>
            </span>
            {check.id === "folder" && check.state !== "proved" ? (
              <button
                type="button"
                data-hub-setup-folder
                onClick={() => void pick()}
                className="shrink-0 rounded-md px-2 py-1 text-[13px] text-content/70 hover:bg-content/8 hover:text-content"
              >
                Choose folder
              </button>
            ) : null}
            {check.id === "folder" && check.state === "proved" ? (
              <button
                type="button"
                data-hub-setup-folder
                onClick={() => void pick()}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-content/50 hover:bg-content/8 hover:text-content"
              >
                Change
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between">
        <button
          type="button"
          data-hub-setup-again
          disabled={running}
          onClick={() => void run({ refresh: true })}
          className="rounded-md px-2 py-1 text-[13px] text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-50"
        >
          {running ? "Checking…" : "Check again"}
        </button>
        {proved ? <span className="text-[13px] text-content/75" data-hub-setup-done>All four checks passed.</span> : null}
      </div>
    </div>
  );
}
