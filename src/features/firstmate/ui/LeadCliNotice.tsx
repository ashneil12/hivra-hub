// WP-120: one line in a first-mate chat when its CLI cannot lead yet.
import { leadBlockReason } from "../model/leadCli";

export function LeadCliNotice({ harness }: { harness: string }) {
  const reason = leadBlockReason(harness);
  if (!reason) return null;
  return (
    <p
      data-lead-cli-notice=""
      data-lead-cli-reason=""
      className="shrink-0 border-b border-stroke px-3 py-1 text-xs text-content/70"
    >
      {reason}
    </p>
  );
}
