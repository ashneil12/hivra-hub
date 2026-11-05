// WP-83: opinions go with a turn, for a judgment call. Voice only when the
// turn is a draft in the person's name. A missed read is not a failed turn.

import { invoke } from "@tauri-apps/api/core";
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
    return text ?? undefined;
  } catch {
    return undefined;
  }
}
