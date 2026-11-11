import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { asStatus, CLOUD_OFF, cloudApi, CloudSaveConflict } from "./cloud";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("cloud status from the app", () => {
  it("stays off when the answer is missing or not a real switch", () => {
    expect(asStatus(undefined)).toEqual(CLOUD_OFF);
    expect(asStatus(null)).toEqual(CLOUD_OFF);
    expect(asStatus({ enabled: "true", endpoint: "https://cloud.example", signedIn: true })).toEqual(
      CLOUD_OFF,
    );
    expect(asStatus({ enabled: true, endpoint: "", signedIn: true })).toMatchObject({
      enabled: true,
      state: "no_endpoint",
      signedIn: false,
      endpoint: "",
    });
    expect(asStatus({ enabled: true, endpoint: "http://cloud.example", signedIn: true })).toMatchObject({
      state: "bad_endpoint",
      signedIn: false,
    });
  });

  it("keeps a ready signed-in answer", () => {
    expect(
      asStatus({
        state: "ready",
        enabled: true,
        endpoint: "https://cloud.example",
        revision: 3,
        signedIn: true,
        message: null,
      }),
    ).toMatchObject({ state: "ready", enabled: true, signedIn: true, revision: 3 });
  });
});

describe("cloud commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("sends a pairing code and nothing else", async () => {
    vi.mocked(invoke).mockResolvedValue({ id: "m1", label: "Desk", sshHost: "me@cloud" });
    await cloudApi.pair("ABCD-1234");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("hivra_cloud_pair", { code: "ABCD-1234" });
  });

  it("starts sign-in with no token and no code", async () => {
    vi.mocked(invoke).mockResolvedValue({ enabled: false });
    await cloudApi.signIn();
    expect(invoke).toHaveBeenCalledWith("hivra_cloud_sign_in");
    const args = vi.mocked(invoke).mock.calls[0]?.[1];
    expect(args ?? {}).not.toHaveProperty("code");
    expect(args ?? {}).not.toHaveProperty("token");
    expect(args ?? {}).not.toHaveProperty("key");
  });

  it("turns a revision clash into a conflict and does not pretend it saved", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Hivra Cloud was changed somewhere else. Nothing was saved."));
    await expect(cloudApi.save(true, "https://cloud.example", 1)).rejects.toBeInstanceOf(CloudSaveConflict);
  });
});
