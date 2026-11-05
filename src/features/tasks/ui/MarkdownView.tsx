import { parseMarkdown, type MdNode } from "../model/markdown";

function Nodes({ nodes }: { nodes: readonly MdNode[] }) {
  return nodes.map((node, index) => {
    if (node.type === "text") return <span key={index}>{node.text}</span>;
    if (node.type === "code") return <code key={index}>{node.text}</code>;
    if (node.type === "strong")
      return (
        <strong key={index}>
          <Nodes nodes={node.children} />
        </strong>
      );
    if (node.type === "em")
      return (
        <em key={index}>
          <Nodes nodes={node.children} />
        </em>
      );
    if (node.type === "link")
      return (
        <a key={index} href={node.href}>
          <Nodes nodes={node.children} />
        </a>
      );
    if (node.type === "heading")
      return (
        <h4 key={index} className="text-[12px] text-content">
          <Nodes nodes={node.children} />
        </h4>
      );
    if (node.type === "item")
      return (
        <li key={index} className="text-[12px] text-content/80">
          <Nodes nodes={node.children} />
        </li>
      );
    return (
      <p key={index} className="whitespace-pre-wrap text-[12px] text-content/80">
        <Nodes nodes={node.children} />
      </p>
    );
  });
}

/** Description text. A script stays text; only http, https and mailto become links. */
export function MarkdownView({ source }: { source: string }) {
  const nodes = parseMarkdown(source);
  if (nodes.length === 0) return null;
  return <div className="mt-1">{<Nodes nodes={nodes} />}</div>;
}
