// WP-83: opinions go with a turn, for a judgment call. Voice only when the
// turn is a draft in the person's name. A missed read is not a failed turn.

import { invoke } from "@tauri-apps/api/core";
import { hasSecretText } from "../../portable/model/secrets";
import { mentionsSecret } from "../model/doc";
import { redactForModel } from "../backpass/ask";
import { profileText } from "../backpass/profile";

/** Nothing, when the profile can't be read this time. The turn still goes out. */
export async function profileNote(message: string): Promise<string | undefined> {
  try {
    const row = await invoke<{ opinions?: unknown; voice?: unknown }>("learn_profile_load");
    const text = profileText(
      typeof row?.opinions === "string" ? row.opinions : "",
      typeof row?.voice === "string" ? row.voice : "",
      message,
    );
    if (!text) return undefined;
    const clean = redactForModel(text);
    if (!clean.trim() || hasSecretText(clean) || mentionsSecret(clean)) return undefined;
    return clean;
  } catch {
    return undefined;
  }
}
