// What a coding tool's row in Settings says when the engine runs it: how many models, the engine's version of the
// tool, and who is signed in there (the account line the usage menu already draws, email kept private the same way).
import type { HarnessEngineFacts } from "../../../integrations/harness/core/availabilityState";
import { ProviderAccountSubtitle } from "./ProviderAccountSubtitle";

/** The plain words of the line, apart from the account. */
export function engineProviderWords(models: number, facts: HarnessEngineFacts): { before: string; after: string } {
  const count = `${models} ${models === 1 ? "model" : "models"} available.`;
  const version = facts.version ? ` Version ${facts.version}.` : "";
  const account = facts.signedIn === false ? " Not signed in." : facts.signedIn && !facts.plan && !facts.email ? " Signed in." : "";
  return { before: `${count}${version}${account}`, after: facts.note ? ` ${facts.note}` : "" };
}

export function EngineProviderLine({ models, facts }: { models: number; facts: HarnessEngineFacts }) {
  const words = engineProviderWords(models, facts);
  const named = facts.signedIn !== false && (facts.plan || facts.email);
  return (
    <span data-engine-provider-line>
      {words.before}
      {named ? (
        <>
          {" Signed in: "}
          <ProviderAccountSubtitle identity={{ plan: facts.plan, email: facts.email }} />
          {"."}
        </>
      ) : null}
      {words.after}
    </span>
  );
}
