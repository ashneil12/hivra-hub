// The later parts of first run's "bring my chats over", in the same card first run uses: choosing what comes in once
// the chats are found, and going through the suggested rules once they have been read. The sidebar's card opens it.

import { useState } from "react";
import { Check } from "../../../shared/ui/icons";
import type { ShownProposal } from "../../memory/ui/LearnFromChats";
import type { ProjectRef } from "../model/plan";
import type { ChatImportRun } from "../model/runner";
import { ChatImportPanel } from "./ChatImportPanel";
import type { SetupPart } from "./importRail";

const PRIMARY = "rounded-md bg-content px-3 py-1.5 text-[13px] font-medium text-background-base hover:opacity-90 disabled:opacity-50";
const QUIET = "rounded-md px-3 py-1.5 text-[13px] text-content/60 hover:bg-content/8 hover:text-content";

export type ImportSetupCardProps = {
  part: SetupPart;
  run: ChatImportRun;
  projects: ProjectRef[];
  /** The suggested rules waiting, for the rules part. */
  rules: ShownProposal[];
  /** How many chats they came from, when known. */
  rulesFrom?: number;
  accept: (id: string) => Promise<boolean>;
  /** The chats are coming in: the setup moves on. */
  onBringIn: () => void;
  /** The rules part is finished (some accepted, or left for later). */
  onRulesDone: () => void;
  onClose: () => void;
  now?: number;
};

export function ImportSetupCard(props: ImportSetupCardProps) {
  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background-base/75" data-import-setup data-part={props.part}>
      <div className="flex max-h-[86vh] w-[640px] flex-col gap-5 rounded-2xl border border-content/7 dialog-glass p-8 shadow-2xl ring-0">
        {props.part === "choose" ? <Choose {...props} /> : <Rules {...props} />}
      </div>
    </div>
  );
}

function Choose({ run, projects, onBringIn, onClose, now }: ImportSetupCardProps) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[18px] text-content">Choose what comes in</h1>
        <p className="text-[13px] leading-5 text-content/75">
          Your chats are grouped by the folder they ran in. Each group becomes a project, or goes into one you pick. They come in behind you, so you can go straight back to the app.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <ChatImportPanel run={run} projects={projects} compact onBringIn={onBringIn} {...(now != null ? { now } : {})} />
      </div>
      <div className="flex justify-end">
        <button type="button" className={QUIET} data-import-setup-later onClick={onClose}>
          Not now
        </button>
      </div>
    </>
  );
}

function Rules({ rules, rulesFrom, accept, onRulesDone, onClose }: ImportSetupCardProps) {
  const [ticked, setTicked] = useState<string[]>(() => rules.map((rule) => rule.id));
  const [left, setLeft] = useState(rules);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const chosen = left.filter((rule) => ticked.includes(rule.id));
  const acceptTicked = async () => {
    if (busy) return;
    setBusy(true);
    setNote("");
    const done: string[] = [];
    for (const rule of chosen) {
      try {
        if (await accept(rule.id)) done.push(rule.id);
      } catch {
        // Stays in the list.
      }
    }
    setBusy(false);
    const rest = left.filter((rule) => !done.includes(rule.id));
    const refused = chosen.length - done.length;
    if (refused === 0) return onRulesDone();
    setLeft(rest);
    setNote(`${refused === 1 ? "One rule" : `${refused} rules`} couldn't be saved and ${refused === 1 ? "is" : "are"} still here. You can try again, or find ${refused === 1 ? "it" : "them"} later in Settings, Memory.`);
  };
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-[18px] text-content">How you work</h1>
        <p className="text-[13px] leading-5 text-content/75" data-import-setup-rules-summary>
          {left.length} suggested {left.length === 1 ? "rule" : "rules"}
          {rulesFrom ? ` from ${rulesFrom.toLocaleString("en-GB")} of your chats` : ""}. Each one quotes the chats it came from. Only ticked ones are saved; the rest wait in Settings, Memory.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1" data-import-setup-rules>
        {left.map((rule) => {
          const on = ticked.includes(rule.id);
          return (
            <button
              key={rule.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-import-setup-rule={rule.id}
              onClick={() => setTicked((cur) => (on ? cur.filter((id) => id !== rule.id) : [...cur, rule.id]))}
              className={`flex items-start gap-3 rounded-lg px-3 py-2 text-left ${on ? "bg-content/8" : "hover:bg-content/5"}`}
            >
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded ${on ? "bg-content text-background-base" : "bg-content/10"}`}>
                {on ? <Check className="size-3" strokeWidth={2.5} /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[13px] text-content">{rule.title}</span>
                <pre className="overflow-x-auto whitespace-pre-wrap text-[12px] leading-5 text-content/75">{rule.diff}</pre>
                {rule.quotes.map((quote, index) => (
                  <span key={`${quote.sessionId}-${index}`} className="border-l-2 border-stroke pl-2 text-[12px] leading-5 text-content/60">
                    {quote.quote}
                  </span>
                ))}
                {rule.note ? <span className="text-[12px] text-content/60">{rule.note}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      {note ? <p className="text-[13px] text-content/75">{note}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={QUIET} data-import-setup-later onClick={onClose}>
          Not now
        </button>
        <button type="button" className={PRIMARY} data-import-setup-accept disabled={busy || chosen.length === 0} onClick={() => void acceptTicked()}>
          Save {chosen.length} {chosen.length === 1 ? "rule" : "rules"}
        </button>
      </div>
    </>
  );
}
