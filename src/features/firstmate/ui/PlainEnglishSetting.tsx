import { useState } from "react";
import { playCue } from "../../settings/model/sounds";
import { plainEnglishEndings, savePlainEnglishEndings } from "../model/plainEnglish";

/** WP-41: the Settings switch. On unless the person turns it off. */
export function PlainEnglishSetting({ onChange }: { onChange?: (on: boolean) => void }) {
  const [on, setOn] = useState(plainEnglishEndings);
  return (
    <button
      type="button"
      role="switch"
      aria-label="Plain-English endings"
      aria-checked={on}
      onClick={() => {
        const next = !on;
        savePlainEnglishEndings(next);
        setOn(next);
        onChange?.(next);
        playCue("switch");
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`}
      />
    </button>
  );
}
