// WP-132b: the guide beside a GitHub pull request diff. A stop jumps to that file.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GithubPrDiff } from "../model/githubTasks";
import {
  guideFilesFromDiff,
  guideFreshness,
  guideWriteSentence,
  isMechanicalFile,
  localReviewGuideStore,
  parseStored,
  reviewGuideKey,
  subscribeReviewGuideStore,
  writeReviewGuide,
  REVIEW_GUIDE_TIMEOUT_MS,
  type GuideAsk,
  type GuideComment,
  type GuideStop,
} from "../model/reviewGuide";

type Props = {
  repo: string;
  number: number;
  head: string;
  diff: GithubPrDiff;
  comments: readonly GuideComment[];
  ask: GuideAsk | null;
  onJump: (path: string) => void;
  timeoutMs?: number;
};

export function ReviewGuidePanel({
  repo,
  number,
  head,
  diff,
  comments,
  ask,
  onJump,
  timeoutMs = REVIEW_GUIDE_TIMEOUT_MS,
}: Props) {
  const key = reviewGuideKey(repo, number);
  const raw = useSyncExternalStore(
    subscribeReviewGuideStore,
    () => readRaw(key),
    () => "",
  );
  const record = useMemo(() => parseStored(raw || null), [raw]);
  const files = useMemo(() => guideFilesFromDiff(diff), [diff]);
  const freshness = guideFreshness(record, head);
  const current = freshness === "current" ? record : null;
  const mechanical = useMemo(
    () =>
      new Set(
        files
          .filter((file) => isMechanicalFile(file.path, file.status))
          .map((file) => file.path),
      ),
    [files],
  );
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const headNow = useRef(head);
  headNow.current = head;
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reading =
    current?.guide.stops.filter((stop) => !mechanical.has(stop.path)) ?? [];
  const trailing =
    current?.guide.stops.filter((stop) => mechanical.has(stop.path)) ?? [];

  const write = () => {
    if (!key) {
      setNotice(guideWriteSentence("failed"));
      return;
    }
    const mine = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setWriting(true);
    setNotice(null);
    void writeReviewGuide({
      store: localReviewGuideStore(),
      key,
      head,
      files,
      comments,
      ask,
      timeoutMs,
      currentHead: () => headNow.current,
      signal: controller.signal,
    }).then((result) => {
      if (mine !== generation.current || controller.signal.aborted) return;
      setWriting(false);
      if (!result.ok) setNotice(guideWriteSentence(result.reason));
    });
  };

  return (
    <section role="region" aria-label="Guide" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-content">Guide</h3>
        <button
          type="button"
          onClick={write}
          disabled={writing}
          className="rounded-md border border-content/15 px-2 py-1 text-[12px] text-content/80 hover:bg-content/5 disabled:opacity-50"
        >
          {writing
            ? "Writing the guide"
            : current || freshness === "stale"
              ? "Rewrite guide"
              : "Write guide"}
        </button>
      </div>
      {freshness === "stale" ? (
        <p className="text-[13px] text-content/60">This guide is out of date.</p>
      ) : null}
      {notice ? <p className="text-[13px] text-content/60">{notice}</p> : null}
      {reading.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {reading.map((stop) => (
            <li key={stop.path}>
              <StopButton stop={stop} onJump={onJump} />
            </li>
          ))}
        </ol>
      ) : null}
      {trailing.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[12px] text-content/45">Mechanical changes</p>
          <ol className="flex flex-col gap-1">
            {trailing.map((stop) => (
              <li key={stop.path}>
                <StopButton stop={stop} onJump={onJump} />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function StopButton({
  stop,
  onJump,
}: {
  stop: GuideStop;
  onJump: (path: string) => void;
}) {
  const lines =
    stop.startLine != null
      ? stop.endLine != null && stop.endLine !== stop.startLine
        ? `lines ${stop.startLine} to ${stop.endLine}`
        : `line ${stop.startLine}`
      : null;
  return (
    <button
      type="button"
      onClick={() => onJump(stop.path)}
      className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-content/5"
    >
      <span className="text-[13px] text-content">
        {stop.path}
        {lines ? <span className="text-content/45"> {lines}</span> : null}
      </span>
      <span className="text-[12px] text-content/60">{stop.note}</span>
      {stop.lookClosely ? (
        <span className="text-[12px] text-content">Look closely</span>
      ) : null}
    </button>
  );
}

function readRaw(key: string | null): string {
  if (!key) return "";
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
