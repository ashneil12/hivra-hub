// WP-34. A stand-in for the Creator mono: the same files a skill would write, with no model and no network.
// The ask is untrusted, so it only ever lands in a file body, never in a path.

export type ContributionKind = "skill" | "panel" | "persona" | "mono" | "command";

export type DraftFile = { path: string; content: string };

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const KINDS: readonly ContributionKind[] = ["skill", "panel", "persona", "mono", "command"];

export function isKind(value: string): value is ContributionKind {
  return (KINDS as readonly string[]).includes(value);
}

/** Controls go, except the line breaks a body is allowed to keep. Empty becomes a sentence that still loads. */
export function shownAsk(ask: string): string {
  const cleaned = ask.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const trimmed = [...cleaned].slice(0, 500).join("").trim();
  return trimmed.length > 0 ? trimmed : "Hello";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function manifest(name: string): string {
  return `${JSON.stringify({ $schema: SCHEMA, name, version: "1.0.0" }, null, 2)}\n`;
}

export function draftFor(kind: ContributionKind, ask: string): DraftFile[] {
  const shown = shownAsk(ask);
  const plugin: DraftFile = { path: "plugin.json", content: manifest(`made-${kind}`) };
  if (kind === "panel") {
    return [
      plugin,
      {
        path: "hivra/panels/hello/panel.json",
        content: `${JSON.stringify({ kind: "bespoke", title: "Hello", permissions: [] }, null, 2)}\n`,
      },
      { path: "hivra/panels/hello/index.html", content: `<p>${escapeHtml(shown)}</p>\n` },
    ];
  }
  if (kind === "skill") {
    return [
      plugin,
      {
        path: "skills/greet/SKILL.md",
        content: `---\nname: greet\ndescription: Says hello.\n---\n\n${shown}\n`,
      },
    ];
  }
  if (kind === "persona") {
    return [
      plugin,
      {
        path: "hivra/personas/critic.md",
        content: `---\nname: critic\ndescription: A critic.\n---\n\n${shown}\n`,
      },
    ];
  }
  if (kind === "mono") {
    return [
      plugin,
      { path: "hivra/monos/helper/mono.json", content: `${JSON.stringify({ name: "Helper", role: "Helps." }, null, 2)}\n` },
      { path: "hivra/monos/helper/SOUL.md", content: `# Soul\n\n${shown}\n` },
    ];
  }
  return [plugin, { path: "hivra/commands/greet.md", content: `${shown}\n` }];
}
