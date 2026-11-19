import { useEffect, useState, type ReactNode } from "react";

/**
 * Opens what it holds with a short height and fade (Ash, 13 Nov: "the animation for it can be better"): a row's card
 * slides open under the row instead of appearing at once. Nothing moves when the person asks for less motion.
 */
export function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      data-reveal={shown ? "open" : "opening"}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--motion-ease-out)] motion-reduce:transition-none ${
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      } ${className}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
