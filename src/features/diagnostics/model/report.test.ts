import { describe, expect, it } from "vitest";
import { SECRET_MARKER } from "../../portable/model/secrets";
import { buildDiagnosticsReport, DIAGNOSTICS_LOG_LINES, maskHome } from "./report";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("diagnostics report", () => {
  it("masks a planted key and a home path, and keeps a longer name", () => {
    const home = "/Users/ada";
    const text = buildDiagnosticsReport({
      version: "1.2.3",
      build: "wp/104 @ abc1234",
      os: "macos aarch64",
      home,
      lines: [`open ${home}/Library/logs and also ${KEY}`],
      crashes: [`panic at ${home}/src/main.rs with ${KEY}`],
      health: [`data folder ${home}/Library/Application Support/Hivra`],
    });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(home);
    expect(text).toContain(SECRET_MARKER);
    expect(text).toContain("~/Library/logs");
    expect(text).toContain("~/src/main.rs");
    expect(text).toContain("Version: 1.2.3");
    expect(text).toContain("System: macos aarch64");
    expect(text).toContain("data folder ~/Library/Application Support/Hivra");
  });

  it("does not mask a name that only starts like the home folder", () => {
    expect(maskHome("see /Users/adaline/notes", "/Users/ada")).toBe("see /Users/adaline/notes");
    expect(maskHome("see /Users/ada/notes", "/Users/ada/")).toBe("see ~/notes");
  });

  it("masks a Windows home written with either slash", () => {
    const home = "C:\\Users\\Ada";
    const text = maskHome(`${home}\\logs and C:/Users/Ada/logs`, home);
    expect(text).toBe("~\\logs and ~/logs");
    expect(text).not.toContain("Ada");
  });

  it("keeps the last 200 log lines and says when a section is empty", () => {
    const lines = Array.from({ length: DIAGNOSTICS_LOG_LINES + 50 }, (_, n) => `line-${n}`);
    const text = buildDiagnosticsReport({
      version: "1",
      build: "b",
      os: "test",
      home: "",
      lines,
      crashes: [],
      health: [],
    });
    expect(text).not.toContain("line-0\n");
    expect(text).not.toContain("line-49\n");
    expect(text).toContain("line-50");
    expect(text).toContain(`line-${DIAGNOSTICS_LOG_LINES + 49}`);
    expect(text).toContain("No check yet.");
    expect(text).toContain("Crash records\nNone.");
  });

  it("keeps an empty report readable", () => {
    const text = buildDiagnosticsReport({
      version: "",
      build: "",
      os: "",
      home: "",
      lines: [],
      crashes: [],
      health: [],
    });
    expect(text).toContain("Recent log\nNone.");
    expect(text.startsWith("Hivra diagnostics\n")).toBe(true);
  });
});
