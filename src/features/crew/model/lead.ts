import { HARNESS_LABEL } from "../../sessions/model/session";

// WP-141: a Lead on Never use is not briefed. The policy read is the Lead's own project's, the folder a brief runs in.

/** The Lead a brief names, with the folder its project policy is saved under and the CLI its chat runs on. */
export type LeadPolicyTarget = { leadId: string; leadName: string; folder: string; cli?: string };

/**
 * Throws when the Lead's CLI is on Never use, or the policy can't be read. `read` is the crew policy in force.
 * Round 6: the Lead's CLI is what is judged (it was the Lead's id before). A Lead whose CLI is unknown is not briefed.
 */
export async function refuseNeverUseLead(
  target: LeadPolicyTarget,
  monoId: string,
  read: (monoId: string, folder: string) => Promise<{ neverUse: string[] }>,
): Promise<void> {
  const policy = await read(monoId, target.folder);
  const cli = target.cli?.trim();
  if (!cli) throw new Error(`${target.leadName}'s CLI is unknown, so it can't be briefed.`);
  if (policy.neverUse.includes(cli)) {
    throw new Error(`${target.leadName} is on Never use, so it can't be briefed. Change it in Settings > Crew Defaults.`);
  }
}

/** A Mono, as far as a brief needs it: its chat, if it has one, and the engine a new chat would start on. */
export type LeadBriefMono = { sessionId?: string; engine?: string; engineModel?: string };

/** A chat, as far as a brief needs it. */
export type LeadBriefChat = { id?: string; harness?: string; model?: string };

function textCli(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cli = value.trim();
  return cli.length > 0 ? cli : undefined;
}

/** An engine this build can start, or nothing. "toString" and any other inherited name are not engines. */
function knownEngine(engine: string | undefined): string | undefined {
  if (!engine || !Object.prototype.hasOwnProperty.call(HARNESS_LABEL, engine)) return undefined;
  return engine;
}

/**
 * The CLI a new Mono chat runs on. Keep this in step with loadMonoSession (monoWorkspace.ts): a known engine that
 * is not the app default is the CLI the new chat starts on. A different model on the same engine does not change it.
 * Anything else, including an unknown engine, is the harness `createDefault` (newDefaultSession) would use.
 */
function harnessForNewChat(mono: LeadBriefMono | undefined, created: LeadBriefChat): string | undefined {
  const engine = knownEngine(mono?.engine);
  const createdHarness = textCli(created.harness);
  if (engine && engine !== createdHarness) return engine;
  return createdHarness;
}

/**
 * The CLI a brief of this Lead will run, or undefined when it cannot be known.
 * An open chat's harness wins, even when it is blank. Otherwise the saved chat is loaded and its harness is used.
 * A Lead with no chat, or whose saved chat is gone, is judged on the CLI the new chat will start on.
 * A load that fails is rethrown: that is not a final "CLI is unknown".
 */
export async function cliForLeadBrief(input: {
  mono: LeadBriefMono | undefined;
  openSessions: readonly LeadBriefChat[];
  load: (sessionId: string) => Promise<LeadBriefChat | null | undefined>;
  createDefault: () => LeadBriefChat | Promise<LeadBriefChat>;
}): Promise<string | undefined> {
  const sessionId = input.mono?.sessionId;
  if (sessionId) {
    const open = input.openSessions.find((session) => session.id === sessionId);
    if (open) return textCli(open.harness);
    const stored = await input.load(sessionId);
    if (stored) return textCli(stored.harness);
  }
  return harnessForNewChat(input.mono, await input.createDefault());
}

/**
 * The check the delegator runs once the Lead's chat exists, before the brief is launched.
 * The harness is that chat's own. A missing harness fails closed.
 */
export async function refuseBriefedLeadHarness(
  lead: { harness?: string },
  target: { leadId: string; leadName: string; folder: string },
  monoId: string,
  read: (monoId: string, folder: string) => Promise<{ neverUse: string[] }>,
): Promise<void> {
  await refuseNeverUseLead(
    { leadId: target.leadId, leadName: target.leadName, folder: target.folder, cli: lead.harness },
    monoId,
    read,
  );
}
