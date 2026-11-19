// WP-252: "Report a problem". The person's own agent reads the app's logs and the source of the build that is running,
// says what it thinks went wrong, and drafts a GitHub issue the person opens themselves.
//
// After Up.computer's Triage (docs/user/triage.md, MIT, github.com/krl-gr/upcomputer): the agent asks before it
// applies a fix or posts anything. Here it never posts at all: it gives a prefilled "new issue" link.

export const TRIAGE_REPO = "ashneil12/hivra-hub";

export type TriageBuild = {
  version: string;
  sha: string;
  branch: string;
  dirty: boolean;
};

/** A GitHub "new issue" link with the title and body filled in. Nothing is posted until the person submits it. */
export function triageIssueUrl(title: string, body: string, repo: string = TRIAGE_REPO): string {
  const params = new URLSearchParams({ title: title.trim(), body: body.trim() });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

function buildLine(build: TriageBuild | null): string {
  if (!build) return "The build stamp could not be read. Run `app app.version` to get it.";
  const sha = build.sha || "unknown";
  const dirty = build.dirty ? " (built with uncommitted changes, so the source may differ from that commit)" : "";
  return `Hivra ${build.version || "unknown version"}, commit ${sha} on ${build.branch || "an unknown branch"}${dirty}.`;
}

/**
 * The first message of a triage chat. The person writes what went wrong after the last line and sends it. The
 * playbook is data the agent follows for this chat only; it gives the agent no rights it does not already have.
 */
export function buildTriageDraft(input: { build: TriageBuild | null; logs: string; repo?: string }): string {
  const repo = input.repo ?? TRIAGE_REPO;
  const sha = input.build?.sha ?? "";
  const source = sha ? `https://github.com/${repo}/tree/${sha}` : `https://github.com/${repo}`;
  return [
    "Help me find out what went wrong in Hivra. Follow this playbook:",
    "",
    `1. The build: ${buildLine(input.build)}`,
    `2. Read the app's logs in ${input.logs} (one file per day, newest last). Look at the time I describe, and at warnings and errors around it.`,
    `3. Read the source for exactly that build: ${source}. If a local checkout of the repo is at that commit you may use \`git show ${sha || "<sha>"}:<path>\` instead. Name the file and lines you think are involved.`,
    `4. Look for a known issue first: https://github.com/${repo}/issues?q=is%3Aissue (search for the error text).`,
    "5. Tell me in plain words what you think happened, how sure you are, and what would confirm it.",
    `6. Draft an issue: a short title, what happened, what I expected, steps, the build line above and the log lines that matter. Then give me one link, made with https://github.com/${repo}/issues/new?title=...&body=... (URL-encoded), so I can read it and submit it myself.`,
    "",
    "Rules:",
    "- Privacy: never put a prompt, a reply, a key, a token or a full path under my home folder into the issue. Name a project by its folder name only. Replace anything private with [removed].",
    "- Never post, comment, push or open anything on GitHub yourself, and never change the app, its data or its settings. If you see a fix, describe it and wait for my yes.",
    "",
    "What went wrong:",
    "",
  ].join("\n");
}
