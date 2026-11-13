// PT-4: Settings > Crew > "When the checker runs". One app-wide pick-one list with round marks, beside "Who checks the work": which
// finished tasks (and the ship check) get the running checker (src-tauri/src/firstmate/checker_when.rs). It is the app's own
// setting, so it is not per project. A late reply never lands on a newer choice, a value this build doesn't know is never shown as
// if it were one, and nothing is written on top of a value that was never read.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CHECKER_WHEN_DETAILS,
  CHECKER_WHEN_HINT,
  CHECKER_WHEN_RULES,
  CHECKER_WHEN_TITLE,
  CHECKER_WHEN_WORDS,
  DEFAULT_CHECKER_WHEN_RULE,
  readCheckerWhenRule,
  type CheckerWhenRule,
} from "../model/checkerWhen";
import { SettingRow } from "./SettingRow";

const READ_AGAIN = "Couldn't read this setting.";
const SAVE_AGAIN = "Couldn't save this setting. Try again.";

export function CheckerWhenSetting() {
  const [rule, setRule] = useState<CheckerWhenRule | null>(null);
  const [pending, setPending] = useState<CheckerWhenRule | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setRule(null);
    setNote(null);
    invoke("checker_when_rule_get")
      .then((value) => {
        if (mine !== gen.current) return;
        const got = readCheckerWhenRule(value);
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

  async function choose(next: CheckerWhenRule) {
    // Nothing is written on top of a value that was never read.
    if (!rule || pending) return;
    const mine = ++gen.current;
    setPending(next);
    setNote(null);
    try {
      const saved = readCheckerWhenRule(await invoke("checker_when_rule_set", { rule: next }));
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
    <SettingRow
      id="checker-when"
      label={CHECKER_WHEN_TITLE}
      description={CHECKER_WHEN_HINT}
      details={CHECKER_WHEN_DETAILS}
      below={
        <>
          {rule ? (
            <div
              role="radiogroup"
              aria-label={CHECKER_WHEN_TITLE}
              aria-busy={pending !== null}
              className="mt-2 flex flex-col gap-1.5"
            >
              {CHECKER_WHEN_RULES.map((option) => {
                const words = CHECKER_WHEN_WORDS[option];
                const checked = (pending ?? rule) === option;
                return (
                  <label
                    key={option}
                    data-checker-when={option}
                    data-checked={checked ? "true" : "false"}
                    className={`flex cursor-pointer items-start gap-2 rounded-md border border-stroke px-3 py-2 ${
                      checked ? "bg-selection" : ""
                    } ${pending !== null ? "opacity-70" : ""}`}
                  >
                    <input
                      type="radio"
                      name="checker-when"
                      aria-label={words.label}
                      className="mt-0.5 shrink-0"
                      checked={checked}
                      disabled={pending !== null}
                      onChange={() => void choose(option)}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[13px] text-content">
                        {words.label}
                        {option === DEFAULT_CHECKER_WHEN_RULE ? (
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
            <p data-checker-when-note className="mt-2 text-[12px] text-content/60">
              {note}
              {!rule ? (
                <>
                  {" "}
                  <button
                    type="button"
                    data-checker-when-retry
                    className="text-content/80 underline"
                    onClick={() => setAgain((n) => n + 1)}
                  >
                    Try again
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </>
      }
    />
  );
}
