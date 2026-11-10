// WP-132: the review guide above a GitHub pull request's diff in the inbox. Nothing is written until the person taps
// "Write guide". The diff and comments go to the model that writes commit text; the guide stays on this Mac and is
// never posted to GitHub.
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "../../../shared/ui/icons";
import {
  canRunHarnessTextPrompt,
  pickTextHarness,
  runHarnessTextPrompt,
} from "../../../integrations/harness";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import type { GithubPrDiff, GithubWorkItemComment } from "../model/githubTasks";
import {
  readReviewGuideRecord,
  REVIEW_GUIDE_TIMEOUT_MS,
  reviewGuideKey,
  reviewGuideState,
  writeReviewGuide,
  type ReviewGuideRecord,
  type ReviewGuideStop,
} from "../model/reviewGuide";

/** Writes the guide's text. The app's default is the model that writes commit text. */
export type ReviewGuideWriter = {
  available: () => boolean;
  run: (prompt: string, cwd: string) => Promise<string>;
};

export const commitTextWriter: ReviewGuideWriter = {
  available: () => canRunHarnessTextPrompt(pickTextHarness()),
  run: (prompt, cwd) =>
    runHarnessTextPrompt({
      harness: pickTextHarness(),
      cwd,
      prompt,
      intent: "plan",
      timeoutMs: REVIEW_GUIDE_TIMEOUT_MS,
    }),
};

let browserDisk: LocalHubDisk | undefined;

/** The app's database inside Tauri; memory in a plain browser preview. */
export function reviewGuideDisk(): LocalHubDisk {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return tauriLocalHubDisk;
  browserDisk ??= memoryDisk();
  return browserDisk;
}

export type InboxPrGuideProps = {
  repo: string;
  number: number;
  title: string;
  cwd: string;
  diff: GithubPrDiff;
  comments?: readonly GithubWorkItemComment[];
  /** Show the diff at a stop: a file, and the line to bring into view (0 for the file's top). */
  onOpen: (path: string, line: number) => void;
  disk?: LocalHubDisk;
  writer?: ReviewGuideWriter;
};

type Kept = { record: ReviewGuideRecord | null; rev: number };

export function useReviewGuide(
  repo: string,
  number: number,
  disk: LocalHubDisk,
): { kept: Kept | null; reload: () => void; set: (kept: Kept) => void } {
  const key = reviewGuideKey(repo, number);
  const [kept, setKept] = useState<{ key: string; value: Kept } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void disk
      .readDoc(key)
      .then((doc) => {
        if (!live) return;
        setKept((current) =>
          // A read that started before a newer revision arrived never replaces it.
          current?.key === key && current.value.rev > doc.rev
            ? current
            : { key, value: { record: readReviewGuideRecord(doc.value), rev: doc.rev } },
        );
      })
      .catch(() => {
        if (live) setKept({ key, value: { record: null, rev: 0 } });
      });
    return () => {
      live = false;
    };
  }, [disk, key, tick]);
  // Another window kept a guide: read it again.
  useEffect(
    () =>
      disk.watch?.((changed) => {
        if (changed === key) setTick((n) => n + 1);
      }),
    [disk, key],
  );
  const set = useCallback(
    (value: Kept) =>
      setKept((current) =>
        current?.key === key && current.value.rev > value.rev ? current : { key, value },
      ),
    [key],
  );
  return {
    kept: kept?.key === key ? kept.value : null,
    reload: () => setTick((n) => n + 1),
    set,
  };
}

