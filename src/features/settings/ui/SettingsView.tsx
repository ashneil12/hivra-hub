import { setShowCodeTools, useShowCodeTools } from "../model/codeTools";
import { activeThemeOf, allSchemes, loadActiveSchemeId, removeCustomScheme, saveActiveSchemeId, saveCustomScheme, themesOf, type SchemeTheme, type ThemeScheme } from "../model/themeSchemes";
import { activeThemeChoice, applyOffer, discardOffer, endPreview, offeredPreviewLook, pickTheme, previewOffer, scanMonoThemes, themeOffers, themePreview, themeRefusals, useThemesVersion } from "../model/themeFiles";
import { UserNameField } from "../../hub/ui/UserNameField";
import { HIVRA_LAYOUT_FIXED } from "../../hub/model/hivraLayout";
import { applyTheme, discardTheme, MAX_THEMES_PER_SCHEME, offerTheme, pendingTheme, previewingTheme, previewLook, previewTheme, stopPreview, useThemeImportVersion } from "../model/themeImport";
import { ChangesPage } from "../../hub/ui/ChangesPage";
import { DecisionsPage } from "../../hub/ui/DecisionsPage";
import { ActivityPage } from "../../activity/ui/ActivityPage";
import { WorkLogPanel } from "../../workLog/ui/WorkLogPanel";
// WP-108: Settings, Usage. Counts and names only.
import { UsagePage } from "../../usage/ui/UsagePage";
// WP-79: Settings → Connected apps.
import { ConnectedApps } from "../../outside/ui/ConnectedApps";
import { DashboardsPage } from "../../hub/ui/DashboardsPage";
import { ConnectorsPage } from "../../hub/ui/ConnectorsPage";
// WP-92: the keys agents ask for and use without seeing them.
import { SecretsPage } from "../../secrets/ui/SecretsPage";
import { PortablePage } from "../../portable/ui/PortablePage";
// WP-75: checked backups.
import { BackupsPage } from "../../backups/ui/BackupsPage";
import { TrashPage } from "../../trash/ui/TrashPage";
import { HistoryImportScreen } from "../../historyImport/ui/HistoryImportScreen";
import { ChatImportSettings } from "../../chatImport/ui/ChatImportSettings";
import { MemorySettingsScreen } from "../../memory/ui/MemorySettingsScreen";
import { TeamsPage } from "../../hub/ui/TeamsPage";
import { PluginsPage } from "../../plugins/ui/DiscoverPage";
import { CrewDefaults } from "../../crew/ui/CrewDefaults";
import { CrewRulesPage } from "../../crew/ui/CrewRulesPage";
import { hubProjectIdFor } from "../../hub/model/hubData";
import { GateSetting } from "../../delivery-gate/ui/GateSetting";
// WP-162: update a conflicting package from main. Off until the person turns it on.
import { ProgrammeUpdateSetting } from "../../programme/ui/ProgrammeUpdateSetting";
// WP-85: show Claude sessions started in a terminal.
import { TerminalSessionsSetting } from "../../terminalMirror/ui/TerminalSessionsSetting";
// WP-134b: More agents, off until the person switches it on.
import { MoreAgentsSettings } from "../../registry/ui/MoreAgentsSettings";
// WP-84: the project's default phase path.
import { PhaseSettings } from "../../phases/ui/PhaseSettings";
// WP-104: copy diagnostics, and the health list.
import { DiagnosticsPanel } from "../../diagnostics/ui/DiagnosticsPanel";
import { CommitGuardAllowsPanel } from "../../commit-guard/ui/CommitGuardAllowsPanel";
// WP-88: the morning note under the chat on Home.
import { DailySummarySetting } from "../../chief/ui/DailySummarySetting";
// WP-156: standing answers stay off until this setting is on.
import { StandingAnswersSetting } from "./StandingAnswersSetting";
// WP-164: quiet hours for routine programme notices.
import { QuietHoursSetting } from "../../notifications/ui/QuietHoursSetting";
import { QUIET_HOURS_DESCRIPTION } from "../../notifications/model/quietHours";
import { GithubIssuesSetting } from "../../github-issues/ui/GithubIssuesSetting";
import { appIdentity, buildLine } from "../../../app/model/appIdentity";

import {
  loadStripBackdrop,
  setStripBackdrop,
} from "../../hub/model/stripBackdrop";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConnectionsSettings } from "../../connections/ui/ConnectionsSettings";
// WP-61: Hivra Cloud, off until the person turns it on.
import { CloudSettings } from "../../hivraCloud/ui/CloudSettings";
import { MobileSettings } from "../../mobile/ui/MobileSettings";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownCircle,
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Globe,
  ImagePlus,
  Loader,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "../../../shared/ui/icons";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import {
  ColorPickerPopover,
  ColorSwatchRow,
} from "../../../shared/ui/ColorPickerPopover";
import { Popover } from "../../../shared/ui/Popover";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import {
  agentInstallPage,
  agentSignIn,
  canInstallAgent,
  cancelAgentInstall,
  installAgent,
  useAgentInstall,
  type AgentInstallState,
} from "../../providers/model/agentInstall";
import { JiraSettings } from "./JiraSettings";
import { AgentSandboxSetting } from "./AgentSandboxSetting";
import { ComputerUseSetting } from "../../computerUse/ui/ComputerUseSetting";
import {
  CONTEXT_CEILING_CHOICES,
  DEFAULT_CONTEXT_CEILING,
  MODEL_CONTEXT_CEILINGS,
  loadContextCeilingChoice,
  loadIdleCompact,
  saveContextCeilingChoice,
  saveIdleCompact,
  type ContextCeilingChoice,
} from "../../sessions/model/contextCeiling";
import { formatTokens } from "../../sessions/model/contextUsage";
import { GradientBlurBackground } from "./GradientBlurBackground";
import { McpSettings } from "./McpSettings";
import { InboxProviderMark } from "../../inbox/ui/InboxProviderMark";
import { RemoveProjectDialog } from "../../projects/ui/RemoveProjectDialog";
import { WindowControls } from "../../../app/shell/WindowControls";
import { CreditsList } from "./CreditsList";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { useColorScheme } from "../../../shared/hooks/useColorScheme";
import {
  WORKSPACE_THEMES,
  WORKSPACE_THEME_DEFAULT,
  isWorkspaceThemeId,
  type WorkspacePalette,
  type WorkspaceThemeId,
} from "../model/workspaceThemes";
import {
  applyChatBackground,
  applyChatBackgroundEmptyOpacity,
  applyChatBackgroundSessionOpacity,
  applyChatBackgroundScope,
  applyDiffPalette,
  applyAccentColor,
  applyBodyGlass,
  applySidebarBlur,
  applySidebarOpacity,
  applyThemeDarkLightness,
  applyThemePreference,
  applyThemeTint,
  applyWorkspaceTheme,
  BODY_GLASS_DEFAULT,
  INSET_LAYOUT_DEFAULT,
  INSET_GLASS_DEFAULT,
  ACCENT_COLOR_DEFAULT,
  CHAT_BACKGROUND_EMPTY_OPACITY_DEFAULT,
  CHAT_BACKGROUND_OPACITY_MAX,
  CHAT_BACKGROUND_OPACITY_MIN,
  CHAT_BACKGROUND_SESSION_OPACITY_DEFAULT,
  CHAT_BACKGROUND_SCOPE_DEFAULT,
  THEME_PREFERENCE_DEFAULT,
  chatBackgroundSrc,
  loadBodyGlass,
  loadInsetLayout,
  loadInsetGlass,
  loadAccentColor,
  loadChatBackgroundEmptyOpacity,
  loadChatBackgroundPath,
  loadChatBackgroundSessionOpacity,
  loadChatBackgroundScope,
  loadDiffPalette,
  loadNewThreadBackgroundEffect,
  loadThemeDarkLightness,
  loadThemePreference,
  loadSidebarBlur,
  loadSidebarOpacity,
  loadThemeHue,
  loadThemeSaturation,
  loadWorkspaceTheme,
  loadTranscriptLayout,
  loadTranscriptAnchor,
  saveBodyGlass,
  saveInsetLayout,
  saveInsetGlass,
  subscribeInsetLayout,
  saveAccentColor,
  saveChatBackgroundEmptyOpacity,
  saveChatBackgroundPath,
  saveChatBackgroundSessionOpacity,
  saveChatBackgroundScope,
  saveDiffPalette,
  setNewThreadBackgroundEffect,
  saveThemeDarkLightness,
  saveThemePreference,
  saveSidebarBlur,
  saveSidebarOpacity,
  saveThemeHue,
  saveThemeSaturation,
  saveWorkspaceTheme,
  isLightScheme,
  saveTranscriptLayout,
  saveTranscriptAnchor,
  syncNativeGlass,
  TRANSCRIPT_ANCHOR_CHANGE_EVENT,
  loadShowExcludedFiles,
  saveShowExcludedFiles,
  SHOW_EXCLUDED_FILES_DEFAULT,
  SIDEBAR_BLUR_DEFAULT,
  SIDEBAR_BLUR_MAX,
  SIDEBAR_BLUR_MIN,
  SIDEBAR_OPACITY_DEFAULT,
  SIDEBAR_OPACITY_MAX,
  SIDEBAR_OPACITY_MIN,
  THEME_DARK_LIGHTNESS_DEFAULT,
  THEME_DARK_LIGHTNESS_MAX,
  THEME_DARK_LIGHTNESS_MIN,
  THEME_HUE_DEFAULT,
  THEME_HUE_MAX,
  THEME_HUE_MIN,
  THEME_SATURATION_DEFAULT,
  THEME_SATURATION_MAX,
  THEME_SATURATION_MIN,
  type ThemePreference,
  type ChatBackgroundScope,
  DIFF_PALETTE_DEFAULT,
  type DiffPalette,
  NEW_THREAD_BACKGROUND_EFFECTS,
  NEW_THREAD_BACKGROUND_EFFECT_LABELS,
  NEW_THREAD_BACKGROUND_EFFECT_DESCRIPTIONS,
  NEW_THREAD_BACKGROUND_EFFECT_DEFAULT,
  type NewThreadBackgroundEffect,
  type TranscriptLayout,
} from "../model/appearance";
import {
  pickAndSaveChatBackground,
  removeChatBackground,
} from "../../projects/model/chatBackground";
import {
  applyUiScale,
  loadUiScale,
  saveUiScale,
  subscribeUiScale,
  UI_SCALE_DEFAULT,
  UI_SCALE_PERCENTS,
} from "../model/uiScale";
import {
  getHarnessAvailabilitySnapshot,
  harnessUnavailableHint,
  isHarnessAvailable,
  probeHarnessAvailability,
  subscribeHarnessAvailability,
} from "../../../integrations/harness/core/availability";
import {
  inspectHarnessBinary,
  type HarnessBinaryInspection,
} from "../../../integrations/harness/core/child";
import {
  loadProviderBinaryPath,
  providerBinaryPathChangePending,
  saveProviderBinaryPath,
  type ConfigurableBinaryProvider,
} from "../../providers/model/providerBinaryPaths";
import {
  compareSemver,
  MINIMUM_OPENCODE_VERSION,
  parseOpenCodeVersion,
} from "../../../integrations/harness/providers/opencode/opencodeProtocol";
import {
  enforceHarnessIdleLimit,
  refreshHarnessCatalogs,
} from "../../../integrations/harness/core/registry";
import { loginHarness } from "../../../integrations/harness/core/auth";
import {
  defaultModelId,
  firstEnabledHarness,
  getModelSnapshot,
  hasLiveCatalog,
  loadDefaultModels,
  loadHiddenPickerProviders,
  loadLastModelChoice,
  modelsFor,
  resolveModel,
  saveDefaultModel,
  saveLastModelChoice,
  savePickerProviderVisible,
  subscribeModels,
} from "../../sessions/model/models";
import {
  pathKey,
  prettyCwd,
  projectKey,
  projectName,
} from "../../../shared/lib/paths";
import { revealPath } from "../../../platform/tauri/fs";
import { IS_LINUX, IS_MAC, IS_WIN } from "../../../platform/tauri/platform";
import {
  loadArchivedProjects,
  looksLikeProject,
  subscribeArchivedProjects,
  type ArchivedProject,
  type RecentProject,
} from "../../projects/model/recents";
import {
  HARNESSES,
  HARNESS_TITLE,
  sessionDisplayTitle,
  type HarnessId,
} from "../../sessions/model/session";
import {
  loadProjectProviderSettings,
  projectProvidersRevision,
  setProjectDefaultModel,
  setProjectDefaultProvider,
  setProjectProviderHidden,
  subscribeProjectProviders,
} from "../../sessions/model/projectProviders";
import {
  newProviderAccount,
  providerAccounts,
  PROVIDER_ACCOUNT_PROVIDERS,
  removeProviderAccount,
  renameProviderAccount,
  saveProviderAccount,
  subscribeProviderAccounts,
  supportsAccountProfiles,
  type ProviderAccount,
  type ProviderAccountProvider,
} from "../../providers/model/providerAccounts";
import { removeProviderAccountCredentials } from "../../providers/model/providerAccountCredentials";
import {
  identityKey,
  identityOrganizationTag,
  useProviderAccountIdentities,
} from "../../providers/model/providerAccountIdentity";
import { ProviderAccountSubtitle } from "../../providers/ui/ProviderAccountSubtitle";
import { AccountOrderControls, AccountWaterfallSwitch } from "../../providers/ui/AccountWaterfall";
import { orderedAccounts } from "../../providers/model/accountWaterfall";
import { signInOptions } from "../../providers/model/providerSignIn";
import {
  saveChatListInbox,
  saveComposerAutocorrect,
  savePacedReveal,
  useChatListInbox,
  usePacedReveal,
  saveMaskEmails,
  saveNewLayoutPromptDismissed,
  saveRailMonosPinned,
  saveShowRemainingUsage,
  useComposerAutocorrect,
  useMaskEmails,
  useRailMonosPinned,
  useShowRemainingUsage,
} from "../model/displayPrefs";
import {
  DICTATION_SETTING_DESCRIPTION,
  DICTATION_SETTING_LABEL,
  dictationSettingIsShown,
  loadDictationSetting,
  saveDictationSetting,
} from "../model/dictationSetting";
import {
  accountStatus,
  accountUsageKey,
  useProviderAccountUsage,
} from "../../providers/model/accountUsage";
import { clearCachedRateLimits } from "../../providers/model/rateLimitsCache";
import {
  AccountStatusLabel,
  AccountUsageMeters,
  AccountUsageRefresh,
} from "../../providers/ui/ProviderAccountUsage";
import {
  loadSessionSidebarFilters,
  saveSessionSidebarFilters,
} from "../../sessions/model/sessionFilters";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import {
  clearInboxCache,
  githubStatus,
  type GithubStatus,
} from "../../inbox/model/githubTasks";
import {
  disconnectGitlab,
  gitlabConnected,
  saveGitlabConfig,
} from "../../inbox/model/gitlab";
import {
  azureDevOpsConnected,
  disconnectAzureDevOps,
  saveAzureDevOpsConfig,
} from "../../inbox/model/azureDevOps";
import {
  disconnectLinear,
  LINEAR_CHANGE_EVENT,
  linearConnected,
  listLinearTeams,
  loadHiddenLinearTeamIds,
  notifyLinearChange,
  saveHiddenLinearTeamIds,
  saveLinearToken,
  type LinearTeam,
} from "../../inbox/model/linear";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../../workspace/model/tabGroups";
import { useTabGroupLogos } from "../../projects/hooks/useTabGroupLogos";
import { ProjectLogoIcon } from "../../projects/ui/ProjectLogoIcon";
import { ProjectMascot } from "../../projects/ui/ProjectMascot";
import { PixelMascot } from "../../projects/ui/PixelMascot";
import {
  defaultMonoName,
  listMonos,
  monoLook,
  monoProjectsPhrase,
  monosSnapshot,
  saveMonoName,
  subscribeMonos,
  updateMono,
  type Mono,
} from "../../monos/model/mono";
import { resetMonoDefaults } from "../../monos/model/monoFiles";
import { pickChief } from "../../home/model/chief";
import { openMonoSettings } from "../../hub/model/hubNav";
import { ConfirmReset } from "../../monos/ui/ConfirmReset";
import {
  filterKeybindings,
  currentKeybindings,
  loadClaudeHooks,
  loadIdleAgentLimit,
  loadCloseToTray,
  loadCollapsedProjectRailMode,
  loadComposerRunner,
  loadDiffViewer,
  loadFileTabMode,
  loadFollowUpBehavior,
  loadFormatOnSave,
  loadGridArcadeEnabled,
  loadLiveAgentsEnabled,
  loadModelControls,
  loadNotesEnabled,
  loadMonosEnabled,
  loadMonoMenuBarIcon,
  loadKeybindingOverrides,
  saveMonoMenuBarIcon,
  subscribeMonoMenuBarIcon,
  loadQuickComposerEnabled,
  loadQuickComposerShortcut,
  loadTabAnimationsEnabled,
  saveClaudeHooks,
  saveIdleAgentLimit,
  IDLE_AGENT_LIMITS,
  type IdleAgentLimit,
  saveCloseToTray,
  saveCollapsedProjectRailMode,
  saveComposerRunner,
  saveDiffViewer,
  saveFileTabMode,
  saveFollowUpBehavior,
  saveFormatOnSave,
  saveGridArcadeEnabled,
  saveLiveAgentsEnabled,
  saveModelControls,
  saveNotesEnabled,
  saveMonosEnabled,
  subscribeMonosEnabled,
  saveKeybindingOverride,
  validateKeybindingShortcut,
  saveQuickComposerEnabled,
  saveQuickComposerShortcut,
  subscribeKeybindings,
  type KeybindingOverride,
  saveTabAnimationsEnabled,
  searchSettings,
  CLASSIC_LAYOUT_HIDDEN_SETTINGS,
  INSET_LAYOUT_HIDDEN_SETTINGS,
  settingsSectionDescription,
  settingsSectionLabel,
  COLLAPSED_PROJECT_RAIL_MODE_DEFAULT,
  type CollapsedProjectRailMode,
  type DiffViewer,
  type FileTabMode,
  type FollowUpBehavior,
  type ModelControls,
  type SettingsSearchResult,
  type SettingsSectionId,
} from "../model/settings";
import { loadSoundsEnabled, playCue, saveSoundsEnabled } from "../model/sounds";
import { PlainEnglishSetting } from "../../firstmate/ui/PlainEnglishSetting";
import { setQuickComposerShortcut } from "../../quick-composer/model/quickComposer";
import {
  isGlobalShortcut,
  QUICK_COMPOSER_DEFAULT_SHORTCUT,
  quickComposerShortcutLabel,
  quickComposerShortcutPreview,
  shortcutFromKeyEvent,
} from "../../quick-composer/model/quickComposerShortcut";
import {
  cachedNotificationPermission,
  loadNotificationsEnabled,
  openNotificationSettings,
  probeNotificationPermission,
  requestNotificationPermission,
  saveNotificationsEnabled,
  type NotificationPermission,
} from "../../notifications/model/notifications";
import {
  installPendingUpdate,
  packageManagedInstall,
  packageManagerHint,
  readAppVersion,
  runUpdateFlow,
  type UpdaterSnapshot,
} from "../../../app/model/updater";

import { SkillsPage } from "../../skills/ui/SkillsPage";
import { ProjectNotificationSettings } from "../../notifications/ui/ProjectNotificationSettings";
import { WorktreesPage } from "../../source-control/ui/WorktreesPage";
// WP-129: who writes titles, commits, pull request text and branch names.
import { TeamWorkspaceSetting } from "./TeamWorkspaceSetting";
import { TextGenerationSetting } from "./TextGenerationSetting";
import { ModelConnectionsSetting } from "./ModelConnectionsSetting";
import {
  removeWorktree,
  type RemoveWorktree,
} from "../../source-control/model/worktrees";
import type { Session } from "../../sessions/model/session";

/**
 * The `data-setting-id` Settings should reveal when it opens: one of the ids in
 * `SETTINGS_INDEX`. Inbox integrations pass their provider id.
 */
export type SettingsAnchor = string;

const settingDomId = (id: string) => `setting-${id}`;

/** The row or group Settings just jumped to, so it can flash where you landed. */
const RevealedSetting = createContext<string | null>(null);

