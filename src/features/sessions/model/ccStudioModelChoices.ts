import type { AgentModel, ModelSetting } from "./models";

const DEEPSEEK_EFFORT: ModelSetting = {
  id: "effort",
  label: "Reasoning",
  description: "DeepSeek thinking effort. Low, High and Max are the distinct levels supported by its Anthropic endpoint.",
  kind: "select",
  value: "high",
  options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }, { value: "max", label: "Max" }],
};

const GROK_EFFORT: ModelSetting = {
  id: "effort",
  label: "Reasoning",
  description: "Sent as Claude Code --effort. Grok 4.7 documents Low, Medium, High and Extra High reasoning depth. Ultracode is not offered for this upstream.",
  kind: "select",
  value: "high",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
};

/** The current CC Studio lineup. Saved sessions keep their original model IDs;
 * retiring a picker choice does not authorize falling back to another route. */
export const CC_STUDIO_MODEL_CATALOG: AgentModel[] = [
  {
    id: "claude:ccstudio:experiential:deepseek-v4.1-flash",
    harness: "claude",
    name: "CC · DeepSeek 4.1 Flash",
    provider: { id: "experiential", name: "Experiential Labs" },
    nativeId: "ccstudio:experiential:deepseek-v4.1-flash",
    settings: [DEEPSEEK_EFFORT],
  },
  {
    id: "claude:ccstudio:grok:grok-4.7",
    harness: "claude",
    name: "CC · Grok 4.7",
    provider: { id: "grok", name: "Grok subscription" },
    nativeId: "ccstudio:grok:grok-4.7",
    settings: [GROK_EFFORT],
  },
  {
    id: "claude:ccstudio:experiential:gemini-4-argon",
    harness: "claude",
    name: "CC · Gemini 4 Argon",
    provider: { id: "experiential", name: "Experiential Labs" },
    nativeId: "ccstudio:experiential:gemini-4-argon",
  },
];

export function isCurrentCcStudioNativeId(nativeId: string): boolean {
  return CC_STUDIO_MODEL_CATALOG.some((model) => model.nativeId === nativeId);
}

/** Native Anthropic discovery stays authoritative; only proxy choices are curated. */
export function withCurrentCcStudioChoices(models: AgentModel[]): AgentModel[] {
  return [
    ...models.filter((model) => !(model.nativeId ?? model.id.replace(/^claude:/, "")).startsWith("ccstudio:")),
    ...CC_STUDIO_MODEL_CATALOG,
  ];
}
