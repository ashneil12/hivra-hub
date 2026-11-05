// SPDX-License-Identifier: Apache-2.0
// Vendored from github.com/coollabsio/orbit apps/web/src/features/docs/editor/slashMenu.tsx (WP-72).
// The upstream file does not carry a separate copyright line.
// The BlockNote menu imports are not used: those packages are not installed here.
// The ordering (title hits before alias hits, Callout after Quote, Mermaid after
// Code) and the callout background are kept. A paragraph's backgroundColor
// `default` must not win over the callout's gray.

export const PAGE_ITEMS_GROUP = "Basic blocks";
export const CALLOUT_DEFAULT_BACKGROUND = "gray";
export const CALLOUT_DEFAULT_EMOJI = "💡";
export const MERMAID_LANGUAGE = "mermaid";
export const MERMAID_STARTER = "flowchart TD\n  A[Start] --> B[End]";

export type SlashItem = {
  key: string;
  title: string;
  subtext: string;
  aliases: string[];
  group: string;
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  { key: "paragraph", title: "Text", subtext: "Plain text", aliases: ["p", "paragraph"], group: PAGE_ITEMS_GROUP },
  { key: "heading", title: "Heading", subtext: "A large heading", aliases: ["h", "heading", "h1"], group: PAGE_ITEMS_GROUP },
  { key: "heading_2", title: "Heading 2", subtext: "A medium heading", aliases: ["h2", "subheading"], group: PAGE_ITEMS_GROUP },
  { key: "heading_3", title: "Heading 3", subtext: "A small heading", aliases: ["h3"], group: PAGE_ITEMS_GROUP },
  { key: "bullet_list", title: "Bullet list", subtext: "A simple list", aliases: ["ul", "list"], group: PAGE_ITEMS_GROUP },
  { key: "numbered_list", title: "Numbered list", subtext: "A list with numbers", aliases: ["ol", "numbered"], group: PAGE_ITEMS_GROUP },
  { key: "check_list", title: "Check list", subtext: "A list with checkboxes", aliases: ["todo", "check", "checkbox"], group: PAGE_ITEMS_GROUP },
  { key: "quote", title: "Quote", subtext: "Capture a quote", aliases: ["quotation"], group: PAGE_ITEMS_GROUP },
  { key: "callout", title: "Callout", subtext: "Make writing stand out", aliases: ["note", "tip", "warning", "info"], group: PAGE_ITEMS_GROUP },
  { key: "code_block", title: "Code", subtext: "Code with a language", aliases: ["code", "pre"], group: PAGE_ITEMS_GROUP },
  { key: "mermaid", title: "Mermaid diagram", subtext: "Draw a diagram from text", aliases: ["mermaid", "diagram", "flowchart", "chart"], group: PAGE_ITEMS_GROUP },
  { key: "image", title: "Image", subtext: "Upload or embed an image", aliases: ["img", "picture"], group: PAGE_ITEMS_GROUP },
  { key: "file", title: "File", subtext: "Attach a file", aliases: ["attachment", "upload"], group: PAGE_ITEMS_GROUP },
  { key: "divider", title: "Divider", subtext: "A line between sections", aliases: ["hr", "rule"], group: PAGE_ITEMS_GROUP },
  { key: "subpage", title: "Sub-page", subtext: "Create a page under this one", aliases: ["subpage", "new", "under", "page"], group: PAGE_ITEMS_GROUP },
];

/** Inserts `item` right after the item with `key`, else at the start of its group. */
export function insertAfterKey<T extends { group?: string; key?: string }>(items: readonly T[], key: string, item: T): T[] {
  const index = items.findIndex((candidate) => candidate.key === key && candidate.group === item.group);
  if (index === -1) return mergeSlashItems(items, [item], item.group);
  return [...items.slice(0, index + 1), item, ...items.slice(index + 1)];
}

/** Inserts `custom` at the start of the `group` run so the group label is printed once. */
export function mergeSlashItems<T extends { group?: string }>(
  defaults: readonly T[],
  custom: readonly T[],
  group = PAGE_ITEMS_GROUP,
): T[] {
  const index = defaults.findIndex((item) => item.group === group);
  if (index === -1) return [...custom, ...defaults];
  return [...defaults.slice(0, index), ...custom, ...defaults.slice(index)];
}

/**
 * Puts groups with a title-prefix match first, and those items first inside the group.
 * An alias must not outrank a title ("/sub" is Sub-page, not Heading 2's "subheading").
 */
export function preferTitleMatches<T extends { title: string; group?: string }>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  const titleHit = (item: T) => item.title.toLowerCase().startsWith(needle);
  const groupOrder = [...new Set(items.map((item) => item.group))];
  const hitGroups = new Set(items.filter(titleHit).map((item) => item.group));
  const rank = (item: T): [number, number, number] => [
    hitGroups.has(item.group) ? 0 : 1,
    groupOrder.indexOf(item.group),
    titleHit(item) ? 0 : 1,
  ];
  return [...items].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

function matches(item: SlashItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const hay = [item.title, item.subtext, ...item.aliases].join(" ").toLowerCase();
  return hay.includes(needle);
}

/** Slash menu for a page, filtered and ordered. */
export function slashMenuItems(query: string): SlashItem[] {
  const without = SLASH_ITEMS.filter((item) => item.key !== "callout" && item.key !== "mermaid");
  const withCallout = insertAfterKey(without, "quote", SLASH_ITEMS.find((item) => item.key === "callout")!);
  const withMermaid = insertAfterKey(withCallout, "code_block", SLASH_ITEMS.find((item) => item.key === "mermaid")!);
  return preferTitleMatches(withMermaid.filter((item) => matches(item, query)), query);
}

export type SlashBlock = {
  type: string;
  props: Record<string, unknown>;
  text: string;
};

/** What picking an item does to the current block. Sub-page is a page action, not a block. */
export function slashBlock(key: string): SlashBlock | "subpage" | null {
  switch (key) {
    case "paragraph":
      return { type: "paragraph", props: {}, text: "" };
    case "heading":
      return { type: "heading", props: { level: 1 }, text: "" };
    case "heading_2":
      return { type: "heading", props: { level: 2 }, text: "" };
    case "heading_3":
      return { type: "heading", props: { level: 3 }, text: "" };
    case "bullet_list":
      return { type: "bulletListItem", props: {}, text: "" };
    case "numbered_list":
      return { type: "numberedListItem", props: {}, text: "" };
    case "check_list":
      return { type: "checkListItem", props: { checked: false }, text: "" };
    case "quote":
      return { type: "quote", props: {}, text: "" };
    case "callout":
      return {
        type: "callout",
        props: { emoji: CALLOUT_DEFAULT_EMOJI, backgroundColor: CALLOUT_DEFAULT_BACKGROUND, textColor: "default" },
        text: "",
      };
    case "code_block":
      return { type: "codeBlock", props: { language: "" }, text: "" };
    case "mermaid":
      return { type: "codeBlock", props: { language: MERMAID_LANGUAGE }, text: MERMAID_STARTER };
    case "divider":
      return { type: "divider", props: {}, text: "" };
    case "image":
      return { type: "image", props: { url: "", caption: "", name: "" }, text: "" };
    case "file":
      return { type: "file", props: { url: "", name: "", caption: "" }, text: "" };
    case "subpage":
      return "subpage";
    default:
      return null;
  }
}
