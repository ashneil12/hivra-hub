import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  Lock,
  Pencil,
  Shield,
  Sparkles,
} from "../../../shared/ui/icons";
import type { RuntimeMode } from "../../sessions/model/session";
import {
  offeredRuntimeModes,
  permissionCliForHarness,
  runtimeModeCopy,
} from "../../../integrations/harness/core/permissionMatrix";

const ICONS = {
  supervised: Lock,
  "auto-accept-edits": Pencil,
  auto: Sparkles,
  "full-access": Shield,
};

export function QuickPermissionIcon({
  mode,
  className,
}: {
  mode: RuntimeMode;
  className?: string;
}) {
  const Icon = ICONS[mode];
  return (
    <Icon
      className={`${className ?? ""} ${mode === "full-access" ? "text-amber-400/90" : ""}`}
      strokeWidth={1.75}
    />
  );
}

export function QuickPermissions({
  value,
  harness,
  onChange,
  onClose,
}: {
  value: RuntimeMode;
  /** The chat's harness: names and offers the modes as its CLI means them (WP-175). */
  harness?: string | null;
  onChange: (mode: RuntimeMode) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const cli = permissionCliForHarness(harness);
  const modes = offeredRuntimeModes(cli);
  const [active, setActive] = useState(Math.max(0, modes.indexOf(value)));
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  const pick = (mode: RuntimeMode) => {
    onChange(mode);
    onClose();
  };

  return (
    <div
      ref={root}
      role="listbox"
      aria-label="Permissions"
      aria-activedescendant={`${id}-${active}`}
      tabIndex={-1}
      className="min-h-0 overflow-y-auto overscroll-none border-t border-stroke p-2 outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive(
            (index) => (index + step + modes.length) % modes.length,
          );
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          pick(modes[active]);
        }
      }}
    >
      {modes.map((mode, index) => (
        <button
          key={mode}
          id={`${id}-${index}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={value === mode}
          onMouseDown={(event) => {
            event.preventDefault();
            root.current?.focus({ preventScroll: true });
          }}
          onMouseEnter={() => setActive(index)}
          onClick={() => pick(mode)}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${active === index ? "bg-selection-emphasis text-content" : "text-content/75 hover:bg-selection-hover"}`}
        >
          <QuickPermissionIcon mode={mode} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">
              {runtimeModeCopy(mode, cli).label}
            </span>
            <span className="mt-0.5 block text-[11px] text-content/45">
              {runtimeModeCopy(mode, cli).hint}
            </span>
          </span>
          {value === mode ? (
            <Check className="size-3.5 shrink-0 text-accent" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
