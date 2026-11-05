// A doc is a note (WP-72). Blocks are BlockNote's document shape so a later
// editor swap does not change what is stored. Page text is data.

export type MentionKind = "page" | "task" | "chat" | "mono";

export type InlineText = {
  type: "text";
  text: string;
  styles: Record<string, boolean>;
};

export type InlineLink = {
  type: "link";
  href: string;
  content: InlineText[];
};

export type InlineMention = {
  type: "mention";
  props: { kind: MentionKind; targetId: string; name: string };
};

export type Inline = InlineText | InlineLink | InlineMention;

export type Block = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: Inline[] | Record<string, unknown>;
  children: Block[];
};

export type MentionTarget = {
  kind: MentionKind;
  id: string;
  name: string;
};

export const MENTION_KINDS: readonly MentionKind[] = [
  "page",
  "task",
  "chat",
  "mono",
];

export function isMentionKind(value: string): value is MentionKind {
  return (MENTION_KINDS as readonly string[]).includes(value);
}

export function blockText(block: Block): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "link") return part.content.map((item) => item.text).join("");
      const name = part.props.name.trim() || part.props.targetId;
      return `@${part.props.kind}/${name}`;
    })
    .join("");
}

export function emptyParagraph(id: string): Block {
  return {
    id,
    type: "paragraph",
    props: {},
    content: [],
    children: [],
  };
}
