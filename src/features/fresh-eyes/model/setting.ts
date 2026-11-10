// WP-144: fresh-eyes review before a crew starts. Off unless a project turns it on.
// A value from disk or another window is untrusted and falls back to off.

export type FreshEyesSetting = {
  /** Only a real true turns the review on. */
  enabled: boolean;
  /** The first mate may accept a review with no findings. Anything else waits for the person. */
  autoAcceptClean: boolean;
  /** 1, 2 or 3 reviewers. Anything else is the default, 2. */
  reviewerCount: number;
  /** The person's model. Empty means the cheap worker model. */
  model: string | null;
};

export function readSetting(raw: unknown): FreshEyesSetting {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const count = record.reviewerCount;
  const reviewerCount =
    typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 3 ? count : 2;
  return {
    enabled: record.enabled === true,
    autoAcceptClean: record.autoAcceptClean === true,
    reviewerCount,
    model: cleanModel(record.model),
  };
}

function cleanModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 200 || /[\0\r\n]/.test(text)) return null;
  return text;
}
