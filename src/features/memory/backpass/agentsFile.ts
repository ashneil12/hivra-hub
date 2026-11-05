// WP-83: one instruction file. CLAUDE.md is a one-line import, the dotfiles pattern.
// The idea is Kun Chen's (MIT-0). This file is Hivra's, not a copy of the dotfiles.

/** Where Hivra writes for more than one engine, the body lives once, in AGENTS.md. */
export function instructionFiles(body: string, engines: string[]): { path: string; text: string }[] {
  const text = body.endsWith("\n") ? body : `${body}\n`;
  const files = [{ path: "AGENTS.md", text }];
  const named = engines.map((engine) => engine.trim()).filter(Boolean);
  if (named.length > 1) files.push({ path: "CLAUDE.md", text: "@AGENTS.md\n" });
  return files;
}
