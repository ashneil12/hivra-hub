// SC-5: Settings > Crew > "Who checks the work". One app-wide pick-one list: the model family that checks a finished task
// (src-tauri/src/firstmate/checker_family.rs). It is the app's own setting, so it is not per project. A late reply never
// lands on a newer choice, and a value this build doesn't know is never shown as if it were one.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CHECKER_FAMILY_RULES,
  CHECKER_FAMILY_WORDS,
  DEFAULT_CHECKER_FAMILY_RULE,
  readCheckerFamilyRule,
  type CheckerFamilyRule,
} from "../model/checkerFamily";

const READ_AGAIN = "Couldn't read this setting.";
const SAVE_AGAIN = "Couldn't save this setting. Try again.";

export function CheckerFamilySetting() {
  const [rule, setRule] = useState<CheckerFamilyRule | null>(null);
  const [pending, setPending] = useState<CheckerFamilyRule | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setRule(null);
    setNote(null);
    invoke("checker_family_rule_get")
      .then((value) => {
        if (mine !== gen.current) return;
        const got = readCheckerFamilyRule(value);
        if (got) setRule(got);
        else setNote(READ_AGAIN);
      })
      .catch(() => {
        if (mine === gen.current) setNote(READ_AGAIN);
      });
    return () => {
      gen.current += 1;
    };
  }, [again]);

  async function choose(next: CheckerFamilyRule) {
    // Nothing is written on top of a value that was never read.
    if (!rule || pending) return;
    const mine = ++gen.current;
    setPending(next);
    setNote(null);
    try {
      const saved = readCheckerFamilyRule(await invoke("checker_family_rule_set", { rule: next }));
      if (mine !== gen.current) return;
      setPending(null);
      if (saved) setRule(saved);
      else setNote(SAVE_AGAIN);
    } catch {
      if (mine !== gen.current) return;
      setPending(null);
      setNote(SAVE_AGAIN);
    }
  }

  return (
    <section
      id="setting-checker-family"
      data-setting-id="checker-family"
      aria-label="Who checks the work"
      className="flex flex-col gap-2 border-b border-stroke px-3 py-2"
    >
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium text-content">Who checks the work</h3>
        <p className="mt-0.5 text-[12px] text-content/60">
          Picks the checker: a second model that re-runs a task's checks, and the ship check's, on a read-only copy.
        </p>
      </div>
      {rule ? (
        <div role="radiogroup" aria-label="Who checks the work" aria-busy={pending !== null} className="flex flex-col gap-1.5">
          {CHECKER_FAMILY_RULES.map((option) => {
            const words = CHECKER_FAMILY_WORDS[option];
            const checked = (pending ?? rule) === option;
            return (
              <label
                key={option}
                data-checker-family={option}
                data-checked={checked ? "true" : "false"}
                className={`flex cursor-pointer items-start gap-2 rounded-md border border-stroke px-3 py-2 ${
                  checked ? "bg-selection" : ""
                } ${pending !== null ? "opacity-70" : ""}`}
              >
                <input
                  type="radio"
                  name="checker-family"
                  aria-label={words.label}
                  className="mt-0.5 shrink-0"
                  checked={checked}
                  disabled={pending !== null}
                  onChange={() => void choose(option)}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] text-content">
                    {words.label}
                    {option === DEFAULT_CHECKER_FAMILY_RULE ? (
                      <span className="ml-2 text-[11px] text-content/60">Default</span>
                    ) : null}
                  </span>
                  <span className="text-[12px] text-content/60">{words.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      {note ? (
        <p data-checker-family-note className="text-[12px] text-content/60">
          {note}
          {!rule ? (
            <>
              {" "}
              <button
                type="button"
                data-checker-family-retry
                className="text-content/80 underline"
                onClick={() => setAgain((n) => n + 1)}
              >
                Try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
