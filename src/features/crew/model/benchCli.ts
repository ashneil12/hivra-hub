// A test bench (docs/REALTEST.md, src-tauri/src/verify_live.rs) starts no agent CLI but its own Claude wrapper.
// A worker routed to another CLI there is refused, never quietly run on Claude instead: a worker on a different
// CLI is what a crew rule or a Mono's default asked for, and running it on Claude silently would hide that.
//
// The sentence has the same words as `provider_start_allowed` in src-tauri/src/verify_live.rs, which refuses the
// same start one layer down. The test reads it out of that file, so the two cannot drift apart.

import { appIdentity } from "../../../app/model/appIdentity";

/** Refuse `cli` on this bench, in the bench's own words, or undefined on a copy that may start it. */
export function benchCliRefusal(cli: string): string | undefined {
  if (!appIdentity()?.verify) return undefined;
  if (cli === "claude") return undefined;
  return `This bench only starts the run's own Claude wrapper. It won't start ${cli}.`;
}