export function InboxPrGuide({
  repo,
  number,
  title,
  cwd,
  diff,
  comments,
  onOpen,
  disk = reviewGuideDisk(),
  writer = commitTextWriter,
}: InboxPrGuideProps) {
  const { kept, set } = useReviewGuide(repo, number, disk);
  const key = reviewGuideKey(repo, number);
  const head = diff.headSha?.trim() || null;
  const headNow = useRef(head);
  headNow.current = head;
  const keyNow = useRef(key);
  keyNow.current = key;
  const [writing, setWriting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string; error: boolean } | null>(null);
  const [showOld, setShowOld] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const record = kept?.record ?? null;
  const state = reviewGuideState(record, repo, number, head);
  const available = writer.available();
  const busy = writing === key;

  const write = async () => {
    if (!head || busy) return;
    setWriting(key);
    setMessage(null);
    const result = await writeReviewGuide(
      {
        disk,
        run: (prompt) => writer.run(prompt, cwd),
        currentHead: () => (keyNow.current === key ? headNow.current : null),
      },
      { repo, number, title, diff, comments, headSha: head },
    ).catch((error: unknown) => ({
      kind: "failed" as const,
      message: `Could not keep the guide: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (!mounted.current) return;
    setWriting((current) => (current === key ? null : current));
    if (keyNow.current !== key) return;
    if (result.kind === "written") {
      set({ record: result.record, rev: result.rev });
      setShowOld(false);
    } else if (result.kind === "newer") {
      set({ record: result.record, rev: result.rev });
      setMessage({ key, text: "Another window wrote a guide first. Showing that one.", error: false });
    } else if (result.kind === "moved") {
      setMessage({
        key,
        text: "The pull request changed while the guide was being written. Write it again for the new commits.",
        error: false,
      });
    } else {
      setMessage({ key, text: result.message, error: true });
    }
  };

  const shown = message?.key === key ? message : null;
  const action = state === "none" ? "Write guide" : "Rewrite guide";
  const disabledReason = !available
    ? "No model is connected to write a guide."
    : !head
      ? "Refresh the pull request to write a guide."
      : null;

  return (
    <section
      aria-label="Guide"
      className="flex flex-col gap-3 rounded-lg border border-content/10 bg-content/[0.02] px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <h3 className="text-[13px] font-medium text-content/85">Guide</h3>
        <div className="ml-auto flex items-center gap-2">
          {disabledReason ? (
            <span className="text-[12px] text-content/45">{disabledReason}</span>
          ) : null}
          <button
            type="button"
            disabled={busy || Boolean(disabledReason) || kept == null}
            onClick={() => void write()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-content/15 px-3 text-[12px] text-content/80 hover:bg-content/5 disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Sparkles className="size-3.5" strokeWidth={1.75} />
            )}
            {busy ? "Writing guide" : action}
          </button>
        </div>
      </div>
      {shown ? (
        <p
          role={shown.error ? "alert" : "status"}
          className={`text-[12px] ${shown.error ? "text-red-400/90" : "text-content/60"}`}
        >
          {shown.text}
        </p>
      ) : null}
      {kept == null ? null : state === "none" ? (
        <p className="text-[12px] text-content/50">
          A short tour of this change, in reading order. The diff below goes to the model that writes commit text. The
          guide is kept on this Mac and never posted to GitHub.
        </p>
      ) : state === "outdated" && record ? (
        <>
          <p role="status" className="text-[12px] text-amber-300/90">
            This guide was written for another version of this pull request. Refresh to see its latest commits, then
            rewrite the guide.
          </p>
          <button
            type="button"
            aria-expanded={showOld}
            onClick={() => setShowOld((open) => !open)}
            className="self-start text-[12px] text-content/55 underline-offset-2 hover:underline"
          >
            {showOld ? "Hide that guide" : "Show that guide"}
          </button>
          {showOld ? (
            <div className="opacity-60">
              <GuideBody record={record} onOpen={onOpen} label="Other version's guide stops" />
            </div>
          ) : null}
        </>
      ) : state === "unchecked" && record ? (
        <>
          <p role="status" className="text-[12px] text-content/55">
            Refresh the pull request to check this guide matches its latest commits.
          </p>
          <GuideBody record={record} onOpen={onOpen} label="Guide stops" />
        </>
      ) : record ? (
        <GuideBody record={record} onOpen={onOpen} label="Guide stops" />
      ) : null}
    </section>
  );
}

function GuideBody({
  record,
  onOpen,
  label,
}: {
  record: ReviewGuideRecord;
  onOpen: (path: string, line: number) => void;
  label: string;
}) {
  const { guide } = record;
  return (
    <div className="flex flex-col gap-3">
      {guide.summary ? <p className="text-[13px] text-content/75">{guide.summary}</p> : null}
      {guide.stops.length ? (
        <ol aria-label={label} className="flex flex-col gap-1">
          {guide.stops.map((stop, index) => (
            <li key={`${index}:${stop.path}`}>
              <button
                type="button"
                onClick={() => onOpen(stop.path, stop.startLine ?? 0)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-content/5"
              >
                <span className="flex flex-wrap items-center gap-2 text-[13px] text-content/85">
                  <span className="text-content/45">{index + 1}.</span>
                  <span>{stop.title}</span>
                  {stop.lookClosely ? (
                    <span className="text-[11px] text-amber-300/90">
                      Look closely
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-[11px] text-content/50">
                  {stop.path}
                  {lineLabel(stop)}
                </span>
                {stop.note ? <span className="text-[12px] text-content/60">{stop.note}</span> : null}
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <FileGroup title="Mechanical files" paths={guide.mechanical} onOpen={onOpen} />
      <FileGroup title="Also changed" paths={guide.unplaced} onOpen={onOpen} />
    </div>
  );
}

function FileGroup({
  title,
  paths,
  onOpen,
}: {
  title: string;
  paths: string[];
  onOpen: (path: string, line: number) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-[12px] text-content/50">{title}</h4>
      <ul className="flex flex-wrap gap-1">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path, 0)}
              className="rounded px-1.5 py-0.5 font-mono text-[11px] text-content/60 hover:bg-content/5 hover:text-content"
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function lineLabel(stop: ReviewGuideStop): string {
  if (!stop.startLine) return "";
  if (stop.endLine && stop.endLine > stop.startLine) return `, lines ${stop.startLine} to ${stop.endLine}`;
  return `, line ${stop.startLine}`;
}
