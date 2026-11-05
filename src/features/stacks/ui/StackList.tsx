// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack status and down (Apache-2.0).
// The upstream tree was not in the local sources checkout, so this is a rewrite.

import { appLink } from "../model/link";

export type StackView = {
  id: string;
  worktree: string;
  composeProject: string;
  url: string | null;
  running: boolean;
  stale: boolean;
};

export function StackList({
  stacks,
  onStop,
}: {
  stacks: readonly StackView[];
  onStop: (worktree: string) => void;
}) {
  if (stacks.length === 0) return <p className="text-[12px] text-content/50">No stack is running.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {stacks.map((stack) => {
        const link = appLink(stack.url);
        return (
          <li key={stack.id} className="flex flex-col gap-0.5 text-[12px]">
            <span className="font-medium">{stack.composeProject}</span>
            <span className="text-content/55">{stack.running ? "Running" : "Stopped"}</span>
            {stack.stale ? <span className="text-content/55">Worktree is gone</span> : null}
            {link ? (
              <a className="text-content" href={link}>
                Open the running app
              </a>
            ) : null}
            <button type="button" className="w-fit text-content/80" onClick={() => onStop(stack.worktree)}>
              Stop
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export type StaleStackView = {
  id: string;
  worktree: string;
  composeProject: string;
};

export function StaleStackList({
  stacks,
  onRemove,
}: {
  stacks: readonly StaleStackView[];
  onRemove: (id: string) => void;
}) {
  if (stacks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[12px] font-medium">Stacks whose worktree is gone</h4>
      <ul className="flex flex-col gap-2">
        {stacks.map((stack) => (
          <li key={stack.id} className="flex flex-col gap-0.5 text-[12px]">
            <span>{stack.composeProject}</span>
            <span className="break-all text-content/45">{stack.worktree}</span>
            <button type="button" className="w-fit text-content/80" onClick={() => onRemove(stack.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
