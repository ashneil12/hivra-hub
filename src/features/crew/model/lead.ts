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
    throw new Error(`${target.leadName} is on Never use, so it can't be briefed.`);
  }
}
