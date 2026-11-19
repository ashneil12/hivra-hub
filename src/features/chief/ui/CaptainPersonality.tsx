// WP-215: the personality sits beside the engine. Saving it never rewrites the charter.

import { useEffect, useState } from "react";
import { editMonoFile } from "../../monos/model/monoFiles";
import { applyPersonality, personalityOf } from "../model/charter";

export function CaptainPersonality({ monoId, soul }: { monoId: string; soul: string }) {
  const [text, setText] = useState(() => personalityOf(soul));
  const [saved, setSaved] = useState(text);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = personalityOf(soul);
    setText(next);
    setSaved(next);
  }, [soul]);

  async function save() {
    const next = text.trim();
    setError(null);
    try {
      await editMonoFile(monoId, "soul", (current) => {
        if (personalityOf(current) === next) return current;
        return applyPersonality(current, next);
      });
      setSaved(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the personality.");
    }
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <label className="text-[13px] leading-5 text-content/90" htmlFor="captain-personality">
        Personality
      </label>
      <p className="text-[12px] leading-5 text-content/40">How the Chief of Staff sounds. The charter stays as it is.</p>
      <textarea
        id="captain-personality"
        value={text}
        rows={4}
        className="w-full rounded-lg border border-stroke bg-transparent px-2 py-1 text-[13px] text-content"
        onChange={(event) => setText(event.target.value)}
      />
      <button type="button" className="self-end text-[12px] text-content/85" disabled={text.trim() === saved} onClick={() => void save()}>
        Save personality
      </button>
      {error ? <p className="text-[12px] text-content/70">{error}</p> : null}
    </div>
  );
}
