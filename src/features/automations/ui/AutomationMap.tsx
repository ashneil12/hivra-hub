import { createElement, type HTMLAttributes } from "react";
import type { Automation } from "../model/automations";
import {
  MAP_NODE_HEIGHT,
  MAP_NODE_WIDTH,
  mapLayout,
  type MapNode,
} from "../model/mapLayout";

/**
 * WP-180a: a read-only drawing of what feeds what. A node opens the editor.
 * Nothing here drags, edits or starts an automation.
 */
export function AutomationMap({
  automations,
  onOpen,
}: {
  automations: readonly Automation[];
  onOpen: (automationId: string) => void;
}) {
  const layout = mapLayout(automations);
  if (layout.emptyMessage) {
    return (
      <p className="px-6 py-8 text-[13px] text-content/60">{layout.emptyMessage}</p>
    );
  }
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-automation-map>
      <svg
        width={layout.width}
        height={layout.height}
        role="group"
        aria-label="Automation map"
        className="text-content"
      >
        {layout.edges.map((edge) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              data-from={from.label}
              data-to={to.label}
              x1={from.x + MAP_NODE_WIDTH}
              y1={from.y + MAP_NODE_HEIGHT / 2}
              x2={to.x}
              y2={to.y + MAP_NODE_HEIGHT / 2}
              stroke="currentColor"
              strokeOpacity={0.35}
              pointerEvents="none"
            />
          );
        })}
        {layout.nodes.map((node) => (
          <MapNodeView key={node.id} node={node} onOpen={onOpen} />
        ))}
      </svg>
    </div>
  );
}

function MapNodeView({
  node,
  onOpen,
}: {
  node: MapNode;
  onOpen: (automationId: string) => void;
}) {
  const open = node.automationId
    ? () => onOpen(node.automationId)
    : undefined;
  return (
    <foreignObject
      x={node.x}
      y={node.y}
      width={MAP_NODE_WIDTH}
      height={MAP_NODE_HEIGHT}
      data-node={node.kind}
      data-disabled={node.disabled ? "true" : "false"}
      opacity={node.disabled ? 0.4 : 1}
    >
      {createElement(
        "div",
        {
          className: "h-full w-full",
          xmlns: "http://www.w3.org/1999/xhtml",
        } as HTMLAttributes<HTMLDivElement> & { xmlns: string },
        open ? (
          <button
            type="button"
            aria-label={node.label}
            title={node.label}
            onClick={open}
            className="h-full w-full truncate rounded-md border border-stroke bg-content/5 px-2 text-left text-[12px] text-content"
          >
            {node.label}
          </button>
        ) : (
          <div
            title={node.label}
            className="flex h-full w-full items-center truncate rounded-md border border-stroke px-2 text-[12px] text-content/80"
          >
            {node.label}
          </div>
        ),
      )}
    </foreignObject>
  );
}
