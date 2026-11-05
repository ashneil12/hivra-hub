// SPDX-License-Identifier: Apache-2.0
// Design: HumanLayer apps/devstack status and down (Apache-2.0).
// Translated to Rust in the app's stack code. This file is not a byte copy.

import { appLink } from "../model/link";

export type StackNameView = {
  hostname: string;
  url: string;
  port?: number;
  service?: string;
  emulated?: boolean;
};

export type StackView = {
  id: string;
  worktree: string;
  composeProject: string;
  url: string | null;
  running: boolean;
  stale: boolean;
  /** WP-90: every published name, the fake services, and one line of mode. */
  names?: readonly StackNameView[];
  emulated?: readonly string[];
  mode?: string;
  note?: string | null;
};

export function StackList({
  stacks,
  onStop,
  onReset,
}: {
  stacks: readonly StackView[];
  onStop: (worktree: string) => void;
  /** WP-90: put the fake services back to their seed. Only shown when one is running. */
  onReset?: (worktree: string) => void;
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
            {(stack.names ?? []).length > 0 ? (
              <ul aria-label="Names" className="flex flex-col gap-0.5 text-content/60">
                {(stack.names ?? []).map((name) => (
                  <li key={name.hostname} className="break-all">
                    {name.hostname}
                    {name.service ? ` (fake ${name.service})` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            {stack.mode ? <p className="text-content/60">{stack.mode}</p> : null}
            {stack.note ? <p className="text-content/70">{stack.note}</p> : null}
            {link ? (
              <a className="text-content" href={link}>
                Open the running app
              </a>
            ) : null}
            {onReset && (stack.emulated ?? []).length > 0 && stack.running ? (
              <button
                type="button"
                className="w-fit text-content/80"
                onClick={() => onReset(stack.worktree)}
              >
                Reset fake services
              </button>
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
