// Connections: which coding tool runs on which of your sign-ins and saved models, with the app's extra connections
// marked. Rules: src/features/providers/model/modelConnections.ts. Signing in stays under Accounts.
import { useSyncExternalStore } from "react";
import { connectionRows, type ConnectionPill } from "../../providers/model/connectionsView";
import { HARNESSES, HARNESS_TITLE } from "../../sessions/model/session";
import { useCustomModels } from "../../sessions/ui/CustomModels";
import {
  getHarnessAvailabilitySnapshot,
  isHarnessAvailable,
  subscribeHarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";

export function ModelConnectionsSetting() {
  useSyncExternalStore(subscribeHarnessAvailability, getHarnessAvailabilitySnapshot, getHarnessAvailabilitySnapshot);
  const saved = useCustomModels();
  const savedProviders = new Set<string>(saved.map((m) => m.provider));
  const rows = connectionRows(isHarnessAvailable, savedProviders);
  const missing = HARNESSES.filter((h) => !isHarnessAvailable(h)).map((h) => HARNESS_TITLE[h]);

  return (
    <section id="setting-model-connections" data-setting-id="model-connections" className="pb-8">
      <div className="pb-2.5">
        <h2 className="text-[13px] font-semibold text-content">Connections</h2>
        <p className="mt-1 text-[12px] leading-relaxed text-content/60">
          Which of your sign-ins and saved models each coding tool can run on. An extra connection is one this app
          makes for the tool, so your key or login stays where it is. Sign in to each tool under Accounts below.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
        {rows.length === 0 ? (
          <p className="m-0 px-4 py-3.5 text-[12px] text-content/60">No coding tools are installed yet.</p>
        ) : (
          rows.map((row) => {
            const waiting = row.pills.filter((p) => !p.ready);
            return (
              <div
                key={row.harness}
                data-connection-row={row.harness}
                className="flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-content">{HARNESS_TITLE[row.harness]}</div>
                  {row.pills.length === 0 && row.inAgent.length === 0 ? (
                    <p className="m-0 mt-1 text-[12px] text-content/60">Runs only on its own account.</p>
                  ) : null}
                  <PillLine label="Its own" pills={row.pills.filter((p) => !p.extra)} />
                  <PillLine label="Extra connections" pills={row.pills.filter((p) => p.extra)} />
                  {waiting.length > 0 ? (
                    <p className="m-0 mt-1.5 text-[12px] text-content/60">{waitingLine(waiting.map((p) => p.source))}</p>
                  ) : null}
                  {row.inAgent.length > 0 ? (
                    <p className="m-0 mt-1 text-[12px] text-content/60">
                      Set up in {HARNESS_TITLE[row.harness]}'s own settings: {row.inAgent.join(", ")}.
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      {missing.length > 0 ? (
        <p className="m-0 mt-2 text-[12px] text-content/60">Not installed: {missing.join(", ")}.</p>
      ) : null}
    </section>
  );
}

function PillLine({ label, pills }: { label: string; pills: ConnectionPill[] }) {
  if (pills.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="w-[120px] shrink-0 text-[12px] text-content/60">{label}</span>
      {pills.map((pill) => (
        <span
          key={pill.source}
          title={pill.note}
          data-connection-source={pill.source}
          data-extra={pill.extra ? "true" : undefined}
          data-ready={pill.ready ? "true" : "false"}
          className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[11px] ${
            pill.extra ? "border-dashed border-content/30" : "border-content/15"
          } ${pill.ready ? "text-content" : "text-content/60"}`}
        >
          {pill.name}
        </span>
      ))}
    </div>
  );
}

function waitingLine(sources: string[]): string {
  const needsClaude = sources.includes("claudeLogin");
  const keys = sources.filter((s) => s !== "claudeLogin").length;
  const parts: string[] = [];
  if (needsClaude) parts.push("The Claude subscription needs Claude Code installed.");
  if (keys > 0) parts.push("The dimmed ones need a model and its key saved under Other models in the model picker.");
  return parts.join(" ");
}
