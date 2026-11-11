export type AutomationScreen = "list" | "runs" | "map";

const TABS: { id: AutomationScreen; label: string }[] = [
  { id: "list", label: "Automations" },
  { id: "runs", label: "Runs" },
  { id: "map", label: "Map" },
];

/** WP-180a: the three screens. The list underneath is the existing editor. */
export function AutomationScreenTabs({
  screen,
  onScreen,
}: {
  screen: AutomationScreen;
  onScreen: (next: AutomationScreen) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Automation screens"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-3"
    >
      {TABS.map((tab) => {
        const selected = screen === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
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
