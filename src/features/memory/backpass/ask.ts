// WP-83: the model call goes through a CLI the person already signed in to.
// No key is read. A timeout is not a rejection and nothing is written.

import { hasSecretText, redactText } from "../../portable/model/secrets";
import { mentionsSecret } from "../model/doc";
import { briefSignedIn, type BriefDeps } from "../model/signedInAsk";
import type { CuratorAsk } from "../model/curator";
import { redact } from "./redact";

/** Backpass's patterns first, then Hivra's. A secret that survives both is not sent. */
export function redactForModel(text: string): string {
  const first = redact(text) ?? "";
  return redactText(first).text;
}

export type LessonAsk = CuratorAsk & { wrote: false };

export async function askForLessons(text: string, deps: BriefDeps): Promise<LessonAsk> {
  const clean = redactForModel(text);
  if (hasSecretText(clean) || mentionsSecret(clean)) {
    return { ok: false, kind: "refused", reason: "That chat contained a secret, so it was not sent.", wrote: false };
  }
  const answer = await briefSignedIn(clean, deps);
  return { ...answer, wrote: false };
}
