// Hivra WP-119: the crew tree above the rows. A click opens the detail. Not a canvas.

import { useState } from "react";
import type { CrewTree, CrewTreeNode } from "../model/crewTree";

function findNode(node: CrewTreeNode, id: string): CrewTreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function NodeView({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: CrewTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={depth > 0 ? { paddingLeft: 12 } : undefined}>
      <button
        type="button"
        data-crew-node={node.id}
        data-role={node.role}
        aria-pressed={selected === node.id}
        className="flex w-full items-baseline gap-2 px-3 py-1 text-left"
        onClick={() => onSelect(node.id)}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-content">{node.title}</span>
        {node.statusWord ? <span className="shrink-0 text-[12px] text-content/70">{node.statusWord}</span> : null}
        {node.latestTool ? (
          <span data-latest-tool className="max-w-[40%] shrink-0 truncate text-[12px] text-content/50">
            {node.latestTool}
          </span>
        ) : null}
      </button>
      {node.children.map((child) => (
        <NodeView key={child.id} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Detail({ node, onOpenChat }: { node: CrewTreeNode; onOpenChat?: (sessionId: string) => void }) {
  return (
    <section data-crew-detail className="border-t border-stroke px-3 py-2">
      <h3 className="text-[13px] text-content">{node.title}</h3>
      <p data-crew-brief className="mt-1 text-[12px] text-content/70">
        {node.brief ?? "No brief yet."}
      </p>
      {node.tools.length === 0 ? (
        <p className="mt-1 text-[12px] text-content/50">No tool calls yet.</p>
      ) : (
        <ul className="mt-1">
          {node.tools.map((tool) => (
            <li key={tool.id} data-tool-call={tool.id} className="text-[12px] text-content/70">
              {tool.label}
              {tool.timing ? <span className="text-content/50"> {tool.timing}</span> : null}
              {tool.running ? <span className="text-content/50"> working</span> : null}
            </li>
          ))}
        </ul>
      )}
      {node.sessionId ? (
        <button type="button" className="mt-1.5 text-[12px] text-content/60" onClick={() => onOpenChat?.(node.sessionId!)}>
          Open the chat
        </button>
      ) : null}
    </section>
  );
}

export function CrewTreeView({
  tree,
  onOpenChat,
}: {
  tree: CrewTree;
  onOpenChat?: (sessionId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!tree.root) return null;
  const open = selected ? findNode(tree.root, selected) : null;
  return (
    <div data-crew-tree className="border-b border-stroke py-1">
      <NodeView
        node={tree.root}
        depth={0}
        selected={selected}
        onSelect={(id) => setSelected((current) => (current === id ? null : id))}
      />
      {open ? <Detail node={open} onOpenChat={onOpenChat} /> : null}
    </div>
  );
}
