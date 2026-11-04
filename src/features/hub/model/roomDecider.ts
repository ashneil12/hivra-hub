// WP-22: the quick model a room in auto mode asks who answers (roomModes.ts autoPick). It is the first model Ash added
// under Other models (Grok first), asked through the hub plugin's `model_quick_pick` (src-tauri/src/model_router.rs),
// which reads the key from the Keychain in Rust and never runs a CLI session. Outside the app, or with no model set
// up, there is no decider and the room's lead answers.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import type { RoomDecider } from "./roomModes";

/** The model auto mode uses, if any. */
export function quickModel(): CustomModel | undefined {
  try {
    return listCustomModels()[0];
  } catch {
    return undefined;
  }
}

export function appDecider(): RoomDecider | undefined {
  let inApp = false;
  try {
    inApp = isTauri();
  } catch {
    inApp = false;
  }
  const model = inApp ? quickModel() : undefined;
  if (!model) return undefined;
  return ({ system, prompt, timeoutMs }) =>
    invoke<string>("plugin:hub|model_quick_pick", {
      provider: model.provider,
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      customModelId: model.id,
      system,
      prompt,
      timeoutMs,
    });
}
