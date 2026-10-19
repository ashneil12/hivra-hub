import { useCallback, useEffect, useState } from "react";
import {
  CheckCheck,
  CheckCircle,
  CloudUpload,
  Loader,
  Play,
  Square,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from "../../../shared/ui/icons";
import { prettyCwd, projectName } from "../../../shared/lib/paths";
import {
  forgetProjectFile,
  importProjectFile,
  listProjectActions,
  onProjectActionEvent,
  runProjectAction,
  runStatusLabel,
  stopProjectAction,
  type ActionRun,
  type ActionsListing,
  type ProjectAction,
  type ProjectActionEvent,
} from "../../projects/model/projectActions";
import type { Worktree } from "../model/worktrees";

const ICONS = {
  setup: Wrench,
  play: Play,
  check: CheckCircle,
  ship: CloudUpload,
  build: Zap,
  test: CheckCheck,
  terminal: Terminal,
  clean: Trash2,
} as const;

function ActionIcon({ icon, className }: { icon?: string; className?: string }) {
  const Icon = ICONS[(icon ?? "play") as keyof typeof ICONS] ?? Play;
  return <Icon className={className} />;
}

/** Apply one live event to the listing's runs: a new or finished run replaces its record, a line extends its tail. */
export function applyActionEvent(
  listing: ActionsListing,
  event: ProjectActionEvent,
): ActionsListing {
  if (event.run) {
    if (event.run.projectRoot !== listing.status.projectRoot) return listing;
    const others = listing.runs.filter((run) => run.id !== event.run!.id);
    const previous = listing.runs.find((run) => run.id === event.run!.id);
    // A finished record carries the full tail; a start record may race lines already shown.
    const run =
      previous && event.run.status === "running" && previous.tail.length > event.run.tail.length
        ? { ...event.run, tail: previous.tail }
        : event.run;
    return { ...listing, runs: [run, ...others].sort((a, b) => b.startedAt - a.startedAt) };
  }
  if (event.line === undefined) return listing;
  let changed = false;
  const runs = listing.runs.map((run) => {
    if (run.id !== event.runId || run.status !== "running") return run;
    changed = true;
    return { ...run, tail: [...run.tail, event.line!].slice(-200) };
  });
  return changed ? { ...listing, runs } : listing;
}

function ActionFlags({ action }: { action: ProjectAction }) {
  const flags = [
    action.runOnWorktreeCreate &&
      (action.hold === false ? "runs on new worktrees" : "runs on new worktrees, first turn waits"),
    action.longRunning && "keeps running until stopped",
    action.confirm && "asks before it runs",
  ].filter(Boolean);
  return flags.length ? (
    <span className="text-[10px] text-content/45">{flags.join(" · ")}</span>
  ) : null;
}

export function ProjectActionsPanel({
  project,
  worktrees,
}: {
  project: string;
  worktrees: Worktree[];
}) {
  const [listing, setListing] = useState<ActionsListing>();
  const [error, setError] = useState<string>();
  const [checkout, setCheckout] = useState(project);
  const [confirming, setConfirming] = useState<ProjectAction>();
  const [openRun, setOpenRun] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setListing(await listProjectActions(project));
      setError(undefined);
    } catch (e) {
      setListing(undefined);
      setError(String(e));
    }
  }, [project]);

  useEffect(() => {
    setCheckout(project);
    setConfirming(undefined);
    setOpenRun(undefined);
    void load();
  }, [project, load]);

  useEffect(
    () =>
      onProjectActionEvent((event) =>
        setListing((current) => (current ? applyActionEvent(current, event) : current)),
      ),
    [],
  );

  const status = listing?.status;
  const reviewFile = status?.file;
  const needsReview =
    status && (status.state === "new" || status.state === "changed") && !!reviewFile;

  const run = async (action: ProjectAction) => {
    if (action.confirm && confirming?.id !== action.id) {
      setConfirming(action);
      return;
    }
    setConfirming(undefined);
    setError(undefined);
    try {
      const started = await runProjectAction(checkout, action.id);
      setListing((current) =>
        current ? applyActionEvent(current, { runId: started.id, run: started }) : current,
      );
      setOpenRun(started.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const trust = async () => {
    if (!status?.fileHash) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await importProjectFile(project, status.fileHash);
      setListing((current) =>
        current
          ? { ...current, status: next, actions: next.trusted?.actions ?? [] }
          : current,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    try {
      const next = await forgetProjectFile(project);
      setListing((current) => (current ? { ...current, status: next, actions: [] } : current));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkouts = worktrees.filter((tree) => !tree.missing);

  return (
    <section
      data-setting-id="project-actions"
      id="setting-project-actions"
      className="flex flex-col gap-3 rounded-xl border border-stroke p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium">Project actions</h3>
        {status && (
          <span className="break-all text-[11px] text-content/40">
            {prettyCwd(status.path)}
          </span>
        )}
      </div>
      {/* Not role="alert": the page's own alert is about the worktree list. */}
      {error && <p className="break-words text-[12px] text-red-400">{error}</p>}
      {!listing && !error && (
        <p className="flex items-center gap-2 text-[12px] text-content/50">
          <Loader className="size-4 animate-spin" />
          Reading the project file…
        </p>
      )}
      {status?.state === "none" && (
        <p className="text-[12px] text-content/50">
          This project has no .monocode/project.json in its main checkout. Add one to give new
          worktrees a setup step and get one-click actions here.
        </p>
      )}
      {status?.error && status.state !== "none" && (
        <p className="break-words text-[12px] text-amber-400">{status.error}</p>
      )}
      {needsReview && (
        <div className="flex flex-col gap-2 rounded-lg bg-content/5 p-3">
          <p className="text-[12px] text-content/70">
            {status.state === "changed"
              ? "The project file changed since you imported it. The imported version still runs until you import this one."
              : "Review before importing. Nothing in this file runs until you import it. It is read from the main checkout only, so a branch can't change it."}
          </p>
          <ul className="flex flex-col gap-1.5">
            {reviewFile.actions.map((action) => (
              <li key={action.id} className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-[12px] font-medium">
                  <ActionIcon icon={action.icon} className="size-3.5 text-content/50" />
                  {action.name}
                </span>
                <code className="break-all text-[11px] text-content/60">{action.command}</code>
                <ActionFlags action={action} />
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void trust()}
              className="flex h-7 items-center gap-1.5 rounded-md bg-content/10 px-2.5 text-[12px] font-medium hover:bg-content/15 disabled:opacity-40 active:scale-[0.97]"
            >
              <CheckCircle className="size-3.5" />
              Import these actions
            </button>
          </div>
        </div>
      )}
      {status?.trusted && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-wrap items-center gap-2 text-[11px] text-content/55">
            Run in
            <select
              aria-label="Checkout to run actions in"
              value={checkout}
              onChange={(event) => setCheckout(event.target.value)}
              className="h-7 max-w-full rounded-md bg-content/5 px-2 text-[12px] text-content"
            >
              {checkouts.map((tree) => (
                <option key={tree.path} value={tree.path}>
                  {projectName(tree.path)}
                  {tree.branch ? ` (${tree.branch})` : ""}
                  {tree.isMain ? " · main checkout" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {listing!.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                title={action.description ?? action.command}
                onClick={() => void run(action)}
                className="flex h-7.5 items-center gap-1.5 rounded-md bg-content/8 px-2.5 text-[12px] hover:bg-content/12 active:scale-[0.97]"
              >
                <ActionIcon icon={action.icon} className="size-3.5" />
                {action.name}
              </button>
            ))}
          </div>
          {confirming && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 p-2.5 text-[12px]">
              <span className="min-w-0 flex-1">{confirming.confirm}</span>
              <button
                type="button"
                onClick={() => void run(confirming)}
                className="h-7 rounded-md bg-content/10 px-2.5 font-medium hover:bg-content/15"
              >
                Run {confirming.name}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(undefined)}
                className="h-7 rounded-md px-2.5 text-content/60 hover:bg-content/8"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {!!listing?.runs.length && (
        <div className="flex flex-col divide-y divide-stroke overflow-hidden rounded-lg border border-stroke">
          {listing.runs.slice(0, 6).map((entry: ActionRun) => (
            <div key={entry.id} className="flex flex-col gap-1 p-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <button
                  type="button"
                  onClick={() => setOpenRun(openRun === entry.id ? undefined : entry.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={openRun === entry.id}
                >
                  {entry.status === "running" ? (
                    <Loader className="size-3.5 shrink-0 animate-spin text-content/50" />
                  ) : (
                    <span
                      className={`size-2 shrink-0 rounded-full ${entry.status === "succeeded" ? "bg-emerald-400" : "bg-red-400"}`}
                    />
                  )}
                  <span className="font-medium">{entry.actionName}</span>
                  <span className="truncate text-content/45">
                    in {projectName(entry.cwd)}
                    {entry.trigger === "worktree-create"
                      ? " · after the worktree was made"
                      : entry.trigger === "agent"
                        ? " · by an agent"
                        : ""}
                  </span>
                </button>
                <span className="text-[11px] text-content/55">{runStatusLabel(entry)}</span>
                {entry.status === "running" && (
                  <button
                    type="button"
                    aria-label={`Stop ${entry.actionName}`}
                    title="Stop"
                    onClick={() => void stopProjectAction(entry.id).catch((e) => setError(String(e)))}
                    className="rounded-md p-1 text-content/50 hover:bg-content/8 hover:text-content"
                  >
                    <Square className="size-3.5" />
                  </button>
                )}
              </div>
              {openRun === entry.id && (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/5 p-2 font-mono text-[11px] leading-snug text-content/70">
                  {entry.tail.length ? entry.tail.join("\n") : "No output yet."}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      {status?.trusted && status.importedAt && (
        <p className="flex flex-wrap items-center gap-2 text-[11px] text-content/40">
          Imported {new Date(status.importedAt).toLocaleString()}.
          <button
            type="button"
            disabled={busy}
            onClick={() => void forget()}
            className="underline decoration-dotted hover:text-content/70 disabled:opacity-40"
          >
            Forget the import
          </button>
        </p>
      )}
    </section>
  );
}
