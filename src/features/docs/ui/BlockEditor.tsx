// Hivra's block editor (WP-72). It stores BlockNote's document shape. The
// BlockNote packages are not installed here, so this editor writes that JSON
// itself and uses Hivra's slash menu.

import { useEffect, useRef, useState } from "react";
import { toStoredContent } from "../model/content";
import { slashBlock, slashMenuItems } from "../model/slashMenu";
import { emptyParagraph, type Block, type Inline, type MentionTarget } from "../model/types";

type Props = {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  catalog: readonly MentionTarget[];
  /** WP-74: the finder opens the doc on this block. */
  focusBlockId?: string | null;
  onSubpage?: () => void;
  onSaveFiles?: (files: File[]) => Promise<{ name: string; markdownPath: string }[]>;
};

function textOf(block: Block): string {
  if (!Array.isArray(block.content)) return "";
  return block.content
    .filter((part): part is Extract<Inline, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function mentionsOf(block: Block): Extract<Inline, { type: "mention" }>[] {
  if (!Array.isArray(block.content)) return [];
  return block.content.filter((part): part is Extract<Inline, { type: "mention" }> => part.type === "mention");
}

function withText(block: Block, text: string): Block {
  const content: Inline[] = [];
  if (text) content.push({ type: "text", text, styles: {} });
  content.push(...mentionsOf(block));
  return { ...block, content };
}

function nextBlockId(): string {
  return `b-${crypto.randomUUID()}`;
}

export function BlockEditor({ blocks, onChange, catalog, focusBlockId, onSubpage, onSaveFiles }: Props) {
  const [focusId, setFocusId] = useState<string | null>(blocks[0]?.id ?? null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(blocks[0]?.id ?? null);
  const refs = useRef(new Map<string, HTMLTextAreaElement>());
  const appliedFocus = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId) return;
    refs.current.get(focusId)?.focus();
  }, [focusId]);

  // WP-74: focus the block the finder matched, once it is on the page.
  useEffect(() => {
    if (!focusBlockId) return;
    if (!blocks.some((block) => block.id === focusBlockId)) return;
    if (appliedFocus.current === focusBlockId) return;
    appliedFocus.current = focusBlockId;
    setFocusId(focusBlockId);
    const node = refs.current.get(focusBlockId);
    node?.focus();
    node?.scrollIntoView({ block: "nearest" });
  }, [blocks, focusBlockId]);

  function commit(next: Block[], focus?: string) {
    onChange(toStoredContent(next.length ? next : [emptyParagraph(nextBlockId())]));
    if (focus) setFocusId(focus);
  }

  function update(id: string, block: Block, focus?: string) {
    commit(
      blocks.map((item) => (item.id === id ? block : item)),
      focus,
    );
  }

  function onType(block: Block, value: string) {
    setActiveId(block.id);
    const slash = /^\/([^\n]*)$/.exec(value);
    const mention = /(?:^|\s)@([^\s@]*)$/.exec(value);
    setSlashQuery(slash ? slash[1] : null);
    setMentionQuery(!slash && mention ? mention[1] : null);
    update(block.id, withText(block, value));
  }

  function focusBlock(id: string) {
    setFocusId(id);
    // The menu click blurs the block. Focusing only when the id changes misses a
    // slash pick that stays on the same block.
    requestAnimationFrame(() => refs.current.get(id)?.focus());
  }

  function pickSlash(key: string) {
    const block = blocks.find((item) => item.id === activeId);
    if (!block) return;
    const next = slashBlock(key);
    setSlashQuery(null);
    if (next === "subpage") {
      onSubpage?.();
      update(block.id, withText(block, ""));
      focusBlock(block.id);
      return;
    }
    if (!next) return;
    const content: Inline[] = next.text ? [{ type: "text", text: next.text, styles: {} }] : [];
    update(block.id, { ...block, type: next.type, props: { ...next.props }, content });
    focusBlock(block.id);
  }

  function pickMention(target: MentionTarget) {
    const block = blocks.find((item) => item.id === activeId);
    if (!block) return;
    const text = textOf(block).replace(/(?:^|\s)@[^\s@]*$/, (match) => (match.startsWith(" ") ? " " : ""));
    const content: Inline[] = [];
    if (text) content.push({ type: "text", text, styles: {} });
    content.push(...mentionsOf(block), {
      type: "mention",
      props: { kind: target.kind, targetId: target.id, name: target.name },
    });
    setMentionQuery(null);
    update(block.id, { ...block, content });
    focusBlock(block.id);
  }

  function insertAfter(block: Block) {
    const paragraph = emptyParagraph(nextBlockId());
    const index = blocks.findIndex((item) => item.id === block.id);
    const next = [...blocks.slice(0, index + 1), paragraph, ...blocks.slice(index + 1)];
    setSlashQuery(null);
    setMentionQuery(null);
    commit(next, paragraph.id);
    requestAnimationFrame(() => refs.current.get(paragraph.id)?.focus());
  }

  async function attach(block: Block, files: File[]) {
    if (!onSaveFiles || files.length === 0) return;
    try {
      const saved = await onSaveFiles(files);
      const asset = saved[0];
      if (!asset) return;
      update(block.id, {
        ...block,
        props: { ...block.props, url: asset.markdownPath, name: asset.name },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The file could not be saved";
      update(block.id, withText(block, message));
    }
  }

  const slashItems = slashQuery === null ? [] : slashMenuItems(slashQuery);
  const mentionHits =
    mentionQuery === null
      ? []
      : catalog.filter((target) => target.name.toLowerCase().includes(mentionQuery.toLowerCase()));

  return (
    <div data-block-editor className="flex min-h-0 flex-1 flex-col gap-2">
      {blocks.map((block) => (
        <BlockRow
          key={block.id}
          block={block}
          inputRef={(node) => {
            if (node) refs.current.set(block.id, node);
            else refs.current.delete(block.id);
          }}
          onType={(value) => onType(block, value)}
          onEnter={() => insertAfter(block)}
          onToggleCheck={() =>
            update(block.id, { ...block, props: { ...block.props, checked: block.props.checked !== true } })
          }
          onFocus={() => {
            setActiveId(block.id);
            setFocusId(block.id);
          }}
          onAttach={(files) => void attach(block, files)}
        />
      ))}
      {slashQuery !== null && slashItems.length > 0 ? (
        <div data-slash-menu className="rounded-md border border-content/15 bg-background-base p-1">
          {slashItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickSlash(item.key)}
            >
              <span>{item.title}</span>
              <span aria-hidden className="text-xs text-content/50">
                {item.subtext}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {mentionQuery !== null && mentionHits.length > 0 ? (
        <div data-mention-menu className="rounded-md border border-content/15 bg-background-base p-1">
          {mentionHits.map((target) => (
            <button
              key={`${target.kind}:${target.id}`}
              type="button"
              className="block w-full rounded px-2 py-1 text-left text-content hover:bg-content/10"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickMention(target)}
            >
              {target.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BlockRow({
  block,
  inputRef,
  onType,
  onEnter,
  onToggleCheck,
  onFocus,
  onAttach,
}: {
  block: Block;
  inputRef: (node: HTMLTextAreaElement | null) => void;
  onType: (value: string) => void;
  onEnter: () => void;
  onToggleCheck: () => void;
  onFocus: () => void;
  onAttach: (files: File[]) => void;
}) {
  const text = textOf(block);
  const mentions = mentionsOf(block);
  const heading = block.type === "heading";
  const level = heading ? Number(block.props.level ?? 1) : 0;
  return (
    <div className={rowClass(block, level)} data-block-id={block.id}>
      {block.type === "checkListItem" ? (
        <input
          type="checkbox"
          aria-label="Checked"
          checked={block.props.checked === true}
          onChange={onToggleCheck}
          className="mt-1"
        />
      ) : null}
      {block.type === "callout" ? <span aria-hidden>{String(block.props.emoji ?? "💡")}</span> : null}
      <div className="min-w-0 flex-1">
        {mentions.map((mention) => (
          <span
            key={`${mention.props.kind}:${mention.props.targetId}`}
            className="mr-1 inline-flex rounded bg-content/10 px-1 text-content"
          >
            {mention.props.name}
          </span>
        ))}
        <textarea
          ref={inputRef}
          aria-label="Block text"
          rows={block.type === "codeBlock" ? 4 : 1}
          value={text}
          className="w-full resize-none bg-transparent text-content outline-none"
          onFocus={onFocus}
          onChange={(event) => onType(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onEnter();
            }
          }}
        />
        {block.type === "codeBlock" && block.props.language === "mermaid" ? <Mermaid source={text} id={block.id} /> : null}
        {block.type === "image" || block.type === "file" ? (
          <input
            type="file"
            aria-label={block.type === "image" ? "Choose an image" : "Choose a file"}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              onAttach(files);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function rowClass(block: Block, level: number): string {
  const base = "flex gap-2 rounded px-2 py-1";
  if (block.type === "heading" && level <= 1) return `${base} text-xl`;
  if (block.type === "heading") return `${base} text-lg`;
  if (block.type === "quote" || block.type === "callout") return `${base} border-l-2 border-content/30 bg-content/10`;
  if (block.type === "codeBlock") return `${base} font-mono text-sm bg-content/10`;
  return base;
}

function Mermaid({ source, id }: { source: string; id: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void import("mermaid")
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const safe = `m${id.replace(/[^A-Za-z0-9]/g, "")}`;
        return mermaid.render(safe, source);
      })
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, id]);
  if (failed || !svg) return null;
  return <div aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
