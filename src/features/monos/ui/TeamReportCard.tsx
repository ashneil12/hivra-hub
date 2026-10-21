// A coding team's report in the briefing Mono's chat, as one framed card (port map idea 1). After UniiChat
// (Apache-2.0, VictorTaelin/UniiChat @ 0500bf6, web/style.css `.msg.work` and `.msg.work::before`, web/src/Html.ts TALL):
// the sender's name sits on the frame's top edge, the body is plain text, and a tall report shows its head (20em) with
// "Show all", then "Fold". Differs on purpose (Critiquito, 21 Oct): a faint hairline frame, no shadow, glow or coloured
// header, for the Monocode glass look; a native fieldset legend cuts the frame, so no painted patch sits on the glass.
import { useState } from "react";
import { reportIsTall, type TeamReport } from "../model/teamReport";

export function TeamReportCard({ report }: { report: TeamReport }) {
  const tall = reportIsTall(report.text);
  const [open, setOpen] = useState(false);
  return (
    <fieldset
      data-team-report={report.team}
      data-team-report-status={report.status}
      className="mx-4 mb-2 mt-1 min-w-0 rounded-[14px] border border-content/12 px-5 pb-3.5 pt-1.5 font-sans"
    >
      <legend
        data-team-report-name
        className="-ml-1.5 px-1.5 text-[12px] font-semibold leading-[1.5] text-content/65"
      >
        {report.team}
      </legend>
      <div
        data-team-report-body
        data-folded={tall && !open ? "" : undefined}
        className={`whitespace-pre-wrap break-words text-[13px] leading-5 text-content/85 ${
          tall && !open ? "max-h-[20em] overflow-hidden" : ""
        }`}
      >
        {report.text}
      </div>
      {tall ? (
        <button
          type="button"
          data-team-report-more
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="mt-1.5 text-[12px] text-content/65 hover:text-content"
        >
          {open ? "Fold" : "Show all"}
        </button>
      ) : null}
    </fieldset>
  );
}
