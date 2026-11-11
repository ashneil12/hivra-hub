// WP-160: the app's one hook for the lead tick. The main window looks once a minute while the app is open (no
// LaunchAgent) and ticks each project whose Lead tick is on and due, as that project's Lead. Off in a dev copy.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { appPolicy } from "../../../app/model/appIdentity";
import { teamLeadOf } from "../../agent-app/model/agentAppRooms";
import { crewDelegate } from "../../crew/model/retry";
import { lookAt } from "../../firstmate/watcher/look";
import { hubProjectIdFor } from "../../hub/model/hubData";
import type { Delegation } from "../../monos/model/delegations";
import { findMono } from "../../monos/model/mono";
import {
  builderHealth,
  builderScale,
  projectLoad,
  queuedWorkers,
  refreshBuilderHealth,
  workerLimits,
} from "../../monos/model/workerPool";
import { noteNotable } from "../../notifications/model/notableDelivery";
import { loadQuietHours } from "../../notifications/model/quietHours";
import type { Session } from "../../sessions/model/session";
import { judgeLaunch } from "../../usage/model/spendGate";
import { appPorts, slotAnswer } from "../model/ports";
import { LeadTickScheduler, type LeadContext } from "../model/schedule";
import { leadTickStore } from "../model/store";
import { runLeadTick } from "../model/tick";

export type LeadTickHost = {
  sessions(): readonly Session[];
  /** Loads a chat into the app if it is not open. */
  open(sessionId: string): Promise<Session | undefined>;
  /** Every chat's open delegations (the worker limits count them). */
  openRows(): readonly Delegation[];
};

function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

async function resolveLead(host: LeadTickHost, folder: string): Promise<LeadContext | { skip: string }> {
  const projectId = hubProjectIdFor(folder);
  if (!projectId) return { skip: "This folder isn't one of the hub's projects." };
  const lead = teamLeadOf(projectId);
  if (!lead) return { skip: "This project has no Lead yet." };
  const sessionId = findMono(lead.id)?.sessionId;
  if (!sessionId) return { skip: "Open the Lead's chat once, so the tick can act as the Lead." };
  const session = host.sessions().find((s) => s.id === sessionId) ?? (await host.open(sessionId));
  if (!session) return { skip: "The Lead's chat couldn't be opened." };
  // WP-161: read the machine before a launch is decided. Never throws.
  await refreshBuilderHealth();
  const look = lookAt(session);
  return {
    projectId,
    lead: { monoId: lead.id, name: lead.name, sessionId },
    look: { busy: look.busy, asking: look.asking, queued: look.queued, limited: look.limited, resumeStopped: look.resumeStopped },
  };
}

export function useLeadTick(host: LeadTickHost): void {
  const latest = useRef(host);
  latest.current = host;

  useEffect(() => {
    if (!isMainWindow()) return;
    const scheduler = new LeadTickScheduler({
      store: leadTickStore(),
      now: Date.now,
      quiet: loadQuietHours,
      allowed: () => appPolicy().automations,
      resolve: (folder) => resolveLead(latest.current, folder),
      ports: (folder, context) =>
        appPorts(
          {
            invoke: (command, args) => invoke(command, args),
            slot: (project, inFlight) =>
              slotAnswer({
                limits: workerLimits(project),
                running: projectLoad(project, latest.current.openRows()).running,
                waiting: queuedWorkers().filter((job) => job.project === project).length,
                inFlight,
                health: builderHealth(),
                scale: builderScale(),
                spend: judgeLaunch({ project, harness: "", warn: false }),
              }),
            delegate: (owner, requestId, input) => crewDelegate(owner, requestId, input),
          },
          folder,
          context,
        ),
      run: runLeadTick,
      // Inside quiet hours the ping is kept as a held notice, which leaves when the window ends (notableEvents.ts).
      tell: (folder, lines, at, held) => {
        lines.forEach((text, index) => {
          const kind = held ? "held" : "lead-tick";
          void noteNotable({ id: `lead-tick:${at}:${index}:${folder.slice(-120)}`, kind, text, at }).catch(() => undefined);
        });
      },
    });
    scheduler.start();
    return () => scheduler.stop();
  }, []);
}
