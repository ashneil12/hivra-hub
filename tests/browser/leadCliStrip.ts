// What the lead strip says and which CLIs it must not offer, shared by the lead-strip specs. Ash ticked Claude Code,
// Cursor and Pi at first launch; Codex, Grok and OpenCode were not ticked, and only Claude Code can lead of those.
export const LEAD_STRIP_REASON =
  "OpenCode cannot lead yet: it can chat here, but it can't give work to helpers, so it does every job itself. " +
  "Switch this chat's coding tool to Claude Code in the model menu above the message box. Its history stays.";

export const CLIS_NOT_OFFERED = ["codex", "cursor", "grok", "opencode", "pi"] as const;
