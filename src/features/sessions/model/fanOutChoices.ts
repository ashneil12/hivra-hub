import type { HarnessId } from "./session";
import { HARNESS_TITLE } from "./session";

export type FanOutChoice = {
  provider: HarnessId;
  model: string;
  label: string;
};

/** One row per provider and model. Hidden providers stay out when a check is passed. */
export function fanOutModelChoices(
  models: readonly { harness: HarnessId; id: string; name: string }[],
  allowed?: readonly HarnessId[],
  visible?: (id: HarnessId) => boolean,
): FanOutChoice[] {
  const seen = new Set<string>();
  const choices: FanOutChoice[] = [];
  for (const model of models) {
    if (!model || typeof model.id !== "string" || typeof model.name !== "string") continue;
    if (allowed && !allowed.includes(model.harness)) continue;
    if (visible && !visible(model.harness)) continue;
    const id = model.id.trim();
    const name = model.name.trim();
    if (!id || !name || /[\0\r\n]/.test(id)) continue;
    const key = `${model.harness}\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({
      provider: model.harness,
      model: id,
      label: `${HARNESS_TITLE[model.harness]}: ${name}`,
    });
  }
  return choices;
}
