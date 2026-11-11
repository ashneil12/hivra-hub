// Dropwave: council is a mode of a team's chat. This is its switch, under the box you type in: off, the team answers
// like any chat; on, the same team answers as a council (each on their own, then they challenge each other and vote).

export function CouncilSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-w-0 cursor-default items-center gap-2 text-[12px] text-content/60" data-council-switch>
      <button
        type="button"
        role="switch"
        aria-label="Council mode"
        aria-checked={on}
        // The same hooks the two old buttons had: the way in from the team's chat, and the way back.
        {...(on ? { "data-council-close": "" } : { "data-hub-council": "" })}
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
      </button>
      <span className={`shrink-0 ${on ? "text-content" : ""}`}>Council mode</span>
      <span className="min-w-0 truncate text-content/45">
        {on ? "The team debates your question and gives you one decision." : "Off: the team answers like a normal chat."}
      </span>
    </label>
  );
}