type Props = {
  section: SettingsSectionId;
  /** Card to scroll to; the General page is too long to land at the top. */
  anchor?: SettingsAnchor | null;
  /** Project to focus when opening notification settings from a quick action. */
  notificationProjectPath?: string | null;
  /** Changes for each quick action, including repeated requests for one project. */
  notificationSettingsRequest?: number;
  recents?: RecentProject[];
  cwd: string;
  sessions: SessionSummary[];
  liveSessions?: Session[];
  onRemoveWorktree?: RemoveWorktree;
  onCheckWorktreeRemoval?: RemoveWorktree;
  onDeleteWorktreeSessions?: (
    sessionIds: readonly string[],
  ) => Promise<boolean>;
  besideRail?: boolean;
  /**
   * The inset layout's title bar slot. When given, the breadcrumb and actions
   * render there in place of the tabs and the page drops its own header row;
   * `null` means the slot hasn't mounted yet, so neither shows for a frame.
   */
  headerHost?: HTMLElement | null;
  onClose: () => void;
  /** Lets search jump to a setting that lives on another page. */
  onSelectSection?: (section: SettingsSectionId) => void;
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => void;
  onOpenWhatsNew: (version: string) => void;
  collapsedProjectRailMode?: CollapsedProjectRailMode;
  onCollapsedProjectRailModeChange?: (mode: CollapsedProjectRailMode) => void;
};

/** Dropwave: the switch that brings Explorer and Changes back to a project's sidebar. */
function CodeToolsSetting() {
  const on = useShowCodeTools();
  return (
    <div data-setting-id="show-code-tools" className="mb-6 flex items-center gap-4 rounded-lg border border-stroke px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-content">Show code tools</p>
        <p className="text-[12px] text-content/60">Explorer, Changes and the worktree picker in each project's sidebar. Off keeps projects simple.</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Show code tools"
        onClick={() => setShowCodeTools(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-content/20"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${on ? "left-4.5" : "left-0.5"}`} />
      </button>
    </div>
  );
}

export function SettingsView({
  section,
  anchor = null,
  notificationProjectPath = null,
  notificationSettingsRequest = 0,
  recents,
  cwd,
  sessions,
  liveSessions,
  onRemoveWorktree = removeWorktree,
  onCheckWorktreeRemoval,
  onDeleteWorktreeSessions,
  besideRail = false,
  headerHost,
  onClose,
  onSelectSection,
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
  onOpenWhatsNew,
  collapsedProjectRailMode,
  onCollapsedProjectRailModeChange,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [revealed, setRevealed] = useState<string | null>(anchor);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const appearance = useAppearanceSettings(
    collapsedProjectRailMode,
    onCollapsedProjectRailModeChange,
  );

  useEffect(() => setRevealed(anchor), [anchor, notificationSettingsRequest]);

  // Section is a dependency so a search result on another page scrolls once
  // that page has mounted the row.
  useEffect(() => {
    if (!revealed) return;
    // A project quick action lets the project card focus itself after discovery.
    if (!(revealed === "project-notifications" && notificationProjectPath)) {
      document
        .getElementById(settingDomId(revealed))
        ?.scrollIntoView?.({ block: "center" });
    }
    const timer = window.setTimeout(() => setRevealed(null), 1800);
    return () => window.clearTimeout(timer);
  }, [revealed, section, notificationProjectPath, notificationSettingsRequest]);

  const onReveal = useCallback(
    (next: SettingsSectionId, settingId: string | null) => {
      if (next !== section) onSelectSection?.(next);
      setRevealed(settingId);
    },
    [onSelectSection, section],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    // Let dialogs and other Settings controls handle Escape first.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The breadcrumb and page actions, in the page's own header row or the
  // inset title bar. There the bar already sits 6px past the rail, and the
  // card ends 6px short of the window, so the padding keeps both ends 10px
  // inside the card's edges.
  const inTitleBar = headerHost !== undefined;
  const settingsHeader = (
    <>
      <div
        className={`flex min-w-0 flex-1 items-center gap-2 text-[13px] ${
          inTitleBar ? "pr-3 pl-1" : "px-3"
        }`}
      >
        {/* Hub: each page shows just its name, no "Settings /" breadcrumb. */}
        <span className="min-w-0 truncate text-content">
          {settingsSectionLabel(section)}
        </span>
      </div>
      <div
        className={`flex shrink-0 items-center gap-1.5 ${
          inTitleBar ? "pr-4" : "pr-2"
        }`}
        data-tauri-drag-region="false"
      >
        {section === "appearance" ? (
          <button
            type="button"
            onClick={appearance.restoreDefaults}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
            Restore defaults
          </button>
        ) : null}
        <SettingsSearch onReveal={onReveal} />
      </div>
    </>
  );

  return (
    <div
      role="region"
      aria-label="Settings"
      data-app-settings
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      {headerHost !== undefined ? (
        headerHost &&
        createPortal(
          <div className="flex h-full min-w-0 flex-1 items-center">
            {settingsHeader}
          </div>,
          headerHost,
        )
      ) : (
        <div
          className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
          data-tauri-drag-region="deep"
        >
          {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
          {settingsHeader}
          {IS_MAC ? null : <WindowControls />}
        </div>
      )}

      {section === "skills" ? (
        <SkillsPage
          key={cwd}
          cwd={cwd}
          header={
            <PageHeader
              title={settingsSectionLabel(section)}
              description={settingsSectionDescription(section)}
            />
          }
        />
      ) : (
        <RevealedSetting.Provider value={revealed}>
          <div
            ref={lockOverscroll}
            className="@container/settings min-h-0 flex-1 overflow-y-auto overscroll-none"
          >
            <div className="w-full px-5 py-6 pb-16 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
              <PageHeader
                title={settingsSectionLabel(section)}
                description={settingsSectionDescription(section)}
              />
              {section === "general" ? (
                <GeneralPage onOpenWhatsNew={onOpenWhatsNew} />
              ) : null}
              {/* WP-84: how much process a task gets, for this project. */}
              {section === "general" ? <PhaseSettings projectKey={cwd} /> : null}
              {/* WP-104: diagnostics a person can send, and the health list. */}
              {section === "general" ? <DiagnosticsPanel /> : null}
              {/* WP-200: the lines the secret check lets through because a person allowed them. */}
              {section === "general" ? <CommitGuardAllowsPanel /> : null}
              {section === "connections" ? (
                <div className="flex flex-col gap-10">
                  {/* WP-61: Hivra Cloud, off until the person turns it on. */}
                  <CloudSettings />
                  <ConnectionsSettings />
                  {/* WP-80: share projects with a team's server. Off until the person turns it on. */}
                  <TeamWorkspaceSetting />
                  <MobileSettings />
                </div>
              ) : null}
              {section === "appearance" ? (
                <AppearancePage appearance={appearance} />
              ) : null}
              {section === "changes" ? <ChangesPage /> : null}
              {section === "decisions" ? <DecisionsPage /> : null}
              {section === "activity" ? (
                // WP-78: Settings → Activity.
                <ActivityPage onOpenSession={onOpenSession} />
              ) : null}
              {section === "work-log" ? (
                // WP-157: Settings → Work log.
                <WorkLogPanel />
              ) : null}
              {section === "usage" ? (
                // WP-108: token and cost history. Read only.
                <UsagePage />
              ) : null}
              {section === "connected" ? (
                // WP-79: Settings → Connected apps.
                <ConnectedApps />
              ) : null}
              {section === "dashboards" ? <DashboardsPage /> : null}
              {section === "portable" ? <PortablePage /> : null}
              {/* WP-75: checked backups, one item or everything. */}
              {section === "backups" ? <BackupsPage /> : null}
              {section === "history" ? (
                // WP-50: past chats, only with a person's OK, drafted for review. Above it, bringing them in as chats.
                <div className="flex flex-col gap-10">
                  <ChatImportSettings />
                  <HistoryImportScreen />
                </div>
              ) : null}
              {section === "memory" ? (
                // WP-51: what a first mate remembers, for the person to review.
                <MemorySettingsScreen />
              ) : null}
              {section === "connectors" ? <ConnectorsPage /> : null}
              {/* WP-92: Settings > Secrets. */}
              {section === "secrets" ? <SecretsPage project={cwd} /> : null}
              {section === "teams" ? <TeamsPage /> : null}
              {section === "plugins" ? (
                // WP-32: Discover. Listing reads indexes; it never runs plugin code.
                // WP-42: offer Verify when this project looks like a web or mobile app.
                <PluginsPage projectFolder={cwd} />
              ) : null}
              {section === "crew" ? (
                <>
                  {/* WP-141: crew defaults, above the advanced rules. */}
                  <CrewDefaults cwd={cwd} projectId={cwd ? hubProjectIdFor(cwd) : undefined} />
                  {/* WP-13: crew rules, the ordered list a person edits. */}
                  <CrewRulesPage cwd={cwd} hideWorkerDefault />
                  {/* WP-81: check work before it goes to GitHub. Off until the person turns it on. */}
                  <GateSetting project={cwd} />
                  {/* WP-162: update a conflicting package from main. Off until the person turns it on. */}
                  <ProgrammeUpdateSetting project={cwd} />
                  {/* WP-77: labelled GitHub issues become tasks. Off until the person turns it on. */}
                  <GithubIssuesSetting project={cwd} />
                </>
              ) : null}
              {section === "chat" ? <ChatPage /> : null}
              {section === "keybindings" ? <KeybindingsPage /> : null}
              {section === "monos" ? <MonosPage /> : null}
              {section === "mcp" ? (
                <McpSettings cwd={cwd} recents={recents} />
              ) : null}
              {section === "providers" ? (
                <>
                  {/* Which coding tool runs on which sign-in or saved model, extra connections marked. */}
                  <ModelConnectionsSetting />
                  {/* WP-129: who writes titles, commits, pull request text and branch names. */}
                  <TextGenerationSetting />
                  <ProvidersPage cwd={cwd} recents={recents} />
                </>
              ) : null}
              {section === "worktrees" ? <CodeToolsSetting /> : null}
              {section === "worktrees" ? (
                <WorktreesPage
                  cwd={cwd}
                  recents={recents}
                  liveSessions={liveSessions}
                  onRemove={onRemoveWorktree}
                  onCheckRemove={onCheckWorktreeRemoval}
                  onDeleteSessions={onDeleteWorktreeSessions}
                />
              ) : null}
              {section === "inbox" ? (
                <InboxPage
                  cwd={cwd}
                  recents={recents}
                  notificationProjectPath={notificationProjectPath}
                  notificationSettingsRequest={notificationSettingsRequest}
                />
              ) : null}
              {section === "archive" ? (
                <ArchivePage
                  cwd={cwd}
                  sessions={sessions}
                  onOpenSession={onOpenSession}
                  onArchiveSession={onArchiveSession}
                  onDeleteSession={onDeleteSession}
                  onRestoreProject={onRestoreProject}
                  onDeleteProject={onDeleteProject}
                />
              ) : null}
              {/* WP-76: deleted chats, Monos, projects, notes, docs and tasks. */}
              {section === "trash" ? (
                <TrashPage onRestoreProject={onRestoreProject} />
              ) : null}
            </div>
          </div>
        </RevealedSetting.Provider>
      )}
      <BuildStampFooter />
    </div>
  );
}

/**
 * Which build this is, on every Settings page: product, version, branch @ commit, when it was built, and whether it
 * is the daily app or a dev copy (src-tauri/src/instance.rs). Nothing outside the app.
 */
export function BuildStampFooter({ identity = appIdentity() }) {
  if (!identity) return null;
  return (
    <div
      data-build-stamp
      className="shrink-0 select-text truncate border-t border-stroke px-5 py-1.5 font-mono text-[11px] text-content/40"
      title={`${identity.identifier} · ${identity.stamp.sha}`}
    >
      {buildLine(identity)}
    </div>
  );
}

/** Jumps to any setting by name, including ones on another page. */
function SettingsSearch({
  onReveal,
}: {
  onReveal: (section: SettingsSectionId, settingId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const insetLayout = useSyncExternalStore(
    subscribeInsetLayout,
    loadInsetLayout,
    () => INSET_LAYOUT_DEFAULT,
  );
  const results = useMemo(
    () =>
      searchSettings(
        query,
        undefined,
        insetLayout
          ? INSET_LAYOUT_HIDDEN_SETTINGS
          : CLASSIC_LAYOUT_HIDDEN_SETTINGS,
      ),
    [query, insetLayout],
  );
  const open = query.trim().length > 0;

  useEffect(() => setActive(0), [query]);

  const go = (result: SettingsSearchResult | undefined) => {
    if (!result) return;
    onReveal(result.section, result.settingId);
    setQuery("");
    input.current?.blur();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    }
  };

  return (
    <div ref={root} className="relative shrink-0">
      <label className="flex h-7 w-48 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          ref={input}
          role="combobox"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-expanded={open}
          aria-controls={listId}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear settings search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
            className="grid size-4 shrink-0 place-items-center rounded text-content/45 hover:text-content"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </label>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={300}
          maxHeight={320}
          onDismiss={(reason) => {
            setQuery("");
            if (reason === "escape") input.current?.focus();
          }}
          id={listId}
          role="listbox"
          aria-label="Settings search results"
          className="overflow-y-auto overscroll-contain p-1"
        >
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-content/45">
              No matching settings
            </p>
          ) : (
            results.map((result, index) => (
              <button
                key={`${result.section}:${result.settingId ?? "*"}`}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(result)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${
                  index === active
                    ? "bg-selection text-content"
                    : "text-content hover:bg-content/5"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{result.label}</span>
                <span className="shrink-0 text-[11px] text-content/40">
                  {result.settingId ? result.sectionLabel : "Page"}
                </span>
              </button>
            ))
          )}
        </Popover>
      ) : null}
    </div>
  );
}

function ChiefModelSetting() {
  useSyncExternalStore(subscribeMonos, monosSnapshot, monosSnapshot);
  const chief = pickChief(listMonos());
  if (!chief) return <span className="text-[12px] text-content/45">No Chief of Staff yet</span>;
  const engine = chief.engine && Object.prototype.hasOwnProperty.call(HARNESS_TITLE, chief.engine) ? (chief.engine as HarnessId) : undefined;
  const shown = engine ? resolveModel(engine, chief.engineModel).name : "Default";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-content/60" data-chief-model>{shown}</span>
      <SecondaryButton onClick={() => void openMonoSettings(chief.id)}>Change</SecondaryButton>
    </div>
  );
}

function GeneralPage({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string) => void;
}) {
  const [soundsEnabled, setSoundsEnabled] = useState(loadSoundsEnabled);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    loadNotificationsEnabled,
  );
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(cachedNotificationPermission);
  const [notesEnabled, setNotesEnabled] = useState(loadNotesEnabled);
  const [liveAgentsEnabled, setLiveAgentsEnabled] = useState(
    loadLiveAgentsEnabled,
  );
  const [fileTabMode, setFileTabMode] = useState<FileTabMode>(loadFileTabMode);
  const [tabAnimationsEnabled, setTabAnimationsEnabled] = useState(
    loadTabAnimationsEnabled,
  );
  const [closeToTray, setCloseToTray] = useState(loadCloseToTray);
  const [quickComposerEnabled, setQuickComposerEnabled] = useState(
    loadQuickComposerEnabled,
  );
  const [quickComposerError, setQuickComposerError] = useState<string | null>(
    null,
  );

  // The user may flip the switch in System Settings and come back: re-read
  // the OS state whenever the window regains focus while the toggle is on.
  useEffect(() => {
    if (!notificationsEnabled) return;
    const refresh = () => {
      void probeNotificationPermission().then(setNotificationPermission);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [notificationsEnabled]);

  const onSoundsEnabled = (next: boolean) => {
    saveSoundsEnabled(next);
    setSoundsEnabled(next);
  };

  const onNotificationsEnabled = (next: boolean) => {
    saveNotificationsEnabled(next);
    setNotificationsEnabled(next);
    if (!next) return;
    void requestNotificationPermission().then(setNotificationPermission);
  };

  const onNotesEnabled = (next: boolean) => {
    saveNotesEnabled(next);
    setNotesEnabled(next);
  };

  const onQuickComposerEnabled = (next: boolean) => {
    saveQuickComposerEnabled(next);
    setQuickComposerEnabled(next);
    setQuickComposerError(null);
    void setQuickComposerShortcut(next).catch((error: unknown) => {
      // Another app already owns the combination. Leave the switch where the
      // user put it so the next launch tries again, but say why it is dead.
      setQuickComposerError(String(error));
    });
  };

  const onLiveAgentsEnabled = (next: boolean) => {
    saveLiveAgentsEnabled(next);
    setLiveAgentsEnabled(next);
  };

  const onFileTabMode = (next: FileTabMode) => {
    saveFileTabMode(next);
    setFileTabMode(next);
  };

  const onTabAnimationsEnabled = (next: boolean) => {
    saveTabAnimationsEnabled(next);
    setTabAnimationsEnabled(next);
  };

  const onCloseToTray = (next: boolean) => {
    saveCloseToTray(next);
    setCloseToTray(next);
  };

  return (
    <>
      <Group title="You" description="How your team of Monos addresses you.">
        <Row
          id="user-name"
          label="What should your team call you?"
          description="Leave it empty and they say “the user”."
        >
          <UserNameField />
        </Row>
      </Group>
      {/* WP-88: the morning note under the chat on Home. */}
      <Group title="Home" description="The morning note under the chat.">
        {/* Ash (12 Nov): "I don't see any way to change the default model". */}
        <Row
          id="chief-model"
          label="Chief of Staff's model"
          description="What its new chats run on. Right-click Chief of Staff in the sidebar for the same."
        >
          <ChiefModelSetting />
        </Row>
        <Row
          id="morning-summary"
          label="Morning summary"
          description="A few lines in the morning, when there is something to say."
        >
          <DailySummarySetting />
        </Row>
      </Group>
      {/* WP-156: standing answers stay off until this is on. */}
      <StandingAnswersSetting />
      <Group
        title="Alerts"
        description="How MonoCode reaches you while you are looking somewhere else."
      >
        <Row
          id="sounds"
          label="Sounds"
          description="Short cues for project activity, finished turns, and available updates. Choose project notification categories in Inbox settings. Switches and Copy on a finished turn also play."
        >
          <Toggle
            label="Sounds"
            on={soundsEnabled}
            onChange={onSoundsEnabled}
          />
        </Row>
        <Row
          id="notifications"
          label="Notifications"
          description="Notify when a reminder is due, or when an agent finishes or needs input in another session or while MonoCode is in the background. Click the notification to open that session."
        >
          {notificationsEnabled && notificationPermission === "denied" ? (
            <NotificationsBlocked />
          ) : null}
          {notificationsEnabled && notificationPermission === "unsupported" ? (
            <span className="text-[12px] text-content/45">
              Not available on this platform
            </span>
          ) : null}
          <Toggle
            label="Notifications"
            on={notificationsEnabled}
            onChange={onNotificationsEnabled}
          />
        </Row>
        {/* WP-164: what waits and what comes through is spelled out in QUIET_HOURS_DESCRIPTION. */}
        <Row id="quiet-hours" label="Quiet hours" description={QUIET_HOURS_DESCRIPTION}>
          <QuietHoursSetting />
        </Row>
      </Group>

      {/* WP-85: off until the person turns it on. */}
      <Group title="Terminal" description="Claude sessions you start in a terminal, on this Mac.">
        <TerminalSessionsSetting />
      </Group>

      <Group
        title="Workspace"
        description="How project navigation and workspace tabs behave."
      >
        <Row
          id="file-tabs"
          label="File tabs"
          description="Open files beside the active chat, or give each file a normal tab in the top bar. Top-bar files can still be combined into split panes."
        >
          <Segmented
            label="File tabs"
            value={fileTabMode}
            options={[
              { value: "pane", label: "Beside chat" },
              { value: "workspace", label: "Top bar" },
            ]}
            onChange={onFileTabMode}
          />
        </Row>
        <Row
          id="tab-animations"
          label="Tab animations"
          description="Animate tabs as they open and close. Turn this off for instant tab changes."
        >
          <Toggle
            label="Tab animations"
            on={tabAnimationsEnabled}
            onChange={onTabAnimationsEnabled}
          />
        </Row>
        <Row
          id="notes"
          label="Notes"
          description="A global markdown notebook on the project rail. Save a finished turn from the transcript, then mention it later with @note or add it to chat."
        >
          <Toggle label="Notes" on={notesEnabled} onChange={onNotesEnabled} />
        </Row>
        {IS_MAC && (
          <Row
            id="quick-composer"
            label="Quick composer"
            description={`Press ${quickComposerShortcutLabel(loadQuickComposerShortcut())} in any app to float a prompt over it and start a session without switching to MonoCode. Change the shortcut in Keybindings. Return starts it in the background; ⌘Return starts it and brings the session forward.`}
          >
            {quickComposerError ? (
              <span className="text-[12px] text-content/45">
                {quickComposerError}
              </span>
            ) : null}
            <Toggle
              label="Quick composer"
              on={quickComposerEnabled}
              onChange={onQuickComposerEnabled}
            />
          </Row>
        )}
        {IS_MAC && <AgentSandboxSetting />}
        {IS_MAC && <ComputerUseSetting />}
        <Row
          id="working-agents"
          label="Working agents"
          description="When two or more chats are in flight, a card on the project rail lists them so you can jump across projects. Finished turns stay until you open that session."
        >
          <Toggle
            label="Working agents"
            on={liveAgentsEnabled}
            onChange={onLiveAgentsEnabled}
          />
        </Row>
        {IS_WIN && (
          <Row
            id="close-to-tray"
            label="Close to tray"
            description="Closing a window hides it to the system tray instead of quitting, so running agents keep going. Reopen from the tray icon, and quit for real from its menu. Turn this off to have close end the window."
          >
            <Toggle
              label="Close to tray"
              on={closeToTray}
              onChange={onCloseToTray}
            />
          </Row>
        )}
      </Group>

      <Group title="About">
        <UpdateRow onOpenWhatsNew={onOpenWhatsNew} />
        <CreditsRow />
      </Group>
    </>
  );
}

function ChatPage() {
  const pacedReveal = usePacedReveal();
  const [transcriptLayout, setTranscriptLayout] =
    useState<TranscriptLayout>(loadTranscriptLayout);
  const [transcriptAnchor, setTranscriptAnchor] =
    useState(loadTranscriptAnchor);
  const [followUpBehavior, setFollowUpBehavior] =
    useState<FollowUpBehavior>(loadFollowUpBehavior);
  const [modelControls, setModelControls] =
    useState<ModelControls>(loadModelControls);
  const [diffViewer, setDiffViewer] = useState<DiffViewer>(loadDiffViewer);
  const [formatOnSave, setFormatOnSave] = useState(loadFormatOnSave);
  const [composerRunner, setComposerRunner] = useState(loadComposerRunner);
  const composerAutocorrect = useComposerAutocorrect();
  // WP-131c: dictation is off until this is turned on. The app keeps the file.
  const [dictationOn, setDictationOn] = useState(false);
  useEffect(() => {
    let dead = false;
    void loadDictationSetting().then((on) => {
      if (!dead) setDictationOn(on);
    });
    return () => {
      dead = true;
    };
  }, []);
  // WP-113: optional settle, snooze and re-sort. Off keeps today's list.
  const chatListInbox = useChatListInbox();
  const [gridArcadeEnabled, setGridArcadeEnabled] = useState(
    loadGridArcadeEnabled,
  );

  useEffect(() => {
    const onAnchor = (event: Event) => {
      setTranscriptAnchor((event as CustomEvent<boolean>).detail === true);
    };
    window.addEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    return () => {
      window.removeEventListener(TRANSCRIPT_ANCHOR_CHANGE_EVENT, onAnchor);
    };
  }, []);

  const onTranscriptLayout = (next: TranscriptLayout) => {
    saveTranscriptLayout(next);
    setTranscriptLayout(next);
  };

  const onTranscriptAnchor = (next: boolean) => {
    saveTranscriptAnchor(next);
    setTranscriptAnchor(next);
  };

  const onFollowUpBehavior = (next: FollowUpBehavior) => {
    saveFollowUpBehavior(next);
    setFollowUpBehavior(next);
  };

  const onModelControls = (next: ModelControls) => {
    saveModelControls(next);
    setModelControls(next);
  };

  const onDiffViewer = (next: DiffViewer) => {
    saveDiffViewer(next);
    setDiffViewer(next);
  };

  const onFormatOnSave = (next: boolean) => {
    saveFormatOnSave(next);
    setFormatOnSave(next);
  };

  const onComposerRunner = (next: boolean) => {
    saveComposerRunner(next);
    setComposerRunner(next);
  };

  const onGridArcadeEnabled = (next: boolean) => {
    saveGridArcadeEnabled(next);
    setGridArcadeEnabled(next);
  };

  return (
    <>
      {/* WP-41: plain-English endings, on unless this switch is off. */}
      <Group title="Replies" description="How a finished reply reads.">
        <Row
          id="plain-english-endings"
          label="Plain-English endings"
          description="Replies end with one short paragraph in plain words about what happened and what it means."
        >
          <PlainEnglishSetting />
        </Row>
      </Group>
      {/* WP-113: one switch for settle, snooze and re-sort. */}
      <Group title="Chat list" description="How the list of chats behaves.">
        <Row
          id="chat-list-inbox"
          label="Settle and snooze"
          description="Settle finished chats, snooze a chat until a time, and bring a chat that needs you back to the top. Off keeps today's list."
        >
          <Toggle
            label="Settle and snooze"
            on={chatListInbox}
            onChange={saveChatListInbox}
          />
        </Row>
      </Group>
      <Group
        title="Transcript"
        description="How a conversation reads as it grows."
      >
        <Row
          id="transcript-layout"
          label="Transcript layout"
          description="Full width keeps user prompts as a spanning card. Chat aligns them to the right with a max width, like a messaging app."
        >
          <Segmented
            label="Transcript layout"
            value={transcriptLayout}
            options={[
              { value: "full", label: "Full width" },
              { value: "chat", label: "Chat" },
            ]}
            onChange={onTranscriptLayout}
          />
        </Row>
        <Row
          id="anchor-prompts"
          label="Anchor prompts to top"
          description="When you send, the new prompt sits at the top of the transcript and the reply grows into the space below. Turn this off to keep the classic layout, with the latest message resting on the composer."
        >
          <Toggle
            label="Anchor prompts to top"
            on={transcriptAnchor}
            onChange={onTranscriptAnchor}
          />
        </Row>
        <Row
          id="paced-reveal"
          label="Smooth text reveal"
          description="Reveal incoming bursts gradually. Turn this off to show received text immediately. This changes presentation timing, not processing speed."
        >
          <Toggle
            label="Smooth text reveal"
            on={pacedReveal}
            onChange={savePacedReveal}
          />
        </Row>
      </Group>

      <Group
        title="Composer"
        description="What the composer does with what you type."
      >
        <Row
          id="follow-up"
          label="Follow-up behavior"
          description="Queue follow-ups until the active turn finishes, or steer the active turn immediately."
        >
          <Segmented
            label="Follow-up behavior"
            value={followUpBehavior}
            options={[
              { value: "queue", label: "Queue" },
              { value: "steer", label: "Steer" },
            ]}
            onChange={onFollowUpBehavior}
          />
        </Row>
        <Row
          id="model-controls"
          label="Model controls"
          description="Show model options beside the picker instead of inside the model menu."
        >
          <Segmented
            label="Model controls"
            value={modelControls}
            options={[
              { value: "menu", label: "Menu" },
              { value: "beside", label: "Beside" },
            ]}
            onChange={onModelControls}
          />
        </Row>
        <Row
          id="composer-autocorrect"
          label="Autocorrect"
          description="Spell check and autocorrect prompts in session and mono composers. Turn this off to keep the text exactly as typed."
        >
          <Toggle
            label="Autocorrect"
            on={composerAutocorrect}
            onChange={saveComposerAutocorrect}
          />
        </Row>
        {dictationSettingIsShown() ? (
          <Row
            id="composer-dictation"
            label={DICTATION_SETTING_LABEL}
            description={DICTATION_SETTING_DESCRIPTION}
          >
            <Toggle
              label={DICTATION_SETTING_LABEL}
              on={dictationOn}
              onChange={(on) => {
                setDictationOn(on);
                void saveDictationSetting(on).then(setDictationOn);
              }}
            />
          </Row>
        ) : null}
      </Group>

      <Group
        title="Editor"
        description="What happens when you save a file in the workspace editor."
      >
        <Row
          id="format-on-save"
          label="Format on save"
          description="Run Prettier on supported files before writing. Off keeps the text you typed, including quote style."
        >
          <Toggle
            label="Format on save"
            on={formatOnSave}
            onChange={onFormatOnSave}
          />
        </Row>
      </Group>

      <Group
        title="Code review"
        description="Where a turn's changes open when you go to read them."
      >
        <Row
          id="diff-view"
          label="Diff view"
          description="Editor keeps working-tree changes in the file. Unified stacks every changed file in one review, with sticky headers and collapsed unchanged lines."
        >
          <Segmented
            label="Diff view"
            value={diffViewer}
            options={[
              { value: "editor", label: "Editor" },
              { value: "unified", label: "Unified" },
            ]}
            onChange={onDiffViewer}
          />
        </Row>
      </Group>

      <Group
        title="Extras"
        description="Idle animation, and nothing else. Turn both off for a still workspace."
      >
        <Row
          id="composer-mascot"
          label="Composer mascot"
          description="When a turn is running, the project mascot runs along the composer, bonks the scroll-to-latest button the first time, then jumps it, and sometimes grabs a coin."
        >
          <Toggle
            label="Composer mascot"
            on={composerRunner}
            onChange={onComposerRunner}
          />
        </Row>
        <Row
          id="empty-session-games"
          label="Empty session games"
          description="Pac-man and snake idle on the empty-session grid. Hover the band to take control of whichever is on screen. Turn this off to keep the pane still."
        >
          <Toggle
            label="Empty session games"
            on={gridArcadeEnabled}
            onChange={onGridArcadeEnabled}
          />
        </Row>
      </Group>
    </>
  );
}

function InboxPage({
  cwd,
  recents,
  notificationProjectPath,
  notificationSettingsRequest,
}: {
  cwd: string;
  recents?: RecentProject[];
  notificationProjectPath?: string | null;
  notificationSettingsRequest?: number;
}) {
  const revealed = useContext(RevealedSetting);
  return (
    <>
      <div
        id={settingDomId("project-notifications")}
        data-setting-id="project-notifications"
      >
        <ProjectNotificationSettings
          cwd={cwd}
          recents={recents}
          notificationProjectPath={notificationProjectPath}
          notificationSettingsRequest={notificationSettingsRequest}
          highlighted={revealed === "project-notifications"}
        />
      </div>
      <Group
        id="github"
        title={
          <span className="flex items-center gap-2">
            <InboxProviderMark provider="github" className="size-4 shrink-0" />
            GitHub
          </span>
        }
        description="Pull requests, reviews, and issues, read through the GitHub CLI."
      >
        <GithubSettings />
      </Group>

      <Group
        id="gitlab"
        title={
          <span className="flex items-center gap-2">
            <InboxProviderMark provider="gitlab" className="size-4 shrink-0" />
            GitLab
          </span>
        }
        description="Merge requests from GitLab.com or a self-managed instance."
      >
        <GitlabSettings />
      </Group>

      <Group
        id="azuredevops"
        title={
          <span className="flex items-center gap-2">
            <InboxProviderMark
              provider="azuredevops"
              className="size-4 shrink-0"
            />
            ADO
          </span>
        }
        description="Pull requests and Boards work items from your ADO organization."
      >
        <AzureDevOpsSettings />
      </Group>

      <Group
        id="jira"
        title={
          <span className="flex items-center gap-2">
            <InboxProviderMark provider="jira" className="size-4 shrink-0" />
            Jira
          </span>
        }
        description="Jira Cloud issues from the projects you pick."
      >
        <JiraSettings />
      </Group>

      <Group
        id="linear"
        title={
          <span className="flex items-center gap-2">
            <InboxProviderMark provider="linear" className="size-4 shrink-0" />
            Linear
          </span>
        }
        description="Issues assigned to you, from the teams you pick."
      >
        <LinearSettings />
      </Group>
    </>
  );
}

function GithubSettings() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const checkStatus = useCallback(async () => {
    const generation = ++request.current;
    setChecking(true);
    setError(null);
    try {
      const next = await githubStatus();
      if (generation === request.current) setStatus(next);
    } catch (err: unknown) {
      if (generation === request.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === request.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    return () => {
      request.current += 1;
    };
  }, [checkStatus]);

  const description = status?.connected
    ? "GitHub CLI is installed and authenticated. MonoCode uses it for GitHub inbox items."
    : status?.installed
      ? "Run gh auth login in a terminal, complete the sign-in flow, then check again."
      : "Install GitHub CLI from cli.github.com, run gh auth login in a terminal, then check again.";
  const label = checking
    ? "Checking"
    : status?.connected
      ? "Connected"
      : status?.installed
        ? "Sign in required"
        : "Not installed";

  return (
    <>
      <Row label="Connection" description={description}>
        <span className="text-[12px] text-content/50">{label}</span>
        {!checking && !status?.installed ? (
          <SecondaryButton
            onClick={() => {
              void openUrl("https://cli.github.com/").catch(() => {});
            }}
          >
            Installation guide
          </SecondaryButton>
        ) : null}
        <SecondaryButton onClick={() => void checkStatus()} disabled={checking}>
          {checking ? "Checking" : "Check again"}
        </SecondaryButton>
      </Row>
      {error ? (
        <p className="border-b border-content/5 px-4 pb-3 text-[12px] text-red-400/90 last:border-b-0">
          {error}
        </p>
      ) : null}
    </>
  );
}

function GitlabSettings() {
  const [url, setUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void gitlabConnected()
      .then((status) => {
        if (cancelled) return;
        setConnected(status.connected);
        setUrl(status.url);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await saveGitlabConfig(url, token);
      setUrl(status.url);
      setToken("");
      setConnected(status.connected);
      clearInboxCache();
    } catch (err: unknown) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await disconnectGitlab(url);
      setConnected(false);
      setUrl(status.url);
      clearInboxCache();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row
        label="Connection"
        description="Connect GitLab.com or a self-managed GitLab instance. Use a personal access token with API access; the token is stored locally and Disconnect deletes it."
      >
        {connected ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <span className="max-w-56 truncate text-[12px] text-content/50">
              {url}
            </span>
            <SecondaryButton
              onClick={() => void onDisconnect()}
              disabled={busy}
            >
              Disconnect
            </SecondaryButton>
          </div>
        ) : (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://gitlab.com"
                aria-label="GitLab URL"
                autoComplete="url"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </label>
            <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSave();
                }}
                placeholder="glpat-…"
                aria-label="GitLab access token"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </label>
            <SecondaryButton
              onClick={() => void onSave()}
              disabled={busy || !token.trim()}
            >
              {busy ? "Saving" : "Connect"}
            </SecondaryButton>
          </div>
        )}
      </Row>
      {error ? (
        <p className="border-b border-content/5 px-4 pb-3 text-[12px] text-red-400/90 last:border-b-0">
          {error}
        </p>
      ) : null}
    </>
  );
}

function AzureDevOpsSettings() {
  const [url, setUrl] = useState("https://dev.azure.com/myorg");
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void azureDevOpsConnected()
      .then((status) => {
        if (cancelled) return;
        setConnected(status.connected);
        if (status.url) setUrl(status.url);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await saveAzureDevOpsConfig(url, token);
      setUrl(status.url);
      setToken("");
      setConnected(status.connected);
      clearInboxCache();
    } catch (err: unknown) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await disconnectAzureDevOps(url);
      setConnected(false);
      setUrl(status.url || url);
      clearInboxCache();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Row
        label="Connection"
        description="Connect your ADO organization with a personal access token (Boards + Repos read & write for comments). The token is stored locally and Disconnect deletes it."
      >
        {connected ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <span className="max-w-56 truncate text-[12px] text-content/50">
              {url}
            </span>
            <SecondaryButton
              onClick={() => void onDisconnect()}
              disabled={busy}
            >
              Disconnect
            </SecondaryButton>
          </div>
        ) : (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://dev.azure.com/myorg"
                aria-label="Azure DevOps organization URL"
                autoComplete="url"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </label>
            <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSave();
                }}
                placeholder="PAT…"
                aria-label="Azure DevOps personal access token"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </label>
            <SecondaryButton
              onClick={() => void onSave()}
              disabled={busy || !token.trim()}
            >
              {busy ? "Saving" : "Connect"}
            </SecondaryButton>
          </div>
        )}
      </Row>
      {error ? (
        <p className="border-b border-content/5 px-4 pb-3 text-[12px] text-red-400/90 last:border-b-0">
          {error}
        </p>
      ) : null}
    </>
  );
}

