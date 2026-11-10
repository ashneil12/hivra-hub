import { withoutEmDashes } from "../../../shared/text/noEmDash";

/** WP-122: a child asked, so the parent thread can answer. */
export function ChildApprovalNote({
  name,
  detail,
}: {
  name: string;
  detail?: string | null;
}) {
  const who = withoutEmDashes(name).trim() || "Subagent";
  const about = detail ? withoutEmDashes(detail).trim() : "";
  return (
    <div data-child-approval className="mt-1.5 font-sans text-[12px] text-content/70">
      <p>Approval needed from {who}</p>
      {about ? (
        <p data-child-approval-detail className="text-content/55">
          {about}
        </p>
      ) : null}
    </div>
  );
}
