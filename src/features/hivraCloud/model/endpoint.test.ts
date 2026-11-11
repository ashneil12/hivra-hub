import { describe, expect, it } from "vitest";
import { endpointProblem } from "./endpoint";

describe("Hivra Cloud address", () => {
  it("allows an empty address, which contacts nothing", () => {
    expect(endpointProblem("")).toBeNull();
    expect(endpointProblem("   ")).toBeNull();
  });

  it("allows https, or http only to this Mac, with no path, query or login", () => {
    expect(endpointProblem("https://cloud.example")).toBeNull();
    expect(endpointProblem("https://cloud.example/")).toBeNull();
    expect(endpointProblem("https://cloud.example:8443")).toBeNull();
    expect(endpointProblem("HTTPS://Cloud.Example")).toBeNull();
    expect(endpointProblem("http://127.0.0.1:9")).toBeNull();
    expect(endpointProblem("http://localhost")).toBeNull();
    expect(endpointProblem("http://[::1]:9")).toBeNull();
  });

  it("rejects the same addresses the app refuses", () => {
    expect(endpointProblem("not a url")).toBe("The Hivra Cloud address isn't a valid URL.");
    expect(endpointProblem("http://cloud.example")).toBe(
      "The Hivra Cloud address must be https, or http to this Mac.",
    );
    expect(endpointProblem("HTTP://Cloud.Example")).toBe(
      "The Hivra Cloud address must be https, or http to this Mac.",
    );
    expect(endpointProblem("http://0.0.0.0:9")).toBe(
      "The Hivra Cloud address must be https, or http to this Mac.",
    );
    expect(endpointProblem("https://cloud.example/path")).toBe(
      "The Hivra Cloud address must be only an address, with no path, query or login.",
    );
    expect(endpointProblem("https://cloud.example/?token=1")).toBe(
      "The Hivra Cloud address must be only an address, with no path, query or login.",
    );
    expect(endpointProblem("https://user:pw@cloud.example")).toBe(
      "The Hivra Cloud address must be only an address, with no path, query or login.",
    );
    expect(endpointProblem("https://cloud.example/#x")).toBe(
      "The Hivra Cloud address must be only an address, with no path, query or login.",
    );
    expect(endpointProblem("https://cloud.example/path?x=1#y")).toBe(
      "The Hivra Cloud address must be only an address, with no path, query or login.",
    );
  });
});
