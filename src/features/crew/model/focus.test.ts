import { describe, expect, it, vi } from "vitest";
import { clearCrewFocus, crewFocus, holdCrewOpen, openCrew, resetCrewFocus, subscribeCrewFocus } from "./focus";

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

  it("keeps the brief while the open is still held, and clears it when the last hold drops", async () => {
    resetCrewFocus();
    openCrew("brief-1");
    const release = holdCrewOpen();
    release();
    const held = holdCrewOpen();
    await Promise.resolve();
    expect(crewFocus().briefId).toBe("brief-1");
    held();
    await Promise.resolve();
    expect(crewFocus().briefId).toBeNull();
    resetCrewFocus();
  });

  it("does not clear a newer brief when an older open ends", async () => {
    resetCrewFocus();
    openCrew("brief-1");
    const release = holdCrewOpen();
    openCrew("brief-2");
    release();
    await Promise.resolve();
    expect(crewFocus().briefId).toBe("brief-2");
    resetCrewFocus();
  });
});
