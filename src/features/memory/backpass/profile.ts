// WP-83: the person's opinions and voice. The shape follows kun's files.
// The sentences are Hivra's. Kun's own text is not copied (no licence).

export type Opinion = {
  heading: string;
  reasoning: string;
  evidence: string[];
};

const EVIDENCE = /^evidence:\s*(.*)$/i;

function evidenceCount(line: string): number {
  const links = line.match(/\[[^\]]+\]\([^)]+\)/g) ?? [];
  const ids = line.match(/session:[A-Za-z0-9._:-]+/g) ?? [];
  return Math.max(links.length, ids.length);
}

/** Agents only see an opinion that has at least two chats behind it. */
export function opinionsForAgents(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = ["# Opinions", ""];
  let block: string[] = [];
  let links = 0;
  const flush = () => {
    if (block.length && links >= 2) kept.push(...block, "");
    block = [];
    links = 0;
  };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      flush();
      block = [line];
      continue;
    }
    if (!block.length) continue;
    block.push(line);
    const evidence = EVIDENCE.exec(line.trim());
    if (evidence) links += evidenceCount(evidence[1]);
  }
  flush();
  return `${kept.join("\n").replace(/\n+$/, "")}\n`;
}

export function renderOpinions(opinions: Opinion[]): string {
  return opinionsForAgents(
    [
      "# Opinions",
      "",
      ...opinions.flatMap((opinion) => [
        `## ${opinion.heading}`,
        "",
        opinion.reasoning,
        "",
        `Evidence: ${opinion.evidence.join(", ")}`,
        "",
      ]),
    ].join("\n"),
  );
}

/** True only when the person asked for something written as them. */
export function draftingInPersonName(message: string): boolean {
  return /\b(in my name|as me)\b/i.test(String(message ?? ""));
}

/** Voice is read only when drafting in the person's name. Otherwise nothing. */
export function voiceForDraft(voice: string | null | undefined, draftingAsPerson: boolean): string | null {
  if (!draftingAsPerson) return null;
  const text = String(voice ?? "").trim();
  return text ? text : null;
}

export function emptyOpinions(): string {
  return "# Opinions\n";
}

export function emptyVoice(): string {
  return "# Voice\n\nUse this only when drafting something in this person's name.\n";
}

/** Opinions for a judgment call. Voice only when the message drafts in the person's name. */
export function profileText(opinions: string, voice: string, message: string): string | null {
  const parts: string[] = [];
  const judged = opinionsForAgents(opinions).trim();
  if (judged && judged !== "# Opinions") parts.push(judged);
  const spoken = voiceForDraft(voice, draftingInPersonName(message));
  if (spoken && spoken.trim() !== emptyVoice().trim()) parts.push(spoken.trim());
  if (!parts.length) return null;
  return `<untrusted_profile>\n${parts.join("\n\n")}\n</untrusted_profile>`;
}
