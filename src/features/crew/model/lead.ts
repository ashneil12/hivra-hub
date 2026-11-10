// WP-141: a Lead on Never use is not briefed. The policy read is the Lead's own project's, the folder a brief runs in.

/** The Lead a brief names, with the folder its project policy is saved under. */
export type LeadPolicyTarget = { leadId: string; leadName: string; folder: string };

/** Throws when the Lead is on Never use, or the policy can't be read. `read` is the crew policy in force. */
export async function refuseNeverUseLead(
  target: LeadPolicyTarget,
  monoId: string,
  read: (monoId: string, folder: string) => Promise<{ neverUse: string[] }>,
): Promise<void> {
  const policy = await read(monoId, target.folder);
  if (policy.neverUse.includes(target.leadId)) {
    throw new Error(`${target.leadName} is on Never use, so it can't be briefed.`);
  }
}
