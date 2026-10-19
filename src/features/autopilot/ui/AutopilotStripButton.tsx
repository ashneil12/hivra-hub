import type { ReactNode } from "react";
import { Airplane } from "../../../shared/ui/icons";
import { useNow } from "../../hub/model/liveJobs";
import { activeSwitches, autopilotSnapshot, useAutopilotVersion } from "../model/autopilot";
import { formatUntil } from "../model/endTime";

/** The strip's Autopilot button (rendered by ProjectStrip's StripButton): its plane turns the accent colour while on. */
export function useAutopilotStrip(): { on: boolean; title: string; glyph: ReactNode } {
  useAutopilotVersion();
  const now = useNow(60_000);
  const on = activeSwitches(autopilotSnapshot(), now);
  const until = on.length ? Math.max(...on.map((s) => s.untilMs)) : undefined;
  return {
    on: on.length > 0,
    title: until ? `Autopilot on until ${formatUntil(until, now)}` : "Autopilot",
    glyph: <Airplane className={`size-[18px] ${on.length ? "text-accent" : ""}`} strokeWidth={1.75} data-autopilot-strip={on.length ? "on" : "off"} />,
  };
}
