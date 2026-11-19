import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelList, ModelOptions } from "@/features/models/ModelPicker";
import {
  useForgetChoiceOnLeave,
  useSessionChoice,
} from "@/features/models/sessionChoice";
import type { ModelCatalog } from "@/features/models/types";
import type { Project } from "@/features/workspace/types";

const desktop = vi.hoisted(() => ({
  fingerprint: "model-picker-desktop",
  configure: vi.fn(),
  dismissTo: vi.fn(),
  listModels: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean; expanded?: boolean };
    disabled?: boolean;
  }) => (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-checked={accessibilityState?.checked}
      aria-expanded={accessibilityState?.expanded}
    >
      {children}
    </button>
  ),
  ActivityIndicator: () => null,
  Switch: () => null,
  StyleSheet: { hairlineWidth: 1 },
  Alert: { alert: vi.fn() },
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("expo-router", () => ({ router: { dismissTo: desktop.dismissTo } }));
vi.mock("@expo/ui", () => ({ Host: () => null, Slider: () => null }));
vi.mock("@expo/ui/swift-ui", () => ({ Host: () => null, Slider: () => null }));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityLabel: vi.fn(),
  tint: vi.fn(),
}));
vi.mock("@/features/connection/ConnectionProvider", () => ({
  useConnection: () => ({
    pairing: { desktop: { fingerprint: desktop.fingerprint } },
    command: desktop.usage,
  }),
}));
vi.mock("@/features/settings/defaultModel", () => ({
  useDefaultModel: () => null,
  useDefaultRuntimeMode: () => null,
}));
vi.mock("@/features/settings/SettingsUI", () => ({
  SettingsPage: ({ children }: { children?: ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("@/features/sessions/ProviderLogo", () => ({
  ProviderLogo: () => null,
}));
vi.mock("@/ui/Icon", () => ({ Icon: () => null }));
vi.mock("@/ui/theme", () => {
  const colors = {
    content: "white",
    muted: "gray",
    accent: "blue",
    stroke: "gray",
  };
  return {
    useColors: () => colors,
    withAlpha: (color: string) => color,
    themedStyles: (create: (value: typeof colors) => object) => () =>
      create(colors),
  };
});
vi.mock("@/features/workspace/WorkspaceProvider", () => ({
  useWorkspace: () => ({
    projects: [project],
    sessions: [{ id: "existing", runtimeMode: "full-access" }],
    configureSession: desktop.configure,
    listModels: desktop.listModels,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const project = { id: "project", defaultRuntimeMode: "supervised" } as Project;
const catalog: ModelCatalog = {
  harnesses: [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude Code" },
  ],
  models: [
    { id: "codex:gpt", harness: "codex", name: "GPT", settings: [] },
    { id: "claude:sonnet", harness: "claude", name: "Sonnet", settings: [] },
  ],
  runtimeModes: [],
  current: {
    harness: "codex",
    model: "codex:gpt",
    modelSettings: {},
    runtimeMode: "full-access",
    providerAccountId: "account-work",
  },
  accounts: [
    { id: "default", provider: "codex", label: "Personal" },
    { id: "account-work", provider: "codex", label: "Work" },
    { id: "default", provider: "claude", label: "Claude personal" },
  ],
  selectedAccounts: { codex: "default", claude: "default" },
};

describe("account picker in the model sheet", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let draft: ReturnType<typeof useSessionChoice>;
  function Screen({ sessionId }: { sessionId?: string }) {
    draft = useSessionChoice(project, undefined);
    useForgetChoiceOnLeave(project.id, undefined);
    useForgetChoiceOnLeave(project.id, "existing");
    return (
      <ModelList
        projectId={project.id}
        sessionId={sessionId}
        query=""
        onOpenOptions={() => {}}
      />
    );
  }
  const render = (sessionId?: string) =>
    act(async () => {
      root.render(<Screen sessionId={sessionId} />);
      await Promise.resolve();
    });
  const click = (label: string) =>
    act(() => {
      const button = [...container.querySelectorAll("button")].find(
        (element) =>
          element.getAttribute("aria-label") === label ||
          element.textContent?.startsWith(label),
      );
      expect(button, label).toBeDefined();
      button!.click();
    });
  beforeEach(() => {
    vi.clearAllMocks();
    desktop.fingerprint = "model-picker-desktop";
    desktop.listModels.mockResolvedValue(catalog);
    desktop.usage.mockResolvedValue({
      accounts: {
        default: {
          status: { tone: "ready", label: "Ready", detail: null },
          updatedAt: 1,
          stale: false,
          meters: [
            {
              title: "5h",
              usedPercent: 30,
              percent: 30,
              label: "30% used",
              reset: "Resets in 2h",
            },
          ],
        },
      },
    });
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("chooses an account for a new session and keeps choices separate across providers", async () => {
    await render();
    click("Account: Personal");
    expect(
      container
        .querySelector('[role="radio"][aria-checked="true"]')
        ?.getAttribute("aria-label"),
    ).toBe("Personal");
    click("Work");
    expect(draft.accounts.codex).toBe("account-work");
    expect(draft.chosen?.pick.harness).toBe("codex");
    click("Claude Code");
    await act(async () => {
      click("Sonnet");
    });
    expect(
      container.querySelector('[aria-label="Account: Claude personal"]'),
    ).not.toBeNull();
    expect(draft.accounts.claude).toBeUndefined();
    expect(desktop.configure).not.toHaveBeenCalled();
    expect(desktop.dismissTo).not.toHaveBeenCalled();
  });

  it("opens a fresh conversation when changing an existing chat's pinned account", async () => {
    await render("existing");
    click("Account: Work");
    expect(container.textContent).toContain(
      "Switching accounts opens a new chat.",
    );
    click("Personal");
    expect(draft.accounts.codex).toBe("default");
    expect(draft.chosen?.pick).toEqual({
      harness: "codex",
      model: "codex:gpt",
      modelSettings: {},
    });
    expect(draft.startAccess).toBe("full-access");
    expect(desktop.configure).not.toHaveBeenCalled();
    expect(desktop.dismissTo).toHaveBeenCalledWith({
      pathname: "/project/[projectId]",
      params: { projectId: "project" },
    });
  });

  it("keeps model selection usable with an older desktop", async () => {
    desktop.listModels.mockResolvedValue({
      ...catalog,
      accounts: undefined,
      selectedAccounts: undefined,
    });
    await render();
    expect(container.textContent).toContain("GPT");
    expect(container.querySelector('[aria-label^="Account:"]')).toBeNull();
  });

  it("shows usage in the collapsed account card and refreshes without switching", async () => {
    await render();
    expect(container.textContent).toContain("30% used");
    expect(container.textContent).toContain("5h · 2h");
    await act(async () => {
      click("Refresh account usage");
    });
    expect(desktop.usage).toHaveBeenLastCalledWith("accounts.usage", {
      projectId: "project",
      provider: "codex",
      refresh: true,
    });
    expect(draft.accounts).toEqual({});
    expect(desktop.configure).not.toHaveBeenCalled();
  });

  it("hides the previous desktop's profiles while a different desktop loads", async () => {
    await render();
    expect(
      container.querySelector('[aria-label="Account: Personal"]'),
    ).not.toBeNull();
    desktop.fingerprint = "different-desktop";
    desktop.listModels.mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.querySelector('[aria-label^="Account:"]')).toBeNull();
  });
});

const runtimeModeNames = (names: Record<string, readonly [string, string]>) =>
  (["supervised", "auto-accept-edits", "auto", "full-access"] as const).map((id) => ({
    id,
    label: names[id][0],
    hint: names[id][1],
    offered: true,
  }));

describe("access choices follow the chat's CLI (WP-175 MED 2)", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  const renderOptions = (next: ModelCatalog) => {
    desktop.listModels.mockResolvedValue(next);
    return act(async () => {
      root.render(<ModelOptions projectId="project" sessionId={undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    desktop.fingerprint = "model-picker-desktop";
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => act(() => root.unmount()));

  it("fx is not hidden, and offers Full access only, with the desktop's honest names", async () => {
    const fxNames = {
      supervised: ["fx approves its own requests", "fx runs its own code mode."],
      "auto-accept-edits": ["fx approves its own requests", "fx runs its own code mode."],
      auto: ["fx approves its own requests", "fx runs its own code mode."],
      "full-access": ["Full access", "Allow commands, edits."],
    } as const;
    const modes = runtimeModeNames(fxNames).map((mode) => ({
      ...mode,
      offered: mode.id === "full-access",
    }));
    const fxCatalog: ModelCatalog = {
      ...catalog,
      models: [{ id: "fx:glm", harness: "fx", name: "GLM", settings: [] }],
      runtimeModes: modes.filter((mode) => mode.offered),
      runtimeModesByHarness: { fx: modes },
      current: { ...catalog.current, harness: "fx", model: "fx:glm", runtimeMode: "supervised" },
    };
    // The options button names the chat's access in the desktop's words, even though fx offers one mode.
    desktop.listModels.mockResolvedValue(fxCatalog);
    await act(async () => {
      root.render(<ModelList projectId="project" sessionId={undefined} query="" onOpenOptions={() => {}} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("fx approves its own requests");
    expect(container.textContent).not.toContain("An AI reviewer");
    // The access card offers Full access alone: the other modes are not choices.
    await renderOptions(fxCatalog);
    expect(container.textContent).toContain("Access");
    expect(container.textContent).toContain("Full access");
    expect(container.textContent).not.toContain("Auto-accept edits");
    expect(container.textContent).not.toContain("An AI reviewer");
  });

  it("Antigravity's Auto reads as the desktop names it, never as an AI reviewer", async () => {
    const names = {
      supervised: ["Supervised", "Ask before commands."],
      "auto-accept-edits": ["Auto-accept edits", "Auto-approve edits."],
      auto: ["Default (no AI review)", "Runs Antigravity's default mode."],
      "full-access": ["Full access", "Allow commands."],
    } as const;
    await renderOptions({
      ...catalog,
      models: [{ id: "antigravity:gemini", harness: "antigravity", name: "Gemini", settings: [] }],
      runtimeModes: runtimeModeNames(names),
      runtimeModesByHarness: { antigravity: runtimeModeNames(names) },
      current: { ...catalog.current, harness: "antigravity", model: "antigravity:gemini", runtimeMode: "auto" },
    });
    expect(container.textContent).toContain("Default (no AI review)");
    expect(container.textContent).not.toContain("An AI reviewer");
    expect(container.textContent).not.toMatch(/\bAuto\b:/);
  });
});
