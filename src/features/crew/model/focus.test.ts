import { describe, expect, it, vi } from "vitest";
import { clearCrewFocus, crewFocus, openCrew, resetCrewFocus, subscribeCrewFocus } from "./focus";

describe("crew focus", () => {
  it("remembers one brief, and the tab button clears it", () => {
    resetCrewFocus();
    const seen: string[] = [];
    const stop = subscribeCrewFocus(() => seen.push(crewFocus().briefId ?? "all"));
    openCrew("brief-1");
    expect(crewFocus().briefId).toBe("brief-1");
    openCrew("  ");
    expect(crewFocus().briefId).toBeNull();
    openCrew("brief-2");
    clearCrewFocus();
    expect(crewFocus().briefId).toBeNull();
    clearCrewFocus();
    expect(seen).toEqual(["brief-1", "all", "brief-2", "all"]);
    stop();
    resetCrewFocus();
  });

  it("tells the window to open the tab", () => {
    resetCrewFocus();
    const heard = vi.fn();
    if (typeof window === "undefined") return;
    window.addEventListener("hivra:open-crew", heard);
    openCrew("brief-1");
    expect(heard).toHaveBeenCalledOnce();
    window.removeEventListener("hivra:open-crew", heard);
    resetCrewFocus();
  });
});
