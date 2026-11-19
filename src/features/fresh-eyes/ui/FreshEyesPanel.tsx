// WP-144: one line on the crew card. A late reply for another project does not land here.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { answerFreshEyes, briefPreview, freshEyesLine } from "../model/gate";
import type { Finding } from "../model/review";
import {
  freshEyesRevision,
  latestReview,
  reviewFor,
  settingFor,
  subscribeFreshEyes,
  writeSetting,
  type ReviewRecord,
} from "../model/store";
import { FreshEyesCard } from "./FreshEyesCard";

export function FreshEyesPanel({ project }: { project: string }) {
  const revision = useSyncExternalStore(subscribeFreshEyes, freshEyesRevision, freshEyesRevision);
  const [enabled, setEnabled] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [review, setReview] = useState<ReviewRecord | null>(null);
  const gen = useRef(0);
  const projectNow = useRef(project);
  projectNow.current = project;

  useEffect(() => {
    const mine = ++gen.current;
    const folder = project.trim();
    const setting = folder ? settingFor(folder) : settingFor("");
    const current = folder ? latestReview(folder) : null;
    if (mine !== gen.current) return;
    setEnabled(setting.enabled);
    setAutoAccept(setting.autoAcceptClean);
    setReview(current);
  }, [project, revision]);

  async function change(patch: { enabled?: boolean; autoAcceptClean?: boolean }) {
    const folder = projectNow.current.trim();
    if (!folder) return;
    const mine = ++gen.current;
    await writeSetting(folder, patch);
    if (mine !== gen.current || projectNow.current.trim() !== folder) return;
    const setting = settingFor(folder);
    setEnabled(setting.enabled);
    setAutoAccept(setting.autoAcceptClean);
    setReview(latestReview(folder));
  }

  async function decide(answer: "Approve" | "Edit plan" | "Skip once") {
    const folder = projectNow.current.trim();
    const current = review;
    if (!folder || !current) return;
    if (current.status !== "pending") return;
    const mine = ++gen.current;
    // Approve and Skip once start the brief that was held. Edit plan does not. The Inbox question closes with it. The
    // answer is about the brief this card shows (its hash): if another has replaced it, nothing is approved.
    await answerFreshEyes(folder, current.requestId, answer, { owner: current.owner, hash: current.hash });
    if (mine !== gen.current || projectNow.current.trim() !== folder) return;
    setReview(reviewFor(folder, current.requestId, undefined, current.owner));
  }

  const findings: readonly Finding[] = enabled && review ? review.findings : [];
  const line =
    enabled && review
      ? freshEyesLine({
          enabled: true,
          status: review.status,
          findings: review.findings.length,
          running: review.running === true,
          askFailed: !!review.askError,
        })
      : null;

  return (
    <FreshEyesCard
      enabled={enabled}
      autoAccept={autoAccept}
      line={line}
      brief={enabled && review ? briefPreview(review) : null}
      findings={findings}
      pending={enabled && review?.status === "pending"}
      onToggle={() => void change({ enabled: !enabled })}
      onAutoAccept={() => void change({ autoAcceptClean: !autoAccept })}
      onDecide={(answer) => void decide(answer)}
    />
  );
}
