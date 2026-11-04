// Hivra WP-11: when the hourly check is due, moved here from monos/model/hourlyCheck.ts into the headless classifier.
// Its words stay with the app (monos/model/hourlyCheck.ts `hourlyCheckMessage`).
// The hourly progress check (Ash, 14 Oct; board H2). Once an hour, the chat that owns a worker running an hour or more
// is asked to look at it. Since 22 Oct the app also brings the evidence, read from the worker's own chat and folder
// (model/progressCheck.ts): what actually moved — commits, files changed, passing and failing test runs — or plainly
// that nothing did. Since 23 Oct it brings the judge's verdict too (model/workerProgress.ts): moving, quiet, looping, done
// elsewhere or no work yet, with the one thing to do about it. The owner still decides; the app messages no worker and
// stops nothing by itself.
import type { Delegation } from "../../monos/model/delegations";

export const HOUR_MS = 60 * 60_000;

/** The rows whose owner is due a look now: open for at least `every`, and not asked about within `every`. */
export function hourlyChecksDue(
  rows: readonly Pick<Delegation, "id" | "state" | "createdAt">[],
  asked: ReadonlyMap<string, number>,
  now: number,
  every = HOUR_MS,
): string[] {
  return rows
    .filter((row) => (row.state === "running" || row.state === "question") && now - row.createdAt >= every && now - (asked.get(row.id) ?? 0) >= every)
    .map((row) => row.id);
}
