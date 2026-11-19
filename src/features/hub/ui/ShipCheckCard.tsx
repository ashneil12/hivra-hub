// SC-3b: the ship check on a project's crew tab. A project that tests at ship (Settings > How tasks are tested) doesn't test
// each task: the real tests and a review run once, here, over everything that landed since the last passed check. One
// button runs it and the last result stays under it: the outcome in plain words, the version it covered, then what was
// tested and what was not. A result that could not run says so and is never shown as a pass (model/shipCheck.ts).
//
// Shown when the project tests at ship, or when it already has a record. A late answer never lands on another project,
// and a second click joins the run that is out instead of starting another.
import { useEffect, useRef, useState } from "react";
import { loadTestingMode, type TestingMode, type TestingModeRead } from "../../delivery/model/testingMode";
import { pathKey } from "../../../shared/lib/paths";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import {
  commitsLine,
  latestShipCheck,
  outcomeWord,
  runShipCheck,
  shipCheckRunning,
  shortSha,
  subscribeShipChecks,
  tauriShipCheck,
  type ShipCheckBackend,
  type ShipCheckRecord,
} from "../model/shipCheck";
import { stageAge } from "../model/verifyStage";

const READ_PROBLEM = "Couldn't read the last ship check.";

function List({ name, kind, lines, none }: { name: string; kind: "tested" | "not-tested" | "findings"; lines: readonly string[]; none: string }) {
  return (
    <div className="min-w-0" data-ship-check-list={kind}>
      <h4 className="text-[12px] font-medium text-content/80">{name}</h4>
      {lines.length ? (
        <ul className="mt-0.5 list-disc pl-4 text-[12px] leading-relaxed text-content/70">
          {lines.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 text-[12px] text-content/60">{none}</p>
      )}
    </div>
  );
}

export function ShipCheckCard({
  project,
  backend = tauriShipCheck,
  loadMode = loadTestingMode,
  quiet = false,
}: {
  /** The project's folder. */
  project: string;
  backend?: ShipCheckBackend;
  loadMode?: (project: string) => Promise<Pick<TestingModeRead, "mode">>;
  /** Another primary button is on this surface: this one is quiet. */
  quiet?: boolean;
}) {
  const folder = project.trim();
  const [mode, setMode] = useState<TestingMode | null>(null);
  const [record, setRecord] = useState<ShipCheckRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The project's version now, read with the record: a result for another version says so. None when it can't be read.
  const [headNow, setHeadNow] = useState<string | null>(null);
  // Bumped by every project change, so an answer for the project before this one is dropped.
  const gen = useRef(0);
  const folderNow = useRef(folder);
  folderNow.current = folder;

  useEffect(() => {
    const mine = ++gen.current;
    setMode(null);
    setRecord(null);
    setHeadNow(null);
    setLoaded(false);
    setProblem(null);
    // A run already out for this project (another card, a first mate's tool call) is this card's to show too.
    setRunning(folder ? shipCheckRunning(folder) : false);
    if (!folder) {
      setLoaded(true);
      return;
    }
    // After a run ends: the record the app kept, and the version the project is at now.
    const refresh = () => {
      void Promise.allSettled([latestShipCheck(folder, backend), (async () => backend.head(folder))()]).then(
        ([recordRead, headRead]) => {
          if (mine !== gen.current) return;
          if (recordRead.status === "fulfilled" && recordRead.value) setRecord(recordRead.value);
          setHeadNow(headRead.status === "fulfilled" ? headRead.value : null);
        },
      );
    };
    // Every run for this folder, whoever asked for it (this card's button, a first mate's tool call, another card).
    const stop = subscribeShipChecks((event) => {
      if (mine !== gen.current || pathKey(event.cwd) !== pathKey(folder)) return;
      if (event.phase === "started") {
        setRunning(true);
        setProblem(null);
        return;
      }
      setRunning(false);
      if (event.error) {
        setProblem(event.error);
        return;
      }
      setProblem(null);
      if (event.record) setRecord(event.record);
      refresh();
    });
    void Promise.allSettled([
      (async () => loadMode(folder))(),
      latestShipCheck(folder, backend),
      (async () => backend.head(folder))(),
    ]).then(([modeRead, recordRead, headRead]) => {
      if (mine !== gen.current) return;
      if (modeRead.status === "fulfilled") setMode(modeRead.value.mode);
      if (recordRead.status === "fulfilled") setRecord((current) => current ?? recordRead.value);
      else setProblem((current) => current ?? READ_PROBLEM);
      setHeadNow(headRead.status === "fulfilled" ? headRead.value : null);
      setLoaded(true);
    });
    return () => {
      stop();
      gen.current += 1;
    };
  }, [folder, backend, loadMode]);

  function start() {
    const target = folderNow.current;
    // The model hands every ask for this project the same run, so a second click can't start another. It tells every card,
    // this one included, when the run starts and how it ends.
    if (!target || running || shipCheckRunning(target)) return;
    void runShipCheck(target, backend).catch(() => undefined);
  }

  if (!loaded || !folder) return null;
  if (mode !== "at-ship" && !record && !running) return null;

  const movedTo =
    record && headNow && headNow.trim() && headNow.trim().toLowerCase() !== record.head.trim().toLowerCase()
      ? shortSha(headNow)
      : null;
  const outcome = record?.outcome ?? null;
  const age = record && record.at > 0 ? `, ${stageAge(record.at)}` : "";
  return (
    <section
      aria-label="Ship check"
      data-ship-check
      data-ship-check-state={running ? "running" : (outcome ?? "none")}
      className="flex flex-col gap-2 border-b border-stroke px-3 py-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-content">Ship check</h3>
          <p className="mt-0.5 text-[12px] text-content/60" data-ship-check-summary>
            {running ? (
              "Running now. The checks, the real-app check, the end-to-end check and the review can take a few minutes."
            ) : record && outcome ? (
              <>
                <span className="font-medium text-content" data-ship-check-outcome={outcome}>
                  {outcomeWord(outcome)}
                </span>{" "}
                for version <span data-ship-check-version>{shortSha(record.head)}</span>
                {age}. It covered {commitsLine(record.commitsCovered)}.
              </>
            ) : (
              "Tests and review run once, when you ship. Nothing has been checked for this project yet."
            )}
          </p>
        </div>
        {quiet ? (
          <SecondaryButton data-ship-check-run="" disabled={running} aria-busy={running} onClick={start}>
            {running ? "Running…" : "Run ship check"}
          </SecondaryButton>
        ) : (
          <button
            type="button"
            data-ship-check-run=""
            disabled={running}
            aria-busy={running}
            onClick={start}
            className="shrink-0 rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40"
          >
            {running ? "Running…" : "Run ship check"}
          </button>
        )}
      </div>
      {problem ? (
        <p className="text-[12px] text-content/60" data-ship-check-problem>
          {problem}
        </p>
      ) : null}
      {record && !running ? (
        <div className="flex flex-col gap-2" data-ship-check-result>
          {record.note ? (
            <p className="text-[12px] text-content/60" data-ship-check-note>
              {record.note}
            </p>
          ) : null}
          {movedTo ? (
            <p className="text-[12px] text-content/60" data-ship-check-moved>
              The project is now at {movedTo}, so this result is for an earlier version.
            </p>
          ) : null}
          <List name="Tested" kind="tested" lines={record.tested} none="Nothing ran." />
          <List name="Not tested" kind="not-tested" lines={record.notTested} none="Nothing was left out." />
          {/* PT-5: named test findings (a real bug, a quarantined flaky test) never hide: they pass the check and stay in view. */}
          {record.findings?.length ? (
            <List name="Findings" kind="findings" lines={record.findings.map((finding) => finding.line)} none="" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
