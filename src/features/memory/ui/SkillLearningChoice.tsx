// WP-242: "Learn skills: Automatic / Ask first / Off", under how Hivra remembers in Settings > Memory. The same shape
// as MemoryTierChoice: presentational, so a browser test drives it directly; the wrapper below reads the saved setting.

import { saveSkillMode, skillModeLabel, useSkillMode, type SkillMode } from "../../selfBuild/model/skillMode";

const OPTIONS: { mode: SkillMode; summary: string }[] = [
  {
    mode: "automatic",
    summary:
      "A lesson a first mate learns from a review goes into its skill straight away, and you can undo it under Changes. Skills proposed from your chats still wait for you here. This is the default.",
  },
  { mode: "ask", summary: "Every lesson and skill waits here until you accept it." },
  { mode: "off", summary: "No lesson or skill is learned. The Memory health card below counts what was left out." },
];

const ROW = "flex cursor-pointer items-start gap-2 rounded-md border border-content/10 px-3 py-2 text-sm";

export function SkillLearningChoice({ value, onChange }: { value: SkillMode; onChange: (mode: SkillMode) => void }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Learn skills" data-skill-learning>
      <p className="text-sm">Learn skills</p>
      <div role="radiogroup" aria-label="Learn skills" className="flex flex-col gap-2">
        {OPTIONS.map((option) => (
          <label key={option.mode} className={ROW} data-skill-mode={option.mode}>
            <input
              type="radio"
              name="skill-learning"
              className="mt-1"
              checked={value === option.mode}
              onChange={() => onChange(option.mode)}
            />
            <span className="flex flex-col gap-0.5">
              <span>{skillModeLabel(option.mode)}</span>
              <span className="text-content/60">{option.summary}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-content/60">
        Before a lesson is saved, names, email addresses, home folder paths and account numbers are taken out, and a
        step that sends something outside is left out.
      </p>
    </section>
  );
}

/** The saved setting. */
export function SkillLearningSetting() {
  const mode = useSkillMode();
  return <SkillLearningChoice value={mode} onChange={saveSkillMode} />;
}
