// A `[MonoCode check]` turn in the chat that owns one of Ash's messages (hub/model/hubChecks.ts): the checker's private
// note and this chat's answer, as one quiet line that opens on a click. Never Ash's words, never on Today (Ash, 19 Oct:
// "that shows private between the two AIs").
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Block } from "../../sessions/model/session";
import { ChevronDown, ChevronRight, Eye, Loader } from "../../../shared/ui/icons";
import { askStore } from "../../asks/model/askStore";
import { openAskLineFor } from "../../asks/model/askedView";
import { lastReply } from "../model/claimEvidence";
import { checkClaim, checkVerdict } from "../model/hubChecks";
import { forYou } from "../model/userName";
import {
  citeStage,
  runVerifyStage,
  stageError,
  stageReadiness,
  touchedPaths,
  verifyStageStatus,
  type VerifyStatus,
} from "../model/verifyStage";

const subscribeAsks = (fn: () => void): (() => void) => askStore().subscribe(fn);
const asksNow = () => askStore().doc();

export function CheckTurnCard({
  turn,
  live,
  agentName,
  cwd,
}: {
  /** The check prompt first, then the chat's work and answer. */
  turn: readonly Block[];
  /** The chat is still answering it. */
  live: boolean;
  agentName?: string;
  /** The chat's folder: where the verify stage runs (verifyStage.ts). Without it, no stage is offered. */
  cwd?: string;
}) {
  const [open, setOpen] = useState(false);
  // The verify stage (board I2): what it last found for this project, and a one-click way to run it on this turn's
  // files. It is only read when the card is opened, and it never runs on its own.
  const [stage, setStage] = useState<VerifyStatus | null>(null);
  const [stageProblem, setStageProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const asked = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!open || !cwd || asked.current) return;
    asked.current = true;
    setReading(true);
    verifyStageStatus(cwd)
      .then((status) => alive.current && setStage(status))
      .catch((e) => alive.current && setStageProblem(stageError(e)))
      .finally(() => alive.current && setReading(false));
  }, [open, cwd]);
  const verify = () => {
    if (!cwd || verifying) return;
    setVerifying(true);
    setStageProblem(null);
    runVerifyStage(cwd, touchedPaths(turn))
      .then((record) => {
        if (!alive.current) return;
        setStage((prev) =>
          prev
            ? { ...prev, latest: record }
            : { projectRoot: record.projectRoot, checkout: record.checkout, imported: true, verify: {}, note: null, latest: record },
        );
      })
      .catch((e) => alive.current && setStageProblem(stageError(e)))
      .finally(() => alive.current && setVerifying(false));
  };
  const readiness = stageReadiness(stage);
  const check = turn[0].monoCheck;
  // The asks from that message the ask ledger still has open (asks/model/askedView.ts): one quiet line, empty for a check about chatter.
  const asks = useSyncExternalStore(subscribeAsks, asksNow, asksNow);
  const stillOpen = check?.dumpId ? openAskLineFor(asks, check.dumpId) : "";
  const reply = lastReply(turn);
  const verdict = checkVerdict(turn);
  // A "fixed" carries its evidence (claimEvidence.ts): verified, or not yet confirmed with what is missing said in the
  // line. Only a check that passed after the turn's last change gets it there.
  const claim = reply ? checkClaim(turn) : undefined;
  const worth = verdict && claim ? (claim.confidence === "verified" ? "verified" : "not yet confirmed") : "";
  const state = live
    ? "looking at it"
    : verdict
      ? `answered: ${verdict}${worth ? `, ${worth}` : ""}`
      : reply
        ? "answered"
        : "not answered";
  return (
    <div className="transcript-turn flex min-w-0 flex-col px-4 py-1" data-mono-check={check?.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-1 text-left font-sans text-[12px] text-content/50 transition-colors hover:bg-content/5 hover:text-content/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {live ? (
          <Loader className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={1.75} />
        ) : (
          <Eye className="size-3.5 shrink-0" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">Checker's note · {state}</span>
        {open ? (
          <ChevronDown className="size-3 shrink-0" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="size-3 shrink-0" strokeWidth={1.75} />
        )}
      </button>
      {open ? (
        <div className="mt-1 ml-1 flex max-w-[40rem] flex-col gap-1.5 border-l border-content/10 pl-3 font-sans text-[12.5px] leading-relaxed text-content/65">
          <p className="whitespace-pre-wrap">
            <span className="text-content/45">The checker noticed: </span>
            {check?.finding ?? forYou("something about one of Ash's messages.")}
          </p>
          {stillOpen ? (
            <p className="whitespace-pre-wrap text-content/55" data-ask-ledger>
              {stillOpen}
            </p>
          ) : null}
          {reply ? (
            <p className="whitespace-pre-wrap">
              <span className="text-content/45">{agentName ?? "This chat"} answered: </span>
              {reply}
            </p>
          ) : null}
          {claim ? (
            <p className="whitespace-pre-wrap text-content/55" data-claim-confidence={claim.confidence}>
              <span className="text-content/45">Evidence: </span>
              {claim.line}
            </p>
          ) : null}
          {cwd ? (
            <p
              className="whitespace-pre-wrap text-content/55"
              data-verify-stage
              data-verification-outcome={
                verifying ? "running" : stageProblem ? "error" : stage?.latest?.outcome ?? "none"
              }
            >
              <span className="text-content/45">Verification: </span>
              {verifying
                ? "running now — its checks and the real path can take a few minutes."
                : stageProblem
                  ? stageProblem
                  : reading || !stage
                    ? "reading the last verdict…"
                    : stage.latest
                      ? citeStage(stage.latest)
                      : (stage.note ?? "nothing has run for this project yet, so this answer stands on its own.")}
              {!verifying && readiness.canRun ? (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={verify}
                    className="rounded font-sans text-[12px] text-content/70 underline decoration-content/25 underline-offset-2 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  >
                    Run verification
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
