import { describe, expect, it, vi } from "vitest";
import { onAddMachineRequest, requestAddMachine } from "./addMachine";

describe("hand-off into Add machine", () => {
  it("tells every listener, and a removed listener hears nothing", () => {
    const first = vi.fn();
    const second = vi.fn(() => {
      throw new Error("one window failed");
    });
    const stopFirst = onAddMachineRequest(first);
    const stopSecond = onAddMachineRequest(second);
    requestAddMachine({ target: "me@cloud", name: "Desk" });
    expect(first).toHaveBeenCalledWith({ target: "me@cloud", name: "Desk" });
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
    requestAddMachine({ target: "other@host", name: "Other" });
    expect(first).toHaveBeenCalledTimes(1);
  });
});
