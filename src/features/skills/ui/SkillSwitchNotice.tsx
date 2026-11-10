// WP-126: load the per-CLI report when a handoff or a mid-thread switch is waiting.

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  acceptLoadedReport,
  readFailureNotice,
  skillSwitchNotice,
} from "../model/cliParity";
import { loadProjectCliParity } from "../model/cliParityFs";
import { SkillSwitchLine } from "./SkillSwitchLine";

export const SKILL_SWITCH_CHECKING = "Checking what will not travel.";

export type SkillSwitchPair<T extends string = string> = { from: T; to: T };

/** One warning per from/to pair. The same switch is not said twice. */
export function skillSwitchPairs<T extends string>(
  handoff: SkillSwitchPair<T> | undefined,
  switchFrom: T | undefined,
  switchTo: T | undefined,
): SkillSwitchPair<T>[] {
  const pairs: SkillSwitchPair<T>[] = [];
  const push = (from: T | undefined, to: T | undefined) => {
    if (!from || !to || from === to) return;
    if (pairs.some((pair) => pair.from === from && pair.to === to)) return;
    pairs.push({ from, to });
  };
  push(handoff?.from, handoff?.to);
  push(switchFrom, switchTo);
  return pairs;
}

function requestToken(cwd: string, from: string, to: string): string {
  return `${cwd}\n${from}\n${to}`;
}

export function SkillSwitchNotice({
  from,
  to,
  toLabel,
  cwd,
}: {
  from: string;
  to: string;
  toLabel: string;
  cwd: string;
}): ReactNode {
  const cwdRef = useRef(cwd);
  const fromRef = useRef(from);
  const toRef = useRef(to);
  cwdRef.current = cwd;
  fromRef.current = from;
  toRef.current = to;
  const [retry, setRetry] = useState(0);
  const [phase, setPhase] = useState<{
    token: string;
    notice: string | null;
    failed: boolean;
  } | null>(null);

  const active = !!cwd && cwd !== "~" && from !== to;

  useEffect(() => {
    if (!active) return;
    const requested = requestToken(cwd, from, to);
    let current = true;
    setPhase({ token: requested, notice: SKILL_SWITCH_CHECKING, failed: false });
    void loadProjectCliParity(cwd)
      .then((report) => {
        if (!current) return;
        const accepted = acceptLoadedReport(
          requested,
          requestToken(cwdRef.current, fromRef.current, toRef.current),
          report,
        );
        if (!accepted) return;
        setPhase({
          token: requested,
          notice: skillSwitchNotice(from, to, toLabel, accepted),
          failed: false,
        });
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (
          !acceptLoadedReport(
            requested,
            requestToken(cwdRef.current, fromRef.current, toRef.current),
            true,
          )
        ) {
          return;
        }
        setPhase({ token: requested, notice: readFailureNotice(error), failed: true });
      });
    return () => {
      current = false;
    };
  }, [active, cwd, from, to, toLabel, retry]);

  if (!active) return null;
  const token = requestToken(cwd, from, to);
  const shown =
    phase?.token === token
      ? phase
      : { notice: SKILL_SWITCH_CHECKING, failed: false };
  if (!shown.failed && !shown.notice) return null;
  return (
    <SkillSwitchLine
      notice={shown.notice}
      onRetry={shown.failed ? () => setRetry((value) => value + 1) : undefined}
    />
  );
}

export function SkillSwitchNotices<T extends string>({
  cwd,
  pairs,
  labelFor,
}: {
  cwd: string;
  pairs: SkillSwitchPair<T>[];
  labelFor: (id: T) => string;
}): ReactNode {
  if (pairs.length === 0) return null;
  return pairs.map((pair) => (
    <SkillSwitchNotice
      key={`${pair.from}:${pair.to}`}
      cwd={cwd}
      from={pair.from}
      to={pair.to}
      toLabel={labelFor(pair.to)}
    />
  ));
}
