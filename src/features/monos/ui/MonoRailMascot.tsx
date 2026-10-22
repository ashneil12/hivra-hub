import { PixelMascot } from "../../projects/ui/PixelMascot";
import { monoTileLetters, type MonoStatus } from "../model/mono";

/** The rail mascot and its status circle, shared by both rail layouts. */
export function MonoRailMascot({
  name,
  color,
  status = "idle",
  className = "size-4 shrink-0",
  letter,
  tone,
  dot = true,
}: {
  name: string;
  /** False: no status circle (a draft Mono that isn't running yet). */
  dot?: boolean;
  /** The sidebar's neutral avatar: this initial, light on a grey glass square, instead of the mascot. */
  letter?: string;
  color: string;
  status?: MonoStatus;
  /** A failed last turn: red (fix something first) or amber (Try again can work). */
  tone?: "red" | "amber";
  className?: string;
}) {
  return (
    <span className={`relative grid place-items-center ${className}`}>
      {letter ? (
        <span
          data-mono-letter
          aria-hidden
          className="grid size-full place-items-center rounded-[4px] bg-content/12 text-[8px] font-semibold tracking-tight leading-none text-content/80 ring-1 ring-inset ring-content/10"
        >
          {letter.length > 2 ? monoTileLetters(letter) : letter}
        </span>
      ) : (
        <PixelMascot
          name={name}
          color={color}
          status={status}
          still={status === "idle"}
          className="size-full"
        />
      )}
      {dot ? (
        <MonoStatusDot
          status={status}
          color={color}
          tone={tone}
          // Just off the tile's top-right corner, so it never cuts into the creature (Critiquito, 21 Oct).
          className="-top-1.5 -right-1.5 size-1.5"
        />
      ) : null}
    </span>
  );
}

/** The status circle alone, for rails that dim the mascot but not its state. */
export function MonoStatusDot({
  status,
  className,
  tone,
}: {
  status: MonoStatus;
  /** Unused: a working dot is grey, not the Mono's colour. Kept so callers needn't change. */
  color?: string;
  className: string;
  /** A failed last turn: red (fix something first) or amber (Try again can work). */
  tone?: "red" | "amber";
}) {
  return (
    <span
      aria-hidden
      data-mono-dot={status}
      className={`absolute rounded-full ring-1 ring-background-base ${className} ${
        status === "working"
          ? // Working is a stronger grey that pulses, not the Mono's own colour (the room, 21 Oct): the rail's only
            // colours are the ones that ask something of Ash.
            "bg-content/60 motion-safe:animate-pulse"
          : status === "needs-you"
            ? "bg-accent"
            : status === "failed"
              ? tone === "red"
                ? "bg-red-400"
                : "bg-content/60" // r27b: grey, never amber; red is only for Needs you
              : "bg-content/30"
      }`}
    />
  );
}
