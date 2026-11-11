import { useState } from "react";
import { Loader, RefreshCw, Trash2, Wrench } from "../../../shared/ui/icons";
import { prettyCwd, projectName } from "../../../shared/lib/paths";
import {
  buildOutputBytes,
  buildOutputFolders,
  formatAge,
  formatBytes,
  janitorClean,
  janitorReport,
  removeCheckedWorktree,
  tapBytes,
  tapTargets,
  type CleanTier,
  type JanitorEntry,
  type JanitorOutcome,
  type JanitorReport,
} from "../model/worktreeJanitor";
import type { RemoveWorktree } from "../model/worktrees";
import { StaleStacks } from "../../stacks/ui/StaleStacks";

const GROUPS: { outcome: JanitorOutcome; title: string }[] = [
  { outcome: "remove", title: "Safe to remove: merged and clean" },
  { outcome: "free", title: "Build output can be freed: idle" },
  { outcome: "keep", title: "Kept" },
];

function EntryRow({ entry, now }: { entry: JanitorEntry; now: number }) {
  const output = buildOutputBytes(entry);
  const folders = buildOutputFolders(entry);
  return (
    <div className="flex flex-col gap-0.5 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium">{projectName(entry.path)}</span>
        {entry.branch && <span className="text-content/45">{entry.branch}</span>}
        <span className="ml-auto text-content/55">{formatBytes(entry.totalBytes)}</span>
      </div>
      <p className="text-[11px] text-content/55">
        <span className="rounded bg-content/8 px-1 py-px text-[10px] text-content/65">
          {entry.verdict.state}
        </span>{" "}
        {entry.lastActivity ? `active ${formatAge(now - entry.lastActivity)} ago · ` : ""}
        {entry.chats ? `${entry.chats} chat${entry.chats === 1 ? "" : "s"} · ` : ""}
        {entry.verdict.reason}
      </p>
      {folders && (
        <p data-build-output="" className="text-[11px] text-content/55">
          Build output {formatBytes(output)} ({folders})
        </p>
      )}
      <p className="break-all text-[10px] text-content/35">{prettyCwd(entry.path)}</p>
    </div>
  );
}

/**
 * Settings > Worktrees > Clean up: one report over ~/Worktrees and this project's worktrees, and two taps. Nothing is
 * removed until Ash taps, and each tap re-checks every worktree first. Branches and chats stay.
 */
