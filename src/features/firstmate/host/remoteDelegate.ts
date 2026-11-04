// Hivra WP-60: a brief for a remote project starts on that project's host.
// A local folder is not this module's concern: it returns null and the caller continues.

import { remoteMachineFor, remoteRequest } from "../../connections/model/connections";
import { isRemoteProvider } from "../../connections/model/protocol";
import { remoteProjectFor } from "../../connections/model/remoteProjects";
import { briefRemoteProject } from "./remoteFirstMate";
import type { Initiator } from "./types";

export type RemoteBrief = {
  taskId: string;
  childSessionId: string;
  status: string;
  title: string;
  alreadyStarted: boolean;
  note: string;
};

/**
 * Start the brief on the host when one of the paths is a remote project.
 * No remote project: null, so a local brief is unchanged.
 * A remote project whose machine is away is refused. It is not started here.
 */
export async function briefOnRemoteHost(input: {
  paths: string[];
  launchKey: string;
  ownerSession: string;
  title: string;
  harness: string;
  model: string;
  runtimeMode: string;
  startedBy: Initiator;
  promptFor: (hostCwd: string) => string;
}): Promise<RemoteBrief | null> {
  const remote = input.paths.map((path) => remoteProjectFor(path)).find((project) => project !== undefined);
  if (!remote) return null;
  const machine = await remoteMachineFor(remote.environmentId);
  if (!machine) {
    throw new Error("That machine isn't connected, so the brief was not started. Try again once it is.");
  }
  if (!isRemoteProvider(input.harness)) {
    throw new Error("That harness does not run on the remote machine, so the brief was not started.");
  }
  const { delegation, created } = await briefRemoteProject(
    (method, params) => remoteRequest(machine.id, method, params),
    {
      projectId: remote.projectId,
      launchKey: input.launchKey,
      ownerSession: input.ownerSession,
      title: input.title,
      brief: input.promptFor(remote.cwd),
      harness: input.harness,
      model: input.model,
      runtimeMode: input.runtimeMode,
      startedBy: input.startedBy,
    },
  );
  return {
    taskId: delegation.id,
    childSessionId: delegation.childSession || delegation.id,
    status: delegation.state ?? "running",
    title: delegation.title || input.title,
    alreadyStarted: !created,
    note: "Running on that machine. Its report comes back to you as its own turn when this computer reconnects.",
  };
}
