// The model as small text above a Mono's composer (port map idea 2). After UniiChat (Apache-2.0, VictorTaelin/UniiChat
// @ 0500bf6): web/src/Html.ts pick_html puts the knobs after a hairline above the box, a click on one moves it on
// (Pick.ts move), and the change is said for 7 s (web/src/main.ts hear() and toast(): "Now <model>."). Ours names no
// price (the hub has none), and a chevron opens the whole menu (ModelPicker `cycle`). On the Grok bridge every Claude
// Code chat runs Grok 4.7 whatever Claude model it names, so the line says Grok 4.7 and a click opens the menu instead
// of stepping through names that would all run the same model.
import { useEffect, useState, type ComponentProps } from "react";
import { ModelControlPills, ModelPicker } from "../../sessions/ui/ModelPicker";
import { GROK_BRIDGE_LABEL, onGrokBridge } from "../../../integrations/harness/providers/claude/claudeGrokBridge";

// The one source for "what really runs" (claudeGrokBridge.ts), shared with the transcript's turn header.
export { GROK_BRIDGE_LABEL };

/** UniiChat main.ts toast(): how long "Now <model>." stays. */
export const MODEL_NOTE_MS = 7000;

type PickerProps = ComponentProps<typeof ModelPicker>;

export function MonoModelLine(props: Omit<PickerProps, "variant" | "cycle" | "hideSettings" | "chevron" | "noIcon">) {
  const [note, setNote] = useState<string | null>(null);
  const onGrok = onGrokBridge(props.harness);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), MODEL_NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  return (
    <span className="flex min-w-0 items-center gap-0.5" data-mono-model-line>
      {note ? (
        <span role="status" data-mono-model-note className="min-w-0 truncate pr-1 text-[12px] text-content/65">
          {note}
        </span>
      ) : null}
      <ModelPicker
        {...props}
        hideSettings
        chevron
        noIcon
        variant="text"
        triggerLabel={onGrok ? GROK_BRIDGE_LABEL : props.triggerLabel}
        cycle={onGrok ? undefined : (name) => setNote(`Now ${name}.`)}
      />
      <ModelControlPills
        harness={props.harness}
        model={props.model}
        values={props.values}
        variant="text"
        labelClassName={props.labelClassName}
        onSettingsChange={props.onSettingsChange}
      />
    </span>
  );
}
