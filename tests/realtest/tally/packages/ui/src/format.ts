// Pure helpers for the board. The UI keeps its own tally shape for now (README: "Known problems").

export type BoardTally = {
  id: string;
  title: string;
  owner: string;
  count: number;
};

/** "12 this week" / "1 this week". */
export function weekLabel(count: number): string {
  return `${count} this week`;
}

/** The board's rows, biggest count first, ties by title. */
export function boardOrder(tallies: BoardTally[]): BoardTally[] {
  return [...tallies].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}