function LinearSettings() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [hiddenTeamIds, setHiddenTeamIds] = useState(loadHiddenLinearTeamIds);

  const loadTeams = useCallback(async () => {
    try {
      const next = await listLinearTeams();
      setTeams(next);
    } catch {
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void linearConnected()
      .then((status) => {
        if (cancelled) return;
        setConnected(status.connected);
        if (status.connected) void loadTeams();
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadTeams]);

  // The inbox filter menu writes the same list, so follow it while both are mounted.
  useEffect(() => {
    const onChange = () => setHiddenTeamIds(loadHiddenLinearTeamIds());
    window.addEventListener(LINEAR_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LINEAR_CHANGE_EVENT, onChange);
  }, []);

  const onSave = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveLinearToken(token);
      setToken("");
      setConnected(true);
      clearInboxCache();
      notifyLinearChange();
      await loadTeams();
    } catch (err: unknown) {
      setConnected(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectLinear();
      setConnected(false);
      setTeams([]);
      clearInboxCache();
      notifyLinearChange();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleTeam = (id: string) => {
    const next = new Set(hiddenTeamIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ids = [...next];
    setHiddenTeamIds(ids);
    saveHiddenLinearTeamIds(ids);
    clearInboxCache();
  };

  return (
    <>
      <Row
        label="API key"
        description="Create a personal API key in Linear → Settings → Security & Access. Disconnect deletes it."
      >
        {connected ? (
          <SecondaryButton onClick={() => void onDisconnect()} disabled={busy}>
            Disconnect
          </SecondaryButton>
        ) : (
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <label className="flex h-7 w-52 max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20">
              <input
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSave();
                }}
                placeholder="lin_api_…"
                aria-label="Linear API key"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </label>
            <SecondaryButton
              onClick={() => void onSave()}
              disabled={busy || !token.trim()}
            >
              {busy ? "Saving" : "Connect"}
            </SecondaryButton>
          </div>
        )}
      </Row>
      {error ? (
        <p className="border-b border-content/5 px-4 pb-3 text-[12px] text-red-400/90 last:border-b-0">
          {error}
        </p>
      ) : null}
      {connected && teams.length > 0 ? (
        <div className="border-b border-content/5 px-4 py-3.5 last:border-b-0">
          <div className="text-[13px] font-medium text-content">Teams</div>
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            Unchecked teams stay out of the inbox.
          </p>
          <div className="-mx-2 mt-2 flex flex-col gap-0.5">
            {teams.map((team) => {
              const checked = !hiddenTeamIds.includes(team.id);
              return (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => toggleTeam(team.id)}
                  className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] text-content hover:bg-content/5"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {team.name}
                    {team.key ? (
                      <span className="ml-1.5 text-content/40">{team.key}</span>
                    ) : null}
                  </span>
                  {checked ? (
                    <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** WP-08: the projects Hivra learns from and the third-party code it carries (docs/hivra/credits.json). */
function CreditsRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Row
        id="credits"
        label="Credits"
        description="The projects Hivra takes ideas or code from, and the licences of the code it carries."
      >
        <SecondaryButton onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide" : "Show"}
        </SecondaryButton>
      </Row>
      {open ? <CreditsList /> : null}
    </>
  );
}

function UpdateRow({
  onOpenWhatsNew,
}: {
  onOpenWhatsNew: (version: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<UpdaterSnapshot>({
    phase: "idle",
    currentVersion: "…",
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([readAppVersion(), packageManagedInstall()]).then(
      ([currentVersion, packageManaged]) => {
        if (cancelled) return;
        setSnapshot((current) => ({
          ...current,
          currentVersion,
          packageManaged: packageManaged ?? undefined,
        }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const busy =
    snapshot.phase === "checking" || snapshot.phase === "downloading";
  const hasUpdate = snapshot.phase === "available";

  const onClick = async () => {
    if (busy) return;
    if (hasUpdate) {
      await installPendingUpdate(setSnapshot);
      return;
    }
    await runUpdateFlow(true, setSnapshot);
  };

  const status =
    snapshot.phase === "available"
      ? `Version ${snapshot.availableVersion} is available.`
      : snapshot.phase === "downloading"
        ? `Downloading${snapshot.progress != null ? ` ${snapshot.progress}%` : "…"}`
        : snapshot.phase === "checking"
          ? "Checking for updates…"
          : snapshot.phase === "current"
            ? "You're on the latest version."
            : snapshot.phase === "error"
              ? (snapshot.error ?? "Update check failed.")
              : snapshot.packageManaged
                ? packageManagerHint(snapshot.packageManaged)
                : "MonoCode updates itself from the release feed.";

  return (
    <Row
      id="update"
      label={
        <span className="flex items-baseline gap-2">
          Version
          <span className="font-mono text-[12px] text-content/45">
            {snapshot.currentVersion}
          </span>
        </span>
      }
      description={status}
    >
      <div className="flex items-center gap-2">
        <SecondaryButton
          onClick={() => onOpenWhatsNew(snapshot.currentVersion)}
          disabled={snapshot.currentVersion === "…"}
        >
          What's new
        </SecondaryButton>
        <SecondaryButton onClick={() => void onClick()} disabled={busy}>
          {busy ? (
            <Loader className="size-3.5 animate-spin" aria-hidden />
          ) : hasUpdate ? (
            <ArrowDownCircle className="size-3.5 text-accent" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} aria-hidden />
          )}
          {hasUpdate ? "Download" : "Check for updates"}
        </SecondaryButton>
      </div>
    </Row>
  );
}

type AppearanceSettings = ReturnType<typeof useAppearanceSettings>;

function useAppearanceSettings(
  controlledCollapsedProjectRailMode?: CollapsedProjectRailMode,
  onControlledCollapsedProjectRailModeChange?: (
    mode: CollapsedProjectRailMode,
  ) => void,
) {
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(loadThemePreference);
  const [accentColor, setAccentColor] = useState(loadAccentColor);
  const [workspaceTheme, setWorkspaceTheme] =
    useState<WorkspaceThemeId>(loadWorkspaceTheme);
  const [opacity, setOpacity] = useState(loadSidebarOpacity);
  const [blur, setBlur] = useState(loadSidebarBlur);
  const [themeHue, setThemeHue] = useState(loadThemeHue);
  const [themeSaturation, setThemeSaturation] = useState(loadThemeSaturation);
  const [themeDarkLightness, setThemeDarkLightness] = useState(
    loadThemeDarkLightness,
  );
  const [bodyGlass, setBodyGlass] = useState(loadBodyGlass);
  const [insetGlass, setInsetGlass] = useState(loadInsetGlass);
  // PM-21: a theme applied, or put back by Undo, shows on the sliders; one being previewed shows there until it stops.
  const themeVersion = useThemeImportVersion();
  const themeFileVersion = useThemesVersion();
  useEffect(() => {
    setThemeHue(loadThemeHue());
    setThemeSaturation(loadThemeSaturation());
    setThemeDarkLightness(loadThemeDarkLightness());
    setOpacity(loadSidebarOpacity());
  }, [themeVersion, themeFileVersion]);
  // Either kind of preview shows on the sliders: a pasted theme or one a Mono is offering.
  const preview = previewLook() ?? offeredPreviewLook();
  const insetLayout = useSyncExternalStore(
    subscribeInsetLayout,
    loadInsetLayout,
    () => INSET_LAYOUT_DEFAULT,
  );
  const [showExcludedFiles, setShowExcludedFiles] = useState(
    loadShowExcludedFiles,
  );
  const [chatBackgroundPath, setChatBackgroundPath] = useState(
    loadChatBackgroundPath,
  );
  const [chatBackgroundEmptyOpacity, setChatBackgroundEmptyOpacity] = useState(
    loadChatBackgroundEmptyOpacity,
  );
  const [chatBackgroundSessionOpacity, setChatBackgroundSessionOpacity] =
    useState(loadChatBackgroundSessionOpacity);
  const [chatBackgroundScope, setChatBackgroundScope] =
    useState<ChatBackgroundScope>(loadChatBackgroundScope);
  const [diffPalette, setDiffPalette] = useState<DiffPalette>(loadDiffPalette);
  const [newThreadBackgroundEffect, setBackgroundEffect] =
    useState<NewThreadBackgroundEffect>(loadNewThreadBackgroundEffect);
  const [chatBackgroundBusy, setChatBackgroundBusy] = useState(false);
  const [chatBackgroundError, setChatBackgroundError] = useState<string | null>(
    null,
  );
  const [uiScale, setUiScale] = useState(loadUiScale);
  const [storedCollapsedProjectRailMode, setStoredCollapsedProjectRailMode] =
    useState<CollapsedProjectRailMode>(loadCollapsedProjectRailMode);
  const collapsedProjectRailMode =
    controlledCollapsedProjectRailMode ?? storedCollapsedProjectRailMode;

  useEffect(() => subscribeUiScale(() => setUiScale(loadUiScale())), []);

  const onThemePreference = useCallback((next: ThemePreference) => {
    applyThemePreference(next);
    saveThemePreference(next);
    setThemePreference(next);
  }, []);

  const onAccentColor = useCallback((value: string | null) => {
    const next = applyAccentColor(value);
    saveAccentColor(next);
    setAccentColor(next);
  }, []);

  const onWorkspaceTheme = useCallback((value: WorkspaceThemeId) => {
    const next = applyWorkspaceTheme(value);
    saveWorkspaceTheme(next);
    setWorkspaceTheme(next);
  }, []);

  const onOpacity = useCallback((percent: number) => {
    stopPreview();
    endPreview();
    const next = applySidebarOpacity(percent / 100);
    saveSidebarOpacity(next);
    setOpacity(next);
  }, []);

  const onBlur = useCallback((radius: number) => {
    const next = applySidebarBlur(radius);
    saveSidebarBlur(next);
    setBlur(next);
  }, []);

  // A real change (a scheme, a preset) ends a theme preview first, so it lands on the saved look.
  const onTint = useCallback((hue: number, saturation: number) => {
    stopPreview();
    endPreview();
    const next = applyThemeTint(hue, saturation);
    saveThemeHue(next.hue);
    saveThemeSaturation(next.saturation);
    setThemeHue(next.hue);
    setThemeSaturation(next.saturation);
  }, []);

  const onDarkLightness = useCallback((value: number) => {
    stopPreview();
    endPreview();
    const next = applyThemeDarkLightness(value);
    saveThemeDarkLightness(next);
    setThemeDarkLightness(next);
  }, []);

  const onBodyGlass = useCallback((next: boolean) => {
    applyBodyGlass(next);
    saveBodyGlass(next);
    setBodyGlass(next);
    if (IS_LINUX) syncNativeGlass(isLightScheme() ? "light" : "dark");
  }, []);

  const onInsetLayout = useCallback((next: boolean) => {
    saveNewLayoutPromptDismissed(true);
    saveInsetLayout(next);
  }, []);

  const onInsetGlass = useCallback((next: boolean) => {
    saveInsetGlass(next);
    setInsetGlass(next);
    syncNativeGlass(isLightScheme() ? "light" : "dark");
  }, []);

  const onShowExcludedFiles = useCallback((next: boolean) => {
    saveShowExcludedFiles(next);
    setShowExcludedFiles(next);
  }, []);

  const onChooseChatBackground = useCallback(async () => {
    setChatBackgroundBusy(true);
    setChatBackgroundError(null);
    try {
      const path = await pickAndSaveChatBackground();
      if (!path) return;
      saveChatBackgroundPath(path);
      applyChatBackground(path);
      setChatBackgroundPath(path);
    } catch (error) {
      setChatBackgroundError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setChatBackgroundBusy(false);
    }
  }, []);

  const onClearChatBackground = useCallback(async () => {
    setChatBackgroundBusy(true);
    setChatBackgroundError(null);
    try {
      await removeChatBackground();
      saveChatBackgroundPath(null);
      applyChatBackground(null);
      setChatBackgroundPath(null);
    } catch (error) {
      setChatBackgroundError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setChatBackgroundBusy(false);
    }
  }, []);

  const onChatBackgroundEmptyOpacity = useCallback((percent: number) => {
    const next = applyChatBackgroundEmptyOpacity(percent / 100);
    saveChatBackgroundEmptyOpacity(next);
    setChatBackgroundEmptyOpacity(next);
  }, []);

  const onChatBackgroundSessionOpacity = useCallback((percent: number) => {
    const next = applyChatBackgroundSessionOpacity(percent / 100);
    saveChatBackgroundSessionOpacity(next);
    setChatBackgroundSessionOpacity(next);
  }, []);

  const onChatBackgroundScope = useCallback((next: ChatBackgroundScope) => {
    applyChatBackgroundScope(next);
    saveChatBackgroundScope(next);
    setChatBackgroundScope(next);
  }, []);

  const onDiffPalette = useCallback((next: DiffPalette) => {
    applyDiffPalette(next);
    saveDiffPalette(next);
    setDiffPalette(next);
  }, []);

  const onNewThreadBackgroundEffect = useCallback(
    (next: NewThreadBackgroundEffect) => {
      setNewThreadBackgroundEffect(next);
      setBackgroundEffect(next);
    },
    [],
  );

  const onUiScale = useCallback((percent: number) => {
    const next = saveUiScale(percent / 100);
    setUiScale(next);
    void applyUiScale(next);
  }, []);

  const onCollapsedProjectRailMode = useCallback(
    (next: CollapsedProjectRailMode) => {
      saveCollapsedProjectRailMode(next);
      setStoredCollapsedProjectRailMode(next);
      onControlledCollapsedProjectRailModeChange?.(next);
    },
    [onControlledCollapsedProjectRailModeChange],
  );

  const restoreDefaults = useCallback(() => {
    onThemePreference(THEME_PREFERENCE_DEFAULT);
    onAccentColor(ACCENT_COLOR_DEFAULT);
    onWorkspaceTheme(WORKSPACE_THEME_DEFAULT);
    onOpacity(Math.round(SIDEBAR_OPACITY_DEFAULT * 100));
    onBlur(SIDEBAR_BLUR_DEFAULT);
    onTint(THEME_HUE_DEFAULT, THEME_SATURATION_DEFAULT);
    onDarkLightness(THEME_DARK_LIGHTNESS_DEFAULT);
    onBodyGlass(BODY_GLASS_DEFAULT);
    onInsetLayout(INSET_LAYOUT_DEFAULT);
    onInsetGlass(INSET_GLASS_DEFAULT);
    onShowExcludedFiles(SHOW_EXCLUDED_FILES_DEFAULT);
    onChatBackgroundEmptyOpacity(
      Math.round(CHAT_BACKGROUND_EMPTY_OPACITY_DEFAULT * 100),
    );
    onChatBackgroundSessionOpacity(
      Math.round(CHAT_BACKGROUND_SESSION_OPACITY_DEFAULT * 100),
    );
    onChatBackgroundScope(CHAT_BACKGROUND_SCOPE_DEFAULT);
    onDiffPalette(DIFF_PALETTE_DEFAULT);
    onNewThreadBackgroundEffect(NEW_THREAD_BACKGROUND_EFFECT_DEFAULT);
    if (chatBackgroundPath) void onClearChatBackground();
    onUiScale(Math.round(UI_SCALE_DEFAULT * 100));
    onCollapsedProjectRailMode(COLLAPSED_PROJECT_RAIL_MODE_DEFAULT);
  }, [
    chatBackgroundPath,
    onBlur,
    onBodyGlass,
    onInsetLayout,
    onInsetGlass,
    onChatBackgroundEmptyOpacity,
    onChatBackgroundSessionOpacity,
    onChatBackgroundScope,
    onDiffPalette,
    onNewThreadBackgroundEffect,
    onClearChatBackground,
    onAccentColor,
    onWorkspaceTheme,
    onShowExcludedFiles,
    onThemePreference,
    onOpacity,
    onTint,
    onDarkLightness,
    onUiScale,
    onCollapsedProjectRailMode,
  ]);

  return {
    themePreference,
    accentColor,
    workspaceTheme,
    opacity: preview?.opacity ?? opacity,
    blur,
    themeHue: preview?.hue ?? themeHue,
    themeSaturation: preview?.saturation ?? themeSaturation,
    themeDarkLightness: preview?.lightness ?? themeDarkLightness,
    /** A theme is being previewed: the sliders show it and wait until it is applied or stopped. */
    previewingTheme: !!preview,
    bodyGlass,
    insetGlass,
    insetLayout,
    showExcludedFiles,
    chatBackgroundPath,
    chatBackgroundEmptyOpacity,
    chatBackgroundSessionOpacity,
    chatBackgroundScope,
    diffPalette,
    newThreadBackgroundEffect,
    chatBackgroundBusy,
    chatBackgroundError,
    uiScale,
    collapsedProjectRailMode,
    onThemePreference,
    onAccentColor,
    onWorkspaceTheme,
    onOpacity,
    onBlur,
    onTint,
    onDarkLightness,
    onBodyGlass,
    onInsetLayout,
    onInsetGlass,
    onShowExcludedFiles,
    onChooseChatBackground,
    onClearChatBackground,
    onChatBackgroundEmptyOpacity,
    onChatBackgroundSessionOpacity,
    onChatBackgroundScope,
    onDiffPalette,
    onNewThreadBackgroundEffect,
    onUiScale,
    onCollapsedProjectRailMode,
    restoreDefaults,
  };
}

/**
 * One-click colour presets. Each sets Monocode's own Hue, Saturation,
 * Dark-mode lightness and Sidebar opacity; the sliders stay free to tweak.
 * "Strip" also lays a semi-transparent blue-to-rose tint (sampled from the
 * hub strip) over the native glass. Neither preset touches glass or blur.
 */
const COLOR_PRESETS = [
  { id: "monocode", label: "Monocode", hue: 240, saturation: 0, lightness: 9, opacity: 85 },
  { id: "strip", label: "Strip", hue: 11, saturation: 20, lightness: 9, opacity: 85 },
] as const;

function ColorPresetsRow({ appearance }: { appearance: AppearanceSettings }) {
  const active = COLOR_PRESETS.find(
    (p) =>
      p.hue === appearance.themeHue &&
      p.saturation === appearance.themeSaturation &&
      p.lightness === appearance.themeDarkLightness &&
      p.opacity === Math.round(appearance.opacity * 100) &&
      (p.id === "strip") === loadStripBackdrop(),
  );
  return (
    <Row id="color-presets" label="Presets" description="Sets the hue, saturation, lightness and sidebar opacity below.">
      <Segmented
        label="Presets"
        value={active?.id ?? ""}
        options={COLOR_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(id) => {
          const p = COLOR_PRESETS.find((preset) => preset.id === id);
          if (!p) return;
          appearance.onTint(p.hue, p.saturation);
          appearance.onDarkLightness(p.lightness);
          appearance.onOpacity(p.opacity);
          setStripBackdrop(p.id === "strip");
        }}
      />
    </Row>
  );
}

/**
 * Named schemes. A scheme only overrides theme tokens, so every screen follows it. Glass (monochrome) is the default;
 * a scheme can carry real colour. "Save as scheme" keeps the current sliders under a name, as Ash or a Mono would.
 */
function SchemesRow({ appearance }: { appearance: AppearanceSettings }) {
  const themeVersion = useThemeImportVersion();
  const themeFileVersion = useThemesVersion();
  const [schemes, setSchemes] = useState(allSchemes);
  const [saved, setActive] = useState(loadActiveSchemeId);
  // While another theme is previewed, none of these shows as the one in use.
  const active = previewingTheme() || themePreview() ? undefined : saved;
  // A theme applied or undone elsewhere (ThemesRow, a Mono's offer, Bot changes) shows here too.
  useEffect(() => {
    setSchemes(allSchemes());
    setActive(loadActiveSchemeId());
  }, [themeVersion, themeFileVersion]);
  const [naming, setNaming] = useState<string | null>(null);
  // A scheme goes on as the theme Ash last chose in it (its first if he never has).
  const apply = (scheme: ThemeScheme) => {
    const theme = activeThemeOf(scheme);
    pickTheme(scheme, theme);
    appearance.onTint(theme.hue, theme.saturation);
    // A light theme leaves the dark-mode lightness alone, so dark mode comes back as Ash had it.
    if (theme.scheme !== "light") appearance.onDarkLightness(theme.lightness);
    appearance.onOpacity(Math.round(theme.opacity * 100));
    appearance.onThemePreference(theme.scheme ?? "dark");
    setActive(scheme.id);
  };
  return (
    <Row id="theme-schemes" label="Scheme" description="Changes the look of the whole app. Glass is the default.">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {schemes.map((scheme) => (
          <button
            key={scheme.id}
            type="button"
            aria-pressed={scheme.id === active}
            data-scheme={scheme.id}
            onClick={() => apply(scheme)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ring-1 ring-inset ${scheme.id === active ? "bg-selection text-content ring-content/30" : "text-content/75 ring-surface-ring hover:bg-selection-hover"}`}
          >
            <span aria-hidden className="size-2.5 rounded-full ring-1 ring-content/20" style={{ background: scheme.accent ?? `hsl(${scheme.hue} ${scheme.saturation}% ${Math.max(scheme.lightness, 30)}%)` }} />
            {scheme.name}
            {scheme.custom && scheme.id !== saved ? (
              <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${scheme.name}`}
                title={`Remove ${scheme.name}`}
                data-scheme-remove={scheme.id}
                onClick={(e) => {
                  e.stopPropagation();
                  removeCustomScheme(scheme.id);
                  setSchemes(allSchemes());
                }}
                className="-mr-1 rounded px-0.5 text-content/50 hover:text-content"
              >
                ×
              </span>
            ) : null}
          </button>
        ))}
        {naming === null ? (
          <button type="button" onClick={() => setNaming("")} className="rounded-md px-2.5 py-1 text-[12px] text-content/70 hover:bg-selection-hover">Save as scheme…</button>
        ) : (
          <form className="flex items-center gap-1" onSubmit={(e) => {
            e.preventDefault();
            if (!naming.trim()) return;
            const made = saveCustomScheme({ name: naming.trim(), hue: appearance.themeHue, saturation: appearance.themeSaturation, lightness: appearance.themeDarkLightness, opacity: appearance.opacity, accent: appearance.accentColor });
            setSchemes(allSchemes());
            saveActiveSchemeId(made.id);
            setActive(made.id);
            setNaming(null);
          }}>
            <input autoFocus aria-label="Scheme name" value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Name"
              className="w-24 rounded-md bg-surface px-2 py-1 text-[12px] text-content outline-none ring-1 ring-surface-ring placeholder:text-content/60" />
            <button type="submit" className="rounded-md bg-content/12 px-2 py-1 text-[12px] text-content">Save</button>
          </form>
        )}
      </div>
    </Row>
  );
}

/**
 * F3: a scheme holds several themes. The schemes above choose the set; this chooses the look inside it (a couple of
 * dark ones, sometimes a light one). Picking one keeps it, so the scheme comes back the way Ash left it.
 */
function ThemesPickerRow() {
  const themeVersion = useThemeImportVersion();
  const themeFileVersion = useThemesVersion();
  const [choice, setChoice] = useState(activeThemeChoice);
  useEffect(() => setChoice(activeThemeChoice()), [themeVersion, themeFileVersion]);
  const scheme = allSchemes().find((s) => s.id === choice.schemeId);
  if (!scheme) return null;
  const themes = themesOf(scheme);
  if (themes.length < 2) return null;
  // While a preview runs, none of them shows as the one in use.
  const held = previewingTheme() || themePreview();
  const shown = held ? undefined : (choice.themeId ?? themes[0].id);
  const pick = (theme: SchemeTheme) => {
    pickTheme(scheme, theme);
    setChoice({ schemeId: scheme.id, themeId: theme.id });
  };
  return (
    <Row id="theme-picker" label="Theme" description={`${scheme.name} has ${themes.length} themes. Picking one keeps it.`}>
      <div className="flex flex-wrap items-center justify-end gap-1.5" data-theme-picker>
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            aria-pressed={theme.id === shown}
            data-theme-choice={`${scheme.id}:${theme.id}`}
            onClick={() => pick(theme)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] ring-1 ring-inset ${theme.id === shown ? "bg-selection text-content ring-content/30" : "text-content/75 ring-surface-ring hover:bg-selection-hover"}`}
          >
            <span
              aria-hidden
              className="size-2.5 rounded-full ring-1 ring-content/20"
              style={{ background: theme.accent ?? `hsl(${theme.hue} ${theme.saturation}% ${theme.scheme === "light" ? 62 : Math.max(theme.lightness, 30)}%)` }}
            />
            {theme.name}
            <span className="text-content/50">{theme.scheme === "light" ? "light" : "dark"}</span>
          </button>
        ))}
      </div>
    </Row>
  );
}

/**
 * F3: add a theme as JSON. Ash pastes it or picks a file (a Mono hands one in the same way); it is checked before
 * anything changes, then Preview, Apply or Discard. Up to 7 per colour scheme.
 */
function ThemesRow() {
  useThemeImportVersion();
  const [text, setText] = useState<string | null>(null);
  const pending = pendingTheme();
  const theme = pending?.check.ok ? pending.check.theme : undefined;
  // Only said when it matters: a full set (the check says so too, if Ash tries another).
  const full = (["dark", "light"] as const).filter((scheme) => allSchemes().filter((s) => s.custom && (s.scheme ?? "dark") === scheme).length >= MAX_THEMES_PER_SCHEME);
  const BTN = "rounded-md px-2.5 py-1 text-[12px] ring-1 ring-inset ring-surface-ring text-content/85 hover:bg-selection-hover";
  return (
    <Row id="theme-files" label="Add a theme" description={`Paste a theme or pick a file. We check it before anything changes.${full.length ? ` You have as many ${full.join(" and ")} themes as we keep, so remove one to add another.` : ""}`}>
      <div className="flex w-[300px] flex-col items-end gap-2" data-theme-import>
        {pending ? (
          <div className="w-full rounded-md bg-surface p-2.5 ring-1 ring-surface-ring" data-theme-pending={pending.check.ok ? "ok" : "problems"}>
            {theme ? (
              <>
                <p className="flex items-center gap-1.5 text-[12px] text-content">
                  <span aria-hidden className="size-2.5 rounded-full ring-1 ring-content/20" style={{ background: theme.accent ?? `hsl(${theme.hue} ${theme.saturation}% ${Math.max(theme.lightness, 30)}%)` }} />
                  {theme.name}
                  <span className="text-content/55">· {theme.scheme} theme{pending.by ? ` from ${pending.by}` : ""}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-content/60">{pending.previewing ? "You're seeing it now. Nothing changes for good until you apply it." : "Looks good. Preview it or apply it."}</p>
              </>
            ) : (
              <>
                <p className="text-[12px] text-content">{pending.by ? `${pending.by}'s theme won't work` : "This theme won't work"}</p>
                <ul className="mt-1 list-disc pl-4 text-[11px] leading-4 text-content/70" data-theme-problems>
                  {!pending.check.ok && pending.check.problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </>
            )}
            <div className="mt-2 flex justify-end gap-1.5">
              {theme ? (
                pending.previewing ? (
                  <button type="button" data-theme-stop-preview onClick={stopPreview} className={BTN}>Stop preview</button>
                ) : (
                  <button type="button" data-theme-preview onClick={previewTheme} className={BTN}>Preview</button>
                )
              ) : null}
              <button type="button" data-theme-discard onClick={discardTheme} className={BTN}>Discard</button>
              {theme ? (
                <button type="button" data-theme-apply onClick={() => applyTheme()} className="rounded-md bg-content/12 px-2.5 py-1 text-[12px] text-content hover:bg-content/18">Apply</button>
              ) : null}
            </div>
          </div>
        ) : text === null ? (
          <div className="flex gap-1.5">
            <button type="button" data-theme-paste onClick={() => setText("")} className={BTN}>Paste a theme…</button>
            <label className={`${BTN} cursor-default`}>
              Pick a file…
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) void file.text().then((t) => offerTheme(t));
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        ) : (
          <form
            className="flex w-full flex-col items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              offerTheme(text);
              setText(null);
            }}
          >
            <textarea
              autoFocus
              aria-label="Theme to paste"
              data-theme-json
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              placeholder={'{ "name": "Night", "scheme": "dark", "hue": 220, "saturation": 8, "lightness": 8, "opacity": 0.9, "accent": null }'}
              className="w-full resize-none rounded-md bg-surface px-2 py-1.5 font-mono text-[11px] text-content outline-none ring-1 ring-surface-ring placeholder:text-content/45"
            />
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setText(null)} className={BTN}>Cancel</button>
              <button type="submit" data-theme-check className="rounded-md bg-content/12 px-2.5 py-1 text-[12px] text-content">Check</button>
            </div>
          </form>
        )}
      </div>
    </Row>
  );
}

/**
 * F3: themes your Monos made. Each Mono's folder can hold `themes/<name>.json`; opening Appearance reads them and offers
 * the ones Ash hasn't answered yet, each with Preview, Apply (a Bot changes row with Undo) or Discard. Only the Monos on
 * the roster can offer one; a temporary worker's files don't show up here.
 */
function MonoThemesRow() {
  useThemesVersion();
  const [scanning, setScanning] = useState(true);
  const offers = themeOffers();
  const refusals = themeRefusals();
  const preview = themePreview();
  const look = () => {
    setScanning(true);
    void scanMonoThemes().finally(() => setScanning(false));
  };
  useEffect(() => {
    let here = true;
    void scanMonoThemes().finally(() => {
      if (here) setScanning(false);
    });
    return () => {
      here = false;
    };
  }, []);
  const nothing = !scanning && !offers.length && !refusals.length;
  const BTN = "rounded-md px-2.5 py-1 text-[12px] ring-1 ring-inset ring-surface-ring text-content/85 hover:bg-selection-hover";
  return (
    <Row
      id="mono-themes"
      label="Themes from your Monos"
      description={
        offers.length
          ? "A Mono made these. Preview one on the whole app, then apply it or discard it."
          : nothing
            ? "A Mono can add a theme file to its folder. Nothing new right now."
            : "Checking your Monos' folders for theme files."
      }
    >
      <div className="flex w-[300px] flex-col items-end gap-2" data-mono-themes>
        {offers.map((offer) => {
          const themes = themesOf(offer.scheme);
          const here = preview?.offerId === offer.id ? preview.themeId : undefined;
          return (
            <div key={offer.id} className="w-full rounded-md bg-surface p-2.5 ring-1 ring-surface-ring" data-mono-offer={offer.id}>
              <p className="text-[12px] text-content">
                “{offer.scheme.name}” <span className="text-content/55">· {themes.length} theme{themes.length === 1 ? "" : "s"} from {offer.by}</span>
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {themes.map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    aria-pressed={theme.id === here}
                    data-mono-theme={theme.id}
                    onClick={() => previewOffer(offer.id, theme.id)}
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${theme.id === here ? "bg-selection text-content ring-content/30" : "text-content/75 ring-surface-ring hover:bg-selection-hover"}`}
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-full ring-1 ring-content/20"
                      style={{ background: theme.accent ?? `hsl(${theme.hue} ${theme.saturation}% ${theme.scheme === "light" ? 62 : Math.max(theme.lightness, 30)}%)` }}
                    />
                    {theme.name}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                {here ? (
                  <button type="button" data-mono-end-preview onClick={endPreview} className={BTN}>Stop preview</button>
                ) : (
                  <button type="button" data-mono-preview onClick={() => previewOffer(offer.id)} className={BTN}>Preview</button>
                )}
                <button type="button" data-mono-discard onClick={() => discardOffer(offer.id)} className={BTN}>Discard</button>
                <button type="button" data-mono-apply onClick={() => applyOffer(offer.id)} className="rounded-md bg-content/12 px-2.5 py-1 text-[12px] text-content hover:bg-content/18">Apply</button>
              </div>
            </div>
          );
        })}
        {refusals.map((refusal) => (
          <div key={refusal.id} className="w-full rounded-md bg-surface p-2.5 ring-1 ring-surface-ring" data-mono-refusal={refusal.id}>
            <p className="text-[12px] text-content">{refusal.by}'s theme won't work</p>
            <p className="mt-0.5 text-[11px] leading-4 text-content/70">{refusal.reason}</p>
            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => discardOffer(refusal.id)} className={BTN}>Dismiss</button>
            </div>
          </div>
        ))}
        <button type="button" data-mono-themes-rescan onClick={look} disabled={scanning} className={BTN}>
          {scanning ? "Looking…" : "Look for new themes"}
        </button>
      </div>
    </Row>
  );
}

/**
 * While a theme is previewed, a slim bar stays at the top of Appearance as Ash scrolls down to the sliders, so Stop
 * preview and Apply are always in reach. It wears the sidebar's glass fill (`sidebar-glass`) with the 24px backdrop
 * blur the peeking sidebar uses, so text scrolling under it doesn't show through.
 */
function ThemePreviewBar() {
  useThemeImportVersion();
  useThemesVersion();
  const pending = pendingTheme();
  const filePreview = themePreview();
  const offer = filePreview ? themeOffers().find((o) => o.id === filePreview.offerId) : undefined;
  const offerTheme = offer && filePreview ? themesOf(offer.scheme).find((t) => t.id === filePreview.themeId) : undefined;
  const name = offer && offerTheme
    ? offerTheme.name
    : pending?.previewing && pending.check.ok
      ? pending.check.theme.name
      : undefined;
  if (!name) return null;
  const stop = offer ? endPreview : stopPreview;
  const apply = offer ? () => applyOffer(offer.id) : () => applyTheme();
  return (
    <div
      data-theme-preview-bar
      className="sidebar-glass hub-fade-in sticky top-0 z-20 -mx-2 mb-4 flex items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-surface-ring backdrop-blur-xl"
    >
      <p className="min-w-0 flex-1 truncate text-[13px] text-content">Previewing {name}</p>
      <button type="button" data-theme-bar-stop onClick={stop}
        className="rounded-md px-2.5 py-1 text-[12px] text-content/85 ring-1 ring-inset ring-surface-ring hover:bg-selection-hover">Stop preview</button>
      <button type="button" data-theme-bar-apply onClick={apply}
        className="rounded-md bg-content/12 px-2.5 py-1 text-[12px] text-content hover:bg-content/18">Apply</button>
    </div>
  );
}

function AppearancePage({ appearance }: { appearance: AppearanceSettings }) {
  const percent = Math.round(appearance.opacity * 100);
  const glassDisabled = useColorScheme() === "light";
  // The inset workspace takes its colours from the workspace theme and has a
  // fixed tint and blur, so the tint and translucency groups only belong to
  // the classic layout. Its one glass switch lives with the theme instead.
  const inset = appearance.insetLayout;

  return (
    <>
      <ThemePreviewBar />
      <Group
        title="Theme"
        description={
          inset
            ? "Each workspace theme has its own dark and light palette."
            : "Dark and light share the same tint, so the color settings below apply to both."
        }
      >
        <Row
          id="theme"
          label="Theme"
          description="System follows the OS appearance."
        >
          <Segmented
            label="Theme"
            value={appearance.themePreference}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
            onChange={appearance.onThemePreference}
          />
        </Row>
        {/* Hub schemes set the classic layout's tint and translucency, which
            the inset workspace's own themes replace. */}
        {inset ? null : <SchemesRow appearance={appearance} />}
        {inset ? null : <ThemesPickerRow />}
        {inset ? null : <ThemesRow />}
        {inset ? null : <MonoThemesRow />}
        {inset ? (
          <Row
            id="workspace-theme"
            label="Workspace theme"
            description="Colors for the inset workspace's shell, card, text and accent. Each theme has a dark and a light palette."
          >
            <div className="w-48">
              <Select
                label="Workspace theme"
                value={appearance.workspaceTheme}
                options={WORKSPACE_THEMES.map((theme) => ({
                  value: theme.id,
                  label: theme.label,
                  icon: (
                    <WorkspaceThemeSwatch
                      palette={glassDisabled ? theme.light : theme.dark}
                    />
                  ),
                }))}
                onChange={(value) => {
                  if (isWorkspaceThemeId(value))
                    appearance.onWorkspaceTheme(value);
                }}
              />
            </div>
          </Row>
        ) : null}
        {inset ? (
          <Row
            id="inset-glass"
            label="Transparent window"
            description={
              IS_LINUX
                ? "The window stays opaque on Linux."
                : glassDisabled
                  ? "Light mode keeps the window opaque. Your dark-mode choice is remembered."
                  : "Show the desktop through the window. Turn off to keep the window opaque."
            }
          >
            <Toggle
              label="Transparent window"
              on={appearance.insetGlass}
              onChange={appearance.onInsetGlass}
              disabled={glassDisabled || IS_LINUX}
            />
          </Row>
        ) : null}
        <Row
          id="accent-color"
          label="Accent color"
          description="Used for the composer send button and your message bubbles."
        >
          <AccentColorPicker
            value={appearance.accentColor}
            onChange={appearance.onAccentColor}
          />
        </Row>
        <Row
          id="diff-colors"
          label="Diff colors"
          description="Colors for added and removed lines. Colorblind and High contrast use blue and orange instead of green and red; High contrast adds stronger tints and text."
        >
          <Segmented
            label="Diff colors"
            value={appearance.diffPalette}
            options={[
              { value: "default", label: "Default" },
              { value: "colorblind", label: "Colorblind" },
              { value: "high-contrast", label: "High contrast" },
            ]}
            onChange={appearance.onDiffPalette}
          />
        </Row>
      </Group>

      {inset ? null : (
        <>
          <Group
            title="Color"
            description="Hue and saturation tint every surface. Lightness only moves the dark theme."
          >
            <ColorPresetsRow appearance={appearance} />
            <Row
              id="hue"
              label="Hue"
              description="Base hue for accents and tinted surfaces."
            >
              <Slider
                label="Hue"
                value={appearance.themeHue}
                display={`${appearance.themeHue}°`}
                min={THEME_HUE_MIN}
                max={THEME_HUE_MAX}
                onChange={(value) =>
                  appearance.onTint(value, appearance.themeSaturation)
                }
                held={appearance.previewingTheme}
              />
            </Row>
            <Row
              id="saturation"
              label="Saturation"
              description="How strongly the hue tints the interface. Zero keeps it neutral."
            >
              <Slider
                label="Saturation"
                value={appearance.themeSaturation}
                display={`${appearance.themeSaturation}%`}
                min={THEME_SATURATION_MIN}
                max={THEME_SATURATION_MAX}
                onChange={(value) =>
                  appearance.onTint(appearance.themeHue, value)
                }
                held={appearance.previewingTheme}
              />
            </Row>
            <Row
              id="dark-lightness"
              label="Dark-mode lightness"
              description={
                glassDisabled
                  ? "This only affects dark mode. Your dark-mode value is preserved."
                  : "Base brightness of the dark theme. Lower values are darker; zero is true black."
              }
            >
              <Slider
                label="Dark-mode lightness"
                value={appearance.themeDarkLightness}
                display={`${appearance.themeDarkLightness}%`}
                min={THEME_DARK_LIGHTNESS_MIN}
                max={THEME_DARK_LIGHTNESS_MAX}
                onChange={appearance.onDarkLightness}
                disabled={glassDisabled}
                held={appearance.previewingTheme}
              />
            </Row>
          </Group>

          <Group
            title="Translucency"
            description={
              glassDisabled
                ? "Light mode always uses an opaque window, so these are off. Your dark-mode values are preserved."
                : "How much of the desktop shows through MonoCode. Blur costs more to composite the higher it goes."
            }
          >
            <Row
              id="sidebar-opacity"
              label="Sidebar opacity"
              description="Applies to the project rail and the other glass panes."
            >
              <Slider
                label="Sidebar opacity"
                value={percent}
                display={`${percent}%`}
                min={Math.round(SIDEBAR_OPACITY_MIN * 100)}
                max={Math.round(SIDEBAR_OPACITY_MAX * 100)}
                onChange={appearance.onOpacity}
                disabled={glassDisabled}
                held={appearance.previewingTheme}
              />
            </Row>
            <Row
              id="blur"
              label="Blur radius"
              description="Background blur behind the window."
            >
              <Slider
                label="Blur radius"
                value={appearance.blur}
                display={String(appearance.blur)}
                min={SIDEBAR_BLUR_MIN}
                max={SIDEBAR_BLUR_MAX}
                onChange={appearance.onBlur}
                disabled={glassDisabled}
              />
            </Row>
            <Row
              id="main-pane-glass"
              label="Main pane glass"
              description="Extend the translucent treatment to the main pane behind sessions and editors."
            >
              <Toggle
                label="Main pane glass"
                on={appearance.bodyGlass}
                onChange={appearance.onBodyGlass}
                disabled={glassDisabled}
              />
            </Row>
          </Group>
        </>
      )}

      <ChatBackgroundCard appearance={appearance} />

      <Group title="Layout">
        {/* WP-03: Hivra has one layout, so no switch (src/features/hub/model/hivraLayout.ts). */}
        {HIVRA_LAYOUT_FIXED ? null : (
        <Row
          id="inset-layout"
          label="Layout"
          description="Classic keeps everything in one sidebar. Focused adds a project switcher, workspace tabs and a right panel."
        >
          <Segmented
            label="Layout"
            value={appearance.insetLayout ? "focused" : "classic"}
            options={[
              { value: "classic", label: "Classic" },
              { value: "focused", label: "Focused" },
            ]}
            onChange={(value) => appearance.onInsetLayout(value === "focused")}
          />
        </Row>
        )}
        <Row
          id="collapsed-project-rail"
          label="Collapsed project rail"
          description="Keep project navigation available as a compact icon rail, or hide the rail completely."
        >
          <Segmented
            label="Collapsed project rail"
            value={appearance.collapsedProjectRailMode}
            options={[
              { value: "compact", label: "Icon rail" },
              { value: "hidden", label: "Hidden" },
            ]}
            onChange={appearance.onCollapsedProjectRailMode}
          />
        </Row>
        <Row
          id="interface-scale"
          label="Interface scale"
          description="Zoom the whole interface. You can also use Ctrl+=, Ctrl+-, and Ctrl+0 (Cmd on macOS)."
        >
          <Select
            label="Interface scale"
            value={String(Math.round(appearance.uiScale * 100))}
            options={UI_SCALE_PERCENTS.map((percent) => ({
              value: String(percent),
              label: `${percent}%`,
            }))}
            onChange={(value) => appearance.onUiScale(Number(value))}
          />
        </Row>
        <Row
          id="show-excluded-files"
          label="Show excluded files"
          description="Show files and folders Git excludes, such as build output and dependencies, in the explorer."
        >
          <Toggle
            label="Show excluded files"
            on={appearance.showExcludedFiles}
            onChange={appearance.onShowExcludedFiles}
          />
        </Row>
      </Group>
    </>
  );
}

function ChatBackgroundCard({
  appearance,
}: {
  appearance: AppearanceSettings;
}) {
  const src = chatBackgroundSrc(appearance.chatBackgroundPath);
  const hasImage = Boolean(appearance.chatBackgroundPath && src);
  const emptyVisibility = Math.round(
    appearance.chatBackgroundEmptyOpacity * 100,
  );
  const sessionVisibility = Math.round(
    appearance.chatBackgroundSessionOpacity * 100,
  );
  const busy = appearance.chatBackgroundBusy;

  return (
    <Group
      id="chat-background"
      title="Chat background"
      description="An image behind your chat panes. It stays on this device."
    >
      <div className="border-b border-content/5 p-4 last:border-b-0">
        <div className="overflow-hidden rounded-lg border border-content/10">
          {hasImage ? (
            <div
              className={`relative h-36 ${appearance.newThreadBackgroundEffect === "gradient-blur" ? "bg-background-base" : ""}`}
            >
              {appearance.newThreadBackgroundEffect === "gradient-blur" ? (
                <GradientBlurBackground
                  className="gradient-blur-preview absolute inset-0"
                  style={{ opacity: appearance.chatBackgroundEmptyOpacity }}
                />
              ) : (
                <div
                  aria-hidden
                  className="chat-background-fade size-full bg-cover bg-center bg-no-repeat"
                  style={{
                    backgroundImage: "var(--chat-background-image)",
                    opacity: appearance.chatBackgroundEmptyOpacity,
                  }}
                />
              )}
              <span className="pointer-events-none absolute bottom-2 left-2 text-[11px] text-content/40">
                Empty chat preview at {emptyVisibility}%
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void appearance.onChooseChatBackground()}
              disabled={busy}
              className="flex h-36 w-full flex-col items-center justify-center gap-2 text-content/40 hover:bg-content/5 hover:text-content/70 disabled:cursor-default disabled:opacity-40"
            >
              {busy ? (
                <Loader className="size-5 animate-spin" aria-hidden />
              ) : (
                <ImagePlus className="size-5" aria-hidden />
              )}
              <span className="text-[12px]">Choose an image</span>
            </button>
          )}
        </div>
        {hasImage ? (
          <div className="mt-3 flex items-center justify-end gap-2">
            <SecondaryButton
              onClick={() => void appearance.onChooseChatBackground()}
              disabled={busy}
            >
              {busy ? (
                <Loader className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              Change
            </SecondaryButton>
            <SecondaryButton
              onClick={() => void appearance.onClearChatBackground()}
              disabled={busy}
              danger
            >
              Remove
            </SecondaryButton>
          </div>
        ) : null}
        {appearance.chatBackgroundError ? (
          <p className="mt-2 text-[12px] text-red-400">
            {appearance.chatBackgroundError}
          </p>
        ) : null}
      </div>
      {hasImage ? (
        <>
          <Row
            label="Background effect"
            description={
              NEW_THREAD_BACKGROUND_EFFECT_DESCRIPTIONS[
                appearance.newThreadBackgroundEffect
              ]
            }
          >
            <Segmented
              label="Background effect"
              value={appearance.newThreadBackgroundEffect}
              options={NEW_THREAD_BACKGROUND_EFFECTS.map((effect) => ({
                value: effect,
                label: NEW_THREAD_BACKGROUND_EFFECT_LABELS[effect],
              }))}
              onChange={appearance.onNewThreadBackgroundEffect}
              optionIdPrefix="new-thread-background-effect"
            />
          </Row>
          <Row
            label="Show on"
            description="Empty sessions only, or every conversation."
          >
            <Segmented
              label="Show background on"
              value={appearance.chatBackgroundScope}
              options={[
                { value: "empty", label: "Empty only" },
                { value: "all", label: "All sessions" },
              ]}
              onChange={appearance.onChatBackgroundScope}
            />
          </Row>
          <Row
            label="Empty chat visibility"
            description="Background strength before a chat has messages."
          >
            <Slider
              label="Empty chat background visibility"
              value={emptyVisibility}
              display={`${emptyVisibility}%`}
              min={Math.round(CHAT_BACKGROUND_OPACITY_MIN * 100)}
              max={Math.round(CHAT_BACKGROUND_OPACITY_MAX * 100)}
              onChange={appearance.onChatBackgroundEmptyOpacity}
            />
          </Row>
          <Row
            label="Session visibility"
            description="Background strength once the conversation has messages."
          >
            <Slider
              label="Session background visibility"
              value={sessionVisibility}
              display={`${sessionVisibility}%`}
              min={Math.round(CHAT_BACKGROUND_OPACITY_MIN * 100)}
              max={Math.round(CHAT_BACKGROUND_OPACITY_MAX * 100)}
              onChange={appearance.onChatBackgroundSessionOpacity}
            />
          </Row>
        </>
      ) : null}
    </Group>
  );
}

type ShortcutModifier = "metaKey" | "ctrlKey" | "altKey" | "shiftKey";

function shortcutModifier(event: KeyboardEvent): ShortcutModifier | null {
  if (event.key === "Meta" || event.code.startsWith("Meta")) return "metaKey";
  if (event.key === "Control" || event.code.startsWith("Control"))
    return "ctrlKey";
  if (event.key === "Alt" || event.code.startsWith("Alt")) return "altKey";
  if (event.key === "Shift" || event.code.startsWith("Shift"))
    return "shiftKey";
  return null;
}

function ShortcutEditor({
  name,
  display,
  resetVisible,
  onApply,
  onDisable,
  onReset,
}: {
  name: string;
  display: string | null;
  resetVisible: boolean;
  onApply: (shortcut: string) => void | Promise<void>;
  onDisable: () => void | Promise<void>;
  onReset: () => void | Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const held = useRef({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });

  const run = async (action: () => void | Promise<void>) => {
    setRecording(false);
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const beginRecording = () => {
    held.current = {
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    setPreview("");
    setError(null);
    setRecording(true);
  };

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const bare =
        !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      // An unmodified Tab leaves the recorder instead of trapping focus.
      if (bare && event.code === "Tab") {
        setRecording(false);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }
      // Delete disables, but only on its own so Cmd+Delete still records.
      if (bare && (event.code === "Backspace" || event.code === "Delete")) {
        void run(onDisable);
        return;
      }
      const modifier = shortcutModifier(event);
      if (modifier) held.current[modifier] = true;
      const modifiers = {
        metaKey: event.metaKey || held.current.metaKey,
        ctrlKey: event.ctrlKey || held.current.ctrlKey,
        altKey: event.altKey || held.current.altKey,
        shiftKey: event.shiftKey || held.current.shiftKey,
      };
      setPreview(
        quickComposerShortcutPreview(
          modifiers,
          modifier ? undefined : event.code,
          event.key,
        ),
      );
      if (modifier) return;
      const next = shortcutFromKeyEvent({ ...modifiers, code: event.code });
      if (next) void run(() => onApply(next));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const modifier = shortcutModifier(event);
      if (!modifier) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      held.current[modifier] = false;
      const modifiers = {
        metaKey: event.metaKey || held.current.metaKey,
        ctrlKey: event.ctrlKey || held.current.ctrlKey,
        altKey: event.altKey || held.current.altKey,
        shiftKey: event.shiftKey || held.current.shiftKey,
      };
      modifiers[modifier] = false;
      setPreview(quickComposerShortcutPreview(modifiers));
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [onApply, onDisable, recording]);

  return (
    <div className="relative w-40 shrink-0">
      <div className="flex items-center gap-0.5">
        <input
          type="text"
          readOnly
          aria-label={`Change ${name} shortcut`}
          data-shortcut-recorder-active={recording ? "true" : undefined}
          aria-busy={busy || undefined}
          value={
            recording || busy ? preview || "Record…" : (display ?? "Disabled")
          }
          onFocus={beginRecording}
          onClick={beginRecording}
          onBlur={() => setRecording(false)}
          className={`h-6 w-28 shrink-0 truncate rounded-md border bg-transparent px-1.5 py-0 font-mono text-[11px] leading-none outline-none focus:border-accent ${
            busy ? "opacity-50" : ""
          } ${
            display === null
              ? "border-dashed border-content/15 text-content/35"
              : "border-content/15 text-content/80 hover:bg-content/10"
          }`}
        />
        {resetVisible ? (
          <button
            type="button"
            aria-label={`Reset ${name} shortcut`}
            disabled={busy}
            onClick={() => void run(onReset)}
            className="rounded-md px-1 py-1 text-content/35 hover:bg-content/10 hover:text-content disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" />
          </button>
        ) : null}
      </div>
      {recording ? (
        <p
          className="pointer-events-none absolute top-1/2 right-full z-40 mr-3 -translate-y-1/2 text-[10px] whitespace-nowrap text-content/50"
          aria-live="polite"
        >
          Del disables · Esc cancels
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="absolute top-full left-0 z-40 mt-1.5 w-max max-w-64 rounded-md border border-content/10 popover-glass px-2 py-1 text-[11px] whitespace-nowrap text-red-400 shadow-lg"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QuickComposerShortcutEditor() {
  const [shortcut, setShortcut] = useState(loadQuickComposerShortcut);
  const [enabled, setEnabled] = useState(loadQuickComposerEnabled);
  const apply = async (next: string) => {
    if (!isGlobalShortcut(next))
      throw new Error("Quick Composer needs ⌘ or Ctrl as a global hotkey");
    // Validate before the native call: a rejected chord must not leave the OS
    // holding a registered global hotkey that settings does not know about.
    validateKeybindingShortcut("App: Quick Composer", next);
    // Recording while the feature is off must not silently switch it back on.
    if (enabled) await setQuickComposerShortcut(true, next);
    saveQuickComposerShortcut(next);
    setShortcut(next);
  };
  const reset = async () => {
    // Reset restores the whole default state, including the enabled flag.
    validateKeybindingShortcut(
      "App: Quick Composer",
      QUICK_COMPOSER_DEFAULT_SHORTCUT,
    );
    await setQuickComposerShortcut(true, QUICK_COMPOSER_DEFAULT_SHORTCUT);
    saveQuickComposerEnabled(true);
    saveQuickComposerShortcut(QUICK_COMPOSER_DEFAULT_SHORTCUT);
    setShortcut(QUICK_COMPOSER_DEFAULT_SHORTCUT);
    setEnabled(true);
  };
  return (
    <ShortcutEditor
      name="quick composer"
      display={enabled ? quickComposerShortcutLabel(shortcut) : null}
      resetVisible={
        enabled !== true || shortcut !== QUICK_COMPOSER_DEFAULT_SHORTCUT
      }
      onApply={apply}
      onDisable={async () => {
        await setQuickComposerShortcut(false);
        saveQuickComposerEnabled(false);
        setEnabled(false);
      }}
      onReset={reset}
    />
  );
}

function KeybindingShortcutEditor({
  command,
  display,
  modified,
  onSave,
}: {
  command: string;
  display: string | null;
  modified: boolean;
  onSave: (
    command: string,
    override: KeybindingOverride,
  ) => void | Promise<void>;
}) {
  return (
    <ShortcutEditor
      name={command}
      display={display}
      resetVisible={modified}
      onApply={(shortcut) => onSave(command, { shortcut })}
      onDisable={() => onSave(command, { disabled: true })}
      onReset={() => onSave(command, {})}
    />
  );
}

function KeybindingsPage() {
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState(loadKeybindingOverrides);
  useEffect(
    () => subscribeKeybindings(() => setOverrides(loadKeybindingOverrides())),
    [],
  );
  const rows = useMemo(
    () => filterKeybindings(currentKeybindings(), query),
    [query, overrides],
  );

  const save = async (command: string, override: KeybindingOverride) => {
    const next = saveKeybindingOverride(command, override);
    if (IS_MAC) await invoke("keybindings_set_overrides", { overrides: next });
  };

  return (
    <Group
      title="Shortcuts"
      description="Click a shortcut to record new keys. Press Delete while recording to disable it."
      action={
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[12px] text-content/40 tabular-nums">
            {rows.length} {rows.length === 1 ? "binding" : "bindings"}
          </span>
          <label className="flex h-7 w-44 shrink-0 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter"
              aria-label="Filter keybindings"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </label>
        </div>
      }
    >
      <div className="flex items-center border-b border-stroke bg-content/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
        <span className="min-w-0 flex-1">Command</span>
        <span className="w-40 shrink-0">Keybinding</span>
        <span className="w-28 shrink-0">When</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-content/45">
          No matching bindings
        </p>
      ) : (
        rows.map((row) => {
          const override = overrides[row.command];
          const disabled = override?.disabled === true;
          return (
            <div
              key={row.command}
              className="flex h-11 items-center border-b border-content/5 px-4 text-[12px] last:border-b-0"
            >
              <span
                className={`min-w-0 flex-1 truncate ${disabled ? "text-content/45" : ""}`}
              >
                {row.command}
              </span>
              {row.fixed ? (
                <span className="w-40 shrink-0">
                  <span className="inline-block h-6 w-28 truncate rounded-md border border-content/10 px-1.5 font-mono text-[11px] leading-6 text-content/60">
                    {row.keys}
                  </span>
                </span>
              ) : row.command === "App: Quick Composer" ? (
                <QuickComposerShortcutEditor />
              ) : (
                <KeybindingShortcutEditor
                  command={row.command}
                  display={disabled ? null : row.keys}
                  modified={Boolean(override)}
                  onSave={save}
                />
              )}
              <span className="w-28 shrink-0 font-mono text-[11px] text-content/40">
                {row.when}
              </span>
            </div>
          );
        })
      )}
    </Group>
  );
}

const GLOBAL_PROVIDER_SCOPE = "global";

function binaryInspectionError(
  provider: ConfigurableBinaryProvider,
  inspection: HarnessBinaryInspection,
): string | null {
  if (inspection.error) return inspection.error;
  if (
    provider === "codex" &&
    !/^codex-cli\s+\d+\.\d+\.\d+/.test(inspection.version ?? "")
  ) {
    return "Codex CLI returned an invalid version.";
  }
  if (provider === "opencode") {
    const version = parseOpenCodeVersion(inspection.version ?? "");
    if (!version) return "OpenCode CLI returned an invalid version.";
    if (compareSemver(version, MINIMUM_OPENCODE_VERSION) < 0) {
      return `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`;
    }
  }
  return null;
}

function ProviderBinaryControl({
  provider,
}: {
  provider: ConfigurableBinaryProvider;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    () => loadProviderBinaryPath(provider) ?? "",
  );
  const [overridden, setOverridden] = useState(() =>
    Boolean(loadProviderBinaryPath(provider)),
  );
  const [inspection, setInspection] = useState<
    HarnessBinaryInspection & { overridden: boolean }
  >();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const inspect = useCallback(
    async (binaryPath?: string | null) => {
      setWorking(true);
      setInspection(undefined);
      setError(null);
      setRevealError(null);
      try {
        const next = await inspectHarnessBinary(provider, binaryPath);
        setInspection({
          ...next,
          overridden: Boolean(binaryPath?.trim()),
        });
        setError(binaryInspectionError(provider, next));
        return next;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        return null;
      } finally {
        setWorking(false);
      }
    },
    [provider],
  );

  useEffect(() => {
    if (editing) editInput.current?.focus();
  }, [editing]);

  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    setEditing(false);
    if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (working) return;
    const value = draft.trim();
    if (!value) {
      await useAuto();
      return;
    }
    const next = await inspect(value);
    if (!next) return;
    const validationError = binaryInspectionError(provider, next);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!saveProviderBinaryPath(provider, value)) {
      setInspection(undefined);
      setError("Could not save the binary path.");
      return;
    }
    setOverridden(true);
    dismiss(true);
  };

  const useAuto = async () => {
    if (working) return;
    const next = await inspect(null);
    if (!next || binaryInspectionError(provider, next)) return;
    if (!saveProviderBinaryPath(provider, null)) {
      setInspection(undefined);
      setError("Could not save the binary path.");
      return;
    }
    setDraft("");
    setOverridden(false);
    dismiss(true);
  };

  const title = HARNESS_TITLE[provider];
  const restartRequired = providerBinaryPathChangePending(provider);

  return (
    <span ref={root} className="inline-flex align-middle">
      <button
        ref={trigger}
        type="button"
        aria-label={
          restartRequired
            ? `Show ${title} CLI details, restart required`
            : `Show ${title} CLI details`
        }
        aria-expanded={open}
        aria-controls={`${provider}-binary-popover`}
        aria-haspopup="dialog"
        title={`${title} CLI path${restartRequired ? " — restart required" : ""}`}
        onClick={() => {
          if (!open && !inspection && !working && !error) {
            void inspect(loadProviderBinaryPath(provider));
          }
          setOpen((value) => !value);
          setEditing(false);
        }}
        className={`grid size-6 place-items-center rounded hover:bg-content/10 focus-visible:outline-2 focus-visible:outline-accent ${
          restartRequired
            ? "text-amber-300"
            : "text-content/35 hover:text-content"
        }`}
      >
        <FolderOpen className="size-3.5" strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          id={`${provider}-binary-popover`}
          role="dialog"
          aria-label={`${title} CLI details`}
          aria-busy={working}
          tabIndex={-1}
          anchor={root}
          side="bottom"
          align="start"
          width={440}
          className="p-3"
          autoFocus
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
              ),
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) return;
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
          onDismiss={(reason) => dismiss(reason === "escape")}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-content">
              {title} CLI
            </span>
            <div className="flex items-center gap-1.5">
              <span className="rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] text-content/50">
                Global path
              </span>
              <span className="rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] text-content/50">
                {error
                  ? "Needs attention"
                  : restartRequired
                    ? "Restart required"
                    : overridden
                      ? "Configured"
                      : "Auto-detected"}
              </span>
            </div>
          </div>
          {editing ? (
            <form className="mt-2" onSubmit={submit}>
              <label
                htmlFor={`${provider}-binary-path`}
                className="text-[11px] text-content/50"
              >
                CLI path
              </label>
              <input
                id={`${provider}-binary-path`}
                ref={editInput}
                type="text"
                value={draft}
                placeholder={inspection?.path ?? "Auto-detected path"}
                disabled={working}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                className="mt-1.5 h-8 w-full rounded-md border border-content/10 bg-content/[0.04] px-2 font-mono text-[11px] text-content outline-none placeholder:font-sans placeholder:text-content/35 focus:border-accent/45 disabled:opacity-50"
              />
              <p className="mt-1.5 text-[10px] text-content/40">
                Enter the absolute path to the CLI executable. Changes apply
                after restarting MonoCode.
              </p>
              {error ? (
                <span
                  role="alert"
                  className="mt-1.5 block text-[11px] text-red-400"
                >
                  {error}
                </span>
              ) : null}
              <div className="mt-3 flex justify-end gap-2">
                <SecondaryButton
                  disabled={working}
                  onClick={() => {
                    setDraft(loadProviderBinaryPath(provider) ?? "");
                    setEditing(false);
                    queueMicrotask(() => trigger.current?.focus());
                  }}
                >
                  Cancel
                </SecondaryButton>
                {overridden ? (
                  <SecondaryButton
                    disabled={working}
                    onClick={() => void useAuto()}
                  >
                    Use auto-detected path
                  </SecondaryButton>
                ) : null}
                <SecondaryButton type="submit" disabled={working}>
                  Save path
                </SecondaryButton>
              </div>
            </form>
          ) : (
            <>
              <div className="mt-2 rounded-md border border-content/10 bg-content/[0.03] px-2.5 py-2">
                <span className="block max-h-12 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] text-content/65">
                  {inspection?.path ??
                    (error
                      ? "CLI could not be resolved"
                      : "Checking the selected CLI…")}
                </span>
                <span className="mt-1 block max-h-10 overflow-y-auto whitespace-pre-wrap break-words text-[10px] text-content/40">
                  {inspection?.version ??
                    (error ? "Retry to check this CLI" : "Checking version…")}
                </span>
              </div>
              {error ? (
                <span
                  role="alert"
                  title={error}
                  className="mt-1.5 block max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-red-400"
                >
                  {error}
                </span>
              ) : null}
              {revealError ? (
                <span
                  role="alert"
                  className="mt-1.5 block max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-red-400"
                >
                  Could not open the CLI location: {revealError}
                </span>
              ) : null}
              <div className="mt-3 flex justify-end gap-2">
                {error ? (
                  <SecondaryButton
                    disabled={working}
                    aria-label={`Retry ${title} ${
                      overridden ? "configured path" : "auto-detect"
                    }`}
                    onClick={() =>
                      void inspect(overridden ? draft.trim() || null : null)
                    }
                  >
                    <RefreshCw className="size-3.5" strokeWidth={1.75} />
                    {overridden ? "Retry configured path" : "Retry auto-detect"}
                  </SecondaryButton>
                ) : null}
                <SecondaryButton
                  aria-label={`Open ${title} CLI location`}
                  disabled={!inspection}
                  onClick={() => {
                    if (inspection) {
                      void revealPath(inspection.path).catch((cause) => {
                        setRevealError(
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                        );
                      });
                    }
                  }}
                >
                  <ExternalLink className="size-3.5" strokeWidth={1.75} />
                  Open location
                </SecondaryButton>
                <SecondaryButton
                  aria-label={`Edit ${title} CLI path`}
                  disabled={working}
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3.5" strokeWidth={1.75} />
                  Edit path
                </SecondaryButton>
              </div>
            </>
          )}
        </Popover>
      ) : null}
    </span>
  );
}

function ProvidersPage({
  cwd,
  recents,
}: {
  cwd?: string;
  recents?: RecentProject[];
}) {
  useSyncExternalStore(subscribeModels, getModelSnapshot, getModelSnapshot);
  useSyncExternalStore(
    subscribeHarnessAvailability,
    getHarnessAvailabilitySnapshot,
    getHarnessAvailabilitySnapshot,
  );
  const providersRevision = useSyncExternalStore(
    subscribeProjectProviders,
    projectProvidersRevision,
    projectProvidersRevision,
  );
  void providersRevision;
  const [choice, setChoice] = useState(loadLastModelChoice);
  const [defaultModels, setDefaultModels] = useState(loadDefaultModels);
  const [claudeHooks, setClaudeHooks] = useState(loadClaudeHooks);
  const [contextCeiling, setContextCeiling] = useState(loadContextCeilingChoice);
  const [idleCompact, setIdleCompact] = useState(loadIdleCompact);
  const [idleAgentLimit, setIdleAgentLimit] =
    useState<IdleAgentLimit>(loadIdleAgentLimit);
  const [scope, setScope] = useState<string>(GLOBAL_PROVIDER_SCOPE);
  const [hiddenGlobally, setHiddenGlobally] = useState(
    loadHiddenPickerProviders,
  );

  const scopeOptions = useMemo(() => {
    const options: { value: string; label: string; icon?: ReactNode }[] = [
      {
        value: GLOBAL_PROVIDER_SCOPE,
        label: "Global",
        icon: (
          <Globe
            className="size-3.5 shrink-0 text-content/60"
            strokeWidth={1.75}
          />
        ),
      },
    ];
    const seen = new Set<string>();
    for (const path of [cwd, ...(recents ?? []).map((entry) => entry.path)]) {
      if (!path || !looksLikeProject(path)) continue;
      const key = pathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        value: path,
        label: projectName(path),
        icon: <ProjectScopeIcon path={path} />,
      });
    }
    return options;
  }, [cwd, recents]);

  const project = scope === GLOBAL_PROVIDER_SCOPE ? null : scope;
  const projectSettings = project ? loadProjectProviderSettings(project) : {};
  // A project without overrides inherits the global default provider, the same
  // way `defaultSessionChoice` resolves it for new conversations.
  const effectiveDefaultHarness = project
    ? firstEnabledHarness(
        project,
        projectSettings.defaultHarness ?? choice?.harness ?? "cursor",
      )
    : (choice?.harness ?? null);

  useEffect(() => {
    void probeHarnessAvailability();
  }, []);

  useEffect(() => {
    if (!scopeOptions.some((option) => option.value === scope)) {
      setScope(GLOBAL_PROVIDER_SCOPE);
    }
  }, [scope, scopeOptions]);

  const onClaudeHooks = (next: boolean) => {
    saveClaudeHooks(next);
    setClaudeHooks(next);
  };

  const onContextCeiling = (next: string) => {
    const choice: ContextCeilingChoice =
      next === "model" || next === "off" ? next : Number(next);
    saveContextCeilingChoice(choice);
    setContextCeiling(choice);
  };

  const onIdleCompact = (next: boolean) => {
    saveIdleCompact(next);
    setIdleCompact(next);
  };

  const onIdleAgentLimit = (next: string) => {
    const limit = Number(next) as IdleAgentLimit;
    saveIdleAgentLimit(limit);
    setIdleAgentLimit(limit);
    // A lower limit takes effect now, not at the next finished turn.
    enforceHarnessIdleLimit();
  };

  const onModelChange = (harness: HarnessId, model: string) => {
    if (project) {
      setProjectDefaultModel(project, harness, model);
      return;
    }
    saveDefaultModel(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    if (choice?.harness === harness) {
      saveLastModelChoice(harness, model);
      setChoice({ harness, model });
    }
  };

  const onDefault = (harness: HarnessId, model: string) => {
    if (project) {
      setProjectDefaultProvider(project, harness, model);
      return;
    }
    saveLastModelChoice(harness, model);
    setDefaultModels((prev) => ({ ...prev, [harness]: model }));
    setChoice({ harness, model });
  };

  const onPickerVisible = (harness: HarnessId, visible: boolean) => {
    if (project) {
      setProjectProviderHidden(project, harness, !visible);
      return;
    }
    savePickerProviderVisible(harness, visible);
    setHiddenGlobally((prev) =>
      visible
        ? prev.filter((id) => id !== harness)
        : [...new Set([...prev, harness])],
    );
  };

  return (
    <>
      <ProviderAccountsSettings />

      <UsageDisplaySettings />

      <Group
        id="agent-clis"
        title="Agent CLIs"
        action={
          <Select
            label="Provider defaults scope"
            value={scope}
            options={scopeOptions}
            onChange={setScope}
          />
        }
        description={
          project
            ? `These defaults apply to ${projectName(project)} only. A provider with Show in picker off is also kept out of new conversations started in this project. CLI paths remain global for MonoCode.`
            : "A provider is listed as installed once its CLI is found on your PATH. Uninstalled CLIs stay listed but are left out of the model picker, as are installed ones with Show in picker off. The model beside a provider is what its new conversations start with; Use by default picks the provider itself. CLI paths are global for MonoCode and apply to every project."
        }
      >
        {HARNESSES.map((harness) => {
          const inPicker = project
            ? !(projectSettings.hidden ?? []).includes(harness) &&
              !hiddenGlobally.includes(harness)
            : !hiddenGlobally.includes(harness);
          // A globally hidden provider stays out of every project's picker, so
          // the project toggle is shown locked rather than appearing to work.
          const pickerLocked =
            project != null && hiddenGlobally.includes(harness);
          const selectedModel = project
            ? (projectSettings.models?.[harness] ??
              (projectSettings.defaultHarness === harness
                ? projectSettings.defaultModel
                : undefined) ??
              defaultModels[harness] ??
              (choice?.harness === harness
                ? choice.model
                : defaultModelId(harness)))
            : (defaultModels[harness] ??
              (choice?.harness === harness
                ? choice.model
                : defaultModelId(harness)));
          const isDefault = project
            ? effectiveDefaultHarness === harness
            : choice?.harness === harness;
          return (
            <ProviderRow
              key={harness}
              harness={harness}
              selectedModel={selectedModel}
              isDefault={isDefault}
              inPicker={inPicker}
              pickerLocked={pickerLocked}
              onDefault={onDefault}
              onModelChange={onModelChange}
              onPickerVisible={(visible) => onPickerVisible(harness, visible)}
            />
          );
        })}
      </Group>

      {/* WP-134b: More agents, off until the person switches it on. */}
      <MoreAgentsSettings cwd={cwd} />

      <Group title="Advanced">
        <Row
          id="idle-agents"
          label="Keep idle agents ready"
          description="A finished conversation keeps its agent CLI running for a few minutes, so a follow-up starts instantly. Each one can hold a few hundred MB of memory. Past this many, the one idle longest stops early; it resumes on your next message after a short restart. Choose None on a machine short on memory."
        >
          <Segmented
            label="Keep idle agents ready"
            value={String(idleAgentLimit)}
            options={IDLE_AGENT_LIMITS.map((limit) => ({
              value: String(limit),
              label: limit === 0 ? "None" : String(limit),
            }))}
            onChange={onIdleAgentLimit}
          />
        </Row>
        <Row
          id="claude-hooks"
          label="Claude Code hooks"
          description="Run the hooks configured in your settings.json files — PreToolUse command rewrites, blocks, notifications, and the rest — just as the Claude Code CLI would. Turn this off if a hook is misbehaving and you need the session back. Takes effect on the next turn."
        >
          <Toggle
            label="Claude Code hooks"
            on={claudeHooks}
            onChange={onClaudeHooks}
          />
        </Row>
        <Row
          id="context-ceiling"
          label="Compact long chats at"
          description={`Every turn resends the whole conversation, so a Lead that runs for days and only compacts near a 1M window spends most of the usage limit re-reading itself. Claude Code compacts at this size instead (or at the model's window, if that is smaller). Model default: ${MODEL_CONTEXT_CEILINGS.map((entry) => `${entry.family} ${formatTokens(entry.tokens)}`).join(", ")}, others ${formatTokens(DEFAULT_CONTEXT_CEILING)}. Monos start their fresh session a little before it. Applies to running chats without a restart.`}
        >
          <Select
            label="Compact long chats at"
            value={String(contextCeiling)}
            options={CONTEXT_CEILING_CHOICES.map((choice) => ({
              value: String(choice),
              label:
                choice === "model"
                  ? "Model default"
                  : choice === "off"
                    ? "Claude Code default"
                    : formatTokens(choice),
            }))}
            onChange={onContextCeiling}
          />
        </Row>
        <Row
          id="idle-compact"
          label="Compact idle chats first"
          description="A chat that sat idle longer than its prompt cache lives (an hour on most plans) would have its whole context cached again, at full price, by your next message. When it is over 100K tokens, Claude Code compacts it first, and the chat says so."
        >
          <Toggle
            label="Compact idle chats first"
            on={idleCompact}
            onChange={onIdleCompact}
          />
        </Row>
      </Group>
    </>
  );
}

function UsageDisplaySettings() {
  const showRemainingUsage = useShowRemainingUsage();
  const maskEmails = useMaskEmails();
  return (
    <Group title="Usage and privacy">
      <Row
        id="show-remaining-usage"
        label="Show remaining usage"
        description="Fill usage meters with what is left in each limit instead of what has been used."
      >
        <Toggle
          label="Show remaining usage"
          on={showRemainingUsage}
          onChange={saveShowRemainingUsage}
        />
      </Row>
      <Row
        id="mask-emails"
        label="Mask account emails"
        description="Blur account emails in Settings and the usage popover until you click one, so they stay out of screenshots."
      >
        <Toggle
          label="Mask account emails"
          on={maskEmails}
          onChange={saveMaskEmails}
        />
      </Row>
    </Group>
  );
}

type AccountEditor = {
  provider: ProviderAccountProvider;
  accountId?: string;
  label: string;
};

function ProviderAccountsSettings() {
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<AccountEditor | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => subscribeProviderAccounts(() => setVersion((value) => value + 1)),
    [],
  );

  const startAdd = (provider: ProviderAccountProvider) => {
    setError(null);
    setEditor({ provider, label: "" });
  };

  const startRename = (account: ProviderAccount) => {
    setError(null);
    setEditor({
      provider: account.provider,
      accountId: account.id,
      label: account.label,
    });
  };

  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !editor.label.trim() || working) return;
    const key = editor.accountId
      ? `rename:${editor.provider}:${editor.accountId}`
      : `add:${editor.provider}`;
    setWorking(key);
    setError(null);
    try {
      if (editor.accountId) {
        renameProviderAccount(editor.provider, editor.accountId, editor.label);
      } else {
        const account = newProviderAccount(editor.provider, editor.label);
        await loginHarness(editor.provider, account.id);
        saveProviderAccount(account);
      }
      setEditor(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save this account",
      );
    } finally {
      setWorking(null);
    }
  };

  const removeAccount = async (account: ProviderAccount) => {
    if (account.isDefault || working) return;
    const confirmed = await ask(
      `Remove “${account.label}”? Its stored credentials will be deleted and any running turns for this account will stop. Existing conversations stay in history, but cannot continue until you switch accounts.`,
      {
        title: `Remove ${HARNESS_TITLE[account.provider]} account`,
        kind: "warning",
        okLabel: "Remove account",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;
    const key = `remove:${account.provider}:${account.id}`;
    setWorking(key);
    setError(null);
    try {
      await removeProviderAccountCredentials(account.provider, account.id);
      removeProviderAccount(account.provider, account.id);
      clearCachedRateLimits(account.provider, account.id);
      if (
        editor?.provider === account.provider &&
        editor.accountId === account.id
      ) {
        setEditor(null);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not remove this account",
      );
    } finally {
      setWorking(null);
    }
  };

  const identities = useProviderAccountIdentities(
    PROVIDER_ACCOUNT_PROVIDERS.flatMap(providerAccounts),
    version,
  );
  const usage = useProviderAccountUsage(version);

  return (
    <Group
      id="provider-accounts"
      title="Accounts"
      description="Add more than one account where the provider allows it. Each is its own sign-in, which you finish in your browser; the app never sees the password or token. Set the order they're used in, and a chat moves to the next one when an account runs out."
      action={<AccountUsageRefresh usage={usage} />}
    >
      {PROVIDER_ACCOUNT_PROVIDERS.map((provider) => {
        const accounts = orderedAccounts(provider);
        const adding = editor?.provider === provider && !editor.accountId;
        const signIn = signInOptions(provider)[0];
        return (
          <div
            key={provider}
            className="border-b border-content/5 last:border-b-0"
          >
            <div className="flex items-center gap-4 px-4 py-3.5">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-content/[0.05] ring-1 ring-inset ring-content/[0.06]">
                  <HarnessIcon harness={provider} className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-content">
                    {HARNESS_TITLE[provider]}
                  </div>
                  <div className="mt-0.5 text-[11px] text-content/40">
                    {accounts.length}{" "}
                    {accounts.length === 1 ? "account" : "accounts"}
                    {signIn ? ` · ${signIn.label}` : ""}
                  </div>
                  {signIn?.note && !supportsAccountProfiles(provider) ? (
                    <div className="mt-0.5 text-[10px] text-content/35">{signIn.note}</div>
                  ) : null}
                </div>
              </div>
              {supportsAccountProfiles(provider) ? (
                <button
                  type="button"
                  disabled={Boolean(working)}
                  onClick={() => startAdd(provider)}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1 text-[12px] text-content/70 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.97] disabled:cursor-default disabled:opacity-40"
                >
                  <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
                  Add account
                </button>
              ) : null}
            </div>
            <AccountWaterfallSwitch provider={provider} count={accounts.length} />
            <div className="border-t border-content/5 bg-content/[0.015] pl-10">
              {accounts.map((account, index) => {
                const editing =
                  editor?.provider === provider &&
                  editor.accountId === account.id;
                const removing = working === `remove:${provider}:${account.id}`;
                const identity = identities[identityKey(account)];
                const orgTag = identityOrganizationTag(identity);
                const limits = usage.usage[accountUsageKey(account)];
                return editing ? (
                  <ProviderAccountEditor
                    key={account.id}
                    editor={editor}
                    working={Boolean(working)}
                    onLabel={(label) =>
                      setEditor((current) =>
                        current ? { ...current, label } : current,
                      )
                    }
                    onCancel={() => setEditor(null)}
                    onSubmit={submitEditor}
                  />
                ) : (
                  <div
                    key={account.id}
                    className="flex h-12 items-center gap-3 border-b border-content/5 px-4 py-2 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[12px] text-content/85">
                          {account.label}
                        </span>
                        {orgTag ? (
                          <span className="max-w-[8rem] shrink-0 truncate rounded bg-content/[0.07] px-1 text-[9px] leading-4 text-content/50">
                            {orgTag}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2.5 text-[10px]">
                        <AccountStatusLabel
                          status={accountStatus(limits, usage.now)}
                          className="shrink-0"
                        />
                        <ProviderAccountSubtitle
                          identity={identity}
                          fallback={
                            account.isDefault
                              ? "Provider CLI profile"
                              : "Isolated profile"
                          }
                          className="truncate text-content/30"
                        />
                      </div>
                    </div>
                    <AccountUsageMeters limits={limits} now={usage.now} />
                    <AccountOrderControls
                      account={account}
                      index={index}
                      count={accounts.length}
                      now={usage.now}
                      usageFor={(entry) => usage.usage[accountUsageKey(entry)]}
                      disabled={Boolean(working)}
                    />
                    <div className="flex w-24 shrink-0 items-center justify-end gap-1">
                      {account.isDefault ? (
                        <span className="mr-1 text-[10px] font-medium uppercase tracking-wide text-content/30">
                          Default
                        </span>
                      ) : null}
                      <button
                        type="button"
                        disabled={Boolean(working)}
                        aria-label={`Rename ${account.label}`}
                        title="Rename account"
                        onClick={() => startRename(account)}
                        className="grid size-7 place-items-center rounded-md text-content/40 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.96] disabled:opacity-35"
                      >
                        <Pencil className="size-3.5" strokeWidth={1.75} />
                      </button>
                      {!account.isDefault ? (
                        <button
                          type="button"
                          disabled={Boolean(working)}
                          aria-label={`Remove ${account.label}`}
                          title="Remove account"
                          onClick={() => void removeAccount(account)}
                          className="grid size-7 place-items-center rounded-md text-content/35 transition-transform duration-150 hover:bg-red-400/10 hover:text-red-400 active:scale-[0.96] disabled:opacity-35"
                        >
                          {removing ? (
                            <Loader className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" strokeWidth={1.75} />
                          )}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {adding && editor ? (
                <ProviderAccountEditor
                  editor={editor}
                  working={Boolean(working)}
                  onLabel={(label) =>
                    setEditor((current) =>
                      current ? { ...current, label } : current,
                    )
                  }
                  onCancel={() => setEditor(null)}
                  onSubmit={submitEditor}
                />
              ) : null}
            </div>
          </div>
        );
      })}
      {error ? (
        <p
          className="border-t border-content/5 px-4 py-2.5 text-[11px] leading-4 text-red-400"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </Group>
  );
}

function ProviderAccountEditor({
  editor,
  working,
  onLabel,
  onCancel,
  onSubmit,
}: {
  editor: AccountEditor;
  working: boolean;
  onLabel: (label: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const adding = !editor.accountId;
  return (
    <form
      className="flex h-12 items-center border-b border-content/5 px-4 py-2 last:border-b-0"
      onSubmit={onSubmit}
    >
      <div
        data-provider-account-editor-field
        className="flex items-center pr-1 h-8 min-w-0 flex-1 overflow-hidden rounded-md border border-content/10 bg-content/[0.04] focus-within:border-accent/45"
      >
        <label className="h-full min-w-0 flex-1">
          <span className="sr-only">Account name</span>
          <input
            autoFocus
            type="text"
            maxLength={48}
            value={editor.label}
            disabled={working}
            placeholder="Work or Personal"
            aria-label={`${adding ? "New" : "Rename"} ${HARNESS_TITLE[editor.provider]} account`}
            onChange={(event) => onLabel(event.target.value)}
            className="h-full w-full bg-transparent px-2.5 text-[12px] text-content outline-none placeholder:text-content/25 disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          disabled={working}
          onClick={onCancel}
          className="flex h-6 shrink-0 items-center rounded-[4.5px] bg-content/[0.05] px-2.5 text-[11px] text-content/45 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.97] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={working || !editor.label.trim()}
          className="ml-1 flex h-6 shrink-0 items-center gap-1.5 rounded-[4.5px] bg-content px-2.5 text-[11px] font-medium text-background-base transition-transform duration-150 hover:bg-content/85 active:scale-[0.97] disabled:cursor-default disabled:opacity-40"
        >
          {working ? <Loader className="size-3 animate-spin" /> : null}
          {adding
            ? working
              ? "Waiting for browser…"
              : "Sign in and add"
            : "Save"}
        </button>
      </div>
    </form>
  );
}

/** The icon the project rail shows: custom logo, else the project mascot. */
function ProjectScopeIcon({ path }: { path: string }) {
  const logos = useTabGroupLogos();
  const [colors] = useState(loadTabGroupColors);
  const [customColors] = useState(loadTabGroupCustomColors);
  const [mascots] = useState(loadTabGroupMascots);
  const key = projectKey(path);
  const name = projectName(path);
  const logoPath = resolveTabGroupLogo(key, logos);
  if (logoPath) {
    return (
      <ProjectLogoIcon
        path={logoPath}
        className="size-4 rounded-sm"
        imageClassName="size-4"
      />
    );
  }
  return (
    <ProjectMascot
      project={name}
      color={resolveTabGroupColor(key, colors, customColors, name)}
      name={resolveTabGroupMascot(key, mascots)}
      className="size-3.5"
    />
  );
}

function ProviderRow({
  harness,
  selectedModel,
  isDefault,
  inPicker,
  pickerLocked = false,
  onDefault,
  onModelChange,
  onPickerVisible,
}: {
  harness: HarnessId;
  selectedModel: string;
  isDefault: boolean;
  inPicker: boolean;
  /** Globally hidden providers cannot be turned on per project. */
  pickerLocked?: boolean;
  onDefault: (harness: HarnessId, model: string) => void;
  onModelChange: (harness: HarnessId, model: string) => void;
  onPickerVisible: (visible: boolean) => void;
}) {
  const models = modelsFor(harness);
  const available = isHarnessAvailable(harness);
  const current =
    models.length > 0 ? resolveModel(harness, selectedModel) : null;
  const install = useAgentInstall(harness);
  const installing = install?.status === "running";
  const installPage = agentInstallPage(harness);

  useEffect(() => {
    if (!available || hasLiveCatalog(harness)) return;
    void refreshHarnessCatalogs([harness]);
  }, [available, harness]);

  return (
    <Row
      label={
        <span className="flex items-center gap-2">
          <HarnessIcon harness={harness} className="size-4 shrink-0" />
          {HARNESS_TITLE[harness]}
          <ProviderBinaryControl provider={harness} />
          {isDefault ? (
            <span className="rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-content/60">
              Default
            </span>
          ) : null}
        </span>
      }
      description={
        available
          ? `${models.length} ${models.length === 1 ? "model" : "models"} available.`
          : harnessUnavailableHint(harness)
      }
      below={install ? <AgentInstallLog harness={harness} state={install} /> : undefined}
    >
      {!available && canInstallAgent(harness) ? (
        installing ? (
          <SecondaryButton
            data-agent-install-cancel={harness}
            onClick={() => cancelAgentInstall(harness)}
          >
            Cancel
          </SecondaryButton>
        ) : (
          <SecondaryButton
            data-agent-install={harness}
            onClick={() => void installAgent(harness)}
          >
            {install?.status === "failed" || install?.status === "cancelled"
              ? "Try again"
              : "Install"}
          </SecondaryButton>
        )
      ) : null}
      {!available && installPage ? (
        <SecondaryButton
          data-agent-install-page={harness}
          onClick={() => void openUrl(installPage).catch(() => undefined)}
        >
          Open install page
        </SecondaryButton>
      ) : null}
      {current ? (
        <Select
          label={`${HARNESS_TITLE[harness]} model`}
          value={current.id}
          onChange={(next) => onModelChange(harness, next)}
          onOpen={() => {
            // Opening the dropdown is an explicit refresh: fallbacks keep
            // `models` non-empty, and routine refreshes skip once a live
            // catalog exists, so force this one past that skip.
            if (available) {
              void refreshHarnessCatalogs([harness], { force: true });
            }
          }}
          options={models.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
        />
      ) : null}
      <SecondaryButton
        onClick={() => current && onDefault(harness, current.id)}
        disabled={isDefault || !current}
      >
        {isDefault ? "Default" : "Use by default"}
      </SecondaryButton>
      {available ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-content/50">
            {pickerLocked ? "Hidden globally" : "Show in picker"}
          </span>
          <Toggle
            label={`Show ${HARNESS_TITLE[harness]} in the model picker`}
            on={inPicker}
            onChange={onPickerVisible}
            disabled={pickerLocked}
          />
        </div>
      ) : null}
    </Row>
  );
}

/** An install's last lines while it runs, then how it ended and how to sign in. */
function AgentInstallLog({
  harness,
  state,
}: {
  harness: HarnessId;
  state: AgentInstallState;
}) {
  const signIn = agentSignIn(harness);
  const [copied, setCopied] = useState(false);
  const showLines = state.status !== "installed" && state.lines.length > 0;
  return (
    <div data-agent-install-log={harness} className="space-y-2">
      {showLines ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-content/[0.04] px-3 py-2 font-mono text-[11px] leading-4 text-content/70 ring-1 ring-inset ring-content/[0.06]">
          {state.lines.join("\n")}
        </pre>
      ) : null}
      {state.status === "running" ? (
        <p className="text-[12px] text-content/60">Installing…</p>
      ) : state.status === "installed" ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-content/60">
          <span className="text-content">Installed.</span>
          {signIn ? (
            <>
              <span>To sign in, run</span>
              <code className="rounded bg-content/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-content/80">
                {signIn.command}
              </code>
              <span>in a terminal{signIn.then ? `, ${signIn.then}` : ""}.</span>
              <SecondaryButton
                data-agent-signin-copy={harness}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(signIn.command)
                    .then(() => setCopied(true))
                    .catch(() => undefined);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </SecondaryButton>
            </>
          ) : null}
        </div>
      ) : state.status === "cancelled" ? (
        <p className="text-[12px] text-content/60">Install cancelled.</p>
      ) : (
        <p className="text-[12px] text-content/60">
          {state.error ?? "The install didn't finish."}
        </p>
      )}
    </div>
  );
}

function useArchivedProjects(): ArchivedProject[] {
  const [items, setItems] = useState(loadArchivedProjects);
  useEffect(
    () => subscribeArchivedProjects(() => setItems(loadArchivedProjects())),
    [],
  );
  return items;
}

function archivedProjectLabel(path: string): string {
  return resolveTabGroupLabel(
    projectKey(path),
    loadTabGroupLabels(),
    projectName(path),
  );
}

function ArchivePage({
  cwd,
  sessions,
  onOpenSession,
  onArchiveSession,
  onDeleteSession,
  onRestoreProject,
  onDeleteProject,
}: {
  cwd: string;
  sessions: SessionSummary[];
  onOpenSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onDeleteSession: (sessionId: string) => void;
  onRestoreProject?: (path: string) => void;
  onDeleteProject?: (path: string) => void;
}) {
  const [filters, setFilters] = useState(loadSessionSidebarFilters);
  const [deleting, setDeleting] = useState<ArchivedProject | null>(null);
  const archivedProjects = useArchivedProjects();
  const archived = useMemo(
    () =>
      sessions
        .filter((session) => session.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  const onShowArchived = (showArchived: boolean) => {
    const next = { ...filters, showArchived };
    saveSessionSidebarFilters(next);
    setFilters(next);
  };

  return (
    <>
      <Group
        title="Archived projects"
        description="Archive a project from the rail to keep its chats without listing it in the sidebar."
      >
        {archivedProjects.length === 0 ? (
          <p className="px-4 py-3.5 text-[12px] text-content/45">
            No archived projects.
          </p>
        ) : (
          archivedProjects.map((project) => (
            <div
              key={project.path}
              className="flex items-center gap-3 border-b border-content/5 px-4 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {archivedProjectLabel(project.path)}
                </div>
                <div className="truncate text-[11px] text-content/40">
                  {prettyCwd(project.path)}
                </div>
              </div>
              {onRestoreProject ? (
                <SecondaryButton onClick={() => onRestoreProject(project.path)}>
                  Restore
                </SecondaryButton>
              ) : null}
              {onDeleteProject ? (
                <SecondaryButton danger onClick={() => setDeleting(project)}>
                  Delete
                </SecondaryButton>
              ) : null}
            </div>
          ))
        )}
      </Group>

      <Group
        title={
          looksLikeProject(cwd)
            ? `Archived in ${projectName(cwd)}`
            : "Archived conversations"
        }
      >
        <Row
          id="show-archived"
          label="Show archived in the sidebar"
          description="Keep archived conversations listed alongside the active ones."
        >
          <Toggle
            label="Show archived in the sidebar"
            on={filters.showArchived}
            onChange={onShowArchived}
          />
        </Row>
        {!looksLikeProject(cwd) ? (
          <p className="px-4 py-3.5 text-[12px] text-content/45">
            Open a project to see its archived conversations.
          </p>
        ) : archived.length === 0 ? (
          <p className="px-4 py-3.5 text-[12px] text-content/45">
            No archived conversations in this project.
          </p>
        ) : (
          archived.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-3 border-b border-content/5 px-4 py-2.5 last:border-b-0"
            >
              <HarnessIcon
                harness={session.harness}
                className="size-3.5 shrink-0"
              />
              <button
                type="button"
                onClick={() => onOpenSession(session.id)}
                className="min-w-0 flex-1 truncate text-left text-[13px] hover:text-content"
              >
                {sessionDisplayTitle(session.title, session.harness)}
              </button>
              <span className="shrink-0 text-[11px] text-content/35 tabular-nums">
                {formatDate(session.updatedAt)}
              </span>
              <SecondaryButton
                onClick={() => onArchiveSession(session.id, false)}
              >
                Unarchive
              </SecondaryButton>
              <SecondaryButton
                danger
                onClick={() => onDeleteSession(session.id)}
              >
                Delete
              </SecondaryButton>
            </div>
          ))
        )}
      </Group>

      {deleting ? (
        <RemoveProjectDialog
          name={archivedProjectLabel(deleting.path)}
          path={deleting.path}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDeleteProject?.(deleting.path);
            setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

/** Monos on or off, and each Mono the user has. */
function MonosPage() {
  const enabled = useSyncExternalStore(
    subscribeMonosEnabled,
    loadMonosEnabled,
    () => true,
  );
  const menuBarIcon = useSyncExternalStore(
    subscribeMonoMenuBarIcon,
    loadMonoMenuBarIcon,
    () => true,
  );
  const railPinned = useRailMonosPinned();
  const snapshot = useSyncExternalStore(subscribeMonos, monosSnapshot);
  const monos = useMemo(() => listMonos(), [snapshot]);

  return (
    <>
      <Group
        id="mono-list"
        title="Your first mates"
        description="Click a name to change it. The Chief of Staff can be renamed too. Add a first mate with the plus next to First mates in a project's sidebar."
      >
        {monos.length ? (
          monos.map((mono) => <MonoRow key={mono.id} mono={mono} />)
        ) : (
          <p className="px-4 py-3.5 text-[12px] text-content/45">
            No first mates yet.
          </p>
        )}
      </Group>
      <Group title="In the sidebar">
        <Row
          id="monos-enabled"
          label="Show first mates"
          description="Your Chief of Staff and first mates in the sidebar. Each works on the projects you give it and remembers what matters. Turn this off to hide them."
        >
          <Toggle label="Show first mates" on={enabled} onChange={saveMonosEnabled} />
        </Row>
        <Row
          id="rail-monos-pinned"
          label="Pin first mates to the icon rail"
          description="When the sidebar is collapsed to icons, show each first mate at the top of it instead of inside the project picker."
        >
          <Toggle
            label="Pin first mates to the icon rail"
            on={railPinned}
            onChange={saveRailMonosPinned}
            disabled={!enabled}
          />
        </Row>
        {IS_MAC && (
          <Row
            id="mono-menu-bar-icon"
            label="Menu bar icon"
            description="Chat with a first mate or open the quick composer from the macOS menu bar. Turn this off to hide the icon."
          >
            <Toggle
              label="Menu bar icon"
              on={menuBarIcon}
              onChange={saveMonoMenuBarIcon}
            />
          </Row>
        )}
      </Group>
    </>
  );
}

function MonoRow({ mono }: { mono: Mono }) {
  const look = monoLook(mono);
  // Rename where it is listed (Ash, 11 Nov: "somewhere to go and rename your chief of staff").
  const [renaming, setRenaming] = useState(false);
  const cancelled = useRef(false);
  return (
    <Row
      label={
        <span className="flex min-w-0 items-center gap-2" data-settings-mono={mono.id}>
          <PixelMascot
            name={look.mascot}
            color={look.color}
            still
            className="size-4 shrink-0"
          />
          {renaming ? (
            <input
              autoFocus
              data-settings-mono-name-input
              aria-label={`Name for ${look.name}`}
              maxLength={40}
              defaultValue={look.name}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={(event) => {
                const name = event.currentTarget.value.trim();
                if (!cancelled.current && name && name !== look.name) saveMonoName(mono.id, name);
                cancelled.current = false;
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelled.current = true;
                  event.currentTarget.blur();
                }
              }}
              className="h-6 w-[220px] min-w-0 rounded bg-content/8 px-1.5 text-[13px] text-content outline-none ring-1 ring-content/25"
            />
          ) : (
            <button
              type="button"
              data-settings-mono-rename
              title="Rename"
              aria-label={`Rename ${look.name}`}
              onClick={() => setRenaming(true)}
              className="group/name -mx-1 flex min-w-0 items-center gap-1.5 rounded px-1 hover:bg-content/8"
            >
              <span className="truncate">{look.name}</span>
              <Pencil className="size-3 shrink-0 text-content/40 group-hover/name:text-content" strokeWidth={1.75} />
            </button>
          )}
          {mono.captain && look.name !== "Chief of Staff" ? <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[11px] text-content/60">Chief of Staff</span> : null}
        </span>
      }
      description={
        mono.captain
          ? "Runs things for you across every project"
          : look.projects.length
            ? `Works on ${monoProjectsPhrase(look.projects)}`
            : "No projects yet"
      }
    >
      <span className="text-[12px] leading-5 text-content/50">
        Show the chats it starts in the sidebar
      </span>
      <Toggle
        label={`Show sessions started by ${look.name} in sidebar`}
        on={mono.showStartedSessionsInSidebar === true}
        onChange={(on) =>
          updateMono(mono.id, (entry) => ({
            ...entry,
            showStartedSessionsInSidebar: on,
          }))
        }
      />
      <ConfirmReset
        label="Reset first mate"
        title={`Reset ${look.name} to its defaults?`}
        body={`Its soul goes back to the default and its name to ${defaultMonoName(look.mascot)}. Changes to its soul can't be recovered.`}
        kept="Its conversation, projects, memory and habits will be kept."
        failure="Could not reset this first mate."
        onConfirm={() => resetMonoDefaults(mono.id)}
      >
        {(open, ref) => (
          <button
            ref={ref}
            type="button"
            title="Reset to defaults"
            aria-label={`Reset ${look.name} to defaults`}
            onClick={open}
            className="grid size-7 place-items-center rounded-md text-content/40 transition-transform duration-150 hover:bg-content/10 hover:text-content active:scale-[0.96]"
          >
            <RotateCcw className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
      </ConfirmReset>
    </Row>
  );
}

function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="pb-4">
      <h1 className="text-[20px] font-semibold leading-tight text-content">
        {title}
      </h1>
      {description ? (
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content/45">
          {description}
        </p>
      ) : null}
    </header>
  );
}

/**
 * A titled card of related settings. Everything on a page lives in one, so a
 * page reads as a handful of topics instead of one long list of switches.
 */
function Group({
  id,
  title,
  description,
  action,
  children,
}: {
  /** Matches a `SETTINGS_INDEX` id when the whole card is the search target. */
  id?: string;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const revealed = useContext(RevealedSetting);
  const flash = id != null && revealed === id;

  return (
    <section
      id={id ? settingDomId(id) : undefined}
      data-setting-id={id}
      className="pt-8 first:pt-0"
    >
      <div className="flex items-end gap-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-content">{title}</h2>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0 pb-0.5">{action}</div> : null}
      </div>
      <div
        className={`overflow-hidden rounded-xl border bg-content/3 transition-colors ${
          flash ? "border-accent/60" : "border-content/10"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

function Row({
  id,
  label,
  description,
  children,
  below,
}: {
  /** Matches a `SETTINGS_INDEX` id so search can scroll here. */
  id?: string;
  label: ReactNode;
  description?: string;
  children?: ReactNode;
  /** Full-width content under the row (an install's log). */
  below?: ReactNode;
}) {
  const revealed = useContext(RevealedSetting);
  const flash = id != null && revealed === id;

  const row = (
    <div
      id={id ? settingDomId(id) : undefined}
      data-setting-id={id}
      className={`settings-row flex items-start gap-6 px-4 py-3.5 transition-colors ${
        below ? "" : "border-b border-content/5 last:border-b-0"
      } ${flash ? "bg-accent/10" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            {description}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
  if (!below) return row;
  return (
    <div className="border-b border-content/5 last:border-b-0">
      {row}
      <div className="px-4 pb-3.5">{below}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  optionIdPrefix,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  optionIdPrefix?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-grid max-w-full shrink-0 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => (
        <button
          id={
            optionIdPrefix
              ? `${optionIdPrefix}-${option.value.toLowerCase()}`
              : undefined
          }
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 rounded-[5px] px-2.5 py-1 ${
            value === option.value
              ? "bg-selection text-content"
              : "text-content/50 hover:text-content"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
  held = false,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Showing a previewed theme's value: readable, not draggable until the preview is applied or stopped. */
  held?: boolean;
}) {
  return (
    <div
      className={`flex w-56 max-w-full items-center gap-3 ${disabled ? "opacity-40" : ""}`}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        disabled={disabled || held}
        className="sidebar-opacity-slider min-w-0 flex-1 disabled:cursor-not-allowed"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 shrink-0 text-right text-[12px] text-content tabular-nums">
        {display}
      </span>
    </div>
  );
}

/** The shell, the card inside it and the accent, at the size of a menu icon. */
function WorkspaceThemeSwatch({ palette }: { palette: WorkspacePalette }) {
  return (
    <span
      aria-hidden
      className="relative block size-4 overflow-hidden rounded-[4px] border border-content/15"
      style={{ background: palette.surface }}
    >
      <span
        className="absolute inset-y-[3px] right-0 left-[5px] rounded-l-[2px]"
        style={{ background: palette.panelSolid }}
      />
      <span
        className="absolute top-[6px] left-[8px] size-[5px] rounded-full"
        style={{ background: palette.accent }}
      />
    </span>
  );
}

const ACCENT_COLOR_PRESETS = [
  "#4da3f5",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f59e0b",
  "#10b981",
] as const;

function AccentColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const colorIndex = value
    ? ACCENT_COLOR_PRESETS.indexOf(
        value as (typeof ACCENT_COLOR_PRESETS)[number],
      )
    : -1;
  const presetIndex = value == null ? 0 : colorIndex >= 0 ? colorIndex + 1 : -1;

  return (
    <div ref={root} className="w-48">
      <ColorSwatchRow
        colors={["var(--color-content)", ...ACCENT_COLOR_PRESETS]}
        labels={["Default", "Blue", "Violet", "Pink", "Red", "Orange", "Green"]}
        colorIndex={presetIndex >= 0 ? presetIndex : undefined}
        customColor={presetIndex < 0 ? (value ?? undefined) : undefined}
        customPickerOpen={open}
        onPickIndex={(index) => {
          setOpen(false);
          onChange(
            index === 0
              ? ACCENT_COLOR_DEFAULT
              : (ACCENT_COLOR_PRESETS[index - 1] ?? ACCENT_COLOR_PRESETS[0]),
          );
        }}
        onToggleCustom={() => setOpen((current) => !current)}
      />
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={248}
          onDismiss={() => setOpen(false)}
          className="px-2 pb-2"
        >
          <ColorPickerPopover
            value={value ?? ACCENT_COLOR_PRESETS[0]}
            onChange={onChange}
          />
        </Popover>
      ) : null}
    </div>
  );
}

/** macOS keeps the decision after the first prompt; only System Settings can flip it. Windows toasts are governed by Settings > Notifications. */
function NotificationsBlocked() {
  return (
    <span className="flex items-center gap-2 text-[12px] text-content/45">
      Permission needed
      {IS_MAC || IS_WIN ? (
        <button
          type="button"
          onClick={() => {
            void openNotificationSettings().catch(() => {});
          }}
          className="rounded-md border border-content/10 px-2 py-1 text-content/70 hover:bg-content/10 hover:text-content"
        >
          Open System Settings
        </button>
      ) : null}
    </span>
  );
}

function Toggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        onChange(!on);
        playCue("switch");
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "bg-content/20"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** Theme-aware dropdown for a Settings row: a trigger button opening a Popover listbox. Used instead of a native select, whose option popup is OS-rendered and unreadable in dark mode on Windows/Linux. */
function Select({
  label,
  value,
  options,
  onChange,
  onOpen,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; icon?: ReactNode }[];
  onChange: (value: string) => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const activeId =
    options[active] != null ? `${listId}-opt-${active}` : undefined;

  useEffect(() => {
    if (!open) return;
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
  }, [open, value, options]);

  useEffect(() => {
    if (open) onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
      return;
    }
    if (e.key === "Tab") {
      const option = options[active];
      if (option && option.value !== value) onChange(option.value);
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = options[active];
      if (option) pick(option.value);
    }
  };

  return (
    <div ref={root} className="relative max-w-52">
      <button
        type="button"
        ref={trigger}
        aria-label={`${label}: ${selected?.label ?? value}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-content/10 bg-content/5 px-2 py-1 text-left text-[12px] text-content outline-none hover:border-content/20"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected?.icon ? (
            <span className="grid size-4 shrink-0 place-items-center">
              {selected.icon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {selected ? selected.label : value}
          </span>
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-content/50 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={280}
          maxHeight={320}
          autoFocus
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") trigger.current?.focus();
          }}
          role="listbox"
          aria-label={label}
          aria-activedescendant={activeId}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="overflow-y-auto overscroll-contain p-1"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const highlighted = index === active;
            return (
              <button
                key={option.value}
                ref={highlighted ? activeOption : undefined}
                type="button"
                id={`${listId}-opt-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option.value)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${
                  highlighted || isSelected
                    ? "bg-selection text-content"
                    : "text-content hover:bg-content/5"
                }`}
              >
                {option.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center">
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected ? (
                  <Check className="size-3.5 shrink-0" strokeWidth={2.25} />
                ) : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </div>
  );
}
