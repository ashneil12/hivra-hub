// What the lead strip says and which CLIs it must not offer, shared by the lead-strip specs. Ash ticked Claude Code,
// Cursor and Pi at first launch; Codex, Grok and OpenCode were not ticked, and only Claude Code can lead of those.
export const LEAD_STRIP_REASON =
  "OpenCode cannot lead yet. The app has no way to give it the tools a lead uses to hand out jobs. Switch this chat to one that can. Its history stays.";

export const CLIS_NOT_OFFERED = ["codex", "cursor", "grok", "opencode", "pi"] as const;
