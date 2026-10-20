// The shapes every Tally package shares.

export type Entry = {
  /** ISO timestamp of the bump. */
  at: string;
  /** How much the bump added (usually 1). */
  by: number;
};

export type Tally = {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  entries: Entry[];
};

export type Stats = {
  /** Sum of every entry. */
  total: number;
  /** Days with at least one entry. */
  days: number;
  /** Mean of the daily totals (0 when there are none). */
  mean: number;
  /** Median of the daily totals (0 when there are none). */
  median: number;
  /** The best single day's total. */
  best: number;
};
