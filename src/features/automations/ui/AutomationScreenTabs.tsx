import type { KeyboardEvent } from "react";

export type AutomationScreen = "list" | "runs" | "map";

const TABS: { id: AutomationScreen; label: string }[] = [
  { id: "list", label: "Automations" },
  { id: "runs", label: "Runs" },
  { id: "map", label: "Map" },
];

export function automationTabId(id: AutomationScreen): string {
  return `automation-tab-${id}`;
}

export function automationPanelId(id: AutomationScreen): string {
  return `automation-panel-${id}`;
}

/** WP-180a: the three screens. The list underneath is the existing editor. */
export function AutomationScreenTabs({
  screen,
  onScreen,
}: {
  screen: AutomationScreen;
  onScreen: (next: AutomationScreen) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((tab) => tab.id === screen);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    const tab = TABS[next];
    if (!tab || tab.id === screen) return;
    onScreen(tab.id);
    document.getElementById(automationTabId(tab.id))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Automation screens"
      onKeyDown={onKeyDown}
      className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-3"
    >
      {TABS.map((tab) => {
        const selected = screen === tab.id;
        return (
          <button
            key={tab.id}
            id={automationTabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={automationPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onScreen(tab.id)}
            className={`h-7 rounded-md px-2.5 text-[12px] ${
              selected
                ? "bg-content/10 text-content"
                : "text-content/55 hover:bg-content/5 hover:text-content"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
