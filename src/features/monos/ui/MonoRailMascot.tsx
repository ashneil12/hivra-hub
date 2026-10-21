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
}: {
  name: string;
  /** The sidebar's neutral avatar: this initial, light on a grey glass square, instead of the mascot. */
  letter?: string;
  color: string;
  status?: MonoStatus;
  /** A failed last turn: red (fix something first) or amber (Try again can work). */
  tone?: "red" | "amber";
  className?: string;
}) {
  // Can't tell (monoLiveness.ts): the creature faded and still, no new dot colour; hover says "Not sure" (rail title).
  const unsure = status === "unknown";
  return (
    <span
      data-mono-unsure={unsure || undefined}
      className={`relative grid place-items-center ${className}`}
    >
      {letter ? (
        <span
          data-mono-letter
          data-unsure={unsure || undefined}
          aria-hidden
          className="grid size-full place-items-center rounded-[4px] bg-content/12 data-[unsure]:opacity-40 text-[8px] font-semibold tracking-tight leading-none text-content/80 ring-1 ring-inset ring-content/10"
        >
          {letter.length > 2 ? monoTileLetters(letter) : letter}
        </span>
      ) : (
        <PixelMascot
          name={name}
          color={color}
          status={status}
          still={status === "idle" || unsure}
          // Only the creature fades; the dot keeps its place and its plain grey.
          className={`size-full ${unsure ? "opacity-40" : ""}`}
        />
      )}
      <MonoStatusDot
        status={status}
        color={color}
        tone={tone}
        // Just off the tile's top-right corner, so it never cuts into the creature (Critiquito, 21 Oct).
        className="-top-1.5 -right-1.5 size-1.5"
      />
    </span>
  );
}

/** The status circle alone, for rails that dim the mascot but not its state. */
export function MonoStatusDot({
  status,
  color,
  className,
  tone,
}: {
  status: MonoStatus;
  color: string;
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
          ? "motion-safe:animate-pulse"
          : status === "needs-you"
            ? "bg-accent"
            : status === "failed"
              ? tone === "red"
                ? "bg-red-400"
                : "bg-amber-400"
              : "bg-content/30"
      }`}
      style={status === "working" ? { backgroundColor: color } : undefined}
    />
  );
}