export function WorktreeCleanup({
  project,
  onRemove,
  onChanged,
}: {
  project: string;
  onRemove: RemoveWorktree;
  /** After a tap, so the worktree list above refreshes. */
  onChanged?: () => void;
}) {
  const [report, setReport] = useState<JanitorReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<CleanTier>();
  const [result, setResult] = useState<string>();
  const [showKept, setShowKept] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setReport(await janitorReport(project || undefined));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const tap = async (tier: CleanTier) => {
    if (!report) return;
    const targets = tapTargets(report, tier);
    if (!targets.length) return;
    setBusy(tier);
    setResult(undefined);
    setError(undefined);
    let done = 0;
    let freed = 0;
    const kept: string[] = [];
    try {
      const results = await janitorClean(tier, targets);
      for (const [index, checked] of results.entries()) {
        if (!checked.done) {
          kept.push(`${projectName(checked.path)}: ${checked.message}`);
          continue;
        }
        if (tier === "remove") {
          try {
            // The app's own removal (it detaches the worktree's chats so they keep their history), checked once more
            // in the same step as the delete.
            await removeCheckedWorktree(checked, targets[index]?.head ?? null, onRemove);
          } catch (e) {
            kept.push(`${projectName(checked.path)}: ${String(e)}`);
            continue;
          }
        }
        done += 1;
        freed += checked.freedBytes;
      }
      setResult(
        `${tier === "remove" ? `Removed ${done} worktree${done === 1 ? "" : "s"}` : `Freed build output in ${done} worktree${done === 1 ? "" : "s"}`} (${formatBytes(freed)}).` +
          (kept.length ? ` Kept ${kept.length}: ${kept.join("; ")}` : ""),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
      onChanged?.();
      await load();
    }
  };

  const now = report?.generatedAt ?? Date.now();
  const removeTargets = report ? tapTargets(report, "remove") : [];
  const freeTargets = report ? tapTargets(report, "free") : [];

  return (
    <section
      data-setting-id="worktree-cleanup"
      id="setting-worktree-cleanup"
      className="flex flex-col gap-3 rounded-xl border border-stroke p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-medium">Clean up</h3>
        <button
          type="button"
          disabled={loading || !!busy}
          onClick={() => void load()}
          className="flex h-7 items-center gap-1.5 rounded-md bg-content/8 px-2.5 text-[12px] hover:bg-content/12 disabled:opacity-40 active:scale-[0.97]"
        >
          {report ? <RefreshCw className="size-3.5" /> : <Wrench className="size-3.5" />}
          {report ? "Refresh report" : "Clean up…"}
        </button>
      </div>
      <p className="text-[12px] text-content/50">
        One report of every worktree in ~/Worktrees and this project: its size and how much of it
        is build output, last activity, whether it is merged, unchanged or has local work, and why
        it is safe to clean or kept. Nothing here is removed until you tap (finished worktrees give
        back their build output by themselves; see the switch above). Branches and chats stay.
      </p>
      <StaleStacks />
      {error && (
        <p role="alert" className="break-words text-[12px] text-red-400">
          {error}
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 text-[12px] text-content/50">
          <Loader className="size-4 animate-spin" />
          Measuring worktrees… this can take a minute.
        </p>
      )}
      {result && <p className="break-words text-[12px] text-content/70">{result}</p>}
      {report && (
        <>
          <p className="text-[12px]">
            {report.entries.length} folders, {formatBytes(report.totalBytes)}. Build output:{" "}
            {formatBytes(report.buildOutputBytes)} in {report.buildOutputCount}{" "}
            {report.buildOutputCount === 1 ? "worktree" : "worktrees"}. Up to{" "}
            {formatBytes(report.removeBytes + report.freeBytes)} can be reclaimed.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={!removeTargets.length || !!busy || loading}
              onClick={() => void tap("remove")}
              className="flex h-7.5 items-center gap-1.5 rounded-md bg-content/8 px-2.5 text-[12px] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40 active:scale-[0.97]"
            >
              {busy === "remove" ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove {removeTargets.length} merged worktree
              {removeTargets.length === 1 ? "" : "s"} ·{" "}
              {formatBytes(tapBytes(removeTargets, "remove"))}
            </button>
            <button
              type="button"
              disabled={!freeTargets.length || !!busy || loading}
              onClick={() => void tap("free")}
              className="flex h-7.5 items-center gap-1.5 rounded-md bg-content/8 px-2.5 text-[12px] hover:bg-content/12 disabled:opacity-40 active:scale-[0.97]"
            >
              {busy === "free" ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <Wrench className="size-3.5" />
              )}
              Free build output · {formatBytes(tapBytes(freeTargets, "free"))} in{" "}
              {freeTargets.length}
            </button>
          </div>
          {GROUPS.map(({ outcome, title }) => {
            const rows = report.entries.filter((entry) => entry.verdict.outcome === outcome);
            if (!rows.length) return null;
            const hidden = outcome === "keep" && !showKept;
            return (
              <div key={outcome} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-[11px] font-medium text-content/60">
                  {title} ({rows.length})
                  {outcome === "keep" && (
                    <button
                      type="button"
                      onClick={() => setShowKept(!showKept)}
                      className="font-normal underline decoration-dotted hover:text-content"
                    >
                      {showKept ? "Hide" : "Show"}
                    </button>
                  )}
                </div>
                {!hidden && (
                  <div className="divide-y divide-stroke overflow-hidden rounded-lg border border-stroke">
                    {rows.map((entry) => (
                      <EntryRow key={entry.path} entry={entry} now={now} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {report.notes.map((note) => (
            <p key={note} className="text-[11px] text-content/40">
              {note}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
