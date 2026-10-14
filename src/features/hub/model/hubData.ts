import { mockHubData } from "./mockData";
import type { HubDataSource } from "./types";

let source: HubDataSource = mockHubData;

/** The one place the frontend gets hub data from. */
export function hubData(): HubDataSource {
  return source;
}

/** Claude Code swaps in the real backend here. */
export function setHubDataSource(next: HubDataSource): void {
  source = next;
}
