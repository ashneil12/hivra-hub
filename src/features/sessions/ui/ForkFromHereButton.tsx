import { GitBranch } from "../../../shared/ui/icons";

/** WP-123: fork this chat from the message the button sits on. */
export function ForkFromHereButton({
  blockId,
  onFork,
}: {
  blockId: string;
  onFork: (blockId: string) => void;
}) {
  return (
    <button
      type="button"
      title="Fork from here"
      aria-label="Fork from here"
      data-fork-from-here={blockId}
      onClick={(event) => {
        event.stopPropagation();
        onFork(blockId);
      }}
      className="rounded-md p-1 text-content/40 transition-[background-color,color] duration-150 hover:bg-content/8 hover:text-content/70 focus-visible:ring-1 focus-visible:ring-accent"
    >
      <GitBranch className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}
