import { HOME_MONOS } from "./shell/MonoRailSection";
import { monoTeamInView as homeMonoTeam } from "../features/hub/model/hubNav";
import { findMono as findHomeMono } from "../features/monos/model/mono";

/** Dropwave: a Mono on no project (the Chief of Staff) open in its own chat belongs to Home's sidebar. */
function homeMonoInView(sel: { project: string; item: string }): boolean {
  const id = homeMonoTeam(sel);
  return !!id && (findHomeMono(id)?.projects.length ?? 1) === 0;
}
import { subscribeMoreAgentsChanges } from "../features/providers/model/moreAgents";
import { setTurnTextDecorator } from "../integrations/harness/core/registry";
// WP-85: terminal Claude sessions in the chat list.
import { startPendingReviews, type ReviewHooks } from "../features/security-review/model/launch";
import { mergeTerminalSessions } from "../features/terminalMirror/model/list";
import { TerminalMirrorPane } from "../features/terminalMirror/ui/TerminalMirrorPane";
import { useTerminalMirror } from "../features/terminalMirror/ui/useTerminalMirror";
import { withInboxCount } from "../features/hub/model/inboxCountNote";
import { roomSeatTitle } from "../features/hub/model/roomSeatTitle";
import { standingRuleSendNote } from "../features/monos/model/workerStartNudge";
import { faultedOutcome, faultedReply, faultStopper, takeWorkerFault } from "../features/monos/model/devFault";
import { doneOnlyWhenDone } from "../features/monos/model/workOutcome";
import { sendVerifyRoomMessage, useRoomRunner } from "./hooks/useRoomRunner";
import { appendControlEvent } from "./model/controlText";
import { installCodingTeamDefault } from "../features/hub/model/codingTeamModel";
import { noteSessionRuns, RUN_HEARTBEAT_MS, setProcessRunSource } from "../features/monos/model/sessionRuns";
import { noteToolCalls, setRunToolTextSource } from "../features/hub/model/soulTamper";
import { parksForApproval } from "../features/sessions/model/approvalCarry";
import { stripHiddenCharacters } from "../features/sessions/model/hiddenText";
import { heldLineForSend } from "../features/sessions/model/approvalWait";
import { listHarnessRuns } from "../integrations/harness/core/child";
import { OPEN_CONNECTOR_EVENT } from "../features/hub/model/connectors";
import { OPEN_HUB_EVENT, OPEN_TEAMS_EVENT } from "../features/hub/model/hubTeams";
import { focusConnector } from "../features/hub/ui/ConnectorsPage";
import { HubOnboardingGate } from "../features/hub/ui/HubOnboardingGate";
import { IS_HUB_BUNDLE } from "../features/hub/model/hubBundle";
import { hubDefaultsOn } from "../features/hub/model/hubDefaults";
import { hubMonoRank } from "../features/hub/model/hubData";
import { liveMonosNote } from "../features/hub/model/liveMonos";
import { recoverMobileUsage } from "../features/mobile/model/mobileUsageLimit";
import { runMobilePairing } from "../features/mobile/model/mobilePairing";
import { sessionConversationPage } from "../features/agent-app/model/sessionConversation";
import { useMobileWorkspace } from "../features/mobile/hooks/useMobileWorkspace";
import { hasMobileAttachments, mobileAttachments } from "../features/mobile/model/mobileAttachments";
import {
  applyMobileChoice,
  mobileWorkspaceChoice,
  applyMobileConfigure,
  mobileCatalog,
  mobilePrivateSessionIds,
  publishedApprovalRows,
  mobileNewSession,
  mobileProjectId,
  mobileQuestionReply,
} from "../features/mobile/model/mobileWorkspace";
import { readMonoConversation } from "../features/monos/model/monoConversation";
import {
  resumeMonoUsageLimit,
  switchMonoUsageLimitAccount,
} from "../features/monos/model/monoUsageLimit";
import {
  acknowledgeMonoMessage,
  enqueueMonoMessage,
} from "../features/monos/model/monoMessaging";
import {
  dismissQueuedMonoSessionCompletion,
  enqueueMonoSessionCompletion,
  monoSessionCompletionResult,
  MonoSessionCompletionBatches,
  type MonoSessionCompletionResult,
} from "../features/monos/model/monoSessionCompletion";
import { reviewAsk, reviewAskNote } from "../features/monos/model/workerReview";
import { landingDue, landWorkerCopy, refreshAsk, refreshAskNote, refreshWorkerCopy, stoppedForAsh, stopQuestion, withLanding, withStopHeld } from "../features/monos/model/workerLanding";
import { answeredQuestionWakes, ashAnsweredLeadNote, ashWordsNote, noteAshAnswer, openJobOf } from "../features/monos/model/ashAnswersWorker";
import { gateAsk, gateAskNote, gateCheckout, gateDue, gateFailedResult, gateVerdict, runTaskGate, runWorkerGate, signedOffFor, workerGateWord } from "../features/monos/model/workerGate";
import { briefGatesFor } from "../features/firstmate/model/completionGates";
import {
  isOpenDelegation,
  DELEGATIONS_CHANGED,
  tauriDelegations,
  type Delegation,
  type DelegationTracker,
} from "../features/monos/model/delegations";
import { delegationTasksHost } from "../features/monos/model/delegationTasks";
import { withCrewAdvice } from "../features/crew/model/advice";
import { crewAnyLock, crewLaunchCheck, crewPickFor, crewPolicyForLead, crewPolicyInForce, crewRouteFor, pickMonosFrom, recordCrewFailure, recordCrewPause } from "../features/crew/model/host";
import { cliForLeadBrief, refuseBriefedLeadHarness, refuseNeverUseLead } from "../features/crew/model/lead";
import {
  briefCancelled,
  briefSentAt,
  briefWaiting,
  currentLeadBrief,
  deliveryFor,
  queueBriefForIdle,
  withoutQueuedBrief,
} from "../features/monos/model/followedBriefs";
import { markAppDelegate, redoLinkRefusal, type DelegationMeta } from "../features/agent-app/model/agentAppTasks";
import { deliverPhaseResult, isPhaseSession, phaseFinish } from "../features/phases/model/phaseBridge";
import { chatMonoOwner, hasDelegateTool } from "../features/hub/model/hubMcp";
import { appendsHubNote, hubNoteFor, setHubNote } from "../features/hub/model/hubNote";
import {
  codingTeamChatProject,
  codingTeamName,
  codingTeamProjectFor,
  codingTeamsOn,
  forgetCodingTeamChat,
  isCodingTeamChat,
  noteCodingTeamChat,
  projectTapSelection,
} from "../features/hub/model/codingTeam";
import { chosenPresence, forgetCodingTeamHome, settleCodingTeam } from "../features/hub/model/codingTeamHome";
import {
  codingTeamNamed,
  ensureMonoTeam,
  forgetMonoTeam,
  isMonoTeamFolder,
  monoTeam,
  monoTeamName,
  nameMonoTeam,
  teamFor,
  useMonoTeamsVersion,
} from "../features/hub/model/monoTeams";
import { isOrchestratorChat } from "../features/monos/model/orchestrators";
import { leadMemoryBlock, leadStandingBlock } from "../features/hub/model/hubMemoryPrimer";
import { longChatOn, treeContext, treeDate, treeZoom } from "../features/monos/model/monoTreeStore";
import { useMonoTrees } from "./hooks/useMonoTrees";
import { useMemoryCurator } from "./hooks/useMemoryCurator";
import { pickSummaryTree } from "../features/memory/model/longChat";
import { recordUse } from "../features/memory/model/memoryUse";
import { memoryUsePorts } from "../features/memory/ui/memoryUseForApp";
import { recalledFence } from "../features/memory/ui/recallForTurn";
import { compactionCount } from "../features/memory/model/shownMemory";
import { profileNote } from "../features/memory/ui/profileForTurn";
import { ensureMorningHabit } from "../features/chief/model/habit";
import { readsEveryProject, turnRecallWide } from "../features/chief/model/scope";
import { leadFor, leadMono, leadSpecFor, leadWorkingFolder } from "../features/hub/model/hubLeads";
import type { HubProject } from "../features/hub/model/types";
import { useDelegations } from "../features/monos/hooks/useDelegations";
import { useFollowedBriefs } from "../features/monos/hooks/useFollowedBriefs";
import {
  briefsLeads,
  delegateToLead,
  findLeadTarget,
  leadTargetsFor,
  leadNoteName,
  formatLeadBrief,
  leadBriefPrompt,
  setLeadDelegator,
} from "../features/hub/model/leadershipDelegation";
import { bindCouncilApp } from "../features/council/model/seatSessions";
import { bindFreshEyesApp } from "../features/fresh-eyes/model/bind";
import { backendFrom, releaseHeld, resumeReviews, syncHeldDecisions } from "../features/fresh-eyes/model/gate";
import { bindFreshEyesBackend, bindHeldStarter } from "../features/fresh-eyes/model/held";
import { subscribeFreshEyes } from "../features/fresh-eyes/model/store";
import { postLeadReport } from "../features/hub/model/roomReports";
import { useDelegationTree } from "../features/monos/hooks/useDelegationTree";
import { usePrWatches } from "../features/pr-watch/hooks/usePrWatches";
// Hivra WP-11: the first mate's wake queue.
import { useFirstMateWakes } from "../features/firstmate/hooks/useFirstMateWakes";
import { useLeadTick } from "../features/leadTick/hooks/useLeadTick";
// WP-43: Stop stays on screen while a browser is showing.
import { DrivingBar } from "../features/browser/ui/DrivingBar";
// Hivra WP-60: a remote project's report, shown in the chat that started it.
import { bindRemoteReports, placeRemoteReport } from "../features/firstmate/host/remoteReport";
// Hivra WP-172: the fan-out checkpoint store (src-tauri/src/fanout_checkpoint.rs).
import { tauriFanoutCheckpoints } from "../features/firstmate/host/fanoutCheckpointStore";
import { OPEN_CREW, openCrew } from "../features/crew/model/focus";
import { registerCrewCancel } from "../features/crew/model/cancel";
import { registerCrewDelegate } from "../features/crew/model/retry";
import type { WakeQueue } from "../features/firstmate/watcher/wakeQueue";
import {
  tauriPrWatches,
  waitingActivity,
  type PrWatchTracker,
} from "../features/pr-watch/model/prWatches";
import { useHubChecks } from "./hooks/useHubChecks";
import { inCheckTurn, withoutQuietTurns } from "../features/hub/model/hubChecks";
import { useAutopilot } from "../features/autopilot/hooks/useAutopilot";
import { acceptQuickLaunch } from "./model/quickLaunchSession";
import { useWorkspaceNavigation } from "./hooks/useWorkspaceNavigation";
import { useIdleSessionDetach } from "./hooks/useIdleSessionDetach";
import { HarnessEventQueue } from "./model/harnessFlush";
import { noteStreamApplied } from "../features/sessions/model/streamingPerformance";
import { updateSessionState } from "./model/sessionState";
import {
  consumeForkPoint,
  forkFocusedChat,
  insertFork,
  pendingForkBrief,
} from "../features/sessions/model/threadFork";
import { ThreadForkHost } from "../features/sessions/ui/ThreadForkHost";
import { beginTabSwitch, commitTabSwitch } from "./model/navigationPerformance";
import {
  SessionStateContext,
  useWorkspaceSessionState,
} from "../features/sessions/model/sessionStateStore";
import {
  handleAgentApp,
  canAccessAgentAppProject,
  type AppSessionListing,
  type AppSessionPlacement,
} from "../features/agent-app/model/agentApp";
// WP-92: the worker route's answer, so the host call is typed without a value.
import type { WorkerArmOutcome } from "../features/agent-app/model/agentAppSecrets";
import { submitWithSettlement } from "./model/managedSubmission";
import { providerFailureOf, withProviderFailure } from "./model/turnFailure";
import {
  submitAfterProjectSync,
  type SubmissionAcceptance,
} from "./model/submissionAcceptance";
import type { CiRepairRequest } from "../features/inbox/model/ciRepair";
import { ciRepairSessions } from "../features/inbox/model/ciRepairSessions";
import {
  rebaseCiRepairs,
  trackCiRepair,
} from "../features/inbox/model/ciRepairTracking";
import { invoke } from "@tauri-apps/api/core";
import { setLineRulesSource } from "../features/crew/model/lineRules";
import { activityNoteSummary } from "../features/crew/model/workerChoice";
import {
  orchestrationCheckoutCwd,
  orchestrationProjectCwd,
  orchestrator,
  appCliCommand,
  workspaceIdentity,
  type ControlOutcome,
} from "../features/orchestration/model/orchestration";
import { modelsFor } from "../features/sessions/model/models";
import { isHarnessAvailable } from "../integrations/harness/core/availability";
import {
  completeOrchestrationProposal,
  completeOrRepairOrchestrationProposal,
  orchestrationPlanningPrompt,
  orchestrationRepairPrompt,
  proposalBlock,
  validateOrchestrationSettings,
  withOrchestrationProposal,
  type OrchestrationProposal,
} from "../features/orchestration/model/orchestrationPlan";
import { discoverOrchestrationSettings } from "../features/orchestration/model/orchestrationCatalog";
import { watchDecisions } from "../features/orchestration/model/decisionWatch";
import {
  attachOrchestrationWorkers,
  consolidateOrchestrationTabs,
  prepareOrchestrationWorkerDetails,
  releaseOrchestrationWorker,
} from "../features/orchestration/model/orchestrationWorkspace";
import {
  OrchestrationActions,
  OrchestrationWorkers,
  type OrchestrationWorkerDetail,
} from "../features/orchestration/ui/OrchestrationActions";
import { flushSync } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ProjectStrip } from "../features/hub/ui/ProjectStrip";
import { HubProjectItems } from "../features/hub/ui/HubProjectItems";
import { HubTopNav } from "../features/hub/ui/HubTopNav";
import { HubSurface } from "../features/hub/ui/HubSurface";
import { ShipNotice } from "../features/hub/ui/ShipNotice";
// WP-92: a Mono's request for a key appears as a form card above the chat.
import { SecretCards } from "../features/secrets/ui/SecretRequestCard";
// WP-92: a finished turn's "Needs Ash (provide): a key" gets the same form, not the composer.
import { SecretKeyAsk } from "../features/secrets/ui/SecretKeyAsk";
import {
  hubData,
  hubProjectFolder,
  hubProjectFolders,
  hubProjectIdFor,
  nameHubProject,
  useHubDataVersion,
} from "../features/hub/model/hubData";
import "../features/hub/model/stripBackdrop";
import {
  NO_PROJECT,
  currentHubSelection,
  hubSurfaceOpen,
  monoTeamInView,
  monoTeamItem,
  selectionLeavingOwnTeam,
  projectHasCodeFolder,
  projectHomeSelection,
  resolveHubOpen,
  retiredHubItem,
  setCodingTeamOpener,
  setHubSelection,
  setMonoChatOpener,
  setMonoTeamOpener,
  showAppItem,
  showProjectToday,
  showProjectHome,
  useHubSelection,
  type CodingTeamTarget,
  type MonoTeamTarget,
} from "../features/hub/model/hubNav";
import { noteOpenedChat } from "../features/home/model/store";
import { stampChat } from "../features/home/model/openedChat";
import { useHomeOnOpen } from "../features/home/ui/useHomeOnOpen";
import { useHomeOpener } from "../features/home/ui/useHomeOpener";
import { notifyHomeChief, setHomeChiefHost } from "../features/home/model/homeChief";
import { placePrompt, rememberPromptSession } from "../features/sessions/model/threadLinkOpen";
import { ThreadLinkNotice, useThreadLinkOpener } from "../features/sessions/ui/ThreadLinkActions";
import {
  codingTeamView,
  noteCodingTeamView,
} from "../features/hub/model/codingTeamList";
import { MonoRailMascot } from "../features/monos/ui/MonoRailMascot";
import type { CodingTeamList } from "./shell/Sidebar";
import {
  forgetWaitingChat,
  noteChats,
  pruneWaitingChats,
  setWaitingChatsHost,
  setWorkerQuestionRouter,
} from "../features/hub/model/waitingChats";
import { setPageActionsHost } from "../features/pages/model/pageActions";
import { useStableValue } from "../shared/hooks/useStableValue";
import { useDragResize } from "../shared/hooks/useDragResize";
import { beginLayoutTransition } from "../shared/lib/layoutTransition";
import { noteProjectStep, Sidebar } from "./shell/Sidebar";
import { ApprovalToasts } from "../features/sessions/ui/ApprovalToasts";
import { ResourcePressureNotice } from "../features/notifications/ui/ResourcePressureNotice";
import { HarnessUpdateNotice } from "../features/providers/ui/HarnessUpdateNotice";
import { NewLayoutNotice } from "./shell/NewLayoutNotice";
import { toastStackTop } from "./shell/toastStack";
import { WhatsNewDialog } from "./shell/WhatsNewDialog";
import { ProviderSignInDialog } from "../features/sessions/ui/ProviderSignInDialog";
import {
  MonoViewActions,
  TitleBar,
  type Tab as TitleTab,
} from "./shell/TitleBar";
import {
  APP_VIEW_LABELS,
  appViewForTab,
  appViewTabId,
  isViewTab,
  monoForTab,
  monoTabId,
  nextDisplayedTabAfterClose,
  reconcileTitleTabOrder,
  type AppView,
} from "../features/workspace/model/appViewTabs";
import { AppViewSurface } from "../features/workspace/ui/AppViewSurface";
import { WindowControls } from "./shell/WindowControls";
import {
  MonoOverview,
  type MonoOverviewTab,
} from "../features/monos/ui/MonoOverview";
import { MonoSettingsDialog } from "../features/monos/ui/MonoSettingsDialog";
import { MonoActivityView } from "../features/monos/ui/MonoActivityView";
import {
  launchedSessionState,
  monoSpawnedSessions,
  recordMonoSpawnedSession,
  waitingCardAfterStart,
  type LaunchedSessionState,
  type LaunchedSessionView,
} from "../features/monos/model/monoSpawnedSessions";
import { groupMonoTurns } from "../features/sessions/model/transcriptActivity";
import {
  resolveMonoActivity,
  type MonoActivitySelection,
} from "../features/monos/model/monoActivity";
import { MenuBar } from "./shell/MenuBar";
import { FinderHost } from "../features/search/ui/FinderHost";
import {
  DeleteSessionDialog,
  type SessionDeleteChoice,
} from "../features/sessions/ui/DeleteSessionDialog";
import { ConfirmDeleteHost, confirmDelete } from "../shared/ui/ConfirmDelete";
import { monoDeleteDetail } from "../features/monos/model/monoDelete";
import { deleteMonoToTrash, STILL_RUNNING } from "../features/trash/model/deleteMono";
import { trashMono } from "../features/trash/model/client";
import { TRASH_CHANGED } from "../features/trash/model/trash";
import { refreshHiddenProjects } from "../features/trash/model/hidden";
import { delegationOf } from "../features/monos/model/delegationView";
import {
  unusedWorktreeOf,
  withinDeadline,
  worktreeTickedByDefault,
} from "../features/sessions/model/sessionDeletePlan";
import {
  type WorktreeFocus,
  useWorktreeFocus,
  worktreeFocus,
} from "../features/source-control/model/worktreeFocus";
import { useProjectDiffStats } from "../features/source-control/hooks/useProjectDiffStats";
import { showWorktreeSetup } from "../features/source-control/model/worktreeSetup";
import {
  listProjectActions,
  runProjectAction,
  waitProjectAction,
} from "../features/projects/model/projectActions";
import {
  assertWorktreeFilesClosed,
  createOrchestrationWorktree,
  createWorktree,
  detachSessionWorktree,
  checkWorktreeRemoval,
  listedWorktreeFor,
  listWorktrees,
  namedWorktreeBranch,
  temporaryWorktreeBranchName,
  orchestrationWorktreeBranchName,
  removeOrchestrationBranch,
  removeOrchestrationWorktree,
  removeWorktree,
  renameWorktreeBranch,
  sessionInWorktree,
  worktreeDeletedExternally,
  worktreeSessionIds,
  type Worktree,
} from "../features/source-control/model/worktrees";
import {
  attachNewChatWorktree,
  gitRepositoryOnThisComputer,
  newChatWorktreeOpenFor,
  openNewChatWorktree,
  pendingNewChatOfferCheck,
  withNewChatFolderChoice,
  withoutNewChatFolderChoice,
} from "../features/source-control/model/newChatWorktree";
import { rememberWorktreeInclude } from "../features/source-control/model/worktreeIncludeNote";
import { UsageFooter } from "./shell/UsageFooter";
import { useProjectBranches } from "../features/source-control/hooks/useProjectBranches";
import { useInboxActivity } from "../features/inbox/hooks/useInboxUnseen";
import {
  applyInsetLayout,
  INSET_LAYOUT_DEFAULT,
  loadInsetLayout,
  loadProjectRailOpen,
  loadRightPanelOpen,
  loadRightPanelTab,
  loadRightPanelWidth,
  loadSessionSidebarOpen,
  RIGHT_PANEL_WIDTH_DEFAULT,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  saveRightPanelOpen,
  saveRightPanelTab,
  saveRightPanelWidth,
  subscribeInsetLayout,
  type RightPanelTab,
  saveProjectRailOpen,
  saveSessionSidebarOpen,
  type SidebarTabId,
} from "../features/settings/model/appearance";
import {
  loadProjectSidebarTab,
  saveProjectSidebarTab,
} from "../features/settings/model/projectSidebarTab";
import { HAS_NATIVE_GLASS, IS_MAC } from "../platform/tauri/platform";
import {
  applyUiScale,
  loadUiScale,
  saveUiScale,
  UI_SCALE_DEFAULT,
  zoomInUiScale,
  zoomOutUiScale,
} from "../features/settings/model/uiScale";
import { resolveZoomKeybinding } from "../features/settings/model/zoomKeybinding";
import { resolveAppShortcut } from "../features/settings/model/appShortcuts";
import { runUpdateFlow } from "./model/updater";
import {
  displayAttachments,
  prepareAttachments,
} from "../features/sessions/model/attachments";
import {
  basename,
  homeDir,
  notifyGitChanged,
  pickFolders,
  type GitFileDiffKind,
  type GitHistoryCommit,
} from "../platform/tauri/fs";
import {
  invalidateProjectFiles,
  prefetchProjectFiles,
  rememberOpenedFile,
  resolveFileOpenRequest,
  resolveOpenablePath,
} from "../features/files/model/fileIndex";
import {
  closeLeaf,
  closeSurfacePanes,
  findSurfacePane,
  firstLeafId,
  focusedFileTab,
  isolateTerminalPanes,
  isFilesystemTab,
  isCommitTab,
  isTerminalTab,
  leaf,
  leafIds,
  movePane,
  neighborLeafId,
  newEditorWorkspaceTab,
  newFileTab,
  newPlanTab,
  newTab,
  newTerminalFile,
  newTerminalWorkspaceTab,
  nextTerminalTitle,
  openChangesTab,
  openCommitTab,
  newAgentTab,
  openEditorTab,
  openSessionChangesTab,
  pinEditorFile,
  openWorkspaceFile,
  previewWorkspaceFile,
  openTerminalTab,
  removePane,
  resetTabToSession,
  replaceLeafId,
  setSplitRatio,
  siblingLeafId,
  splitPane,
  surfacePanes,
  updateTerminalTab,
  withSurfacePanes,
  type EditorPane,
  type FilePaneTab,
  type FocusDir,
  type PaneEdge,
  type SplitDir,
  type WorkspaceTab,
} from "../features/workspace/model/layout";
import {
  releaseNotesForVersion,
  releaseNotesTitle,
} from "./model/releaseNotes";
import { mergeOrderedSubset, orderByIds } from "../shared/lib/reorder";
import {
  addTerminalToDock,
  applyDockGridStyle,
  closeTerminalInDock,
  createProjectTerminal,
  findProjectTerminal,
  focusedDockTerminalId,
  isVerticalDock,
  mapProjectTerminal,
  nextDockTerminalTitle,
  patchProjectTerminals,
  reorderDockTerminals,
  selectDockTerminal,
  withDockOpen,
  withDockSide,
  withDockSize,
  type DockSide,
  type ProjectTerminalDock as ProjectTerminal,
} from "../features/projects/model/projectTerminal";
import {
  applyGroupedReorder,
  insertTabBesideActive,
  removeTabFromGroup,
  tabGroupProject,
} from "../features/workspace/model/tabGroups";
import { type WindowTransferPayload } from "./model/windowTransfer";
import {
  confirmCloseTerminal,
  confirmCloseTerminals,
} from "../features/terminal/model/terminalClose";
import {
  listRunningTerminals,
  newTerminalCwd,
  terminalTabLabel,
  type TerminalMetaPatch,
} from "../features/terminal/model/terminalTab";
import {
  applyHarnessEvent,
  applyHarnessEvents,
  appendUser,
  appendSteerUser,
  bindHarnessSession,
  transferHarnessSessionAccount,
  cancelHarnessTurn,
  canCompactHarnessContext,
  canRewindHarnessLastTurn,
  canSteerHarness,
  harnessCannotSteer,
  compactHarnessContext,
  rewindHarnessLastTurn,
  forgetHarnessSession,
  // WP-129: titles and branch names try the short text model first.
  generateTitleWithTextModel,
  generateBranchWithTextModel,
  migrateMonoCodexSession,
  isLiveHarness,
  latestTurnNeedsHarnessLogin,
  probeHarnessAvailability,
  refreshHarnessCatalogs,
  registerBuiltinHarnesses,
  promoteLastAssistantToPlan,
  respondHarnessApproval,
  respondHarnessQuestion,
  keepHarnessQuestionOpen,
  runHarnessTextPrompt,
  sendHarnessTurn,
  steerHarnessTurn,
  startHarnessBridge,
  stopHarnessSession,
  configureHarnessIdlePark,
  stopHarnessTextPrompts,
  stopStreaming,
  pickTextHarness,
  type ApprovalDecision,
  type HarnessEvent,
  type UserQuestionReply,
} from "../integrations/harness";
import { supportsHarnessLogin } from "../integrations/harness/core/authSupport";
import {
  appendPreparingHandoff,
  buildDeterministicHandoff,
  buildHandoffComposerCard,
  chooseHandoffBrief,
  completeHandoff,
  consumeHandoff,
  HANDOFF_TITLE,
  handoffTurnCard,
  isPreparingHandoff,
  pendingHandoff,
  pendingComposerSwitch,
  sessionChildHarnesses,
  sessionThroughTurn,
  shouldAskOutgoingAgent,
  type HandoffComposerCard,
  userMessagesAfterHandoff,
  wrapForkPrompt,
  wrapHandoffPrompt,
  wrapRecoveredPrompt,
} from "../features/sessions/model/handoff";
import {
  applyMidThreadSwitch,
  commitMidThreadSwitch,
  buildPortableTranscript,
  restoreUnsentPortableResume,
  wrapPortableResume,
} from "../features/sessions/model/midThreadSwitch";
import { requestOutgoingHandoff } from "../features/sessions/model/handoffTurn";
import {
  applyBtwHarnessEvent,
  btwTurnHarness,
  buildBtwPrompt,
  sealBtwResponseBlocks,
  supportsBtwHarness,
  withSideThread,
} from "../features/sessions/model/btw";

import { isEditTool } from "../integrations/harness/core/preview";
import { CHAT_NEEDS_FOLDER, hasChatFolder, withRelinkedFolder } from "../integrations/harness/core/chatFolder";
import { sessionEditPaths } from "../features/sessions/model/checkpointEdits";
import { useSessionChangeTotals } from "../features/sessions/ui/SessionReview";
import {
  createEditedResendAttempt,
  createEditedResendCoordinator,
} from "../features/sessions/model/editLastTurn";
import {
  beginSessionTurn,
  finishSessionTurn,
  applySessionCheckpoint,
  captureSessionCheckpoint,
  forgetSessionCheckpoint,
  flushSessionCheckpoint,
  keepSessionChanges,
  notifyReviewChanged,
  prepareSessionCheckpoint,
  sessionCheckpointCleanupSafe,
} from "../features/sessions/model/checkpoint";
import { notifyDirsChanged } from "../features/files/model/fileTree";
import {
  invalidateWatchedFiles,
  nudgeWatchedFiles,
} from "../features/files/model/fileWatch";
import {
  type EditorNavigationTarget,
  type OpenFileFn,
} from "../features/search/model/search";
import {
  mergeModelSettings,
  nativeModelId,
  preferredModelSettings,
  resolveModel,
  saveLastModelSettings,
  saveRecentModelChoice,
} from "../features/sessions/model/models";

import {
  buildPlanPrompt,
  isProviderFailureText,
  planTitle,
  planTurnKey,
  planTurnPrompt,
} from "../features/sessions/model/plan";
import {
  displayPath,
  isEqualOrInside,
  pathKey,
  projectName,
  rebasePath,
  resolveWorkspacePath,
} from "../shared/lib/paths";
import {
  rebaseProjectData,
  removeProjectData,
} from "../features/projects/model/projectData";
import { removeProjectFromWindow } from "../features/trash/model/removeProject";
import {
  forgetProjectLocation,
  rememberProjectLocation,
  synchronizeProjectLocation,
} from "../features/projects/model/projectLocation";
import {
  archiveProject,
  forgetProject,
  lastProjectPath,
  loadRecents,
  loadPinnedProjects,
  isLocalProject,
  isRemoteProjectPath,
  looksLikeProject,
  normalizeProjectPath,
  projectRailItems,
  rememberProject,
  replaceProjectPath,
  sameProjectPath,
} from "../features/projects/model/recents";
import {
  applyDetachPaneToTab,
  applyPlaceTabOnPane,
  applyPlaceSessionOnPane,
  filterTabsForProject,
  findOpenSessionTab,
  planWorkspaceTabClose,
  switchSessionInTab,
  workspaceTabCwd,
  workspaceTabWorktree,
  focusedWorkspaceTabCwd,
} from "../features/workspace/model/workspaceTabGroups";
import { applyAddToChatRequest } from "../features/sessions/model/addChatToWorkspace";
import {
  isBlankWorkspaceTab,
  newWorkspaceSession,
  reusableBlankSessionTab,
} from "./model/newWorkspaceSession";
import {
  ADD_TO_CHAT_EVENT,
  type AddToChatRequest,
} from "../features/sessions/model/quoteDraft";
import { useBusyChatsFeed } from "../features/monos/hooks/useBusyChatsFeed";
// Hivra WP-10: a first mate reads and never edits (features/firstmate/).
import { useFirstMateCheckoutGuard } from "../features/firstmate/hooks/useFirstMateCheckoutGuard";
import { useSteering } from "../features/firstmate/hooks/useSteering";
import { firstMateLaunch } from "../features/firstmate/model/checkoutGuard";
import { crewLaunch } from "../features/crew/model/crewSession";
// WP-115: compact an idle Claude chat shortly before its prompt cache expires.
import {
  commitIdleCompactBusy,
  watchIdleClaudeCompaction,
} from "../integrations/harness/providers/claude/idleCompactWatch";
// WP-115: plain sentence when this agent cannot redirect a running turn.
import {
  COMPACTING_NOTE,
  QUEUED_MESSAGE_WAITS,
  cantRedirectTurn,
  cantTakeFollowUp,
  followUpWhenBusy,
} from "../features/sessions/model/cantDo";
import { withLegacyBriefParts } from "../features/firstmate/model/brief";
import { useFanoutHost } from "../features/firstmate/hooks/useFanoutHost";
import { viewAfterRemoval, type RemovalOrigin } from "../features/sessions/model/sessionWorkspaceLifecycle";
import { focusClosesMono, paneFocus } from "./model/paneFocus";
import { useLiveTurns } from "../features/sessions/hooks/useLiveTurns";
import { listLiveTurns, overlayLiveWorking, publishLiveTurns } from "../features/sessions/model/liveTurns";
import { createSessionRemover } from "../features/sessions/model/sessionRemoval";
import { shouldGenerateSessionTitle } from "../features/sessions/model/sessionTitle";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccountExists,
  sameProviderAccountId,
  selectedProviderAccountId,
  supportsProviderAccounts,
  type ProviderAccountProvider,
} from "../features/providers/model/providerAccounts";
import { firstTurnAccount, providerName, reactToLimit, workerRoom } from "../features/providers/model/accountWaterfall";
import { claudeRunsOnSubscriptionBridge } from "../integrations/harness/providers/claude/claudeDeepseekBridge";
import { getCachedRateLimits } from "../features/providers/model/rateLimitsCache";
import { approvalSessionIdsOf } from "../features/sessions/model/approvalSessionIds";
import {
  discardFanOutLoser,
  pickFanOutInStore,
  releaseFanOutWorktrees,
} from "../features/sessions/model/fanOutDecide";
import {
  defaultWorktreeRoots,
  fanOutJanitorPort,
  startFanOutSetup,
} from "../features/sessions/model/fanOutJanitor";
import { startFanOut } from "../features/sessions/model/fanOutLaunch";
import { listCompares, putCompare, subscribeCompares } from "../features/sessions/model/fanOutStore";
import { fanOutCompareRows, fanOutNotStartedLines } from "../features/sessions/model/fanOutView";
import {
  HARNESSES,
  HARNESS_LABEL,
  HARNESS_TITLE,
  canReplaceSessionTitle,
  formatSessionTitle,
  sessionNeedsInput,
  newDefaultSession,
  newSession,
  retargetSessionToProject,
  removeSessionDraft,
  sessionDisplayTitle,
  sessionDraftBlock,
  sessionWorkCwd,
  titleFromPrompt,
  type Attachment,
  type Block,
  type BtwThread,
  type ComposerTurnOptions,
  type HarnessId,
  type LinkedWorkItem,
  type ModelTarget,
  type PlanBuildTarget,
  type QueuedMessage,
  type RuntimeMode,
  type PlanStatus,
  type SecondOpinionMeta,
  type MonoSpawnedSession,
  type Session,
  type UsageLimit,
  type WorkspaceMode,
  DEFAULT_RUNTIME_MODE,
} from "../features/sessions/model/session";
// WP-134b: a More agents chat never goes through the eleven CLIs.
import { AGENT_GONE, WAITS } from "../features/registry/model/registryCopy";
import {
  START_REGISTRY_CHAT_EVENT,
  loadRegistryDocument,
  refreshRegistry,
  reportRegistryChatRefused,
  subscribeRegistry,
} from "../features/registry/model/registryList";
import { registrySendPlan, registrySessionFields } from "../features/registry/model/registryPlan";
import { moreAgentOfSession, openMoreAgentSession } from "../integrations/harness/moreAgents/moreAgentAdapter";
// WP-113: attention for the optional chat list inbox. Off passes no sessions.
import { useChatListInbox } from "../features/settings/model/displayPrefs";
import {
  EMPTY_CHAT_LIST_SESSIONS,
  useChatListAttention,
} from "../features/sessions/model/chatListInboxStore";

import {
  canDispatchQueuedHead,
  canSteerQueuedHead,
  dequeueQueuedMessage,
  isWaitingBrief,
  queuedMessageForSubmit,
  typedQuestionAnswer,
  waitsOnCutTurn,
} from "../features/sessions/model/messageQueue";
import { deliverQueuedFollowUp } from "../features/sessions/model/queuedFollowUp";
import {
  USAGE_LIMIT_RESUME_GRACE_MS,
  resumeUsageLimitedSession,
  usageLimitResumeAt,
  usageLimitResumeDue,
  withUsageLimitAccount,
} from "../features/sessions/model/usageLimit";
import {
  fetchClaudeRateLimits,
  fetchCodexRateLimits,
} from "../features/providers/model/rateLimitsFetch";
import { exhaustedWindowResetAt } from "../features/providers/model/rateLimits";
import {
  discardDraftSessionRecord,
  deleteSession,
  getSession,
  readSession,
  repairSession,
  applySessionRepair,
  listLinkedSessions,
  listSessionsByProject,
  persistFingerprint,
  rebaseProjectSessions,
  dropInFlightSession,
  replaceInFlightSessions,
  saveWorkspaceSnapshot,
  setSessionArchived,
  setSessionLinkedWorkItem,
  setSessionPinned,
  setSessionPrivate,
  shouldPersistSession,
  upsertSession,
  flushSessionWrites,
  type SessionSummary,
} from "../features/sessions/data/sessionStore";
import { rememberLoadedSession } from "../features/sessions/data/sessionCache";
import { privateChatKeys, replaceLivePrivateKeys, withPrivate } from "../features/memory/model/privateChat";
import {
  TranscriptPool,
  TranscriptPoolOutlet,
} from "../features/sessions/ui/TranscriptPool";
import { syncDockBadge } from "../features/notifications/model/dockBadge";
import { liveAgentsFromSessions } from "../features/sessions/model/liveAgents";
import { hiddenApprovalNotices } from "../features/notifications/model/approvalToast";
import { hubToastNotices, hubToastView } from "../features/hub/model/hubApprovalToasts";
import { useSessionReminders } from "../features/notifications/hooks/useSessionReminders";
import { ReminderNotices } from "../features/sessions/ui/ReminderNotices";
import { useUnseenFinishedSessions } from "../features/sessions/hooks/useUnseenFinishedSessions";
import { useLiveHarnessSettings } from "../features/sessions/hooks/useLiveHarnessSettings";
import { useUnseenReplyCounts } from "../features/sessions/hooks/useUnseenReplyCounts";
import {
  loadNotificationsEnabled,
  NOTIFICATION_CLICK_EVENT,
  announceSessionFinished,
  probeNotificationPermission,
  setWindowFocused,
} from "../features/notifications/model/notifications";
import { useInputNotifications } from "../features/notifications/hooks/useInputNotifications";
import { useNotablePings } from "../features/notifications/hooks/useNotablePings";
import { archiveFocusedSession } from "../features/sessions/model/archiveShortcut";
import {
  adjacentItemId,
  deferUnhandledEscape,
  focusedBusyAgentSessionId,
  shouldHandleListNavigation,
  shouldStopFocusedTurnOnEscape,
  tabCommand,
  tabCommandForKeybinding,
  tabCommandKeybinding,
} from "../features/workspace/model/tabKeys";
import {
  canTabVisitBack,
  canTabVisitForward,
  emptyTabVisitHistory,
  pruneTabVisitHistory,
  recordTabVisit,
  tabVisitBack,
  tabVisitForward,
  type TabVisitHistory,
} from "../features/workspace/model/tabVisitHistory";
import { preparePrompt } from "../features/sessions/model/promptPreparation";
import {
  consumeOperatorCommand,
  operatorEnabledInThread,
} from "../features/sessions/model/operatorCommand";
import {
  createMono,
  findMono,
  monoWorksOn,
  isMonoSession,
  isProjectLeadId,
  listMonos,
  loadOpenMono,
  monoForSession,
  monoLook,
  monosSnapshot,
  monoState,
  removeMono,
  updateMono,
  saveMonoName,
  saveMonoSessionId,
  saveOpenMono,
  subscribeMonos,
  type MonoState,
} from "../features/monos/model/mono";
import { holdRunCard, monoCardText } from "../features/monos/model/monoCards";
import {
  codingTeamContext,
  loadMonoFiles,
  MONO_PROMPT_VERSION,
  planAgentContext,
  monoContext,
  monoTurn,
  readAgentFile,
  recordAgentContext,
  standingKeyPart,
  writeAgentFile,
} from "../features/monos/model/monoFiles";
import { withFirstMateContract } from "../features/firstmate/model/contract";
import { monoTurnNote } from "../features/monos/model/monoMate";
import { plainEnglishEndings } from "../features/firstmate/model/plainEnglish";
import { useMonoHabits } from "./hooks/useMonoHabits";
import { appPolicy } from "./model/appIdentity";
import {
  claimVerifyKickoff,
  pendingVerifyKickoff,
  traceVerifyKickoff,
  verifyKickoffMono,
  verifyRun,
  watchVerifyMessages,
} from "./model/verifyKickoff";
import {
  delegationActions,
  delegationRows,
  subscribeDelegations,
  useDelegationRows,
} from "../features/monos/model/delegationStore";
import {
  holdForLimit,
  nextHealthCheck,
  nextWake,
  planHeld,
  droppedTaskLine,
  setQueueDependency,
  pumpWorkers,
  queuedWorkers,
  retryNow,
  setWorkerQueueBackend,
  subscribeWorkerPool,
  tauriWorkerQueue,
  projectWorkerDefault,
  systemWorkerDefault,
  workerPoolHost,
  type HeldSeen,
  type QueuedWorker,
} from "../features/monos/model/workerPool";
import { subscribeSpend, type TurnOrigin } from "../features/usage/model/spendGate";
import { noteMonoFailures, setMonoFailuresHost } from "../features/monos/model/monoFailures";
import { failedTurnMessage } from "../features/monos/model/turnFailure";
import {
  driverEnabled as verifyDriverEnabled,
  startDriver as startVerifyDriver,
  type DriverHost as VerifyDriverHost,
} from "./model/verifyDriver";
import {
  loadShipNote,
  reportShipReady,
  shipStatus,
  startShip,
  useShipStatus,
} from "./model/ship";
import { useFloatingMono } from "./hooks/useFloatingMono";
import {
  dropRelays,
  habitPostsContext,
  habitRunMono,
  isHabitRun,
  noteHabitRunLaunch,
  relayApproval,
  takeRelayedApproval,
  loadHabits,
  unseenHabitPosts,
  updateHabits,
} from "../features/monos/model/monoHabits";
import {
  loadMonoRotation,
  planRotation,
  rotationReason,
  saveMonoRotation,
} from "../features/monos/model/monoRotation";
import {
  detachMonoTabs,
  ensureMonoProjectSession,
  ensureMonoRoomSession,
  ensureMonoSession,
  resetMonoSession,
} from "../features/monos/model/monoWorkspace";
import { projectFront, setProjectFront, useProjectFrontVersion } from "../features/hub/model/projectFront";
import { pickChief as pickCaptain } from "../features/home/model/chief";
// WP-34: the Creator screen starts the Creator Mono's chat through this window's sessions.
import { CREATOR_MONO_ID, landCreatorBrief, setCreatorSessionHost } from "../features/creator/model/creatorChat";
import {
  warmNativeSkills,
  isNativeCommandPrompt,
} from "../features/skills/model/skills";
import { nativeSkillContextForSession } from "../features/sessions/model/sessionSkills";
import {
  loadSessionFolders,
  placeSessionInFolder,
  saveSessionFolders,
  type SessionFolderTarget,
} from "../features/sessions/model/sessionFolders";
import {
  ADD_NOTE_TO_CHAT_EVENT,
  NOTES_CHANGED_EVENT,
  composeNoteMessage,
  loadNotes,
  noteCardMeta,
  upsertNote,
  type NoteComposerCard,
} from "../features/notes";
import {
  getArtifact,
  saveArtifact,
  artifactCards,
  recordArtifactCard,
  removeArtifactCard,
  ARTIFACT_DELETED_EVENT,
} from "../features/artifacts/artifacts";
import type { MonoChangesRequest } from "../features/monos/ui/MonoChangesView";
import {
  claimDueAutomations,
  listAutomations,
  recoverAutomationRuns,
  updateAutomationRun,
  type Automation,
  type AutomationRun,
} from "../features/automations/model/automations";
import { useQuickComposerLaunches } from "../features/quick-composer/hooks/useQuickComposerLaunches";
import type { QuickLaunch } from "../features/quick-composer/model/quickComposer";
import { claimInboxAutomationRuns } from "../features/automations/model/automationEvents";
import {
  SECOND_OPINION_TITLE,
  buildSecondOpinionRequest,
  harnessForTurn,
  turnEditedFiles,
  turnUserRequest,
} from "../features/sessions/model/secondOpinion";

import { PaneTree } from "../features/workspace/ui/PaneTree";
import { SessionPane } from "../features/sessions/ui/SessionPane";
import { SessionSurface } from "../features/sessions/ui/SessionSurface";
import { ProjectTerminalDock } from "../features/terminal/ui/ProjectTerminalDock";
import { lazySurface } from "../shared/ui/lazySurface";
import { preloadNavigationWhenIdle } from "./model/preloadNavigation";
import { requestTranscriptJump } from "../features/sessions/model/transcriptJump";
import { finderShortcutAction, routeFinderHit } from "../features/search/model/finder";
// WP-93: the command palette reads what the app can do and runs each row.
import type { PaletteContext } from "../features/search/model/commandRegistry";
import { runPaletteRow } from "../features/search/model/paletteRun";
import { runPaletteCommand } from "../features/search/model/paletteWiring";
import {
  focusBeforePalette,
  paletteFocusOf,
} from "../features/search/model/paletteFocus";
import {
  finderFileOptions,
  requestDocFocus,
  requestTaskFocus,
} from "../features/search/model/finderOpen";
import { openDocsMode } from "../features/docs/docsMode";
import type { SettingsAnchor } from "../features/settings/ui/SettingsView";
import {
  OPEN_CONNECTIONS_EVENT,
  OPEN_REMOTE_PROJECT_EVENT,
  REMOTE_HISTORY_UPDATED,
  cachedRemoteSessionSummary,
  rememberRemotePendingWorktree,
  rememberRemoteSession,
  remotePendingWorktree,
  remoteTabCwd,
  remoteSessionFor,
} from "../features/connections/model/connections";
import {
  buildRemotePlan,
  remoteSessionActions,
} from "../features/connections/model/remoteSessionActions";
import { remoteSessionState } from "../features/connections/model/remoteSessionState";
import { findRemoteSessionTab } from "../features/connections/model/remoteSessionTabs";
import {
  remotePath,
  remoteProjectFor,
  remoteSessionGitCwd,
} from "../features/connections/model/remoteProjects";
import type { HostSession } from "../features/connections/model/protocol";
import { AddRemoteProjectDialog } from "../features/connections/ui/AddRemoteProjectDialog";
import type { ConnectableInboxSource } from "../features/inbox/model/inboxFilters";
import type { InboxSessionPortal } from "../features/inbox/ui/InboxDiscussionPanel";
import { inboxAskKey, inboxAskPrompt } from "../features/inbox/model/inboxAsk";
import {
  githubWorkItemThread,
  inboxComposerCard,
  type InboxItem,
} from "../features/inbox/model/githubTasks";
import {
  linkedWorkItemFromAutomationEvent,
  linkedWorkItemFromInboxItem,
  resolveLinkedWorkItem,
} from "../features/sessions/model/sessionWorkItem";
import {
  completeLinkedWorkItemUpdateCard,
  failLinkedWorkItemUpdateCard,
  pendingLinkedWorkItemUpdateCard,
  type LinkedWorkItemUpdateCard,
} from "../features/inbox/model/linkedWorkItemActivity";
import type { LinkedSessionUpdate } from "../features/inbox/model/linkedSessionUpdates";
import { markLinkedSessionUpdateSeen } from "../features/inbox/model/linkedSessionSeen";
import { inboxTrackerDescription } from "../features/inbox/model/inboxContext";
import {
  gitlabWorkItemDetails,
  peekGitlabWorkItemDetails,
} from "../features/inbox/model/gitlab";
import {
  azureDevOpsWorkItemDetails,
  peekAzureDevOpsWorkItemDetails,
} from "../features/inbox/model/azureDevOps";
import {
  loadCloseToTray,
  loadAutosave,
  loadCollapsedProjectRailMode,
  loadFileTabMode,
  loadLiveAgentsEnabled,
  loadNotesEnabled,
  loadMonosEnabled,
  subscribeMonosEnabled,
  loadDiffViewer,
  loadFollowUpBehavior,
  loadMoreAgentsEnabled,
  loadNewChatWorktree,
  loadIdleAgentLimit,
  loadKeybindingOverrides,
  loadSettingsSection,
  keybindingPressed,
  matchCustomKeybinding,
  saveSettingsSection,
  saveAutosave,
  subscribeLiveAgentsEnabled,
  subscribeNotesEnabled,
  type CollapsedProjectRailMode,
  type SettingsSectionId,
  type FollowUpBehavior, syncMoreAgentsSwitch } from "../features/settings/model/settings";
import {
  handleEditorFindKey,
  openFindInActiveEditor,
  openReplaceInActiveEditor,
} from "../features/files/editor/editorSearch";

import {
  mergeHistorySummary,
  mergeProjectHistorySummary,
  replaceProjectHistory,
  historyWithLiveSessions,
  sameSessionSummaries,
  summaryFromSession,
} from "../features/sessions/data/sessionHistory";
import {
  CONTINUE_PROMPT,
  RESUME_STOPPED_MESSAGE,
  canAutoContinue,
  interruptingShip,
  inFlightRefs,
  inFlightSnapshotKey,
  markResumeStopped,
  claimAutoContinue,
  resumeBlocked,
  resumePrompt,
  isTurnRunning,
  shouldWriteInFlightSnapshot,
} from "../features/sessions/model/inFlight";
import {
  isBlankSession,
  reconcileProjectReturn,
  type ProjectReturnMemory,
} from "../features/projects/model/projectReturn";
import {
  planProjectOpenRun,
  type ProjectOpenStep,
} from "../features/projects/model/projectOpenRun";
import {
  collectWorkspaceSnapshot,
  workspaceSnapshotKey,
} from "../features/workspace/model/workspaceSnapshot";
import type { InstalledUpdate } from "./model/updateNotice";

import {
  bindResumedSessions,
  bindRestoredHarness,
  closeBusyWindow,
  closeCurrentWindow,
  confirmReload,
  hasInFlightSessions,
  hideCurrentWindow,
  isAppQuitting,
  persistLiveTranscripts,
  persistQuitState,
  reapWindowRuntime,
  setQuitWorkspace,
  type ResumedWorkspace,
} from "./model/appLifecycle";
import { wireSpendGate } from "../features/usage/model/spendWiring";

/** WP-156: the project's standing answers as one block (the app answers "" while standing answers are off). */
const readStandingBrief = (project: string): Promise<string> => invoke<string>("decisions_standing_brief", { project });

const SearchView = lazySurface(
  async () => {
    const module = await import("../features/search/ui/SearchView");
    return { default: module.SearchView };
  },
  { suspense: false },
);
const SettingsView = lazySurface(
  async () => {
    const module = await import("../features/settings/ui/SettingsView");
    return { default: module.SettingsView };
  },
  { suspense: false },
);
const InboxView = lazySurface(
  async () => {
    const module = await import("../features/inbox/ui/InboxView");
    return { default: module.InboxView };
  },
  { suspense: false },
);
const LinkedWorkItemPanel = lazySurface(async () => {
  const module = await import("../features/inbox/ui/InboxView");
  return { default: module.LinkedWorkItemPanel };
});
const NotesView = lazySurface(
  async () => {
    const module = await import("../features/notes/ui/NotesView");
    return { default: module.NotesView };
  },
  { suspense: false },
);
const PagesView = lazySurface(async () => {
  const module = await import("../features/pages/ui/PagesView");
  return { default: module.PagesView };
}, { suspense: false });
// WP-33: plugin panels open as tabs beside Pages.
const PanelTabsScreen = lazySurface(async () => {
  const module = await import("../features/panels/ui/PanelTabs");
  return { default: module.PanelTabsScreen };
}, { suspense: false });
const AutomationsView = lazySurface(
  async () => {
    const module = await import("../features/automations/ui/AutomationsView");
    return { default: module.AutomationsView };
  },
  { suspense: false },
);

type LinkedWorkItemPanelState = {
  item: LinkedWorkItem;
  sessionId: string;
  cwd: string;
};

type SubmitOptions = ComposerTurnOptions & {
  /**
   * Who started the turn, for the spend gate. Only the composer and the quick composer say "person". Every other caller
   * (habits, automations, agent apps, wakes, continue prompts, first-mate steers) leaves it out, so it is automated.
   */
  origin?: TurnOrigin;
  ciRepair?: CiRepairRequest;
  /** Saved alongside the user turn; does not replace the submitted prompt. */
  ciContext?: string;
  secondOpinion?: SecondOpinionMeta;
  followUpBehavior?: FollowUpBehavior;
  noteCard?: NoteComposerCard;
  handoffCard?: HandoffComposerCard;
  queuedMessageId?: string;
  planBlockId?: string;
  buildTarget?: PlanBuildTarget;
  managed?: boolean;
  orchestrationRetry?: OrchestrationProposal;
  appRequestId?: string;
  /** An app request that may arrive mid-turn, steering or queuing as one typed here would. */
  followsUp?: boolean;
  /** A brief that must wait behind the current work (queued, sent as its own turn once idle; never steered). */
  waitForIdle?: boolean;
  monoSessionCompletion?: Block["monoSessionCompletion"];
  /** A checker's note for this chat (hub/model/hubChecks.ts): a hidden turn shown as a quiet card. */
  monoCheck?: Block["monoCheck"];
  /** A room's turn or another Mono's message (hub rooms): a hidden turn shown as a quiet line. */
  monoNote?: Block["monoNote"];
  onSettled?: (outcome: ControlOutcome) => void;
  /** r84 (s14): Ash's own message to a worker whose job is open; its turn carries a note that his words decide. */
  ashToWorker?: boolean;
  /** The turn was committed to the session (its user block is in). */
  onStarted?: () => void;
  /**
   * An automatic resume after a restart, and which one (1 = the first). Kept on the session (`autoResumes`) and in
   * its in-flight row; any other turn starts the count again from none.
   */
  autoResume?: number;
  /** Generate a fresh title even when this is not the session's first turn. */
  refreshTitle?: boolean;
  /** Internal guard for the retry after resolving a renamed project. */
  projectLocationReady?: boolean;
};

type Submit = (
  sessionId: string,
  text: string,
  attachments?: Attachment[],
  options?: SubmitOptions,
) => SubmissionAcceptance;

function withPlanStatus(
  session: Session,
  blockId: string,
  status: PlanStatus,
): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.id === blockId && block.role === "plan"
        ? {
            ...block,
            plan: { ...(block.plan ?? { status: "ready" }), status },
          }
        : block,
    ),
  };
}

function lastAssistantTextInTurn(session: Session): string {
  for (let index = session.blocks.length - 1; index >= 0; index -= 1) {
    const block = session.blocks[index];
    if (session.queuedMessages?.some((message) => message.blockId === block.id))
      continue;
    if (block.role === "user") return "";
    if (block.role === "assistant" && block.text.trim()) return block.text;
  }
  return "";
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function userTurnCards(
  noteCard: NoteComposerCard | undefined,
  secondOpinion?: SecondOpinionMeta,
) {
  if (!noteCard && !secondOpinion) return undefined;
  return {
    ...(secondOpinion ? { secondOpinion } : {}),
    ...(noteCard ? { noteCard: noteCardMeta(noteCard) } : {}),
  };
}

function withPlanBuildTarget(
  session: Session,
  target: PlanBuildTarget,
): Session {
  const resolved = resolveModel(target.harness, target.model);
  const modelSettings = mergeModelSettings(resolved, target.modelSettings);
  // WP-121: the same switch the picker uses, including a resume or a labelled recap.
  return applyMidThreadSwitch(session, {
    harness: target.harness,
    model: resolved.id,
    modelSettings,
  }).session;
}

function openSessionIds(tabs: WorkspaceTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    for (const id of leafIds(tab.layout)) ids.add(id);
  }
  return ids;
}

function filesInWorkspaceTabs(tabs: readonly WorkspaceTab[]): FilePaneTab[] {
  return tabs.flatMap((tab) => [
    ...tab.editorPanes.flatMap((pane) => pane.files),
    ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
  ]);
}

/** Stable empty tab list for the title bar while a Mono is in full view. */
const NO_TITLE_TABS: [] = [];

/** Native sheet. `window.confirm` is swallowed when a macOS menu accelerator fires. */
function confirmDiscardUnsaved(message: string): Promise<boolean> {
  return ask(message, { title: "MonoCode", kind: "warning" });
}

function titleTabsEqual(a: TitleTab[], b: TitleTab[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tab, index) => {
    const other = b[index];
    return (
      other != null &&
      tab.id === other.id &&
      tab.appView === other.appView &&
      tab.mono?.mascot === other.mono?.mascot &&
      tab.mono?.color === other.mono?.color &&
      tab.mono?.status === other.mono?.status &&
      tab.project === other.project &&
      tab.title === other.title &&
      tab.sessionCount === other.sessionCount &&
      tab.dirty === other.dirty &&
      tab.more.join("\u0000") === other.more.join("\u0000") &&
      tab.harnesses.join("\u0000") === other.harnesses.join("\u0000") &&
      tab.busyHarnesses.join("\u0000") === other.busyHarnesses.join("\u0000") &&
      (tab.doneHarnesses ?? []).join("\u0000") ===
        (other.doneHarnesses ?? []).join("\u0000") &&
      tab.files.join("\u0000") === other.files.join("\u0000") &&
      tab.multiPane === other.multiPane &&
      tab.fileFocused === other.fileFocused &&
      tab.blank === other.blank &&
      tab.terminal === other.terminal &&
      tab.previewFileId === other.previewFileId &&
      tab.groupId === other.groupId
    );
  });
}

// Register capabilities before composer hooks choose their discovery strategy.
registerBuiltinHarnesses();
// E7: new coding-team chats start on DeepSeek, High, when it is set up (hub/model/codingTeamModel.ts).
installCodingTeamDefault();

type AppProps = {
  windowTransfer?: WindowTransferPayload | null;
  resumed?: ResumedWorkspace | null;
  installedUpdate?: InstalledUpdate | null;
  history?: SessionSummary[];
  historyCwd?: string | null;
};

/** The worktree a project's workspace currently shows. */
function currentWorkspace(project: string): string {
  return worktreeFocus(project)?.path ?? project;
}

/**
 * The hub project whose coding team this chat is in, noted the first time (hub/model/codingTeam.ts): a top-level chat
 * in a hub project's code folder. None in plain MonoCode.
 */
function codingTeamOf(session: Session): HubProject | undefined {
  if (!codingTeamsOn()) return undefined;
  const projects = hubData().listProjects();
  const noted = codingTeamChatProject(session.id);
  if (noted) return projects.find((project) => project.id === noted && !!project.folder);
  const project = codingTeamProjectFor(session, projects, { isMono: isMonoSession, isHabitRun });
  if (project) noteCodingTeamChat(session.id, project.id);
  return project;
}

/**
 * The coding team a project's Lead lives in: its project, when that has a code folder (Ash, 20 Oct: the coding team is
 * the main place he talks, and the Lead is its default chat). None in plain MonoCode, or for any other Mono.
 */
function leadCodingTeam(monoId: string): HubProject | undefined {
  if (!codingTeamsOn()) return undefined;
  const lead = leadFor(monoId);
  return lead
    ? hubData()
        .listProjects()
        .find((project) => project.id === lead.projectId && !!project.folder)
    : undefined;
}

// WP-176: the spend gate reads the hub ids and the Mono and habit registries. Wired once, at module load.
wireSpendGate();

export default function App(props: AppProps) {
  return (
    <Suspense fallback={null}>
      {/* WP-43: Stop stays visible while a browser is showing. */}
      <DrivingBar />
      <Workspace {...props} />
    </Suspense>
  );
}

function Workspace({
  windowTransfer = null,
  resumed = null,
  installedUpdate = null,
  history: bootHistory = [],
  historyCwd: bootHistoryCwd = null,
}: AppProps) {
  const [projectCwd, setProjectCwd] = useState(
    () =>
      windowTransfer?.projectCwd ??
      resumed?.projectCwd ??
      lastProjectPath() ??
      "~",
  );
  const [recents, setRecents] = useState(() =>
    resumed?.projectCwd && looksLikeProject(resumed.projectCwd)
      ? rememberProject(resumed.projectCwd)
      : loadRecents(),
  );
  const [seed] = useState(() => {
    const cwd = lastProjectPath() ?? "~";
    const session = newDefaultSession(cwd);
    const tab = newTab(session.id);
    return { session, tab };
  });
  const { sessions, setSessions, sessionsRef, store: sessionState } =
    useWorkspaceSessionState(
      () => windowTransfer?.sessions ?? resumed?.sessions ?? [seed.session],
    );
  // WP-110: the first chat in a new window follows the worktree setting.
  useEffect(() => {
    if (!sessionsRef.current.some((session) => session.id === seed.session.id)) return;
    attachNewChatWorktree(seed.session.id, seed.session.cwd, setSessions);
  }, [seed.session.cwd, seed.session.id, sessionsRef, setSessions]);
  // The app's Try again, lent to harness self-repair (features/monos/model/harnessRepair.ts): the same path as the
  // failure card's button, so a retried turn sends Ash's held message, its unsent one, or carries on.
  const retryFailedTurnRef = useRef<(sessionId: string) => boolean>(() => false);
  const [sessionDeleteDialog, setSessionDeleteDialog] = useState<{
    title: string;
    unusedWorktree?: string;
    worktreeTicked?: boolean;
    resolve: (choice: SessionDeleteChoice) => void;
  }>();
  const switchingWorktrees = useRef(new Map<string, string>());
  const removingWorktreePaths = useRef(new Set<string>());
  const deleteConfirmationPending = useRef(false);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(
    () => windowTransfer?.tabs ?? resumed?.tabs ?? [seed.tab],
  );
  const [projectTerminals, setProjectTerminals] = useState<ProjectTerminal[]>(
    () => windowTransfer?.projectTerminals ?? resumed?.projectTerminals ?? [],
  );
  /** Dock side a brand-new project's terminal starts with, persisted in the workspace snapshot. */
  const [lastDockSide, setLastDockSide] = useState<DockSide | null>(
    () => resumed?.lastDockSide ?? null,
  );
  const lastDockSideRef = useRef(lastDockSide);
  lastDockSideRef.current = lastDockSide;
  const [projectTerminalFocused, setProjectTerminalFocused] = useState(false);
  const [activeTabId, setActiveTabIdState] = useState(
    () => windowTransfer?.activeTabId ?? resumed?.activeTabId ?? seed.tab.id,
  );
  const [monoViewId, setMonoViewId] = useState<string | null>(null);
  // A Mono opens with its overview beside the chat until it is hidden.
  const [monoOverviewOpen, setMonoOverviewOpen] = useState(true);
  const [monoOverviewTab, setMonoOverviewTab] =
    useState<MonoOverviewTab>("sessions");
  const monoOverviewOpenRef = useRef(monoOverviewOpen);
  monoOverviewOpenRef.current = monoOverviewOpen;
  const monoOverviewTabRef = useRef(monoOverviewTab);
  monoOverviewTabRef.current = monoOverviewTab;
  // The Mono whose settings dialog is open; another Mono's view closes it.
  const [monoSettingsFor, setMonoSettingsFor] = useState<string | null>(null);
  // A document opened from the chat shows on the overview's Documents tab,
  // the same page the tab opens it on.
  const onOpenMonoArtifact = useCallback((_sessionId: string, id: string) => {
    setMonoShownSession(null);
    setMonoOverviewDocument(id);
    setMonoOverviewTab("documents");
    setMonoOverviewOpen(true);
  }, []);
  // What the overview's Changes tab was last asked to show.
  const [monoChangesRequest, setMonoChangesRequest] =
    useState<MonoChangesRequest>({});
  useEffect(() => {
    const listening = listen<string>(
      ARTIFACT_DELETED_EVENT,
      ({ payload: id }) => {
        const previous = sessionsRef.current;
        const updated = previous.map((session) =>
          removeArtifactCard(session, id),
        );
        if (updated.some((session, index) => session !== previous[index])) {
          sessionsRef.current = updated;
          setSessions(updated);
        }
        setMonoOverviewDocument((current) => (current === id ? null : current));
      },
    );
    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, []);
  const [monoActivity, setMonoActivity] =
    useState<MonoActivitySelection | null>(null);
  // A launched session or a document open over the overview's list. Hiding
  // the overview leaves them, so it opens on its list again.
  const [monoShownSession, setMonoShownSession] = useState<string | null>(null);
  const [monoOverviewDocument, setMonoOverviewDocument] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (monoOverviewOpen) return;
    setMonoShownSession(null);
    setMonoOverviewDocument(null);
  }, [monoOverviewOpen]);
  // Whether the shown session, rather than the Mono's chat, holds focus.
  const [monoShownSessionFocused, setMonoShownSessionFocused] = useState(false);
  const shownMonoSessionId =
    monoViewId && monoOverviewOpen && monoShownSession
      ? monoShownSession
      : undefined;
  const shownMonoSessionIdRef = useRef(shownMonoSessionId);
  shownMonoSessionIdRef.current = shownMonoSessionId;
  // A turn's activity shows on the overview's Activity tab; picking the shown
  // one again clears it.
  const onShowMonoActivity = useCallback(
    (sessionId: string, turnId: string, blocks: Block[]) => {
      const shown =
        monoOverviewOpenRef.current &&
        monoOverviewTabRef.current === "activity";
      setMonoShownSession(null);
      setMonoOverviewDocument(null);
      setMonoOverviewTab("activity");
      setMonoOverviewOpen(true);
      setMonoActivity((previous) =>
        shown && previous?.sessionId === sessionId && previous.turnId === turnId
          ? null
          : { sessionId, turnId, blocks },
      );
    },
    [],
  );
  const monoViewIdRef = useRef(monoViewId);
  monoViewIdRef.current = monoViewId;
  const monoViewRequest = useRef(0);
  // WP-06: opening the coding team reveals the project's own pane, and that pane taking focus would cancel the
  // Lead's open (onFocusPane). Held until the focus from this open has passed; a real chat pick still closes it.
  const openingMono = useRef(false);
  const openingMonoGen = useRef(0);
  const closeMonoView = useCallback(() => {
    monoViewRequest.current += 1;
    monoViewIdRef.current = null;
    saveOpenMono(undefined);
    setMonoViewId(null);
    setMonoActivity(null);
  }, []);
  const [composerFocused, setComposerFocused] = useState(() => {
    if (windowTransfer) return true;
    if (!resumed) return false;
    const tab =
      resumed.tabs.find((entry) => entry.id === resumed.activeTabId) ??
      resumed.tabs[0];
    return (
      !!tab && resumed.sessions.some((session) => session.id === tab.focusedId)
    );
  });
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  /** Tab id -> project name, kept in sync with the rendered title tabs. */
  const tabProjectsRef = useRef(new Map<string, string>());
  const displayedTabNavigation = useRef<{
    tabs: readonly TitleTab[];
    activeId: string;
    select?: (id: string) => void;
  }>({ tabs: [], activeId: "" });
  const projectOfTab = useCallback(
    (id: string) => tabProjectsRef.current.get(id),
    [],
  );
  const [projectRailOpen, setProjectRailOpen] = useState(loadProjectRailOpen);
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(
    loadSessionSidebarOpen,
  );
  const tabCloseScope = "project" as const;
  const currentProjectDock = findProjectTerminal(projectTerminals, projectCwd);
  const dockVisible = !!currentProjectDock?.open;
  const [filesSearchOpen, setFilesSearchOpen] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [searchViewOpen, setSearchViewOpen] = useState(false);
  const [searchViewFocusToken, setSearchViewFocusToken] = useState(0);
  const [inboxViewOpen, setInboxViewOpen] = useState(false);
  const [linkedWorkItemPanels, setLinkedWorkItemPanels] = useState<
    ReadonlyMap<string, LinkedWorkItemPanelState>
  >(() => new Map());
  const linkedWorkItemPanelRequest = useRef(0);
  const closeLinkedWorkItemPanel = useCallback((sessionId: string) => {
    linkedWorkItemPanelRequest.current += 1;
    setLinkedWorkItemPanels((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);
  const [inboxAskPortal, setInboxAskPortal] =
    useState<InboxSessionPortal | null>(null);
  const openingInboxSessions = useRef(new Map<string, Promise<string>>());
  const [notesViewOpen, setNotesViewOpen] = useState(false);
  const [automationsViewOpen, setAutomationsViewOpen] = useState(false);
  // Ship (src-tauri/src/ship.rs): a build on trial holds auto-resume, habits and automations until it commits.
  const shipHold = useShipStatus().holding;
  const shipHoldRef = useRef(shipHold);
  shipHoldRef.current = shipHold;
  useEffect(() => {
    // The workspace is drawn: a build on trial now checks its database and hub bridge, then commits.
    void reportShipReady();
  }, []);
  /** Pages rides on the Automations view slot, so every place that closes Automations also closes Pages. */
  const [pagesMode, setPagesMode] = useState(false);
  const [openAppViews, setOpenAppViews] = useState<AppView[]>([]);
  // Monos open as title tabs in the inset layout, by Mono id.
  const [openMonoTabs, setOpenMonoTabs] = useState<string[]>([]);
  const [titleTabOrder, setTitleTabOrder] = useState(() =>
    tabs.map((tab) => tab.id),
  );
  const activeAppView: AppView | undefined = searchViewOpen
    ? "search"
    : inboxViewOpen
      ? "inbox"
      : notesViewOpen
        ? "notes"
        : automationsViewOpen
          ? "automations"
          : undefined;
  const rememberAppView = useCallback((view: AppView) => {
    setOpenAppViews((current) =>
      current.includes(view) ? current : [...current, view],
    );
  }, []);
  const [inspectedWorkerId, setInspectedWorkerId] = useState<string | null>(
    null,
  );
  // Set while the lead's tab is still opening; the agent tab lands on the
  // commit that brings it in.
  const [workerDetailRequest, setWorkerDetailRequest] = useState<{
    leadId: string;
    workers: OrchestrationWorkerDetail[];
  } | null>(null);
  const orchestrationRuns = useSyncExternalStore(
    orchestrator.subscribe,
    orchestrator.snapshot,
    orchestrator.snapshot,
  );
  const notesEnabled = useSyncExternalStore(
    subscribeNotesEnabled,
    loadNotesEnabled,
    () => true,
  );
  const liveAgentsEnabled = useSyncExternalStore(
    subscribeLiveAgentsEnabled,
    loadLiveAgentsEnabled,
    () => true,
  );
  const [collapsedProjectRailMode, setCollapsedProjectRailMode] =
    useState<CollapsedProjectRailMode>(loadCollapsedProjectRailMode);
  const insetLayout = useSyncExternalStore(
    subscribeInsetLayout,
    loadInsetLayout,
    () => INSET_LAYOUT_DEFAULT,
  );
  const [insetRailHost, setInsetRailHost] = useState<HTMLDivElement | null>(
    null,
  );
  // Where Settings puts its breadcrumb and actions in the inset title bar.
  const [settingsHeaderHost, setSettingsHeaderHost] =
    useState<HTMLDivElement | null>(null);
  const insetLayoutRef = useRef(insetLayout);
  insetLayoutRef.current = insetLayout;
  // The inset layout's project tools beside the card.
  const [rightPanelHost, setRightPanelHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [rightPanelOpen, setRightPanelOpenState] = useState(loadRightPanelOpen);
  const [rightPanelTab, setRightPanelTabState] =
    useState<RightPanelTab>(loadRightPanelTab);
  // A closed panel keeps its contents until it has slid out.
  const [rightPanelClosing, setRightPanelClosing] = useState(false);
  const rightPanelOpenRef = useRef(rightPanelOpen);
  rightPanelOpenRef.current = rightPanelOpen;
  const showRightPanel = useCallback((tab: RightPanelTab) => {
    setRightPanelTabState(tab);
    saveRightPanelTab(tab);
    setRightPanelOpenState(true);
    setRightPanelClosing(false);
    saveRightPanelOpen(true);
  }, []);
  // WP-15: a brief line opens the Crew tab. Classic uses the sidebar; the inset layout uses its panel.
  const openCrewTab = useRef<() => void>(() => {});
  useEffect(() => {
    const onCrew = () => openCrewTab.current();
    window.addEventListener(OPEN_CREW, onCrew);
    return () => window.removeEventListener(OPEN_CREW, onCrew);
  }, []);
  const onToggleRightPanel = useCallback(() => {
    const next = !rightPanelOpenRef.current;
    rightPanelOpenRef.current = next;
    saveRightPanelOpen(next);
    setRightPanelOpenState(next);
    setRightPanelClosing(!next);
  }, []);
  // Its handle sits on the left edge, so dragging left widens it.
  const rightPanelResize = useDragResize({
    direction: "left",
    min: RIGHT_PANEL_WIDTH_MIN,
    max: () =>
      Math.min(RIGHT_PANEL_WIDTH_MAX, Math.floor(window.innerWidth * 0.5)),
    defaultWidth: RIGHT_PANEL_WIDTH_DEFAULT,
    initial: loadRightPanelWidth(),
    onCommit: saveRightPanelWidth,
  });
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const setRightPanelPane = rightPanelResize.setPaneRef;
  const setRightPanelRef = useCallback(
    (el: HTMLDivElement | null) => {
      rightPanelRef.current = el;
      setRightPanelPane(el);
    },
    [setRightPanelPane],
  );
  const rightPanelAnimation = useRef<Animation | null>(null);
  const endRightPanelTransition = useRef<(() => void) | null>(null);
  const rightPanelWasOpen = useRef(rightPanelOpen);
  useLayoutEffect(() => {
    applyInsetLayout(insetLayout);
  }, [insetLayout]);
  // The title bar's navigation spans the open rail, so its tabs line up with
  // the card. Written straight to the shell to follow a rail drag per frame.
  useLayoutEffect(() => {
    const host = insetRailHost;
    const shell = host?.closest<HTMLElement>(".inset-shell");
    if (!host || !shell) return;
    const sync = () =>
      shell.style.setProperty("--inset-rail-width", `${host.offsetWidth}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--inset-rail-width");
    };
  }, [insetRailHost]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsReturnViewRef = useRef({
    search: false,
    inbox: false,
    notes: false,
    automations: false,
  });
  const [updateNotice, setUpdateNotice] = useState(installedUpdate);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const monosEnabled = useSyncExternalStore(
    subscribeMonosEnabled,
    loadMonosEnabled,
    () => true,
  );
  const monosSnap = useSyncExternalStore(subscribeMonos, monosSnapshot);
  // A deleted Mono, or Monos turned off, drop their tabs.
  const shownMonoTabs = useMemo(
    () =>
      insetLayout && monosEnabled
        ? openMonoTabs.filter((monoId) => findMono(monoId))
        : [],
    // The roster is read through its snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insetLayout, monosEnabled, openMonoTabs, monosSnap],
  );
  useLayoutEffect(() => {
    if (!insetLayout) return;
    setTitleTabOrder((order) =>
      reconcileTitleTabOrder(order, [
        ...tabs.map((tab) => tab.id),
        ...openAppViews.map(appViewTabId),
        ...shownMonoTabs.map(monoTabId),
      ]),
    );
  }, [insetLayout, tabs, openAppViews, shownMonoTabs]);
  /** A Mono hides the terminal, so reaching for one leaves it. */
  const leaveCoveringMono = useCallback(() => {
    if (monoViewIdRef.current) closeMonoView();
  }, [closeMonoView]);
  const [providerSignInRequest, setProviderSignInRequest] = useState<{
    key: string;
    sessionId: string;
    harness: HarnessId;
  } | null>(null);
  const seenProviderSignInRequestsRef = useRef<Set<string> | null>(null);
  const seenProviderSignInRequests =
    seenProviderSignInRequestsRef.current ??
    (seenProviderSignInRequestsRef.current = new Set(
      sessions.flatMap((session) => {
        if (
          !supportsHarnessLogin(session.harness) ||
          !latestTurnNeedsHarnessLogin(session.blocks)
        ) {
          return [];
        }
        return [providerSignInRequestKey(session)];
      }),
    ));
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>(loadSettingsSection);
  const [settingsAnchor, setSettingsAnchor] = useState<SettingsAnchor | null>(
    null,
  );
  const [notificationProjectPath, setNotificationProjectPath] = useState<
    string | null
  >(null);
  const [notificationSettingsRequest, setNotificationSettingsRequest] =
    useState(0);
  const [editorNavigation, setEditorNavigation] =
    useState<EditorNavigationTarget | null>(null);
  const editorNavigationToken = useRef(0);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerInitialQuery, setFilePickerInitialQuery] = useState("");
  const [filePickerResetToken, setFilePickerResetToken] = useState(0);
  // WP-74: ⌘K and ⌘⇧P use the finder. ⌘P stays go to file.
  const [finderMode, setFinderMode] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(
    () => new Set(windowTransfer?.dirtyFileIds ?? []),
  );
  // Not carried across a window transfer the way dirty state is: the editor
  // re-lints whatever it mounts, so the counts rebuild themselves.
  const [fileErrorCounts, setFileErrorCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [history, setHistory] = useState<SessionSummary[]>(() => bootHistory);
  const [, refreshRemoteTabTitles] = useState(0);
  useEffect(() => {
    const updated = () => refreshRemoteTabTitles((value) => value + 1);
    window.addEventListener(REMOTE_HISTORY_UPDATED, updated);
    return () => window.removeEventListener(REMOTE_HISTORY_UPDATED, updated);
  }, []);
  const [storedLinkedSessions, setStoredLinkedSessions] = useState<
    SessionSummary[]
  >(() => bootHistory.filter((session) => session.linkedWorkItem));
  /**
   * Projects whose rows are already in `history`. This has to be state, not a
   * ref: `sidebarCwd` is derived during render, so the frame that first shows
   * a new project must already know the listing has not arrived yet.
   */
  const btwRequestsRef = useRef(
    new Map<string, { sessionId: string; controller: AbortController }>(),
  );
  const [loadedProjects, setLoadedProjects] = useState<ReadonlySet<string>>(
    () =>
      bootHistoryCwd
        ? new Set([normalizeProjectPath(bootHistoryCwd)])
        : new Set(),
  );
  const loadedProjectsRef = useRef(loadedProjects);
  loadedProjectsRef.current = loadedProjects;
  /** Project whose listing failed, so the error cannot leak to another one. */
  const [historyErrorCwd, setHistoryErrorCwd] = useState<string | null>(null);

  const linkedSessionUpdatesRef = useRef<
    ReadonlyMap<string, LinkedSessionUpdate>
  >(new Map());
  const linkedWorkItemActivityFetches = useRef(new Map<string, number>());
  const queueDispatchingRef = useRef(new Set<string>());
  const [queueDispatchVersion, setQueueDispatchVersion] = useState(0);
  const mobileUsageActions = useRef<{ resume: (id: string) => Promise<boolean>; automatic: (id: string, enabled: boolean) => void } | null>(null);
  const mobileUsagePending = useRef(new Set<string>());
  const usageResumingRef = useRef(new Set<string>());
  const usageResetLookups = useRef(new WeakSet<UsageLimit>());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirtyFilesRef = useRef(dirtyFiles);
  dirtyFilesRef.current = dirtyFiles;
  const projectTerminalsRef = useRef(projectTerminals);
  projectTerminalsRef.current = projectTerminals;
  const projectTerminalFocusedRef = useRef(projectTerminalFocused);
  projectTerminalFocusedRef.current = projectTerminalFocused;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  useLayoutEffect(() => commitTabSwitch(activeTabId), [activeTabId]);

  useLayoutEffect(() => {
    const migration = detachMonoTabs(
      tabs,
      sessions,
      activeTabId,
      projectCwd,
      (cwd) => newDefaultSession(cwd),
    );
    if (!migration) return;
    tabsRef.current = migration.tabs;
    sessionsRef.current = [...sessions, ...migration.addedSessions];
    setTabs(migration.tabs);
    setSessions(sessionsRef.current);
    setActiveTabIdState(migration.activeTabId);
    if (migration.agentViewId) {
      monoViewIdRef.current = migration.agentViewId;
      setMonoViewId(migration.agentViewId);
    }
  }, [tabs, sessions, activeTabId, projectCwd]);

  const projectWorktree = useWorktreeFocus(projectCwd);
  /** Tab or session id -> the workspace it was opened or moved in. A tab
   * belongs to the workspace it was opened in, whatever worktree it runs in:
   * opening a session, or moving one from its composer, never switches the
   * workspace. Unpinned tabs (restored ones) group by their own worktree. */
  // Only the default workspace's tabs were saved, so every restored tab
  // belongs to it, including one its composer moved to a worktree.
  const [restoredPins] = useState(
    () =>
      new Map(
        tabs.flatMap((tab) => {
          const project = workspaceTabCwd(tab, sessions);
          return project && !isRemoteProjectPath(project)
            ? [[tab.id, project] as const]
            : [];
        }),
      ),
  );
  const workspacePins = useRef(restoredPins);
  const tabWorkspace = useCallback(
    (tab: WorkspaceTab, list: readonly Session[]) => {
      const pinnedTab = workspacePins.current.get(tab.id);
      if (pinnedTab) return pinnedTab;
      for (const id of leafIds(tab.layout)) {
        const pinned = workspacePins.current.get(id);
        if (pinned) return pinned;
      }
      return workspaceTabWorktree(tab, list);
    },
    [],
  );
  const tabWorktreeOf = useCallback(
    (tab: WorkspaceTab) => tabWorkspace(tab, sessionsRef.current),
    [tabWorkspace],
  );
  /** Saved tabs: the app reopens on each project's default workspace, so
   * tabs from other worktrees close with it instead of piling up. */
  const keepWorkspaceTab = useCallback(
    (tab: WorkspaceTab) => {
      const project = workspaceTabCwd(tab, sessionsRef.current);
      if (!project || isRemoteProjectPath(project)) return true;
      const workspace = tabWorkspace(tab, sessionsRef.current);
      return !workspace || sameProjectPath(workspace, project);
    },
    [tabWorkspace],
  );

  const workspaceNavigation = useWorkspaceNavigation({
    project: projectCwd,
    activeTabId,
    tabs,
    sessions,
    pins: workspacePins.current,
    tabWorkspace,
    moveSession: (id, tree, isCurrent) =>
      onWorktreeChange(id, tree, false, isCurrent),
    activateTab: (id) => {
      if (tabsRef.current.some((tab) => tab.id === id)) {
        activateTab(id, undefined, "workspace");
      } else {
        // A newly created tab has not rendered into tabsRef yet.
        closeMonoView();
        setActiveTabIdState(id);
        setComposerFocused(true);
      }
    },
    createTab: (project, focus) => createWorkspaceTab(project, focus),
  });
  // Every ordinary tab activation supersedes an unfinished workspace request,
  // including opening a session in the same tab or selecting a project.
  const setActiveTabId = useCallback(
    (id: string) => {
      workspaceNavigation.cancel();
      closeMonoView();
      setActiveTabIdState(id);
    },
    [workspaceNavigation.cancel, closeMonoView],
  );

  const projectCwdRef = useRef(projectCwd);
  projectCwdRef.current = projectCwd;
  const searchViewOpenRef = useRef(searchViewOpen);
  searchViewOpenRef.current = searchViewOpen;
  const inboxViewOpenRef = useRef(inboxViewOpen);
  inboxViewOpenRef.current = inboxViewOpen;
  const foregroundSurfaceRef = useRef<{
    workspaceVisible: boolean;
    standaloneSessionId?: string;
    /** A session shown beside the Mono's chat. */
    sideSessionId?: string;
  }>({ workspaceVisible: true });
  foregroundSurfaceRef.current = {
    workspaceVisible:
      !searchViewOpen &&
      !inboxViewOpen &&
      !notesViewOpen &&
      !automationsViewOpen &&
      !settingsOpen &&
      !monoViewId,
    standaloneSessionId: inboxViewOpen
      ? inboxAskPortal?.sessionId
      : !searchViewOpen &&
          !notesViewOpen &&
          !automationsViewOpen &&
          !settingsOpen
        ? (monoViewId ?? undefined)
        : undefined,
    sideSessionId:
      !inboxViewOpen &&
      !searchViewOpen &&
      !notesViewOpen &&
      !automationsViewOpen &&
      !settingsOpen
        ? shownMonoSessionId
        : undefined,
  };
  const notesViewOpenRef = useRef(notesViewOpen);
  notesViewOpenRef.current = notesViewOpen;
  const automationsViewOpenRef = useRef(automationsViewOpen);
  automationsViewOpenRef.current = automationsViewOpen;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const sessionNavigationIdsRef = useRef<readonly string[]>([]);
  const filePickerOpenRef = useRef(filePickerOpen);
  filePickerOpenRef.current = filePickerOpen;
  const whatsNewVersionRef = useRef(whatsNewVersion);
  whatsNewVersionRef.current = whatsNewVersion;
  useEffect(() => {
    const liveSessionIds = new Set(sessions.map((session) => session.id));
    for (const [key, request] of btwRequestsRef.current) {
      if (liveSessionIds.has(request.sessionId)) continue;
      request.controller.abort();
      btwRequestsRef.current.delete(key);
    }
  }, [sessions]);

  useEffect(
    () => () => {
      for (const request of btwRequestsRef.current.values()) {
        request.controller.abort();
      }
      btwRequestsRef.current.clear();
      void stopHarnessTextPrompts();
    },
    [],
  );

  useEffect(() => {
    if (!notesEnabled) setNotesViewOpen(false);
  }, [notesEnabled]);

  useEffect(
    () =>
      preloadNavigationWhenIdle([
        InboxView.preload,
        LinkedWorkItemPanel.preload,
        AutomationsView.preload,
        listAutomations,
        ...(notesEnabled ? [NotesView.preload, loadNotes] : []),
      ]),
    [notesEnabled],
  );

  const projectReturnRef = useRef<ProjectReturnMemory>(
    resumed?.projectReturnMemory ?? new Map(),
  );
  const readProjectReturnMemory = useCallback(() => {
    projectReturnRef.current = reconcileProjectReturn({
      memory: projectReturnRef.current,
      tabs: tabsRef.current,
      sessions: sessionsRef.current,
      activeTabId: activeTabIdRef.current,
    });
    return projectReturnRef.current;
  }, []);
  useEffect(() => {
    readProjectReturnMemory();
  }, [activeTabId, tabs, sessions, readProjectReturnMemory]);

  const tabVisitRef = useRef(emptyTabVisitHistory(activeTabId));
  const tabVisitFromHistoryRef = useRef(false);
  const [tabVisitNav, setTabVisitNav] = useState({
    canBack: false,
    canForward: false,
  });
  const turnGen = useRef(new Map<string, number>());
  // Chats the idle compact watcher holds busy, and the turn generation it took. WP-115.
  const idleCompactOwners = useRef(new Map<string, number>());
  const editedResends = useRef(createEditedResendCoordinator()).current;
  const lastPersisted = useRef(new Map<string, string>());
  const lastBoundProvider = useRef(new Map<string, string>());
  // Delegation rows (model/delegations.ts), set once useDelegations runs below; submitSession re-attaches through it.
  const delegationsRef = useRef<DelegationTracker | null>(null);
  // WP-143: what marks a chat as a crew's (crewSession.ts): the rows the UI reads and the ones this window launched since.
  const crewRows = () => [...delegationRows(), ...(delegationsRef.current?.known() ?? [])];
  // PR watches (features/pr-watch), set once usePrWatches runs below; the queue marks their wakes delivered.
  const prWatchesRef = useRef<PrWatchTracker | null>(null);
  // Hivra WP-11: the first mate's wake queue; the queue marks its drained turns delivered.
  const firstMateWakesRef = useRef<WakeQueue | null>(null);
  const lastPersistedUserBlock = useRef(new Map<string, string>());
  const inFlightSyncKey = useRef<string | null>(null);
  const sawInFlight = useRef(false);
  const workspaceSyncKey = useRef<string | null>(null);
  const observedSessions = useRef(new Map<string, Session>());
  const pendingPersist = useRef(new Map<string, Session>());
  const removingSessionIds = useRef(new Set<string>());
  const loadedSessionCache = useRef(new Map<string, Session>());
  const sessionLoads = useRef(new Map<string, Promise<Session | null>>());
  const sessionLoadEpochs = useRef(new Map<string, number>());
  const openingSessionIds = useRef(new Set<string>());
  const activeSessionPrefetch = useRef<Promise<Session | null> | null>(null);
  const [transcriptPool] = useState(() => new TranscriptPool());
  // Visible output advances per frame; hidden streams keep their own cadence.
  const [harnessEvents] = useState<HarnessEventQueue>(
    () =>
      new HarnessEventQueue(
        (sessionId) => {
          const tab = tabsRef.current.find(
            (entry) => entry.id === activeTabIdRef.current,
          );
          // Standalone conversations live outside the workspace tab tree.
          return (
            foregroundSurfaceRef.current.standaloneSessionId === sessionId ||
            foregroundSurfaceRef.current.sideSessionId === sessionId ||
            (foregroundSurfaceRef.current.workspaceVisible &&
              !!tab &&
              (leafIds(tab.layout).includes(sessionId) ||
                tab.editorPanes.some((pane) =>
                  pane.files.some(
                    (file) =>
                      file.id === pane.activeFileId &&
                      file.agent?.sessionId === sessionId,
                  ),
                )))
          );
        },
        (batches) => {
          const previous = sessionsRef.current;
          const textOnly = [...batches.values()].every((events) =>
            events.every(
              (event) => event.type === "message.delta" || event.type === "reasoning.delta",
            ),
          );
          const next = sessionState.update(
            (current) => {
              const updated = current.map((session) => {
                const events = batches.get(session.id);
                if (!events) return session;
                const updated = applyHarnessEvents(session, events);
                noteStreamApplied(
                  session.blocks, updated.blocks, events,
                  harnessEvents.isForeground(session.id),
                );
                return updated;
              });
              return updated.some(
                (session, index) => session !== current[index],
              )
                ? updated
                : current;
            },
            textOnly,
          );
          if (!textOnly && next !== previous) syncDockBadge(next);
        },
      ),
  );
  // Cap warm agent CLIs, sparing the conversations on screen.
  useEffect(() => {
    configureHarnessIdlePark({
      limit: loadIdleAgentLimit,
      keep: harnessEvents.isForeground,
    });
  }, [harnessEvents]);
  const skipForgetSessionIds = useRef(new Set<string>());
  const importedSessionsApplied = useRef(false);
  const projectLocationSyncs = useRef(
    new Map<string, ReturnType<typeof synchronizeProjectLocation>>(),
  );
  const submitAfterProjectSyncRef = useRef<Submit>(() => false);

  useEffect(() => {
    for (const project of recents) {
      void rememberProjectLocation(project.path).catch(() => undefined);
    }
  }, [recents]);

  useEffect(() => {
    if (importedSessionsApplied.current) return;
    const imported = windowTransfer?.sessions ?? resumed?.sessions;
    if (!imported?.length) return;
    importedSessionsApplied.current = true;
    for (const session of imported) {
      observedSessions.current.set(session.id, session);
      lastPersisted.current.set(session.id, persistFingerprint(session));
      const userId = lastUserBlockId(session);
      if (userId) lastPersistedUserBlock.current.set(session.id, userId);
      if (session.providerSessionId) {
        lastBoundProvider.current.set(session.id, session.providerSessionId);
      }
    }
  }, [windowTransfer, resumed]);

  const flushHarnessEvents = harnessEvents.flush;
  const flushForegroundHarnessEvents = harnessEvents.flushForeground;

  const stopSessionForRemoval = useCallback(
    async (sessionId: string): Promise<Session | undefined> => {
      await orchestrator.stopForSession(sessionId);
      const open = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (!open?.busy) return open;

      turnGen.current.set(sessionId, (turnGen.current.get(sessionId) ?? 0) + 1);
      flushHarnessEvents();
      await Promise.all(
        sessionChildHarnesses(open).map(async (harness) => {
          await cancelHarnessTurn(harness, sessionId).catch(() => undefined);
          await stopHarnessSession(harness, sessionId);
        }),
      );
      await finishSessionTurn(sessionId, sessionWorkCwd(open));
      flushHarnessEvents();
      return sessionsRef.current.find((session) => session.id === sessionId);
    },
    [flushHarnessEvents],
  );

  const enqueueHarnessEvent = harnessEvents.enqueue;

  useEffect(() => {
    if (resumed?.sessions.length) bindResumedSessions(resumed.sessions);
    const stopBridge = startHarnessBridge();
    const reap = () => {
      if (isAppQuitting()) return;
      void persistQuitState(
        sessionsRef.current,
        tabsRef.current,
        activeTabIdRef.current,
        projectCwdRef.current,
        readProjectReturnMemory(),
        "unload",
        projectTerminalsRef.current,
        lastDockSideRef.current ?? undefined,
      ).finally(() => {
        void reapWindowRuntime(
          sessionsRef.current,
          tabsRef.current,
          projectTerminalsRef.current,
        );
      });
    };
    window.addEventListener("pagehide", reap);
    window.addEventListener("beforeunload", reap);
    return () => {
      window.removeEventListener("pagehide", reap);
      window.removeEventListener("beforeunload", reap);
      stopBridge();
      harnessEvents.cancelScheduled();
    };
  }, [resumed, readProjectReturnMemory, harnessEvents]);

  useEffect(() => {
    let cancelled = false;
    // Retain known existing Mono threads before hiding their original entries.
    // Sending a turn uses the same migration lock, so it can safely overlap.
    void (async () => {
      for (const mono of listMonos()) {
        if (cancelled) return;
        if (!mono.sessionId) continue;
        try {
          const session =
            sessionsRef.current.find((s) => s.id === mono.sessionId) ??
            (await getSession(mono.sessionId));
          if (
            !session ||
            cancelled ||
            sessionsRef.current.find((s) => s.id === session.id)?.busy
          )
            continue;
          const cwd = sessionWorkCwd(session);
          if (!cwd || cwd === "~") continue;
          const threadIds = new Set<string>();
          if (session.harness === "codex" && session.providerSessionId)
            threadIds.add(session.providerSessionId);
          for (const block of session.blocks) {
            for (const thread of block.btwThreads ?? []) {
              if (
                (thread.harness ?? session.harness) === "codex" &&
                thread.providerThreadId
              )
                threadIds.add(thread.providerThreadId);
            }
          }
          for (const threadId of threadIds) {
            if (cancelled) return;
            await migrateMonoCodexSession({
              sessionId: session.id,
              threadId,
              cwd,
              providerAccountId: session.providerAccountId,
            });
          }
        } catch (error) {
          // Keep the original context intact; the next native operation retries.
          console.warn("Could not migrate saved Mono Codex context", error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monosSnap]);

  useEffect(() => {
    void probeHarnessAvailability();
    // Only the harnesses already in this window. Probing every installed CLI
    // at boot left unused agents (especially Pi) running in the background.
    const harnesses = [
      ...new Set(sessionsRef.current.map((session) => session.harness)),
    ];
    void refreshHarnessCatalogs(harnesses).then(() => {
      setSessions((prev) =>
        prev.map((session) => {
          if (!isLiveHarness(session.harness)) return session;
          const resolved = resolveModel(session.harness, session.model);
          const modelSettings = mergeModelSettings(
            resolved,
            session.modelSettings,
          );
          if (
            resolved.id === session.model &&
            sameSettings(modelSettings, session.modelSettings)
          ) {
            return session;
          }
          return { ...session, model: resolved.id, modelSettings };
        }),
      );
    });
  }, []);

  // A stale id falls back within the project, never to another project's tab.
  const activeTab =
    tabs.find((t) => t.id === activeTabId) ??
    filterTabsForProject(tabs, sessions, projectCwd)[0] ??
    tabs[0];
  const active =
    sessions.find((session) => session.id === activeTab?.focusedId) ??
    sessions.find(
      (session) => activeTab && leafIds(activeTab.layout).includes(session.id),
    );
  const monoViewSession = monoViewId
    ? sessions.find((session) => session.id === monoViewId)
    : undefined;
  const monoCovers = !!monoViewId;
  // The open Mono's title tab, in the inset layout.
  const monoViewTabId = useMemo(() => {
    const monoId = monoViewId ? monoForSession(monoViewId)?.id : undefined;
    return monoId ? monoTabId(monoId) : undefined;
    // The roster is read through its snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monoViewId, monosSnap]);
  const activeTabSessionIds = activeTab ? leafIds(activeTab.layout) : [];
  const activeLinkedWorkItemPanel = activeTab
    ? (linkedWorkItemPanels.get(activeTab.focusedId) ??
      [...linkedWorkItemPanels.values()]
        .reverse()
        .find((panel) => activeTabSessionIds.includes(panel.sessionId)) ??
      null)
    : null;

  // Panels are tab-local UI. Keep mounted panels alive while their tab is in
  // the workspace so switching away preserves the fetched issue and its UI
  // state, then discard them when their session leaves every open tab.
  useEffect(() => {
    const openSessionIds = new Set(tabs.flatMap((tab) => leafIds(tab.layout)));
    setLinkedWorkItemPanels((current) => {
      if ([...current.keys()].every((id) => openSessionIds.has(id))) {
        return current;
      }
      return new Map([...current].filter(([id]) => openSessionIds.has(id)));
    });
  }, [tabs]);

  const sessionDefaults = active ?? sessions[0];

  useEffect(() => {
    const openSessionForAddToChat = (event: Event) => {
      const detail = (event as CustomEvent<AddToChatRequest>).detail;
      if (!detail?.text) return;

      const result = applyAddToChatRequest({
        sessions: sessionsRef.current,
        tabs: tabsRef.current,
        activeTabId: activeTabIdRef.current,
        projectCwd: projectCwdRef.current,
        fallbackCwd: sessionDefaults?.cwd,
        defaultRuntimeMode: sessionDefaults?.runtimeMode,
        text: detail.text,
        mode: detail.mode,
      });
      if (!result) return;

      sessionsRef.current = result.sessions;
      tabsRef.current = result.tabs;
      setSessions(result.sessions);
      setTabs(result.tabs);
      setActiveTabId(result.activeTabId);
      setProjectTerminalFocused(false);
      setComposerFocused(true);
    };

    window.addEventListener(ADD_TO_CHAT_EVENT, openSessionForAddToChat);
    return () =>
      window.removeEventListener(ADD_TO_CHAT_EVENT, openSessionForAddToChat);
  }, [sessionDefaults?.cwd, sessionDefaults?.runtimeMode]);

  const activeSkillContext = active
    ? nativeSkillContextForSession(active)
    : null;
  const activeSkillCwd = activeSkillContext?.cwd;

  useEffect(() => {
    if (!activeSkillContext || !activeSkillCwd) return;
    warmNativeSkills(activeSkillContext);
  }, [activeSkillCwd, active?.id, active?.harness]);

  const activeFile = activeTab ? focusedFileTab(activeTab) : undefined;
  // A Mono belongs to no project, so its view keeps the project in place.
  const sidebarCwd =
    activeFile?.projectCwd ?? activeFile?.cwd ?? active?.cwd ?? projectCwd;
  const sidebarCwdRef = useRef(sidebarCwd);
  sidebarCwdRef.current = sidebarCwd;
  // Each inset space is one project, so its Inbox, Notes and Automations (and
  // the Inbox dot) show that project's items; the classic layout shows all.
  const appViewScope =
    insetLayout && looksLikeProject(sidebarCwd) ? sidebarCwd : undefined;
  const [sidebarTabSelection, setSidebarTabSelection] = useState<{
    project: string;
    tab: SidebarTabId;
  }>(() => ({
    project: pathKey(sidebarCwd),
    tab: loadProjectSidebarTab(sidebarCwd),
  }));
  const sidebarTab =
    sidebarTabSelection.project === pathKey(sidebarCwd)
      ? sidebarTabSelection.tab
      : loadProjectSidebarTab(sidebarCwd);
  const setSidebarTab = useCallback(
    (tab: SidebarTabId, project?: string) => {
      // Inset: Explorer and Changes open in the right panel; the sidebar stays
      // on the sessions.
      if (insetLayoutRef.current && (tab === "files" || tab === "changes")) {
        showRightPanel(tab);
        return;
      }
      const cwd = project ?? sidebarCwdRef.current;
      saveProjectSidebarTab(cwd, tab);
      setSidebarTabSelection({
        project: pathKey(cwd),
        tab: tab === "inbox" ? "sessions" : tab,
      });
    },
    [showRightPanel],
  );
  // WP-15: the brief line opens Crew in the sidebar Hivra actually shows.
  openCrewTab.current = () => {
    if (insetLayoutRef.current) showRightPanel("crew");
    else setSidebarTab("crew");
  };
  const sidebarCwdKey =
    sidebarCwd && sidebarCwd !== "~" ? normalizeProjectPath(sidebarCwd) : null;
  const historyFailed =
    sidebarCwdKey != null && historyErrorCwd === sidebarCwdKey;
  // True from the very first frame that shows a project we have never listed,
  // so the sidebar can stay blank instead of flashing "No sessions yet".
  const historyPending =
    sidebarCwdKey != null &&
    !loadedProjects.has(sidebarCwdKey) &&
    !historyFailed;
  const gitCwd =
    activeFile?.cwd ?? (active ? sessionWorkCwd(active) : sidebarCwd);
  const terminalCwd = newTerminalCwd({
    activeFile,
    session: active,
    fallback: sidebarCwd,
  });
  const gitCwdBranches = useProjectBranches(
    gitCwd,
    Boolean(gitCwd) && gitCwd !== "~" && !isRemoteProjectPath(sidebarCwd),
  );
  const explorerRootLabel =
    active?.worktreeCwd && sameProjectPath(gitCwd, sessionWorkCwd(active))
      ? active.branch || gitCwdBranches?.current || undefined
      : undefined;
  const remoteFilesProject = remoteProjectFor(sidebarCwd);
  // The host checkout the remote tab is aimed at — the attached session's
  // work path or a worktree picked before the first message.
  const remoteTabCheckout = remoteFilesProject
    ? remoteTabCwd(sidebarCwd, active?.id)
    : undefined;
  const filesCwd = remoteFilesProject
    ? isRemoteProjectPath(gitCwd)
      ? gitCwd
      : remotePath(
          remoteFilesProject.environmentId,
          remoteTabCheckout ??
            (gitCwd && gitCwd !== sidebarCwd ? gitCwd : remoteFilesProject.cwd),
        )
    : gitCwd;
  // Git follows the session's own work path (a linked worktree included),
  // never the terminal-following files cwd: a remote session working in a
  // separate worktree diffed the main checkout and showed "No file changes".
  const gitRootCwd = remoteFilesProject
    ? remoteSessionGitCwd(
        remoteFilesProject,
        gitCwd,
        sidebarCwd,
        remoteTabCheckout,
      )
    : gitCwd;
  const gitCwdRef = useRef(gitRootCwd);
  gitCwdRef.current = gitRootCwd;
  const projectBranches = useProjectBranches(
    sidebarCwd,
    Boolean(sidebarCwd) && sidebarCwd !== "~",
  );

  const nextBusySessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of sessions) {
      // A chat held for a background compact is not working: it must not spin
      // in the rail, publish a live turn, or read as finished when it ends.
      if (isTurnRunning(session)) {
        ids.add(session.id);
        if (session.orchestrationLeadId) ids.add(session.orchestrationLeadId);
      }
    }
    return ids;
  }, [sessions]);
  const busySessionIdsRef = useRef(nextBusySessionIds);
  if (!setsEqual(busySessionIdsRef.current, nextBusySessionIds)) {
    busySessionIdsRef.current = nextBusySessionIds;
  }
  const busySessionIds = busySessionIdsRef.current;
  // Other windows never saw Session.busy; the process union is what the rail reads.
  const liveBusySessionIds = useLiveTurns(busySessionIds);

  /** Probe the active session's harness for its live model catalog whenever
   * the active harness changes. Catalogs load lazily (probing spawns a CLI
   * process) and the boot refresh runs before restored sessions land, so a
   * fresh session would otherwise show only the built-in fallback model
   * until the picker happened to be opened. Idempotent: refreshHarnessCatalogs
   * dedupes via hasLiveCatalog and its inflight map. */
  const activeHarness = active?.harness;
  useEffect(() => {
    if (!activeHarness || !isLiveHarness(activeHarness)) return;
    void refreshHarnessCatalogs([activeHarness]);
  }, [activeHarness]);

  // The footer's usage follows what is in view: under the inset layout a
  // Mono's tab keeps the footer, which then reads the Mono's model.
  const usageSource =
    insetLayout && monoViewSession ? monoViewSession : active;
  const usageProviders = useMemo(() => {
    if (usageSource?.registryAgentId) return [];
    if (
      usageSource?.harness === "claude" ||
      usageSource?.harness === "codex" ||
      usageSource?.harness === "opencode" ||
      usageSource?.harness === "devin"
    ) {
      return [usageSource.harness];
    }
    return [];
  }, [usageSource?.harness, usageSource?.registryAgentId]);
  const usageSession = useMemo(() => {
    if (!usageSource) return undefined;
    return {
      id: usageSource.id,
      harness: usageSource.harness,
      ...(usageSource.registryAgentId ? { registryAgentId: usageSource.registryAgentId } : {}),
      model: usageSource.model,
      authRequired: latestTurnNeedsHarnessLogin(usageSource.blocks),
      providerAccountId:
        usageSource.providerAccountId ??
        (usageSource.blocks.some((block) => block.role === "user")
          ? DEFAULT_PROVIDER_ACCOUNT_ID
          : undefined),
    };
  }, [
    usageSource?.id,
    usageSource?.harness,
    usageSource?.registryAgentId,
    usageSource?.model,
    usageSource?.blocks,
    usageSource?.providerAccountId,
  ]);
  const activeProviderSignInRequest = useMemo(() => {
    if (
      !active ||
      !supportsHarnessLogin(active.harness) ||
      !latestTurnNeedsHarnessLogin(active.blocks)
    ) {
      return null;
    }
    return {
      key: providerSignInRequestKey(active),
      sessionId: active.id,
      harness: active.harness,
    };
  }, [active]);
  useEffect(() => {
    if (!activeProviderSignInRequest) return;
    if (seenProviderSignInRequests.has(activeProviderSignInRequest.key)) {
      return;
    }
    seenProviderSignInRequests.add(activeProviderSignInRequest.key);
    setProviderSignInRequest(activeProviderSignInRequest);
  }, [activeProviderSignInRequest, seenProviderSignInRequests]);
  useEffect(() => {
    if (
      providerSignInRequest &&
      active?.id !== providerSignInRequest.sessionId
    ) {
      setProviderSignInRequest(null);
    }
  }, [active?.id, providerSignInRequest]);
  const runningTerminals = useMemo(() => {
    const files: FilePaneTab[] = [];
    const dock = findProjectTerminal(projectTerminals, projectCwd);
    if (dock) files.push(...dock.pane.files);
    for (const tab of tabs) {
      for (const pane of tab.terminalPanes ?? []) {
        files.push(...pane.files);
      }
    }
    return listRunningTerminals(files);
  }, [projectCwd, projectTerminals, tabs]);
  const runningTerminalOpen = useMemo(() => {
    const ids = new Set(runningTerminals.map((terminal) => terminal.id));
    if (
      currentProjectDock?.open &&
      currentProjectDock.pane.files.some((file) => ids.has(file.id))
    ) {
      return true;
    }
    const focused = activeTab ? focusedFileTab(activeTab) : undefined;
    return !!focused && ids.has(focused.id);
  }, [activeTab, currentProjectDock, runningTerminals]);

  const approvalDelegationRows = useDelegationRows();
  const nextApproval = useMemo(
    () => approvalSessionIdsOf(sessions, approvalDelegationRows),
    [sessions, approvalDelegationRows],
  );
  const approvalSessionIdsRef = useRef(nextApproval.ids);
  if (!setsEqual(approvalSessionIdsRef.current, nextApproval.ids)) {
    approvalSessionIdsRef.current = nextApproval.ids;
  }
  const approvalSessionIds = approvalSessionIdsRef.current;
  const approvalElsewhereSessionIdsRef = useRef(nextApproval.elsewhere);
  if (!setsEqual(approvalElsewhereSessionIdsRef.current, nextApproval.elsewhere)) {
    approvalElsewhereSessionIdsRef.current = nextApproval.elsewhere;
  }
  const approvalElsewhereSessionIds = approvalElsewhereSessionIdsRef.current;

  // WP-113: attention for settle, snooze and re-sort. Off passes nothing, so today's list is untouched.
  const chatListInboxOn = useChatListInbox();
  const chatListAttention = useChatListAttention(
    chatListInboxOn ? sessions : EMPTY_CHAT_LIST_SESSIONS,
  );

  const activeSessionId = inboxViewOpen
    ? inboxAskPortal?.sessionId
    : shownMonoSessionId && monoShownSessionFocused
      ? shownMonoSessionId
      : (monoViewSession?.id ?? active?.id);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // WP-92: the chat in view, for the key ask form below its header.
  const activeChat = sessions.find((session) => session.id === activeSessionId);

  // Sessions that belong in the UI: a habit's hidden run is not one of them,
  // and asks through its Mono's chat rather than on its own.
  const promptableSessions = useMemo(
    () => sessions.filter((session) => !session.ephemeral),
    [sessions],
  );
  useInputNotifications(promptableSessions, activeSessionId);
  // WP-164: held notices leave when quiet hours end; a failure waits no longer than its ping interval.
  useNotablePings();
  // Model, effort and permission changes reach a running turn's CLI now.
  useLiveHarnessSettings(sessions);

  // Cache the OS decision so a turn ending later can skip a denied banner.
  useEffect(() => {
    if (loadNotificationsEnabled()) void probeNotificationPermission();
  }, []);
  const finishedTurnIds = useUnseenFinishedSessions(
    sessions,
    liveBusySessionIds,
    activeSessionId,
  );
  // The green Done tick follows the worker's job, not only its chat's last turn (workOutcome.ts: one source).
  const doneRows = useDelegationRows();
  const unseenFinishedIds = useMemo(
    () => doneOnlyWhenDone(finishedTurnIds, doneRows),
    [finishedTurnIds, doneRows],
  );
  const monoSessionIds = useMemo(
    () =>
      new Set(
        listMonos().flatMap((mono) => (mono.sessionId ? [mono.sessionId] : [])),
      ),
    // The roster is read through its snapshot.
    [monosSnap],
  );
  // How many replies each Mono has that the user has not read, for the rail. An answer to the checker is not one, nor
  // is a room turn's (its reply is in the room, r52).
  const replyBusyRef = useRef(liveBusySessionIds);
  const replyBusy = withoutQuietTurns(liveBusySessionIds, sessions);
  if (!setsEqual(replyBusyRef.current, replyBusy)) replyBusyRef.current = replyBusy;
  const monoReplies = useUnseenReplyCounts(
    monoSessionIds,
    replyBusyRef.current,
    activeSessionId,
  );

  const trayDelegationRows = useDelegationRows();
  const liveAgentRows = useMemo(
    () =>
      liveAgentsEnabled
        ? liveAgentsFromSessions(
            promptableSessions,
            unseenFinishedIds,
            new Set(
              listMonos().flatMap((mono) =>
                mono.sessionId ? [mono.sessionId] : [],
              ),
            ),
            {
              // The Hub's tray is running work only, each worker named by its task (liveAgents.ts).
              runningOnly: IS_HUB_BUNDLE,
              // r67: a room seat reads as the Mono and the room, never its turn prompt.
              taskTitle: (id) =>
                trayDelegationRows.find((row) => row.childSession === id)
                  ?.title ?? roomSeatTitle(id),
            },
          )
        : [],
    [
      liveAgentsEnabled,
      promptableSessions,
      unseenFinishedIds,
      monosSnap,
      trayDelegationRows,
    ],
  );
  // Rebuilt for every streamed batch; identity only moves when a row does.
  const liveAgents = useStableValue(liveAgentRows);

  const hiddenApprovalToasts = useMemo(
    () =>
      hiddenApprovalNotices(
        monoViewId
          ? promptableSessions.filter((session) => session.id !== monoViewId)
          : promptableSessions,
        monoCovers ? "" : activeTabId,
        tabs,
        composerFocused,
        (id) => trayDelegationRows.some((row) => row.childSession === id && !!row.ownerMono),
      ),
    [
      promptableSessions,
      activeTabId,
      tabs,
      composerFocused,
      monoViewId,
      monoCovers,
      trayDelegationRows,
    ],
  );
  const [reminderNoticesHeight, setReminderNoticesHeight] = useState(0);
  const [harnessUpdateHeight, setHarnessUpdateHeight] = useState(0);
  const [newLayoutNoticeHeight, setNewLayoutNoticeHeight] = useState(0);
  // The footer's slot for the resource pressure chip. Monitoring continues
  // while the footer is hidden.
  const [pressureChipHost, setPressureChipHost] =
    useState<HTMLSpanElement | null>(null);

  useEffect(() => {
    syncDockBadge(sessions);
    // When chats run, for the soul tamper check (hub/model/soulTamper.ts).
    noteSessionRuns(sessions);
    // And what they ran, while it is still pending (a finished command's detail is its output).
    noteToolCalls(sessions);
  }, [sessions]);

  useEffect(() => {
    // The app process's record of its chats' turns, which a reload doesn't lose (sessionRuns.ts).
    setProcessRunSource(listHarnessRuns);
    // What each chat's tool calls said, so a run that named another Mono's soul counts for it (soulTamper.ts).
    setRunToolTextSource((sessionId) => {
      // Each call carries when its turn started (the user block before it), so an earlier turn's write isn't this run's.
      let turnAt: number | undefined;
      return (sessionsRef.current.find((s) => s.id === sessionId)?.blocks ?? []).flatMap((block) => {
        if (block.startedAt != null) turnAt = block.startedAt;
        return block.tool
          ? [{ kind: block.tool.kind, text: [block.tool.title, block.tool.detail, ...(block.tool.paths ?? [])].filter(Boolean).join("\n"), at: turnAt }]
          : [];
      });
    });
    // A heartbeat while a chat runs with nothing new on screen, so a reload or crash leaves when it last ran.
    const timer = setInterval(() => noteSessionRuns(sessionsRef.current), RUN_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        setWindowFocused(focused);
        if (focused) {
          flushForegroundHarnessEvents();
          syncDockBadge(sessionsRef.current);
          if (
            document.activeElement === document.body &&
            !projectTerminalFocusedRef.current &&
            !searchViewOpenRef.current &&
            !inboxViewOpenRef.current &&
            !notesViewOpenRef.current &&
            !automationsViewOpenRef.current &&
            !settingsOpenRef.current
          ) {
            setComposerFocused(true);
            setComposerFocusToken((token) => token + 1);
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [flushForegroundHarnessEvents]);

  useEffect(() => {
    const onVisible = () => {
      // Flush on hiding too: WebKit can suspend a pending animation frame,
      // leaving the last output stranded until another event or activation.
      flushHarnessEvents();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [flushHarnessEvents]);

  useLayoutEffect(() => {
    // Catch up only the newly visible panes before paint. Other streams keep
    // their background timer instead of adding work to this tab switch.
    flushForegroundHarnessEvents();
  }, [
    activeTabId,
    monoViewId,
    inboxViewOpen,
    inboxAskPortal?.sessionId,
    shownMonoSessionId,
    searchViewOpen,
    notesViewOpen,
    automationsViewOpen,
    settingsOpen,
    flushForegroundHarnessEvents,
  ]);

  useEffect(() => {
    let unlistenClose: (() => void) | undefined;
    const releaseQuit = setQuitWorkspace(
      () => sessionsRef.current,
      () => tabsRef.current,
      () => activeTabIdRef.current,
      () => projectCwdRef.current,
      () => projectTerminalsRef.current,
      readProjectReturnMemory,
      flushHarnessEvents,
      () => lastDockSideRef.current,
      keepWorkspaceTab,
    );
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        // Listening here makes close our job. Letting the default path run
        // calls JS `window.destroy`, which Tauri denies without a permission.
        event.preventDefault();
        if (
          IS_MAC &&
          (await invoke<boolean>("mono_chat_keep_alive").catch(() => false))
        ) {
          flushHarnessEvents();
          void persistLiveTranscripts(sessionsRef.current);
          void hideCurrentWindow();
          return;
        }
        const toTray = loadCloseToTray();
        if (hasInFlightSessions(sessionsRef.current)) {
          flushHarnessEvents();
          if (!toTray && !IS_MAC) {
            void closeBusyWindow();
            return;
          }
          // Not `persistQuitState`: that marks the live turns interrupted.
          void persistLiveTranscripts(sessionsRef.current);
          void hideCurrentWindow();
          return;
        }
        void persistQuitState(
          sessionsRef.current,
          tabsRef.current,
          activeTabIdRef.current,
          projectCwdRef.current,
          readProjectReturnMemory(),
          "unload",
          projectTerminalsRef.current,
          lastDockSideRef.current ?? undefined,
          keepWorkspaceTab,
        ).finally(() => {
          void (toTray ? hideCurrentWindow() : closeCurrentWindow());
        });
      })
      .then((fn) => {
        unlistenClose = fn;
      });
    return () => {
      releaseQuit();
      unlistenClose?.();
    };
  }, [flushHarnessEvents, keepWorkspaceTab, readProjectReturnMemory]);

  const refreshHistory = useCallback(async (cwd: string) => {
    if (!cwd || cwd === "~") return;
    // `history` holds every visited project's rows and the sidebar filters it
    // by cwd, so a project loaded once paints from cache on the way back and
    // revalidates quietly underneath the cards already on screen. Whether the
    // first load is still pending is derived from `loadedProjects`, not
    // tracked here — a status set from this effect lands a render too late to
    // suppress the empty state.
    const key = normalizeProjectPath(cwd);
    setHistoryErrorCwd((prev) => (prev === key ? null : prev));
    try {
      const rows = await listSessionsByProject(cwd);
      if (cwd !== sidebarCwdRef.current) return;
      setHistory((current) => replaceProjectHistory(current, cwd, rows));
      setLoadedProjects((prev) =>
        prev.has(key) ? prev : new Set(prev).add(key),
      );
    } catch {
      if (cwd !== sidebarCwdRef.current) return;
      // A failed revalidate keeps the cached cards rather than replacing a
      // good list with an error.
      if (!loadedProjectsRef.current.has(key)) setHistoryErrorCwd(key);
    }
  }, []);

  useEffect(() => {
    void refreshHistory(sidebarCwd);
  }, [sidebarCwd, refreshHistory]);

  // WP-76: a trash change in this window or another refreshes the sidebar and Home.
  const [, setTrashTick] = useState(0);
  useEffect(() => {
    const listening = listen(TRASH_CHANGED, () => {
      void refreshHiddenProjects().finally(() => {
        void refreshHistory(projectCwdRef.current);
        setTrashTick((tick) => tick + 1);
      });
    });
    void refreshHiddenProjects().then((changed) => {
      if (changed) setTrashTick((tick) => tick + 1);
    });
    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, [refreshHistory]);

  useEffect(() => {
    if (!inboxViewOpen) return;
    let cancelled = false;
    void listLinkedSessions()
      .then((rows) => {
        if (!cancelled) setStoredLinkedSessions(rows);
      })
      .catch(() => {
        // Already-loaded and live sessions still provide a useful fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [inboxViewOpen]);

  useEffect(() => {
    prefetchProjectFiles(gitCwd);
  }, [gitCwd]);

  const persistSession = useCallback((session: Session | undefined) => {
    if (
      !session ||
      !shouldPersistSession(session) ||
      removingSessionIds.current.has(session.id) ||
      switchingWorktrees.current.has(session.id)
    )
      return;
    const fingerprint = persistFingerprint(session);
    // Leaving a session flushes it. An unchanged one would still rewrite and
    // re-diff its whole transcript under the store lock, stalling the next load.
    if (lastPersisted.current.get(session.id) === fingerprint) return;
    void upsertSession(session)
      .then((summary) => {
        if (!summary) return;
        lastPersisted.current.set(session.id, fingerprint);
        if (summary.cwd === sidebarCwdRef.current) {
          setHistory((current) => mergeProjectHistorySummary(current, summary));
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const observe = () => {
      const sessions = sessionState.snapshot();
      const liveIds = new Set(sessions.map((session) => session.id));
      const visibleIds = openSessionIds(tabsRef.current);
      for (const session of sessions) {
        if (
          removingSessionIds.current.has(session.id) ||
          switchingWorktrees.current.has(session.id)
        )
          continue;
        const previouslyObserved = observedSessions.current.get(session.id);
        if (previouslyObserved === session) continue;
        observedSessions.current.set(session.id, session);
        const queueChanged =
          previouslyObserved?.queuedMessages !== session.queuedMessages ||
          previouslyObserved?.queueStatus !== session.queueStatus;
        // A /goal is saved as it changes, mid-turn too: a restart must find the latest one (set, checked, ended).
        const goalChanged =
          !!previouslyObserved && previouslyObserved.goal !== session.goal;
        const parked = !visibleIds.has(session.id);
        const newlyBound =
          !!session.providerSessionId &&
          lastBoundProvider.current.get(session.id) !==
            session.providerSessionId;
        const lastUserId = lastUserBlockId(session);
        const newUserTurn =
          !!lastUserId &&
          lastPersistedUserBlock.current.get(session.id) !== lastUserId;
        if (newlyBound && session.providerSessionId) {
          lastBoundProvider.current.set(session.id, session.providerSessionId);
        }
        if (newUserTurn && lastUserId) {
          lastPersistedUserBlock.current.set(session.id, lastUserId);
        }
        if (
          (newlyBound || newUserTurn || queueChanged || goalChanged) &&
          shouldPersistSession(session)
        ) {
          persistSession(session);
        }
        if (
          shouldPersistSession(session) &&
          (!session.busy ||
            parked ||
            newlyBound ||
            newUserTurn ||
            !lastPersisted.current.has(session.id))
        ) {
          pendingPersist.current.set(session.id, session);
        }
      }
      for (const sessionId of observedSessions.current.keys()) {
        if (liveIds.has(sessionId)) continue;
        observedSessions.current.delete(sessionId);
        pendingPersist.current.delete(sessionId);
      }
      if (pendingPersist.current.size === 0) return;

      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const dirty = [...pendingPersist.current.values()];
        pendingPersist.current.clear();
        void Promise.all(
          dirty.map(async (session) => {
            if (
              removingSessionIds.current.has(session.id) ||
              switchingWorktrees.current.has(session.id)
            )
              return;
            const fingerprint = persistFingerprint(session);
            if (lastPersisted.current.get(session.id) === fingerprint) return;
            const summary = await upsertSession(session).catch(() => null);
            if (!summary) return;
            lastPersisted.current.set(session.id, fingerprint);
            if (summary.cwd === sidebarCwdRef.current) {
              setHistory((current) =>
                mergeProjectHistorySummary(current, summary),
              );
            }
          }),
        );
      }, 650);
    };
    observe();
    const unsubscribe = sessionState.observe(observe);
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [persistSession, sessionState]);

  useEffect(() => {
    const refs = inFlightRefs(sessions, tabs);
    if (refs.length > 0) sawInFlight.current = true;
    const key = inFlightSnapshotKey(refs);
    if (
      !shouldWriteInFlightSnapshot(
        key,
        refs,
        inFlightSyncKey.current,
        sawInFlight.current,
      )
    ) {
      return;
    }
    inFlightSyncKey.current = key;
    void replaceInFlightSessions(refs).catch(() => undefined);
  }, [sessions, tabs]);

  useEffect(() => {
    if (windowTransfer) return;
    const snapshot = collectWorkspaceSnapshot(
      tabs,
      sessions,
      activeTabId,
      projectCwd,
      reconcileProjectReturn({
        memory: projectReturnRef.current,
        tabs,
        sessions,
        activeTabId,
      }),
      projectTerminals,
      lastDockSide ?? undefined,
      keepWorkspaceTab,
    );
    const key = workspaceSnapshotKey(snapshot);
    if (workspaceSyncKey.current === key) return;
    workspaceSyncKey.current = key;
    const timer = window.setTimeout(() => {
      void saveWorkspaceSnapshot(snapshot).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    tabs,
    sessions,
    activeTabId,
    projectCwd,
    projectTerminals,
    lastDockSide,
    windowTransfer,
    keepWorkspaceTab,
    projectWorktree?.path,
    workspaceNavigation.revision,
  ]);

  useEffect(() => {
    if (lastProjectPath()) return;
    void invoke<string>("default_cwd")
      .then((cwd) => {
        if (!looksLikeProject(cwd)) return;
        setProjectCwd(cwd);
        setRecents((prev) => (prev.length > 0 ? prev : rememberProject(cwd)));
        setSessions((prev) =>
          prev.map((s) => (s.cwd === "~" ? { ...s, cwd } : s)),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const isolated = isolateTerminalPanes(tab);
        if (isolated !== tab) changed = true;
        return isolated;
      });
      return changed ? next : prev;
    });
  }, [tabs]);

  // Tabs are views. Hidden idle sessions drop their child. A visible session
  // keeps its child for a few minutes after a turn so follow-ups stay instant,
  // then parks it and resumes on the next prompt.
  useIdleSessionDetach({
    sessions,
    sessionsRef,
    tabs,
    tabsRef,
    orchestrationRuns,
    liveAgentsEnabled,
    unseenFinishedIds,
    openingSessionIds,
    loadedSessionCache,
    skipForgetSessionIds,
    persistSession,
    setSessions,
  });

  const activateTab = useCallback(
    (
      id: string,
      paneId?: string,
      reason: "session" | "workspace" = "session",
    ) => {
      if (id !== activeTabIdRef.current) beginTabSwitch(id);
      closeMonoView();
      const tab = tabsRef.current.find((entry) => entry.id === id);
      const nextFocusedId =
        tab &&
        paneId &&
        (leafIds(tab.layout).includes(paneId) ||
          tab.editorPanes.some((entry) => entry.id === paneId) ||
          (tab.terminalPanes ?? []).some((entry) => entry.id === paneId))
          ? paneId
          : tab?.focusedId;

      if (reason === "workspace") setActiveTabIdState(id);
      else setActiveTabId(id);
      if (tab && nextFocusedId && nextFocusedId !== tab.focusedId) {
        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? { ...entry, focusedId: nextFocusedId, diffFocused: false }
              : entry,
          ),
        );
      }

      if (tab) {
        const focusedTab = nextFocusedId
          ? { ...tab, focusedId: nextFocusedId }
          : tab;
        const cwd = focusedWorkspaceTabCwd(focusedTab, sessionsRef.current);
        if (cwd && looksLikeProject(cwd)) {
          const normalized = normalizeProjectPath(cwd);
          if (!sameProjectPath(normalized, projectCwdRef.current)) {
            setProjectCwd(normalized);
            setRecents(rememberProject(normalized));
          }
        }
      }
      setComposerFocused(
        !!nextFocusedId &&
          sessionsRef.current.some((session) => session.id === nextFocusedId),
      );
    },
    [],
  );

  const commitTabVisit = useCallback((history: TabVisitHistory) => {
    tabVisitRef.current = history;
    const canBack = canTabVisitBack(history);
    const canForward = canTabVisitForward(history);
    setTabVisitNav((prev) =>
      prev.canBack === canBack && prev.canForward === canForward
        ? prev
        : { canBack, canForward },
    );
  }, []);

  useEffect(() => {
    const openIds = new Set(tabs.map((tab) => tab.id));
    let next = pruneTabVisitHistory(tabVisitRef.current, openIds, activeTabId);
    if (tabVisitFromHistoryRef.current) {
      tabVisitFromHistoryRef.current = false;
    } else if (next.current !== activeTabId) {
      next = recordTabVisit(next, activeTabId);
    }
    commitTabVisit(pruneTabVisitHistory(next, openIds, activeTabId));
  }, [activeTabId, commitTabVisit, tabs]);

  /** `cwd` scopes group inheritance: a tab from another project starts alone. */
  const insertBeside = useCallback(
    (
      prev: WorkspaceTab[],
      tab: WorkspaceTab,
      anchorId: string | undefined,
      cwd?: string,
    ) =>
      insertTabBesideActive(prev, tab, anchorId, (id) =>
        id === tab.id ? (cwd ? projectName(cwd) : undefined) : projectOfTab(id),
      ),
    [projectOfTab],
  );

  const insertBesideActive = useCallback(
    (prev: WorkspaceTab[], tab: WorkspaceTab, cwd?: string) =>
      insertBeside(prev, tab, activeTabIdRef.current, cwd),
    [insertBeside],
  );

  const appendTab = useCallback(
    (tab: WorkspaceTab, cwd?: string) => {
      setTabs((prev) => insertBesideActive(prev, tab, cwd));
    },
    [insertBesideActive],
  );

  // WP-134b: the More agents list the chat screens read is the app's own list. Read it at start, and again whenever
  // it changes in any window (Settings adds, allows, withdraws or removes an entry).
  useEffect(() => {
    // The app's copy of the switch follows the saved setting from the start, so Rust agrees with what Settings shows.
    void syncMoreAgentsSwitch(loadMoreAgentsEnabled());
    void refreshRegistry();
    const unsubscribe = subscribeRegistry(() => undefined);
    // A change made in another window (a withdraw, a removal) re-reads the list here too, so this window stops runs.
    let stopChanges: (() => void) | undefined;
    let disposed = false;
    void subscribeMoreAgentsChanges(() => void refreshRegistry()).then((stop) => {
      if (disposed) stop();
      else stopChanges = stop;
    });
    return () => {
      disposed = true;
      unsubscribe();
      stopChanges?.();
    };
  }, []);

  // WP-134b: Start a chat opens a More agents session. The harness stays one of the eleven.
  useEffect(() => {
    const onStart = async (event: Event) => {
      const detail = (event as CustomEvent<{ agentId?: unknown; cwd?: unknown }>).detail;
      const agentId = typeof detail?.agentId === "string" ? detail.agentId : "";
      // The entry may have been added or allowed a moment ago in Settings: read the app's list before deciding.
      await refreshRegistry();
      const plan = registrySendPlan({
        registryAgentId: agentId,
        enabled: loadMoreAgentsEnabled(),
        agents: loadRegistryDocument().agents,
        busy: false,
      });
      if (plan.action !== "prompt") {
        reportRegistryChatRefused(plan.action === "refuse" ? plan.sentence : AGENT_GONE);
        return;
      }
      const rawCwd = detail?.cwd;
      const cwd =
        typeof rawCwd === "string" && rawCwd.length > 0 && rawCwd.length <= 4096 && !/[\0\r\n]/.test(rawCwd)
          ? rawCwd
          : "~";
      const session = {
        ...newSession("claude", cwd),
        ...registrySessionFields(plan.agent, "claude"),
      };
      // WP-134: the entry id is on the session and is saved with it. Browser storage is not the link.
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    };
    window.addEventListener(START_REGISTRY_CHAT_EVENT, onStart);
    return () => window.removeEventListener(START_REGISTRY_CHAT_EVENT, onStart);
  }, [appendTab]);

  // WP-134b: a More agents chat is routed to its entry as soon as it is in the list, so its first send, compact,
  // rewind and restore never reach the harness it was saved with. Sends still check the list and the switch.
  useEffect(() => {
    for (const session of sessions) {
      if (session.registryAgentId && moreAgentOfSession(session.id) !== session.registryAgentId) {
        openMoreAgentSession(session.id, session.registryAgentId);
      }
    }
  }, [sessions]);

  const usageLimitAccountChangeRef = useRef<
    ((sessionId: string, accountId: string) => Promise<void>) | null
  >(null);
  const onSelectProviderAccount = useCallback(
    (provider: ProviderAccountProvider, accountId: string) => {
      const current = sessionsRef.current.find(
        (session) => session.id === active?.id,
      );
      if (!current || current.harness !== provider) return;

      // A limited session continues in place under the selected account.
      if (current.usageLimit && !current.busy) {
        void usageLimitAccountChangeRef.current?.(current.id, accountId);
        return;
      }

      if (current.blocks.length === 0 && !current.busy) {
        if (current.providerAccountId === accountId) return;
        updateSessionState(sessionsRef, setSessions, (sessions) =>
          sessions.map((session) =>
            session.id === current.id
              ? { ...session, providerAccountId: accountId }
              : session,
          ),
        );
        return;
      }

      const currentId =
        current.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
      if (currentId === accountId) return;

      // Provider thread ids are account-owned. Keep the current conversation
      // pinned to its account and open a clean one for the selected profile.
      const session = {
        ...newSession(
          current.harness,
          current.cwd,
          current.model,
          current.runtimeMode,
          current.modelSettings,
        ),
        providerAccountId: accountId,
      };
      const tab = newTab(session.id);
      updateSessionState(sessionsRef, setSessions, (sessions) => [
        ...sessions,
        session,
      ]);
      appendTab(tab, current.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
    },
    [active?.id, appendTab],
  );

  const onOpenWhatsNew = useCallback((version: string) => {
    const document = releaseNotesForVersion(version);
    if (!document) {
      void message(
        "Release notes for this version are not available in this build.",
        { title: "MonoCode" },
      );
      return;
    }
    setWhatsNewVersion(document.source.version);
  }, []);

  const createWorkspaceTab = useCallback(
    (cwd: string, focus?: WorktreeFocus) => {
      const session = {
        ...newDefaultSession(cwd, sessionDefaults?.runtimeMode),
        ...(focus && !sameProjectPath(focus.path, cwd)
          ? { worktreeCwd: focus.path, branch: focus.branch ?? undefined }
          : {}),
      };
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, cwd);
      // WP-110: a new chat follows the worktree setting.
      attachNewChatWorktree(session.id, cwd, setSessions);
      return tab.id;
    },
    [appendTab, sessionDefaults?.runtimeMode],
  );

  const onNew = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    const cwd = sidebarCwd;
    const session = newWorkspaceSession(cwd, sessionDefaults?.runtimeMode);
    // An untouched New session tab for this project is already open: go to
    // it rather than stacking another empty one beside it. A Hub default
    // (hubDefaultsOn): upstream's own build appends a new tab every time.
    const blank = hubDefaultsOn()
      ? reusableBlankSessionTab(tabsRef.current, sessionsRef.current, session)
      : undefined;
    if (blank) {
      setActiveTabId(blank.tabId);
      setComposerFocused(true);
      return blank.sessionId;
    }
    const tab = newTab(session.id);
    setSessions((prev) => [...prev, session]);
    appendTab(tab, cwd);
    setActiveTabId(tab.id);
    setComposerFocused(true);
    // WP-110: a new chat follows the worktree setting.
    attachNewChatWorktree(session.id, cwd, setSessions);
    return session.id;
  }, [appendTab, sessionDefaults?.runtimeMode, sidebarCwd]);

  // WP-123: open a forked chat. The original is not written.
  const openForkedSession = useCallback(
    (session: Session) => {
      updateSessionState(sessionsRef, setSessions, (sessions) =>
        insertFork(sessions, session),
      );
      const tab = newTab(session.id);
      appendTab(tab, session.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
    },
    [appendTab],
  );

  const onSelectRemoteSession = useCallback(
    (project: string, remoteSessionId: string) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      const existing = findRemoteSessionTab(
        tabsRef.current,
        sessionsRef.current,
        project,
        remoteSessionId,
      );
      if (existing) {
        activateTab(existing.tab.id, existing.shellId);
        return;
      }
      // Reserve a dedicated tab immediately. An apparently blank remote tab
      // may hold composer text or a create/upload that the host has not accepted.
      const session = newDefaultSession(project, sessionDefaults?.runtimeMode);
      const tab = newTab(session.id);
      rememberRemoteSession(session.id, remoteSessionId);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, project);
      setActiveTabId(tab.id);
    },
    [activateTab, appendTab, sessionDefaults?.runtimeMode],
  );

  const onStartInboxItem = useCallback(
    async (item: InboxItem, body?: string) => {
      const start = (description?: string) => {
        setInboxViewOpen(false);
        setNotesViewOpen(false);
        setAutomationsViewOpen(false);
        const cwd =
          item.projectPath || active?.cwd || sessionDefaults?.cwd || projectCwd;
        setSidebarTab("sessions", cwd);
        const ref =
          item.provider === "linear" || item.provider === "jira"
            ? item.identifier?.trim() || `#${item.number}`
            : `#${item.number}`;
        const linkedWorkItem = linkedWorkItemFromInboxItem(item);
        const session = {
          ...newDefaultSession(cwd, sessionDefaults?.runtimeMode),
          title: `${ref} ${item.title}`,
          inboxCard: inboxComposerCard(item, description),
          ...(linkedWorkItem ? { linkedWorkItem } : {}),
        };
        const tab = newTab(session.id);
        setSessions((prev) => [...prev, session]);
        appendTab(tab, cwd);
        setActiveTabId(tab.id);
        setComposerFocused(true);
        // WP-110: a new chat follows the worktree setting.
        attachNewChatWorktree(session.id, cwd, setSessions);
      };

      start(await inboxTrackerDescription(item, body));
    },
    [
      active?.cwd,
      appendTab,
      sessionDefaults?.cwd,
      sessionDefaults?.runtimeMode,
      projectCwd,
    ],
  );

  const onAddNoteToChat = useCallback(
    (card: NoteComposerCard) => {
      if (!card.id) return;
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      const cwd =
        (card.sourceCwd && looksLikeProject(card.sourceCwd)
          ? card.sourceCwd
          : undefined) ||
        active?.cwd ||
        sessionDefaults?.cwd ||
        projectCwd;
      setSidebarTab("sessions", cwd);
      const title = card.title.trim();
      const session = {
        ...newDefaultSession(cwd, sessionDefaults?.runtimeMode),
        ...(title ? { title } : {}),
        noteCard: card,
      };
      const tab = newTab(session.id);
      setSessions((prev) => [...prev, session]);
      appendTab(tab, cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
      // WP-110: a new chat follows the worktree setting.
      attachNewChatWorktree(session.id, cwd, setSessions);
    },
    [
      active?.cwd,
      appendTab,
      sessionDefaults?.cwd,
      sessionDefaults?.runtimeMode,
      projectCwd,
    ],
  );

  useEffect(() => {
    const onAdd = (event: Event) => {
      const card = (event as CustomEvent<NoteComposerCard>).detail;
      if (!card?.id) return;
      onAddNoteToChat(card);
    };
    window.addEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
  }, [onAddNoteToChat]);

  const onInboxCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.inboxCard
          ? { ...session, inboxCard: undefined }
          : session,
      ),
    );
  }, []);

  const setLinkedWorkItemUpdateCard = useCallback(
    (
      sessionId: string,
      update: (
        card: LinkedWorkItemUpdateCard | undefined,
      ) => LinkedWorkItemUpdateCard | undefined,
    ) => {
      const previous = sessionsRef.current;
      const next = previous.map((session) => {
        if (session.id !== sessionId) return session;
        const card = update(session.linkedWorkItemUpdateCard);
        return card === session.linkedWorkItemUpdateCard
          ? session
          : { ...session, linkedWorkItemUpdateCard: card };
      });
      if (!next.some((session, index) => session !== previous[index])) return;
      sessionsRef.current = next;
      setSessions(next);
    },
    [],
  );

  const onLinkedWorkItemUpdateCardDismiss = useCallback(
    (sessionId: string) => {
      setLinkedWorkItemUpdateCard(sessionId, () => undefined);
    },
    [setLinkedWorkItemUpdateCard],
  );

  const onNoteCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.noteCard
          ? { ...session, noteCard: undefined }
          : session,
      ),
    );
  }, []);

  const onHandoffCardDismiss = useCallback((sessionId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId && session.handoffCard
          ? { ...session, handoffCard: undefined }
          : session,
      ),
    );
  }, []);

  const onSplit = useCallback(
    (dir: SplitDir) => {
      closeMonoView();
      if (!activeTab) return;
      const session = newDefaultSession(
        sessionDefaults?.cwd ?? projectCwd,
        sessionDefaults?.runtimeMode,
      );
      setSessions((prev) => [...prev, session]);
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== activeTab.id) return t;
          return {
            ...t,
            layout: splitPane(t.layout, t.focusedId, dir, session.id),
            focusedId: session.id,
          };
        }),
      );
      setComposerFocused(true);
      // WP-110: a new chat follows the worktree setting.
      attachNewChatWorktree(session.id, session.cwd, setSessions);
    },
    [activeTab, projectCwd, sessionDefaults?.cwd, sessionDefaults?.runtimeMode],
  );

  const focusProjectTerminal = useCallback(() => {
    setProjectTerminalFocused(true);
    setComposerFocused(false);
  }, []);

  const openProjectTerminal = useCallback(
    (cwd: string) => {
      const workdir = cwd || projectCwdRef.current;
      const projectPath = projectCwdRef.current;
      if (!isLocalProject(projectPath)) return false;
      setProjectTerminals((prev) => {
        const existing = findProjectTerminal(prev, projectPath);
        const file = newTerminalFile(
          workdir,
          existing ? nextDockTerminalTitle(existing, workdir) : undefined,
          projectPath,
        );
        if (!existing) {
          return [
            ...prev,
            createProjectTerminal(
              projectPath,
              file,
              lastDockSideRef.current ?? "bottom",
            ),
          ];
        }
        return mapProjectTerminal(prev, projectPath, (dock) =>
          addTerminalToDock(dock, file),
        );
      });
      focusProjectTerminal();
      return true;
    },
    [focusProjectTerminal],
  );

  const onOpenTerminal = useCallback(
    (cwd: string, asWorkspaceTab = false, occupySessionId?: string) => {
      const workdir = cwd || terminalCwd;
      if (!isLocalProject(projectCwdRef.current) || !isLocalProject(workdir))
        return;
      if (openProjectTerminal(workdir)) return;

      if (asWorkspaceTab || !activeTab) {
        const file = newTerminalFile(workdir, undefined, sidebarCwd);
        const tab = newTerminalWorkspaceTab(file);
        appendTab(tab, sidebarCwd);
        setActiveTabId(tab.id);
        setComposerFocused(false);
        return;
      }

      const occupying = sessionsRef.current.find(
        (session) => session.id === (occupySessionId ?? activeTab.focusedId),
      );
      const occupyPaneId =
        occupying && isBlankSession(occupying) ? occupying.id : undefined;
      if (occupyPaneId && occupying) {
        lastPersisted.current.delete(occupyPaneId);
        void forgetHarnessSession(occupying.harness, occupyPaneId);
        setSessions((prev) =>
          prev.filter((session) => session.id !== occupyPaneId),
        );
      }

      const file = newTerminalFile(
        workdir,
        nextTerminalTitle(activeTab, workdir),
        sidebarCwd,
      );
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTab.id
            ? openTerminalTab(tab, file, occupyPaneId)
            : tab,
        ),
      );
      setComposerFocused(false);
    },
    [terminalCwd, activeTab, appendTab, openProjectTerminal, sidebarCwd],
  );

  const onNewTerminal = useCallback(() => {
    onOpenTerminal(terminalCwd);
  }, [terminalCwd, onOpenTerminal]);

  const onNewTerminalInSession = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      if (session?.worktreeRemoved) return;
      onOpenTerminal(
        session ? sessionWorkCwd(session) : projectCwd,
        false,
        sessionId,
      );
    },
    [onOpenTerminal, projectCwd],
  );

  const onToggleProjectTerminal = useCallback(() => {
    if (!isLocalProject(projectCwd)) return;
    leaveCoveringMono();
    const dock = findProjectTerminal(projectTerminalsRef.current, projectCwd);
    if (!dock) {
      openProjectTerminal(terminalCwd);
      return;
    }
    const nextOpen = !dock.open;
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, projectCwd, (entry) =>
        withDockOpen(entry, nextOpen),
      ),
    );
    if (nextOpen) focusProjectTerminal();
    else setProjectTerminalFocused(false);
  }, [
    terminalCwd,
    focusProjectTerminal,
    leaveCoveringMono,
    openProjectTerminal,
    projectCwd,
  ]);

  const onHideProjectTerminal = useCallback(() => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, projectCwdRef.current, (dock) =>
        withDockOpen(dock, false),
      ),
    );
    setProjectTerminalFocused(false);
  }, []);

  const onProjectTerminalSide = useCallback((side: DockSide) => {
    setLastDockSide(side);
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, projectCwdRef.current, (dock) =>
        withDockSide(dock, side, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      ),
    );
  }, []);

  const onProjectTerminalSize = useCallback((size: number) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, projectCwdRef.current, (dock) =>
        withDockSize(dock, size, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      ),
    );
  }, []);

  const onSelectProjectTerminal = useCallback(
    (fileId: string) => {
      setProjectTerminals((prev) =>
        mapProjectTerminal(prev, projectCwdRef.current, (dock) =>
          selectDockTerminal(dock, fileId),
        ),
      );
      focusProjectTerminal();
    },
    [focusProjectTerminal],
  );

  const onReorderProjectTerminals = useCallback((ids: string[]) => {
    setProjectTerminals((prev) =>
      mapProjectTerminal(prev, projectCwdRef.current, (dock) =>
        reorderDockTerminals(dock, orderByIds(dock.pane.files, ids)),
      ),
    );
  }, []);

  const onCloseProjectTerminal = useCallback((fileId: string) => {
    const dock = findProjectTerminal(
      projectTerminalsRef.current,
      projectCwdRef.current,
    );
    const file = dock?.pane.files.find((entry) => entry.id === fileId);
    if (!file) return;
    const finishClose = () => {
      setProjectTerminals((prev) =>
        mapProjectTerminal(prev, projectCwdRef.current, (entry) =>
          closeTerminalInDock(entry, fileId),
        ),
      );
    };
    void confirmCloseTerminal(file).then((ok) => ok && finishClose());
  }, []);

  const onCloseOtherProjectTerminals = useCallback((fileId: string) => {
    const projectPath = projectCwdRef.current;
    const dock = findProjectTerminal(projectTerminalsRef.current, projectPath);
    if (!dock?.pane.files.some((file) => file.id === fileId)) return;
    const closingFiles = dock.pane.files.filter((file) => file.id !== fileId);
    if (closingFiles.length === 0) return;
    const closingIds = new Set(closingFiles.map((file) => file.id));

    const finishClose = () => {
      setProjectTerminals((prev) =>
        mapProjectTerminal(prev, projectPath, (entry) => {
          if (!entry.pane.files.some((file) => file.id === fileId)) {
            return entry;
          }
          const files = entry.pane.files.filter(
            (file) => !closingIds.has(file.id),
          );
          return {
            ...entry,
            pane: { ...entry.pane, files, activeFileId: fileId },
          };
        }),
      );
    };

    void confirmCloseTerminals(closingFiles).then((ok) => ok && finishClose());
  }, []);

  const onTerminalMetaChange = useCallback(
    (fileId: string, patch: TerminalMetaPatch) => {
      setProjectTerminals((prev) => patchProjectTerminals(prev, fileId, patch));
      setTabs((prev) =>
        prev.map((tab) => updateTerminalTab(tab, fileId, patch)),
      );
    },
    [],
  );

  const onToggleRunningTerminal = useCallback(
    (fileId: string) => {
      const dock = projectTerminalsRef.current.find((entry) =>
        entry.pane.files.some((file) => file.id === fileId),
      );
      if (dock) {
        if (dock.open) {
          setProjectTerminals((prev) =>
            mapProjectTerminal(prev, dock.projectPath, (entry) =>
              withDockOpen(entry, false),
            ),
          );
          setProjectTerminalFocused(false);
          return;
        }
        setProjectTerminals((prev) =>
          mapProjectTerminal(prev, dock.projectPath, (entry) =>
            withDockOpen(selectDockTerminal(entry, fileId), true),
          ),
        );
        focusProjectTerminal();
        return;
      }
      for (const tab of tabsRef.current) {
        for (const pane of tab.terminalPanes ?? []) {
          if (!pane.files.some((file) => file.id === fileId)) continue;
          const showing =
            activeTabIdRef.current === tab.id &&
            tab.focusedId === pane.id &&
            pane.activeFileId === fileId;
          if (showing) {
            setComposerFocused(true);
            setProjectTerminalFocused(false);
            return;
          }
          setActiveTabId(tab.id);
          setTabs((prev) =>
            prev.map((entry) => {
              if (entry.id !== tab.id) return entry;
              return withSurfacePanes(
                { ...entry, focusedId: pane.id },
                "terminal",
                (entry.terminalPanes ?? []).map((item) =>
                  item.id === pane.id
                    ? { ...item, activeFileId: fileId }
                    : item,
                ),
              );
            }),
          );
          setProjectTerminalFocused(false);
          setComposerFocused(false);
          return;
        }
      }
    },
    [focusProjectTerminal],
  );

  const onNewTerminalTab = useCallback(() => {
    onOpenTerminal(terminalCwd, true);
  }, [terminalCwd, onOpenTerminal]);

  const onCloseTab = useCallback(
    (id: string, opts?: { confirmedTerminalIds?: string[] }) => {
      const current = tabsRef.current;
      const index = current.findIndex((t) => t.id === id);
      if (index < 0) return;
      const closePlan = planWorkspaceTabClose({
        tabs: current,
        sessions: sessionsRef.current,
        closingTabId: id,
        scope: tabCloseScope,
        worktreeOf: tabWorktreeOf,
      });
      if (closePlan.action === "keep") return;
      const closing = current[index];
      const closingFiles = [
        ...closing.editorPanes.flatMap((pane) => pane.files),
        ...(closing.terminalPanes ?? []).flatMap((pane) => pane.files),
      ];
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
      );
      const confirmed = new Set(opts?.confirmedTerminalIds ?? []);
      const terminals = closingFiles.filter(
        (file) => file.terminal && !confirmed.has(file.id),
      );

      const finishClose = () => {
        const nextActiveTabId = closePlan.nextActiveTabId;
        const next = current.filter((t) => t.id !== id);
        const gone = new Set(
          leafIds(closing.layout).filter((paneId) =>
            sessionsRef.current.some((session) => session.id === paneId),
          ),
        );
        for (const sessionId of gone) {
          persistSession(sessionsRef.current.find((s) => s.id === sessionId));
          rememberRemoteSession(sessionId);
          rememberRemotePendingWorktree(sessionId);
        }
        setDirtyFiles((prev) => {
          const updated = new Set(prev);
          for (const file of closingFiles) updated.delete(file.id);
          return updated;
        });
        if (id !== activeTabIdRef.current) {
          setTabs(next);
          void refreshHistory(sidebarCwd);
          return;
        }
        const navigation = displayedTabNavigation.current;
        // A view shown over this tab stays up; only the workspace beneath it
        // moves on.
        if (
          insetLayoutRef.current &&
          navigation.activeId !== id &&
          isViewTab(navigation.activeId)
        ) {
          setTabs(next);
          if (nextActiveTabId) setActiveTabIdState(nextActiveTabId);
          void refreshHistory(sidebarCwd);
          return;
        }
        const nextId = nextDisplayedTabAfterClose(
          navigation.tabs,
          navigation.activeId,
          id,
        );
        const close = () => {
          setTabs(next);
          // View tabs still need a valid workspace to return to underneath;
          // a Mono's opens over it, so it moves there without revealing it.
          if (nextActiveTabId) {
            if (nextId && monoForTab(nextId)) {
              setActiveTabIdState(nextActiveTabId);
            } else if (!nextId || appViewForTab(nextId)) {
              activateTab(nextActiveTabId);
            }
          }
          if (nextId) navigation.select?.(nextId);
        };
        // A view tab opens in a transition; closing alongside it keeps the
        // workspace beneath from painting between the two.
        if (nextId && isViewTab(nextId)) startTransition(close);
        else close();
        void refreshHistory(sidebarCwd);
      };

      void (async () => {
        if (unsaved.length > 0) {
          const ok = await confirmDiscardUnsaved(
            "Close this tab with unsaved files?",
          );
          if (!ok) return;
        }
        if (terminals.length > 0) {
          const ok = await confirmCloseTerminals(terminals);
          if (!ok) return;
        }
        finishClose();
      })();
    },
    [activateTab, persistSession, refreshHistory, sidebarCwd, tabCloseScope],
  );

  const onCloseTabs = useCallback(
    (ids: string[], fallbackId: string, opts?: { confirmed?: boolean }) => {
      const current = tabsRef.current;
      const closingIds = new Set(ids);
      const closing = current.filter((tab) => closingIds.has(tab.id));
      const fallback = current.find(
        (tab) => tab.id === fallbackId && !closingIds.has(tab.id),
      );
      if (!fallback || closing.length === 0) return;

      const closingFiles = closing.flatMap((tab) => [
        ...tab.editorPanes.flatMap((pane) => pane.files),
        ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
      ]);
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
      );
      const terminals = closingFiles.filter((file) => file.terminal);

      const finishClose = () => {
        const sessionIds = new Set(
          closing.flatMap((tab) =>
            leafIds(tab.layout).filter((paneId) =>
              sessionsRef.current.some((session) => session.id === paneId),
            ),
          ),
        );
        for (const sessionId of sessionIds) {
          persistSession(
            sessionsRef.current.find((session) => session.id === sessionId),
          );
          rememberRemoteSession(sessionId);
          rememberRemotePendingWorktree(sessionId);
        }
        setDirtyFiles((prev) => {
          const next = new Set(prev);
          for (const file of closingFiles) next.delete(file.id);
          return next;
        });
        setTabs((prev) => prev.filter((tab) => !closingIds.has(tab.id)));
        if (closingIds.has(activeTabIdRef.current)) activateTab(fallback.id);
        void refreshHistory(sidebarCwd);
      };

      // The caller already confirmed unsaved files and terminals.
      if (opts?.confirmed) {
        finishClose();
        return;
      }

      void (async () => {
        if (unsaved.length > 0) {
          const ok = await confirmDiscardUnsaved(
            "Close these tabs with unsaved files?",
          );
          if (!ok) return;
        }
        if (terminals.length > 0) {
          const ok = await confirmCloseTerminals(terminals);
          if (!ok) return;
        }
        finishClose();
      })();
    },
    [activateTab, persistSession, refreshHistory, sidebarCwd],
  );

  const onCloseOtherTabs = useCallback(() => {
    const current = tabsRef.current;
    const activeId = activeTabIdRef.current;
    if (!current.some((tab) => tab.id === activeId)) return;
    onCloseTabs(
      current.filter((tab) => tab.id !== activeId).map((tab) => tab.id),
      activeId,
    );
  }, [onCloseTabs]);

  const onCloseFile = useCallback(
    (paneId: string, fileId: string) => {
      const tab = tabsRef.current.find((entry) =>
        findSurfacePane(entry, paneId),
      );
      if (!tab) return;
      const found = findSurfacePane(tab, paneId);
      if (!found) return;
      const { kind, pane } = found;
      const index = pane.files.findIndex((file) => file.id === fileId);
      if (index < 0) return;
      const file = pane.files[index];
      const needsUnsavedConfirm =
        isFilesystemTab(file) && dirtyFilesRef.current.has(fileId);

      const finishClose = () => {
        const files = pane.files.filter((entry) => entry.id !== fileId);
        let nextFocus = tab.focusedId;
        let nextLayout = tab.layout;
        let nextPanes = surfacePanes(tab, kind);
        if (files.length > 0) {
          nextFocus = paneId;
          const activeFileId =
            pane.activeFileId === fileId
              ? files[Math.min(index, files.length - 1)].id
              : pane.activeFileId;
          nextPanes = nextPanes.map((entry) =>
            entry.id === paneId ? { ...entry, files, activeFileId } : entry,
          );
        } else {
          const sibling = siblingLeafId(tab.layout, paneId);
          const withoutPane = removePane(tab.layout, paneId);
          if (!withoutPane) {
            setDirtyFiles((prev) => {
              const next = new Set(prev);
              next.delete(fileId);
              return next;
            });
            const closePlan = planWorkspaceTabClose({
              tabs: tabsRef.current,
              sessions: sessionsRef.current,
              closingTabId: tab.id,
              scope: tabCloseScope,
              worktreeOf: tabWorktreeOf,
            });
            if (closePlan.action === "close") {
              onCloseTab(
                tab.id,
                file.terminal ? { confirmedTerminalIds: [fileId] } : undefined,
              );
              return;
            }
            const seed = sessionsRef.current[0];
            const session = newSession(
              seed?.harness ?? "claude",
              file.cwd || projectCwd,
              seed?.model,
              seed?.runtimeMode,
              seed?.modelSettings,
            );
            setSessions((prev) => [...prev, session]);
            setTabs((prev) =>
              prev.map((entry) =>
                entry.id === tab.id
                  ? {
                      ...entry,
                      layout: leaf(session.id),
                      focusedId: session.id,
                      editorPanes: [],
                      terminalPanes: [],
                      diffOpen: false,
                      diffFocused: false,
                    }
                  : entry,
              ),
            );
            setComposerFocused(true);
            const navigation = displayedTabNavigation.current;
            const nextId = nextDisplayedTabAfterClose(
              navigation.tabs,
              navigation.activeId,
              tab.id,
            );
            if (nextId) navigation.select?.(nextId);
            return;
          }
          nextLayout = withoutPane;
          nextFocus =
            tab.focusedId === paneId
              ? (sibling ?? firstLeafId(withoutPane))
              : tab.focusedId;
          nextPanes = nextPanes.filter((entry) => entry.id !== paneId);
        }

        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === tab.id
              ? withSurfacePanes(
                  {
                    ...entry,
                    layout: nextLayout,
                    focusedId: nextFocus,
                  },
                  kind,
                  nextPanes,
                )
              : entry,
          ),
        );
        setDirtyFiles((prev) => {
          const next = new Set(prev);
          next.delete(fileId);
          return next;
        });
        if (tab.id === activeTabId && files.length === 0) {
          setComposerFocused(
            sessionsRef.current.some((session) => session.id === nextFocus),
          );
        }
      };

      void (async () => {
        if (needsUnsavedConfirm) {
          const ok = await confirmDiscardUnsaved(
            `Close ${basename(file.path)} without saving?`,
          );
          if (!ok) return;
        }
        if (file.terminal) {
          const ok = await confirmCloseTerminal(file);
          if (!ok) return;
        }
        finishClose();
      })();
    },
    [activeTabId, onCloseTab, projectCwd, tabCloseScope],
  );

  const onCloseOtherFiles = useCallback((paneId: string, fileId: string) => {
    const tab = tabsRef.current.find((entry) => findSurfacePane(entry, paneId));
    if (!tab) return;
    const found = findSurfacePane(tab, paneId);
    if (!found?.pane.files.some((file) => file.id === fileId)) return;
    const closingFiles = found.pane.files.filter((file) => file.id !== fileId);
    if (closingFiles.length === 0) return;
    const closingIds = new Set(closingFiles.map((file) => file.id));
    const unsaved = closingFiles.filter(
      (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
    );
    const terminals = closingFiles.filter((file) => file.terminal);

    const finishClose = () => {
      setTabs((prev) =>
        prev.map((entry) => {
          if (entry.id !== tab.id) return entry;
          const current = findSurfacePane(entry, paneId);
          if (!current?.pane.files.some((file) => file.id === fileId)) {
            return entry;
          }
          return withSurfacePanes(
            { ...entry, focusedId: paneId },
            current.kind,
            surfacePanes(entry, current.kind).map((pane) =>
              pane.id === paneId
                ? {
                    ...pane,
                    files: pane.files.filter(
                      (file) => !closingIds.has(file.id),
                    ),
                    activeFileId: fileId,
                  }
                : pane,
            ),
          );
        }),
      );
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        for (const id of closingIds) next.delete(id);
        return next;
      });
    };

    void (async () => {
      if (unsaved.length > 0) {
        const ok = await confirmDiscardUnsaved(
          "Close other tabs with unsaved files?",
        );
        if (!ok) return;
      }
      if (terminals.length > 0) {
        const ok = await confirmCloseTerminals(terminals);
        if (!ok) return;
      }
      finishClose();
    })();
  }, []);

  const onClearTabSession = useCallback(
    (id: string, opts?: { confirmed?: boolean; selectNeighbor?: boolean }) => {
      const tab = tabs.find((entry) => entry.id === id);
      if (!tab) return;
      const navigation = displayedTabNavigation.current;
      const neighborId = opts?.selectNeighbor
        ? nextDisplayedTabAfterClose(navigation.tabs, navigation.activeId, id)
        : undefined;
      const selectNeighbor = () => {
        if (neighborId) navigation.select?.(neighborId);
      };
      if (isBlankWorkspaceTab(tab, sessionsRef.current)) {
        selectNeighbor();
        return;
      }

      const closingFiles = [
        ...tab.editorPanes.flatMap((pane) => pane.files),
        ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
      ];
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
      );

      const oldSessionId = leafIds(tab.layout).find((paneId) =>
        sessionsRef.current.some((session) => session.id === paneId),
      );
      const oldSession = sessionsRef.current.find(
        (session) => session.id === oldSessionId,
      );
      if (!oldSession) return;

      const clear = () => {
        persistSession(oldSession);
        for (const shellId of leafIds(tab.layout)) {
          rememberRemoteSession(shellId);
          rememberRemotePendingWorktree(shellId);
        }

        // The blank replacement stays in the tab's worktree, so clearing the
        // last tab there does not switch the workspace back to the project.
        const workspace = tabWorkspace(tab, sessionsRef.current);
        const focus = worktreeFocus(oldSession.cwd);
        const session = {
          ...newSession(
            oldSession.harness,
            oldSession.cwd,
            oldSession.model,
            oldSession.runtimeMode,
            oldSession.modelSettings,
          ),
          ...(workspace && !sameProjectPath(workspace, oldSession.cwd)
            ? {
                worktreeCwd: workspace,
                branch:
                  (focus && sameProjectPath(focus.path, workspace)
                    ? focus.branch
                    : undefined) ??
                  (oldSession.worktreeCwd &&
                  sameProjectPath(oldSession.worktreeCwd, workspace)
                    ? oldSession.branch
                    : undefined) ??
                  undefined,
              }
            : {}),
        };

        setSessions((prev) => [...prev, session]);
        // WP-110: a new chat follows the worktree setting.
        attachNewChatWorktree(session.id, session.cwd, setSessions);
        setDirtyFiles((prev) => {
          const updated = new Set(prev);
          for (const file of closingFiles) updated.delete(file.id);
          return updated;
        });
        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  layout: leaf(session.id),
                  focusedId: session.id,
                  editorPanes: [],
                  terminalPanes: [],
                  diffOpen: false,
                  diffFocused: false,
                }
              : entry,
          ),
        );
        setComposerFocused(true);
        void refreshHistory(sidebarCwd);
        selectNeighbor();
      };
      // A view tab opens in a transition; clearing alongside it keeps the
      // blank tab from painting before the view.
      const finishClear = () => {
        if (neighborId && isViewTab(neighborId)) startTransition(clear);
        else clear();
      };

      // The caller already confirmed unsaved files.
      if (unsaved.length === 0 || opts?.confirmed) {
        finishClear();
        return;
      }
      void confirmDiscardUnsaved(
        "Close this conversation with unsaved files?",
      ).then((ok) => ok && finishClear());
    },
    [tabs, persistSession, refreshHistory, sidebarCwd],
  );

  const onRemoteSessionDeleted = useCallback(
    (remoteSessionId: string) => {
      const tab = tabsRef.current.find((entry) =>
        leafIds(entry.layout).some(
          (shellId) => remoteSessionFor(shellId) === remoteSessionId,
        ),
      );
      if (!tab) return;
      const closePlan = planWorkspaceTabClose({
        tabs: tabsRef.current,
        sessions: sessionsRef.current,
        closingTabId: tab.id,
        scope: tabCloseScope,
        worktreeOf: tabWorktreeOf,
      });
      if (closePlan.action === "keep") onClearTabSession(tab.id);
      else onCloseTab(tab.id);
    },
    [onClearTabSession, onCloseTab, tabCloseScope],
  );

  const seedSession = useCallback((cwd: string) => {
    const seed = sessionsRef.current[0];
    return newSession(
      seed?.harness ?? "claude",
      cwd,
      seed?.model,
      seed?.runtimeMode,
      seed?.modelSettings,
    );
  }, []);

  // The workspace always keeps one tab, so close every other tab and reset
  // the active one to a blank session. `scope` limits this to those tabs,
  // such as the ones the title bar shows. Every confirmation runs before
  // any tab changes, so a cancelled prompt leaves all tabs.
  const onCloseEveryTab = useCallback(
    (scope?: readonly string[]) => {
      const inScope = scope ? new Set(scope) : null;
      const tab = tabsRef.current.find(
        (entry) => entry.id === activeTabIdRef.current,
      );
      if (!tab || (inScope && !inScope.has(tab.id))) return;

      const otherIds = tabsRef.current
        .filter((entry) => entry.id !== tab.id)
        .filter((entry) => !inScope || inScope.has(entry.id))
        .map((entry) => entry.id);
      const keptFiles = [
        ...tab.editorPanes.flatMap((pane) => pane.files),
        ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
      ];
      const closingFiles = [
        ...tabsRef.current
          .filter((entry) => otherIds.includes(entry.id))
          .flatMap((entry) => [
            ...entry.editorPanes.flatMap((pane) => pane.files),
            ...(entry.terminalPanes ?? []).flatMap((pane) => pane.files),
          ]),
        ...keptFiles,
      ];
      const unsaved = closingFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
      );
      const terminals = closingFiles.filter((file) => file.terminal);

      void (async () => {
        if (unsaved.length > 0) {
          const ok = await confirmDiscardUnsaved(
            "Close all tabs with unsaved files?",
          );
          if (!ok) return;
        }
        if (terminals.length > 0) {
          const ok = await confirmCloseTerminals(terminals);
          if (!ok) return;
        }
        if (otherIds.length > 0) {
          onCloseTabs(otherIds, tab.id, { confirmed: true });
        }
        const hasSession = leafIds(tab.layout).some((paneId) =>
          sessionsRef.current.some((session) => session.id === paneId),
        );
        if (hasSession) {
          onClearTabSession(tab.id, { confirmed: true });
          return;
        }
        // The tab held no session: seed one so the workspace stays usable.
        const session = seedSession(keptFiles[0]?.cwd || projectCwd);
        setSessions((prev) => [...prev, session]);
        // WP-110: a new chat follows the worktree setting.
        attachNewChatWorktree(session.id, session.cwd, setSessions);
        setDirtyFiles((prev) => {
          const updated = new Set(prev);
          for (const file of keptFiles) updated.delete(file.id);
          return updated;
        });
        setTabs((prev) =>
          prev.map((entry) =>
            entry.id === tab.id ? resetTabToSession(entry, session.id) : entry,
          ),
        );
        setComposerFocused(true);
      })();
    },
    [onCloseTabs, onClearTabSession, projectCwd, seedSession],
  );

  const onCloseAllTabs = useCallback(() => {
    closeMonoView();
    const tab = tabsRef.current.find(
      (entry) => entry.id === activeTabIdRef.current,
    );
    if (!tab) return;

    // Stage one: files open in the active tab's editor panes close first.
    // Only when none are open does the command close every workspace tab.
    const editorFiles = tab.editorPanes.flatMap((pane) => pane.files);
    if (editorFiles.length > 0) {
      const remaining = closeSurfacePanes(tab, "editor");
      if (!remaining) {
        const closePlan = planWorkspaceTabClose({
          tabs: tabsRef.current,
          sessions: sessionsRef.current,
          closingTabId: tab.id,
          scope: tabCloseScope,
          worktreeOf: tabWorktreeOf,
        });
        if (closePlan.action === "close") {
          onCloseTab(tab.id);
          return;
        }
      }
      const unsaved = editorFiles.filter(
        (file) => isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
      );

      const finishClose = () => {
        let nextTab: WorkspaceTab;
        let focusesSession: boolean;
        if (remaining) {
          nextTab = remaining;
          focusesSession = sessionsRef.current.some(
            (session) => session.id === remaining.focusedId,
          );
        } else {
          // The tab held only editor panes and must stay: seed a session.
          const session = seedSession(editorFiles[0].cwd || projectCwd);
          setSessions((prev) => [...prev, session]);
          nextTab = resetTabToSession(tab, session.id);
          focusesSession = true;
        }
        setTabs((prev) =>
          prev.map((entry) => (entry.id === tab.id ? nextTab : entry)),
        );
        setDirtyFiles((prev) => {
          const updated = new Set(prev);
          for (const file of editorFiles) updated.delete(file.id);
          return updated;
        });
        setComposerFocused(focusesSession);
      };

      void (async () => {
        if (unsaved.length > 0) {
          const ok = await confirmDiscardUnsaved(
            "Close all open files with unsaved changes?",
          );
          if (!ok) return;
        }
        finishClose();
      })();
      return;
    }

    // Stage two: no files are open, so close every workspace tab.
    onCloseEveryTab();
  }, [onCloseEveryTab, onCloseTab, projectCwd, seedSession, tabCloseScope]);

  const onClosePane = useCallback(
    (sessionId?: string) => {
      if (monoViewIdRef.current) {
        closeMonoView();
        setComposerFocused(true);
        return;
      }
      // The project terminal is shared by every workspace tab in the project,
      // so pane and title-bar close buttons stay scoped to workspace tabs and
      // panes. ⌘W / Ctrl+W goes through onCloseFocused to reach the dock.
      if (!activeTab) return;
      const focusedSurface = findSurfacePane(activeTab, activeTab.focusedId);
      if (sessionId === undefined && focusedSurface) {
        onCloseFile(focusedSurface.pane.id, focusedSurface.pane.activeFileId);
        return;
      }
      const closingId = sessionId ?? activeTab.focusedId;
      const ids = leafIds(activeTab.layout);
      const sessionIds = ids.filter((paneId) =>
        sessionsRef.current.some((session) => session.id === paneId),
      );
      if (!sessionIds.includes(closingId)) return;
      const nextTab = closeLeaf(activeTab, closingId);
      if (!nextTab) {
        const closePlan = planWorkspaceTabClose({
          tabs: tabsRef.current,
          sessions: sessionsRef.current,
          closingTabId: activeTab.id,
          scope: tabCloseScope,
          worktreeOf: tabWorktreeOf,
        });
        if (closePlan.action === "keep") {
          onClearTabSession(activeTab.id, { selectNeighbor: true });
        } else {
          onCloseTab(activeTab.id);
        }
        return;
      }
      persistSession(sessionsRef.current.find((s) => s.id === closingId));
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id
            ? { ...t, layout: nextTab.layout, focusedId: nextTab.focusedId }
            : t,
        ),
      );
      if (closingId === activeTab.focusedId) {
        setComposerFocused(
          nextTab &&
            sessionsRef.current.some(
              (session) => session.id === nextTab.focusedId,
            ),
        );
      }
      void refreshHistory(sidebarCwd);
    },
    [
      activeTab,
      closeMonoView,
      onCloseFile,
      onCloseTab,
      onClearTabSession,
      persistSession,
      refreshHistory,
      sidebarCwd,
      tabCloseScope,
    ],
  );

  /** The dock terminal that ⌘T / ⌘W act on while the keyboard is in the dock. */
  const focusedDockTerminal = useCallback(() => {
    // Require DOM focus as well as the dock flag: the flag outlives clicks on
    // chrome that does not clear it, and the shortcuts must follow the keyboard.
    const dockFocused =
      projectTerminalFocusedRef.current &&
      Boolean(document.activeElement?.closest("[data-project-terminal-dock]"));
    return focusedDockTerminalId(
      findProjectTerminal(projectTerminalsRef.current, projectCwdRef.current),
      dockFocused,
    );
  }, []);

  /** ⌘T / Ctrl+T: add a dock terminal while the dock has focus, else a tab. */
  const onNewFocused = useCallback(() => {
    if (focusedDockTerminal()) onNewTerminal();
    else onNew();
  }, [focusedDockTerminal, onNew, onNewTerminal]);

  /** ⌘W / Ctrl+W: close the focused dock terminal, else the focused pane. */
  const onCloseFocused = useCallback(() => {
    const fileId = focusedDockTerminal();
    if (fileId) onCloseProjectTerminal(fileId);
    else onClosePane();
  }, [focusedDockTerminal, onCloseProjectTerminal, onClosePane]);

  const onCloseTitleTab = useCallback(
    (id: string) => {
      // The inset layout shows a Mono as its own tab, which closing another
      // tab leaves alone.
      if (!insetLayoutRef.current) closeMonoView();
      const closePlan = planWorkspaceTabClose({
        tabs: tabsRef.current,
        sessions: sessionsRef.current,
        closingTabId: id,
        scope: tabCloseScope,
        worktreeOf: tabWorktreeOf,
      });
      if (closePlan.action === "keep" && id === activeTabIdRef.current) {
        onClosePane();
        return;
      }
      onCloseTab(id);
    },
    [onClosePane, onCloseTab, tabCloseScope],
  );

  /** Open tabs per workspace in the sidebar's project, keyed by worktree
   * path, so the switcher can show what each worktree still has open. */
  const worktreeTabStats = useMemo(() => {
    const stats = new Map<string, { tabs: number; busy: boolean }>();
    if (!sidebarCwd || sidebarCwd === "~" || isRemoteProjectPath(sidebarCwd))
      return stats;
    for (const tab of filterTabsForProject(tabs, sessions, sidebarCwd)) {
      const workspace = tabWorkspace(tab, sessions) ?? sidebarCwd;
      const key = pathKey(workspace);
      const entry = stats.get(key) ?? { tabs: 0, busy: false };
      entry.tabs += 1;
      entry.busy ||= leafIds(tab.layout).some(
        (id) => sessions.find((session) => session.id === id)?.busy,
      );
      stats.set(key, entry);
    }
    return stats;
  }, [tabs, sessions, sidebarCwd, tabWorkspace, workspaceNavigation.revision]);
  const deckProjectTabs = useMemo(() => {
    // A projectless session belongs to no project, so it stands on its own
    // rather than trailing the last project's tabs.
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (active && !workspaceTabCwd(active, sessions)) return [active];
    // Each worktree keeps its own tabs; the others stay open, just hidden.
    const worktree = projectWorktree?.path ?? projectCwd;
    return filterTabsForProject(tabs, sessions, projectCwd).filter((tab) => {
      if (tab.id === activeTabId) return true;
      const workspace = tabWorkspace(tab, sessions);
      return !workspace || sameProjectPath(workspace, worktree);
    });
  }, [
    activeTabId,
    tabs,
    sessions,
    projectCwd,
    projectWorktree?.path,
    tabWorkspace,
    workspaceNavigation.revision,
  ]);

  const onNext = useCallback(() => {
    if (monoViewIdRef.current) {
      activateTab(activeTabId);
      return;
    }
    const index = deckProjectTabs.findIndex((t) => t.id === activeTabId);
    if (index >= 0)
      activateTab(deckProjectTabs[(index + 1) % deckProjectTabs.length].id);
  }, [activateTab, activeTabId, deckProjectTabs]);

  const onPrev = useCallback(() => {
    if (monoViewIdRef.current) {
      activateTab(activeTabId);
      return;
    }
    const index = deckProjectTabs.findIndex((t) => t.id === activeTabId);
    if (index >= 0) {
      activateTab(
        deckProjectTabs[
          (index - 1 + deckProjectTabs.length) % deckProjectTabs.length
        ].id,
      );
    }
  }, [activateTab, activeTabId, deckProjectTabs]);

  const onVisitBack = useCallback(() => {
    if (monoViewIdRef.current) {
      activateTab(activeTabIdRef.current);
      return;
    }
    const openIds = new Set(tabsRef.current.map((tab) => tab.id));
    const pruned = pruneTabVisitHistory(
      tabVisitRef.current,
      openIds,
      activeTabIdRef.current,
    );
    const next = tabVisitBack(pruned);
    if (!next || !openIds.has(next.current)) return;
    tabVisitFromHistoryRef.current = true;
    commitTabVisit(next);
    activateTab(next.current);
  }, [activateTab, commitTabVisit]);

  const onVisitForward = useCallback(() => {
    if (monoViewIdRef.current) {
      activateTab(activeTabIdRef.current);
      return;
    }
    const openIds = new Set(tabsRef.current.map((tab) => tab.id));
    const pruned = pruneTabVisitHistory(
      tabVisitRef.current,
      openIds,
      activeTabIdRef.current,
    );
    const next = tabVisitForward(pruned);
    if (!next || !openIds.has(next.current)) return;
    tabVisitFromHistoryRef.current = true;
    commitTabVisit(next);
    activateTab(next.current);
  }, [activateTab, commitTabVisit]);

  const onActivate = useCallback(
    (slot: number) => {
      const tab =
        slot < 0
          ? deckProjectTabs[deckProjectTabs.length - 1]
          : deckProjectTabs[slot];
      if (tab) activateTab(tab.id);
    },
    [activateTab, deckProjectTabs],
  );

  const onFocusPane = useCallback(
    (paneId: string, reason?: "pointer") => {
      const focus = paneFocus(paneId, {
        monoViewId: monoViewIdRef.current,
        shownMonoSessionId: shownMonoSessionIdRef.current ?? null,
      });
      if (focus === "mono") {
        setMonoShownSessionFocused(false);
        setProjectTerminalFocused(false);
        setComposerFocused(true);
        return;
      }
      if (focus === "shown") {
        setMonoShownSessionFocused(true);
        setProjectTerminalFocused(false);
        setComposerFocused(true);
        return;
      }
      // Over the Mono every workspace tab is hidden, and a pane outside the workspace is a launched session sliding
      // away from its sidebar: Ash can't have clicked either, so their focus never closes the Mono (r61).
      if (focus === "ignore") return;
      // WP-06: uncovering the project pane focuses it. That is not Ash leaving the Lead. A real click is, and it
      // cancels an open still in flight (focusClosesMono), so a hung open cannot swallow the next click.
      if (!focusClosesMono({ opening: openingMono.current, pointer: reason === "pointer" })) return;
      closeMonoView();
      if (
        tabsRef.current.find((tab) => tab.id === activeTabIdRef.current)
          ?.focusedId !== paneId
      )
        workspaceNavigation.cancel();
      setProjectTerminalFocused(false);
      if (inboxAskPortal?.sessionId === paneId) {
        setComposerFocused(true);
        return;
      }
      setTabs((prev) => {
        const selectedId = activeTabIdRef.current;
        const selected = prev.find((tab) => tab.id === selectedId);
        if (!selected || (selected.focusedId === paneId && !selected.diffFocused)) return prev;
        return prev.map((tab) => tab.id === selectedId
          ? { ...tab, focusedId: paneId, diffFocused: false }
          : tab);
      });
      setComposerFocused(
        sessionsRef.current.some((session) => session.id === paneId),
      );
    },
    [inboxAskPortal, closeMonoView],
  );

  const onOpenDiff = useCallback(
    (
      path?: string,
      session?: { sessionId: string; cwd: string },
      changeKind?: GitFileDiffKind,
      pin = false,
      options?: { exact?: boolean },
    ) => {
      void (async () => {
        const diffCwd = session?.cwd ?? gitCwdRef.current;
        const diffProjectCwd = session
          ? sessionsRef.current.find((entry) => entry.id === session.sessionId)
              ?.cwd
          : sidebarCwdRef.current;
        const resolved = path
          ? options?.exact
            ? path
            : ((await resolveOpenablePath(diffCwd, path)) ?? path)
          : undefined;
        if (resolved) rememberOpenedFile(diffCwd, resolved);
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.id !== activeTabId) return tab;
            if (session) {
              return openSessionChangesTab(
                tab,
                session.cwd,
                session.sessionId,
                resolved,
                diffProjectCwd,
                pin,
              );
            }
            if (loadDiffViewer() === "unified") {
              return openChangesTab(
                tab,
                diffCwd,
                resolved,
                changeKind,
                diffProjectCwd,
              );
            }
            if (!resolved) return tab;
            return openEditorTab(
              tab,
              newFileTab(resolved, diffCwd, true, changeKind, diffProjectCwd),
              { pin },
            );
          }),
        );
        setSidebarTab("changes", diffProjectCwd);
        setComposerFocused(false);
      })();
    },
    [activeTabId],
  );

  // A Mono view covers the workspace, so its session changes open on the
  // overview's Changes tab instead of in a project tab hidden behind it.
  const openMonoChanges = useCallback((request: MonoChangesRequest) => {
    setMonoShownSession(null);
    setMonoOverviewDocument(null);
    setMonoChangesRequest(request);
    setMonoOverviewTab("changes");
    setMonoOverviewOpen(true);
  }, []);
  const onOpenMonoDiff = useCallback(
    (path?: string, session?: { sessionId: string; cwd: string }) => {
      if (!session) {
        onOpenDiff(path);
        return;
      }
      openMonoChanges({ path });
    },
    [onOpenDiff, openMonoChanges],
  );
  const onCommitMonoChanges = useCallback(
    () => openMonoChanges({}),
    [openMonoChanges],
  );

  const onOpenWorkingTreeDiff = useCallback(
    (path: string, kind?: GitFileDiffKind, pin?: boolean) =>
      onOpenDiff(path, undefined, kind, pin, { exact: true }),
    [onOpenDiff],
  );

  /** Stack one section's working-tree changes in one review, whatever the diff-view setting. */
  const onOpenAllChanges = useCallback(
    (kind: GitFileDiffKind) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? openChangesTab(
                tab,
                gitCwdRef.current,
                undefined,
                kind,
                sidebarCwdRef.current,
              )
            : tab,
        ),
      );
      setComposerFocused(false);
    },
    [activeTabId],
  );

  const onOpenCommit = useCallback(
    (commit: GitHistoryCommit, pin?: boolean) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? openCommitTab(
                tab,
                gitCwdRef.current,
                {
                  sha: commit.sha,
                  shortSha: commit.shortSha,
                  subject: commit.subject,
                },
                sidebarCwdRef.current,
                pin,
              )
            : tab,
        ),
      );
      setComposerFocused(false);
    },
    [activeTabId],
  );

  const onShowSourceControl = useCallback(() => {
    setSidebarTab("changes");
  }, []);

  const onToggleChanges = useCallback(() => {
    onShowSourceControl();
  }, [onShowSourceControl]);

  const onReorderTabs = useCallback(
    (ids: string[], movedId?: string) => {
      setTabs((prev) => {
        const visibleIds = new Set(ids);
        const visibleTabs = prev.filter((tab) => visibleIds.has(tab.id));
        if (movedId) {
          const reordered = applyGroupedReorder(
            visibleTabs,
            ids,
            movedId,
            projectOfTab,
          );
          return reordered ? mergeOrderedSubset(prev, reordered) : prev;
        }
        return mergeOrderedSubset(prev, orderByIds(visibleTabs, ids));
      });
    },
    [projectOfTab],
  );

  const onReorderFiles = useCallback((paneId: string, ids: string[]) => {
    setTabs((prev) =>
      prev.map((tab) => {
        const found = findSurfacePane(tab, paneId);
        if (!found) return tab;
        return withSurfacePanes(
          tab,
          found.kind,
          surfacePanes(tab, found.kind).map((pane) =>
            pane.id === paneId
              ? { ...pane, files: orderByIds(pane.files, ids) }
              : pane,
          ),
        );
      }),
    );
  }, []);

  const onMovePane = useCallback(
    (fromId: string, toId: string, edge: PaneEdge) => {
      setTabs((prev) =>
        prev.map((tab) => {
          return leafIds(tab.layout).includes(fromId)
            ? {
                ...tab,
                layout: movePane(tab.layout, fromId, toId, edge),
                focusedId: fromId,
              }
            : tab;
        }),
      );
    },
    [],
  );

  const onDetachPane = useCallback(
    (paneId: string, targetTabId: string, position: "before" | "after") => {
      const result = applyDetachPaneToTab({
        tabs: tabsRef.current,
        paneId,
        targetTabId,
        position,
      });
      if (!result) return;

      tabsRef.current = result.tabs;
      setTabs(result.tabs);
      setProjectTerminalFocused(false);
      activateTab(result.activeTabId, result.focusedId);
    },
    [activateTab],
  );

  const focusOpenSession = useCallback((sessionId: string) => {
    const tab = findOpenSessionTab(
      tabsRef.current,
      sessionsRef.current,
      sessionId,
    );
    if (!tab) return false;
    loadedSessionCache.current.delete(sessionId);
    setActiveTabId(tab.id);
    setTabs((prev) =>
      prev.map((entry) =>
        entry.id === tab.id ? { ...entry, focusedId: sessionId } : entry,
      ),
    );
    setComposerFocused(true);
    return true;
  }, []);

  const replaceBlankPaneWithSession = useCallback((session: Session) => {
    const tab =
      tabsRef.current.find((entry) => entry.id === activeTabIdRef.current) ??
      tabsRef.current[0];
    if (!tab) return false;

    const paneId = isBlankSession(
      sessionsRef.current.find((entry) => entry.id === tab.focusedId),
    )
      ? tab.focusedId
      : leafIds(tab.layout).find((id) =>
          isBlankSession(sessionsRef.current.find((entry) => entry.id === id)),
        );
    if (!paneId || paneId === session.id) return false;

    lastPersisted.current.delete(paneId);
    {
      const blank = sessionsRef.current.find((entry) => entry.id === paneId);
      if (blank) void forgetHarnessSession(blank.harness, paneId);
    }
    setSessions((prev) => {
      const next = prev.filter((entry) => entry.id !== paneId);
      return next.some((entry) => entry.id === session.id)
        ? next
        : [...next, session];
    });
    setTabs((prev) =>
      prev.map((entry) =>
        entry.id === tab.id
          ? {
              ...entry,
              layout: replaceLeafId(entry.layout, paneId, session.id),
              focusedId: session.id,
            }
          : entry,
      ),
    );
    setActiveTabId(tab.id);
    setComposerFocused(true);
    return true;
  }, []);

  const invalidateLoadedSession = useCallback((sessionId: string) => {
    openingSessionIds.current.delete(sessionId);
    loadedSessionCache.current.delete(sessionId);
    sessionLoads.current.delete(sessionId);
    sessionLoadEpochs.current.set(
      sessionId,
      (sessionLoadEpochs.current.get(sessionId) ?? 0) + 1,
    );
  }, []);

  const loadStoredSession = useCallback(
    (sessionId: string): Promise<Session | null> => {
      const cached = loadedSessionCache.current.get(sessionId);
      if (cached) {
        // The cache owns closed sessions only. Transfer this reference into
        // live state instead of retaining a stale duplicate while it changes.
        loadedSessionCache.current.delete(sessionId);
        return Promise.resolve(cached);
      }

      const pending = sessionLoads.current.get(sessionId);
      if (pending) return pending;

      const epoch = sessionLoadEpochs.current.get(sessionId) ?? 0;
      const loading = readSession(sessionId)
        .then((loaded) => {
          if (
            !loaded ||
            removingSessionIds.current.has(sessionId) ||
            (sessionLoadEpochs.current.get(sessionId) ?? 0) !== epoch
          ) {
            return null;
          }
          return loaded;
        })
        .catch(() => null);
      sessionLoads.current.set(sessionId, loading);
      void loading.then(() => {
        if (sessionLoads.current.get(sessionId) === loading) {
          sessionLoads.current.delete(sessionId);
        }
      });
      return loading;
    },
    [],
  );

  const ensureOpenSession = useCallback(
    async (sessionId: string): Promise<Session | null> => {
      const open = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (open) return open;

      openingSessionIds.current.add(sessionId);
      const restored = await loadStoredSession(sessionId);
      if (!restored || removingSessionIds.current.has(sessionId)) {
        openingSessionIds.current.delete(sessionId);
        void refreshHistory(sidebarCwd);
        return null;
      }
      loadedSessionCache.current.delete(sessionId);
      const appeared = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (appeared) return appeared;
      if (
        !restored.worktreeRemoved &&
        restored.providerSessionId &&
        isLiveHarness(restored.harness)
      ) {
        // WP-134b: a More agents chat binds its saved ACP session to its entry. The route is set first, in this same
        // call, so the bind never reaches the harness the chat was saved with.
        if (restored.registryAgentId) {
          openMoreAgentSession(restored.id, restored.registryAgentId);
        }
        bindHarnessSession(
          restored.harness,
          restored.id,
          restored.providerSessionId,
          sessionWorkCwd(restored),
          restored.providerAccountId,
          restored.blocks,
          restored.goal,
        );
      }
      lastPersisted.current.set(restored.id, persistFingerprint(restored));
      if (!sessionsRef.current.some((session) => session.id === restored.id)) {
        const next = [...sessionsRef.current, restored];
        sessionsRef.current = next;
        setSessions(next);
        // Provider log reads (old shell labels, subagent trails, interjections)
        // must not sit between the hotkey and the saved conversation. Apply
        // them later only if this transcript has not advanced in the meantime.
        void repairSession(restored, { persist: false })
          .then((repaired) => {
            if (repaired.blocks === restored.blocks) return;
            updateSessionState(sessionsRef, setSessions, (current) => {
              let changed = false;
              const next = current.map((session) => {
                if (session.id !== restored.id) return session;
                const repairedSession = applySessionRepair(
                  session,
                  restored,
                  repaired,
                );
                changed ||= repairedSession !== session;
                return repairedSession;
              });
              return changed ? next : current;
            });
          })
          .catch(() => undefined);
      }
      return restored;
    },
    [loadStoredSession, refreshHistory, sidebarCwd],
  );

  const onPrefetchHistorySession = useCallback(
    (sessionId: string) => {
      if (
        removingSessionIds.current.has(sessionId) ||
        sessionsRef.current.some((session) => session.id === sessionId) ||
        loadedSessionCache.current.has(sessionId) ||
        sessionLoads.current.has(sessionId) ||
        activeSessionPrefetch.current
      ) {
        return;
      }
      const loading = loadStoredSession(sessionId);
      activeSessionPrefetch.current = loading;
      void loading.then((loaded) => {
        if (
          loaded &&
          !removingSessionIds.current.has(sessionId) &&
          !sessionsRef.current.some((session) => session.id === sessionId)
        ) {
          rememberLoadedSession(loadedSessionCache.current, loaded);
        }
        if (activeSessionPrefetch.current === loading) {
          activeSessionPrefetch.current = null;
        }
      });
    },
    [loadStoredSession],
  );

  const revealLinkedSessionUpdate = useCallback(
    (sessionId: string, update: LinkedSessionUpdate) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      if (!session?.linkedWorkItem) return;
      if (
        session.linkedWorkItemUpdateCard?.updatedAt === update.updatedAt &&
        session.linkedWorkItemUpdateCard.status !== "error"
      ) {
        return;
      }
      if (
        linkedWorkItemActivityFetches.current.get(sessionId) ===
        update.updatedAt
      ) {
        return;
      }
      const pending = pendingLinkedWorkItemUpdateCard(update);
      linkedWorkItemActivityFetches.current.set(sessionId, update.updatedAt);
      // A stale/error card should not remain visible while fresh details load.
      // The session itself is already open; this request stays fully detached
      // from the navigation path.
      setLinkedWorkItemUpdateCard(sessionId, (current) =>
        current?.updatedAt === update.updatedAt && current.status === "ready"
          ? current
          : undefined,
      );

      void githubWorkItemThread(
        session.cwd,
        session.linkedWorkItem.repo,
        session.linkedWorkItem.kind,
        session.linkedWorkItem.number,
        { force: true },
      ).then(
        (thread) => {
          if (
            linkedWorkItemActivityFetches.current.get(sessionId) !==
            pending.updatedAt
          ) {
            return;
          }
          linkedWorkItemActivityFetches.current.delete(sessionId);
          if (
            linkedSessionUpdatesRef.current.get(sessionId)?.updatedAt !==
            pending.updatedAt
          ) {
            return;
          }
          setLinkedWorkItemUpdateCard(sessionId, () =>
            completeLinkedWorkItemUpdateCard(pending, thread),
          );
        },
        () => {
          if (
            linkedWorkItemActivityFetches.current.get(sessionId) !==
            pending.updatedAt
          ) {
            return;
          }
          linkedWorkItemActivityFetches.current.delete(sessionId);
          if (
            linkedSessionUpdatesRef.current.get(sessionId)?.updatedAt !==
            pending.updatedAt
          ) {
            return;
          }
          setLinkedWorkItemUpdateCard(sessionId, () =>
            failLinkedWorkItemUpdateCard(pending),
          );
        },
      );
    },
    [setLinkedWorkItemUpdateCard],
  );

  const onAskInboxItem = useCallback(
    (item: InboxItem): Promise<string> => {
      const key = inboxAskKey(item);
      const pending = openingInboxSessions.current.get(key);
      if (pending) return pending;
      const opening = (async () => {
        let session = sessionsRef.current.find(
          (entry) => entry.inboxAsk?.key === key,
        );
        if (!session) {
          const candidate = item.projectPath || sidebarCwd;
          const cwd =
            candidate && candidate !== "~"
              ? candidate
              : await invoke<string>("default_cwd");
          const description =
            item.provider === "linear" || item.provider === "jira"
              ? await inboxTrackerDescription(item)
              : item.provider === "gitlab" &&
                  (item.kind === "issue" || item.kind === "pr")
                ? (
                    peekGitlabWorkItemDetails(
                      item.repo,
                      item.kind,
                      item.number,
                    ) ??
                    (await gitlabWorkItemDetails(
                      item.repo,
                      item.kind,
                      item.number,
                    ))
                  ).body
                : item.provider === "azuredevops" &&
                    (item.kind === "issue" || item.kind === "pr")
                  ? (
                      peekAzureDevOpsWorkItemDetails(
                        item.repo,
                        item.kind,
                        item.number,
                      ) ??
                      (await azureDevOpsWorkItemDetails(
                        item.repo,
                        item.kind,
                        item.number,
                      ))
                    ).body
                  : undefined;
          session = {
            ...newDefaultSession(cwd),
            title: `Ask · ${item.title}`,
            inboxAsk: {
              key,
              title: item.title,
              url: item.url,
              provider: item.provider,
              description,
            },
          };
          sessionsRef.current = [...sessionsRef.current, session];
          setSessions(sessionsRef.current);
        }
        return session.id;
      })();
      openingInboxSessions.current.set(key, opening);
      void opening.then(
        () => openingInboxSessions.current.delete(key),
        () => openingInboxSessions.current.delete(key),
      );
      return opening;
    },
    [sidebarCwd],
  );

  const onRestartInboxAsk = useCallback(
    async (item: InboxItem): Promise<string> => {
      const id = await onAskInboxItem(item);
      const current = sessionsRef.current.find((session) => session.id === id)!;
      removingSessionIds.current.add(id);
      try {
        await stopSessionForRemoval(id);
        const stopped =
          sessionsRef.current.find((session) => session.id === id) ?? current;
        await Promise.all(
          sessionChildHarnesses(stopped).map((harness) =>
            forgetHarnessSession(harness, id),
          ),
        );
        const imagePaths = stopped.blocks.flatMap((block) =>
          block.role === "image" && block.image ? [block.image.path] : [],
        );
        await deleteSession(id, imagePaths);
        const fresh = {
          ...newSession(
            stopped.harness,
            stopped.cwd,
            stopped.model,
            stopped.runtimeMode,
            stopped.modelSettings,
          ),
          title: stopped.title,
          inboxAsk: stopped.inboxAsk,
        };
        const next = sessionsRef.current.map((session) =>
          session.id === id ? fresh : session,
        );
        sessionsRef.current = next;
        setSessions(next);
        setInboxAskPortal((portal) =>
          portal?.sessionId === id
            ? { ...portal, sessionId: fresh.id }
            : portal,
        );
        return fresh.id;
      } finally {
        removingSessionIds.current.delete(id);
      }
    },
    [onAskInboxItem, stopSessionForRemoval],
  );

  useEffect(() => {
    if (!inboxAskPortal || !inboxViewOpen) return;
    setComposerFocused(true);
  }, [inboxAskPortal, inboxViewOpen]);

  /** The last Mono opened, which the shortcut brings back. */
  const lastMonoIdRef = useRef<string | undefined>(undefined);

  /** The project rail's selection (onSelectProject, declared below), for a Lead opening in its coding team. */
  const selectProjectRef = useRef<(path: string) => void>(() => undefined);

  /** A Mono's conversation is a view over the existing workspace tabs. */
  const onOpenMono = useCallback(
    async (monoId: string, options: { inTeam?: boolean; leaveSettings?: boolean; project?: string } = {}) => {
      // WP-06: held until the focus from uncovering the project pane has passed (onFocusPane).
      const opening = ++openingMonoGen.current;
      openingMono.current = true;
      try {
      // A project's Lead lives in its coding team (Ash, 20 Oct: "mainly the coding team is the main place i want to
      // talk to"): opened from anywhere (the Monos rail, Being built, Today, a page), it lands there, with the
      // project's Sessions list beside its chat.
      // Dropwave: the Mono's own chat for a project (the Chief of Staff's) opens in that project's chat area the same
      // way, pinned on top of its list.
      const ownProject = options.project
        ? hubData().listProjects().find((project) => project.id === options.project)
        : undefined;
      const team = ownProject ? (codingTeamsOn() && ownProject.folder ? ownProject : undefined) : leadCodingTeam(monoId);
      // Any other Mono opens on its own (people, not work), or inside its own team (monoTeams.ts) when asked: its
      // chat pinned on top of the team's Sessions list, as a Lead's is in its coding team.
      const own = !team && !ownProject && options.inTeam && codingTeamsOn() ? monoTeam(monoId) : undefined;
      if (team?.folder) {
        setProjectFront(team.id, ownProject ? "captain" : "lead");
        setHubSelection({ project: team.id, item: "coding-team" });
        nameHubProject(team);
        noteCodingTeamView(team.id, "lead");
        if (!sameProjectPath(projectCwdRef.current, team.folder)) {
          selectProjectRef.current(team.folder);
        }
        // The project's own chat must not take the focus meanwhile: a pane taking focus closes the Mono's view
        // (onFocusPane). The Lead's composer takes it once its view is up. The pane is already showing when the
        // folder has not changed, so this is not only for a project switch (WP-06).
        setComposerFocused(false);
      } else if (own) {
        const mono = findMono(monoId);
        // The Mono's own team opens over the project Ash was last in (a project is the unit of the hub, G1).
        showAppItem(monoTeamItem(monoId));
        nameMonoTeam(own.folder, mono ? monoLook(mono).name : undefined);
        noteCodingTeamView(monoTeamItem(monoId), "lead");
        if (!sameProjectPath(projectCwdRef.current, own.folder)) {
          selectProjectRef.current(own.folder);
        }
        setComposerFocused(false);
      } else {
        // The rail opens this Mono on its own. Its team still selected (Inbox does not change the item) would keep
        // Team pressed, so the chat would open inside the team.
        const left = selectionLeavingOwnTeam(currentHubSelection(), monoId);
        if (left) setHubSelection(left);
      }
      setMonoActivity(null);
      workspaceNavigation.cancel();
      const request = ++monoViewRequest.current;
      lastMonoIdRef.current = monoId;
      const sessionHost = {
        home: homeDir,
        load: ensureOpenSession,
        create: (path: string) => newDefaultSession(path),
        add: (created: Session) => {
          sessionsRef.current = [...sessionsRef.current, created];
          setSessions(sessionsRef.current);
        },
      };
      const opened = ownProject
        ? await ensureMonoProjectSession(monoId, ownProject, sessionHost)
        : await ensureMonoSession(monoId, sessionHost);
      // WP-34: a build that started before this window's sessions existed lands its brief here.
      const session = opened && monoId === CREATOR_MONO_ID ? landCreatorBrief(opened) : opened;
      if (session && session !== opened) {
        sessionsRef.current = sessionsRef.current.map((item) => (item.id === session.id ? session : item));
        setSessions(sessionsRef.current);
      }
      if (!session || request !== monoViewRequest.current) return;
      // What the last Mono had open over its overview is its own; another
      // Mono opens on its list.
      if (monoViewIdRef.current !== session.id) {
        setMonoShownSession(null);
        setMonoShownSessionFocused(false);
        setMonoOverviewDocument(null);
      }
      monoViewIdRef.current = session.id;
      saveOpenMono(monoId);
      // App views close with the Mono's arrival, not before the await, so
      // the workspace tab never shows between them.
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      // Asked from Settings (Bot changes' Ask Alfred): Settings goes with the Mono's arrival, so its chat shows now
      // rather than after Back.
      if (options.leaveSettings) setSettingsOpen(false);
      setMonoViewId(session.id);
      if (insetLayoutRef.current) {
        setOpenMonoTabs((current) =>
          current.includes(monoId) ? current : [...current, monoId],
        );
      }
      setProjectTerminalFocused(false);
      setComposerFocused(true);
      setComposerFocusToken((token) => token + 1);
      } finally {
        // The stray focus is an effect after paint, later than this function's return.
        const mine = opening;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (openingMonoGen.current === mine) openingMono.current = false;
          });
        });
      }
    },
    [ensureOpenSession, workspaceNavigation.cancel],
  );

  // A Mono open when the app last closed opens again; a moved window keeps
  // what it carried.
  const reopenedMono = useRef(false);
  useEffect(() => {
    if (reopenedMono.current) return;
    reopenedMono.current = true;
    if (windowTransfer || !monosEnabled) return;
    const monoId = loadOpenMono();
    if (monoId && findMono(monoId)) void onOpenMono(monoId);
    else if (monoId) saveOpenMono(undefined);
  }, [monosEnabled, onOpenMono, windowTransfer]);

  /** The shortcut opens the last Mono, or the first on the rail. */
  const onToggleMono = useCallback(() => {
    if (monoViewIdRef.current) {
      closeMonoView();
      setComposerFocused(true);
      return;
    }
    if (!monosEnabled) return;
    const last = lastMonoIdRef.current;
    const monoId =
      (last && findMono(last) ? last : undefined) ?? listMonos()[0]?.id;
    if (monoId) void onOpenMono(monoId);
  }, [closeMonoView, monosEnabled, onOpenMono]);

  /** A new Mono opens straight away, ready to be told what it works on. */
  const onCreateMono = useCallback((projects?: readonly string[]) => {
    const monoId = createMono(projects).id;
    setMonoSettingsFor(monoId);
    void onOpenMono(monoId);
  }, [onOpenMono]);

  const onResetMono = useCallback(
    async (sessionId: string): Promise<void> => {
      const current = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (!current || !isMonoSession(sessionId))
        throw new Error("This Mono's conversation is no longer available.");
      if (removingSessionIds.current.has(sessionId))
        throw new Error("This conversation is already being reset.");

      removingSessionIds.current.add(sessionId);
      pendingPersist.current.delete(sessionId);
      invalidateLoadedSession(sessionId);
      try {
        await resetMonoSession(current, {
          stop: async (id) => {
            const latest = (await stopSessionForRemoval(id)) ?? current;
            const stopped = {
              ...stopStreaming(latest),
              queueStatus: "paused" as const,
            };
            sessionsRef.current = sessionsRef.current.map((session) =>
              session.id === id ? stopped : session,
            );
            setSessions(sessionsRef.current);
            return stopped;
          },
          remove: async (stopped) => {
            await Promise.all(
              sessionChildHarnesses(stopped).map((harness) =>
                forgetHarnessSession(harness, sessionId),
              ),
            );
            await flushSessionCheckpoint(sessionId);
            const imagePaths = stopped.blocks.flatMap((block) =>
              block.role === "image" && block.image ? [block.image.path] : [],
            );
            await orchestrator.deleteSession(sessionId, () =>
              deleteSession(sessionId, imagePaths),
            );
          },
          replace: (fresh) => {
            pendingPersist.current.delete(sessionId);
            lastPersisted.current.delete(sessionId);
            lastPersistedUserBlock.current.delete(sessionId);
            lastBoundProvider.current.delete(sessionId);
            invalidateLoadedSession(sessionId);
            sessionsRef.current = sessionsRef.current.map((session) =>
              session.id === sessionId ? fresh : session,
            );
            setSessions(sessionsRef.current);
            setHistory((history) =>
              history.filter((entry) => entry.id !== sessionId),
            );
            setStoredLinkedSessions((history) =>
              history.filter((entry) => entry.id !== sessionId),
            );
            if (monoViewIdRef.current === sessionId) {
              monoViewRequest.current += 1;
              monoViewIdRef.current = fresh.id;
              setMonoViewId(fresh.id);
              setComposerFocused(true);
              setComposerFocusToken((token) => token + 1);
            }
          },
        });
      } finally {
        removingSessionIds.current.delete(sessionId);
      }
    },
    [invalidateLoadedSession, stopSessionForRemoval],
  );

  const onSelectHistorySession = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const askedAt = Date.now();
      workspaceNavigation.cancel();
      let session = await ensureOpenSession(sessionId);
      // WP-125: false means no pane was shown (an inbox ask, or the chat is gone).
      if (!session || session.inboxAsk) return false;
      const mono = monoForSession(session.id);
      if (mono) {
        await onOpenMono(mono.id);
        return true;
      }
      const parentId =
        session.orchestrationLeadId ??
        orchestrator.forSession(sessionId)?.leadId;
      if (parentId && parentId !== sessionId) {
        setInspectedWorkerId(sessionId);
        session = await ensureOpenSession(parentId);
        if (!session) return false;
      }
      setSearchViewOpen(false);
      setSettingsOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      // WP-73: a chat the person opened is Recent on Home. The stamp is when they asked, not when the session finished opening. An inbox ask and a Mono's chat returned above.
      const noted = stampChat({ id: session.id, title: session.title }, currentHubSelection().project, askedAt);
      if (noted) void noteOpenedChat(noted);
      if (looksLikeProject(session.cwd))
        setProjectCwd(normalizeProjectPath(session.cwd));
      const linkedUpdate = linkedSessionUpdatesRef.current.get(session.id);
      if (focusOpenSession(session.id)) {
        if (linkedUpdate) revealLinkedSessionUpdate(session.id, linkedUpdate);
        return true;
      }
      if (replaceBlankPaneWithSession(session)) {
        if (linkedUpdate) revealLinkedSessionUpdate(session.id, linkedUpdate);
        return true;
      }
      const tab = newTab(session.id);
      appendTab(tab, session.cwd);
      setActiveTabId(tab.id);
      setComposerFocused(true);
      if (linkedUpdate) revealLinkedSessionUpdate(session.id, linkedUpdate);
      return true;
    },
    [
      appendTab,
      ensureOpenSession,
      onOpenMono,
      focusOpenSession,
      replaceBlankPaneWithSession,
      revealLinkedSessionUpdate,
    ],
  );

  // WP-71: an agent card opens that worker's own chat.
  useEffect(() => {
    const onChat = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string" && id.trim()) void onSelectHistorySession(id.trim());
    };
    window.addEventListener("hivra:open-task-chat", onChat);
    return () => window.removeEventListener("hivra:open-task-chat", onChat);
  }, [onSelectHistorySession]);

  const onOpenMonoLaunchedSession = useCallback(
    async (sessionId: string) => {
      const session = await ensureOpenSession(sessionId);
      if (!session) throw new Error("This session is no longer available.");
      closeMonoView();
      setSidebarTab("sessions", session.cwd);
      await onSelectHistorySession(sessionId);
    },
    [ensureOpenSession, closeMonoView, setSidebarTab, onSelectHistorySession],
  );

  // A launched session opens over the overview, where it can be followed,
  // answered or stopped without leaving the chat. Back lands on every session
  // the Mono started; opening the one already shown hides it again.
  const showMonoLaunchedSession = useCallback(
    async (monoSessionId: string, launchedId: string) => {
      if (shownMonoSessionIdRef.current === launchedId) {
        setMonoShownSession(null);
        return;
      }
      // Load it first, then switch in one step: the overview goes straight
      // from what it shows to this session, never through the list.
      const session = await ensureOpenSession(launchedId).catch(() => null);
      if (monoViewIdRef.current !== monoSessionId) return;
      setMonoOverviewTab("sessions");
      setMonoOverviewDocument(null);
      setMonoOverviewOpen(true);
      // One that is gone leaves the sessions list open, which says so.
      if (!session) {
        setMonoShownSession(null);
        return;
      }
      setMonoShownSession(launchedId);
      setMonoShownSessionFocused(true);
      setProjectTerminalFocused(false);
      setComposerFocused(true);
    },
    [ensureOpenSession],
  );
  const onOpenMonoSession = useCallback(
    (
      monoSessionId: string,
      _turnId: string,
      _blocks: Block[],
      launchedId: string,
    ) => showMonoLaunchedSession(monoSessionId, launchedId),
    [showMonoLaunchedSession],
  );

  const openReminderSession = useCallback(
    async (sessionId: string) => {
      const session = await ensureOpenSession(sessionId);
      if (!session)
        throw new Error("This conversation is no longer available.");
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      setSettingsOpen(false);
      setFilePickerOpen(false);
      setSidebarTab("sessions", session.cwd);
      setProjectCwd(session.cwd);
      setRecents(rememberProject(session.cwd));
      await onSelectHistorySession(sessionId);
    },
    [ensureOpenSession, onSelectHistorySession],
  );

  const ensureReminderSessionsSaved = useCallback(
    async (ids: readonly string[]) => {
      for (const id of ids) {
        const session = sessionsRef.current.find(
          (session) => session.id === id,
        );
        if (session && !(await upsertSession(session))) {
          throw new Error(
            "Send a message in this conversation before setting a reminder.",
          );
        }
      }
    },
    [],
  );

  const sessionReminders = useSessionReminders(
    openReminderSession,
    ensureReminderSessionsSaved,
    sessions
      .filter((session) => !session.inboxAsk)
      .map((session) => session.id),
  );

  const dismissNoticesForContinuedSession = useCallback(
    (sessionId: string) => {
      void sessionReminders.dismissDue(sessionId);
      const updatedAt = sessionsRef.current.find(
        (session) => session.id === sessionId,
      )?.linkedWorkItemUpdateCard?.updatedAt;
      if (updatedAt == null) return;
      markLinkedSessionUpdateSeen(sessionId, updatedAt);
      setLinkedWorkItemUpdateCard(sessionId, (card) =>
        card?.updatedAt === updatedAt ? undefined : card,
      );
    },
    [sessionReminders.dismissDue, setLinkedWorkItemUpdateCard],
  );

  const onPlaceSessionOnPane = useCallback(
    async (sessionId: string, targetId: string, edge: PaneEdge) => {
      if (sessionId === targetId) return;
      const targetTab = tabsRef.current.find((tab) =>
        leafIds(tab.layout).includes(targetId),
      );
      if (!targetTab) return;

      const alreadyHere = leafIds(targetTab.layout).includes(sessionId);
      if (!alreadyHere) {
        const session = await ensureOpenSession(sessionId);
        if (!session) return;
      }

      const tab = tabsRef.current.find((entry) => entry.id === targetTab.id);
      if (!tab || !leafIds(tab.layout).includes(targetId)) return;

      const replaceTarget =
        !leafIds(tab.layout).includes(sessionId) &&
        isBlankSession(
          sessionsRef.current.find((entry) => entry.id === targetId),
        );

      if (replaceTarget) {
        lastPersisted.current.delete(targetId);
        const blank = sessionsRef.current.find(
          (entry) => entry.id === targetId,
        );
        if (blank) void forgetHarnessSession(blank.harness, targetId);
      }

      const result = applyPlaceSessionOnPane({
        tabs: tabsRef.current,
        sessions: sessionsRef.current,
        sessionId,
        targetId,
        edge,
        replaceTarget,
        scope: tabCloseScope,
        createReplacement: (seed) =>
          newDefaultSession(
            seed?.cwd ?? projectCwdRef.current,
            seed?.runtimeMode,
          ),
      });
      if (!result) return;

      sessionsRef.current = result.sessions;
      tabsRef.current = result.tabs;
      setSessions(result.sessions);
      setTabs(result.tabs);
      setActiveTabId(result.activeTabId);
      setProjectTerminalFocused(false);
      setComposerFocused(true);
    },
    [ensureOpenSession, tabCloseScope],
  );

  const onPlaceTabOnPane = useCallback(
    (sourceTabId: string, targetId: string, edge: PaneEdge) => {
      const targetTab = tabsRef.current.find((tab) =>
        leafIds(tab.layout).includes(targetId),
      );
      if (!targetTab || targetTab.id === sourceTabId) return;

      const blankTarget = sessionsRef.current.find(
        (session) => session.id === targetId && isBlankSession(session),
      );
      const result = applyPlaceTabOnPane({
        tabs: tabsRef.current,
        sessions: sessionsRef.current,
        sourceTabId,
        targetId,
        edge,
        replaceTarget: blankTarget != null,
      });
      if (!result) return;

      if (blankTarget) {
        lastPersisted.current.delete(blankTarget.id);
        void forgetHarnessSession(blankTarget.harness, blankTarget.id);
      }
      sessionsRef.current = result.sessions;
      tabsRef.current = result.tabs;
      setSessions(result.sessions);
      setTabs(result.tabs);
      setActiveTabId(result.activeTabId);
      setProjectTerminalFocused(false);
      setComposerFocused(
        result.sessions.some((session) => session.id === result.focusedId),
      );
    },
    [],
  );

  const onRenameHistorySession = useCallback(
    async (sessionId: string, displayTitle: string) => {
      const trimmed = displayTitle.trim();
      if (!trimmed) return;
      invalidateLoadedSession(sessionId);

      const open = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (open) {
        const title = formatSessionTitle(open.harness, trimmed);
        const updated = { ...open, title };
        setSessions((prev) =>
          prev.map((session) => (session.id === sessionId ? updated : session)),
        );
        loadedSessionCache.current.delete(sessionId);
        persistSession(updated);
      } else {
        const restored = await getSession(sessionId).catch(() => null);
        if (!restored) {
          void refreshHistory(sidebarCwd);
          return;
        }
        const updated = {
          ...restored,
          title: formatSessionTitle(restored.harness, trimmed),
        };
        const saved = await upsertSession(updated).catch(() => null);
        if (saved) {
          rememberLoadedSession(loadedSessionCache.current, updated);
          lastPersisted.current.set(sessionId, persistFingerprint(updated));
        }
      }
      void refreshHistory(sidebarCwd);
    },
    [invalidateLoadedSession, persistSession, refreshHistory, sidebarCwd],
  );

  const checkOpenWorktreeFiles = useCallback((path: string) => {
    assertWorktreeFilesClosed(path, [
      ...filesInWorkspaceTabs(tabsRef.current),
      ...projectTerminalsRef.current.flatMap((dock) => dock.pane.files),
    ]);
  }, []);

  const onCheckWorktreeRemoval = useCallback(
    async (cwd: string, path: string, force: boolean) => {
      checkOpenWorktreeFiles(path);
      await checkWorktreeRemoval(cwd, path, force);
      // Re-read UI state after the native check, before deleting sessions.
      checkOpenWorktreeFiles(path);
    },
    [checkOpenWorktreeFiles],
  );

  const onRemoveWorktree = useCallback(
    async (cwd: string, path: string, force: boolean, keepSessions = false) => {
      if (removingWorktreePaths.current.has(path)) {
        throw new Error("This worktree is already being deleted.");
      }
      removingWorktreePaths.current.add(path);
      const lockedIds = new Set<string>();
      const forgottenIds = new Set<string>();
      try {
        if (
          [...switchingWorktrees.current.values()].some((target) =>
            isEqualOrInside(target, path),
          )
        ) {
          throw new Error(
            "A session is selecting this worktree. Try deleting it again once selection finishes.",
          );
        }
        await onCheckWorktreeRemoval(cwd, path, force);
        const listed = await listWorktrees(cwd);
        const tree = listed.worktrees.find(
          (entry) => pathKey(entry.path) === pathKey(path),
        );
        if (!tree) throw new Error("This worktree is no longer available.");
        const ids = worktreeSessionIds(tree, sessionsRef.current);
        if (!keepSessions && ids.length) {
          throw new Error(
            "Move or delete the sessions using this worktree first.",
          );
        }
        if (
          ids.some(
            (id) =>
              removingSessionIds.current.has(id) ||
              switchingWorktrees.current.has(id),
          )
        ) {
          throw new Error(
            "Wait for these sessions to finish changing before deleting the worktree.",
          );
        }
        for (const id of ids) {
          removingSessionIds.current.add(id);
          lockedIds.add(id);
          pendingPersist.current.delete(id);
          invalidateLoadedSession(id);
        }
        for (const id of ids) {
          await stopSessionForRemoval(id);
          const session = sessionsRef.current.find((entry) => entry.id === id);
          if (!session) continue;
          await flushSessionCheckpoint(id);
          forgottenIds.add(id);
          for (const harness of sessionChildHarnesses(session)) {
            await forgetHarnessSession(harness, id);
          }
          const latest = sessionsRef.current.find((entry) => entry.id === id);
          if (!latest) continue;
          const stopped = {
            ...stopStreaming(latest),
            busy: false,
            queueStatus: "paused" as const,
            pendingQuestion: undefined,
          };
          sessionsRef.current = sessionsRef.current.map((entry) =>
            entry.id === id ? stopped : entry,
          );
          setSessions(sessionsRef.current);
          if (shouldPersistSession(stopped)) await upsertSession(stopped);
        }
        await flushSessionWrites();
        checkOpenWorktreeFiles(path);
        const removed = await removeWorktree(cwd, path, force, keepSessions);
        const affected = new Set([...ids, ...removed.sessionIds]);
        if (isEqualOrInside(projectCwdRef.current, path)) {
          setProjectCwd(removed.projectCwd);
          setRecents(rememberProject(removed.projectCwd));
        }
        for (const id of affected) {
          invalidateLoadedSession(id);
          pendingPersist.current.delete(id);
          lastPersisted.current.delete(id);
        }
        sessionsRef.current = sessionsRef.current.map((session) =>
          affected.has(session.id)
            ? detachSessionWorktree(session, removed.projectCwd, path)
            : session,
        );
        setSessions(sessionsRef.current);
        const patchSummary = (entry: SessionSummary) =>
          affected.has(entry.id)
            ? detachSessionWorktree(entry, removed.projectCwd, path)
            : entry;
        setHistory((current) => current.map(patchSummary));
        setStoredLinkedSessions((current) => current.map(patchSummary));
        for (const id of affected) notifyReviewChanged(id);
      } catch (error) {
        // Removal may fail after idle agent processes were stopped. Rebind
        // their saved threads so the unchanged working copy can still resume.
        const kept = sessionsRef.current.filter(
          (session) => forgottenIds.has(session.id) && !session.worktreeRemoved,
        );
        bindResumedSessions(kept);
        for (const session of kept) {
          const pending = session.pendingSwitch;
          if (pending?.fromProviderSessionId) {
            if (session.registryAgentId) {
              openMoreAgentSession(session.id, session.registryAgentId);
            }
            bindHarnessSession(
              pending.from,
              session.id,
              pending.fromProviderSessionId,
              sessionWorkCwd(session),
              pending.fromProviderAccountId,
              session.blocks,
            );
          }
        }
        throw error;
      } finally {
        removingWorktreePaths.current.delete(path);
        for (const id of lockedIds) removingSessionIds.current.delete(id);
      }
    },
    [
      checkOpenWorktreeFiles,
      invalidateLoadedSession,
      onCheckWorktreeRemoval,
      stopSessionForRemoval,
    ],
  );

  const onRemoveHistorySession = useCallback(
    async (
      sessionId: string,
      mode: "archive" | "delete",
      skipDeleteConfirm = false,
      origin: RemovalOrigin = "ui",
    ): Promise<boolean> => {
      if (
        removingSessionIds.current.has(sessionId) ||
        switchingWorktrees.current.has(sessionId) ||
        deleteConfirmationPending.current
      )
        return false;
      const open = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const summary = history.find((entry) => entry.id === sessionId);
      removingSessionIds.current.add(sessionId);
      // r69 (g): a sub-chat of another project is neither open nor in the shown history; read its saved record so the
      // confirm names it and offers its worktree (never waiting past DELETE_LOOKUP_MS).
      const seed: (Session | SessionSummary) | undefined =
        open ??
        summary ??
        (mode === "delete" && !skipDeleteConfirm
          ? ((await withinDeadline(readSession(sessionId))) ?? undefined)
          : undefined);
      const label = seed
        ? sessionDisplayTitle(seed.title, seed.harness)
        : "this session";
      let deleteWorktreePath: string | undefined;
      if (mode === "delete" && !skipDeleteConfirm) {
        deleteConfirmationPending.current = true;
        const subChat =
          !!delegationOf(sessionId, delegationRows()) || !!seed?.orchestrationLeadId;
        // A slow or failed listing never keeps the confirm away (it then offers no worktree).
        const listed = seed?.worktreeCwd
          ? await withinDeadline(listWorktrees(seed.cwd))
          : undefined;
        const unusedWorktree = unusedWorktreeOf(
          sessionId,
          seed,
          listed?.worktrees,
          sessionsRef.current,
        );
        // r30d: every delete asks first, in the one shared confirm (Cancel focused); a session with an unused
        // worktree of its own also offers to clear that (ticked for a sub-chat, r69).
        {
          const choice = await new Promise<SessionDeleteChoice>((resolve) => {
            setSessionDeleteDialog({
              title: label,
              ...(unusedWorktree ? { unusedWorktree } : {}),
              worktreeTicked: worktreeTickedByDefault(subChat, unusedWorktree),
              resolve,
            });
          });
          deleteConfirmationPending.current = false;
          if (!choice.confirmed) {
            removingSessionIds.current.delete(sessionId);
            return false;
          }
          if (choice.deleteWorktree && unusedWorktree) deleteWorktreePath = unusedWorktree;
        }
      }
      invalidateLoadedSession(sessionId);
      pendingPersist.current.delete(sessionId);
      try {
        // A team's sub-chat (a worker a Lead started, or an orchestration worker) closes its tab rather than leaving an
        // empty "New session" behind (r30d).
        const subChat =
          !!delegationOf(sessionId, delegationRows()) || !!seed?.orchestrationLeadId;
        const remover = createSessionRemover({
          mode,
          preserveOpenFiles: origin === "cli",
          scope: tabCloseScope,
          replaceEmptyTab: !subChat,
          replacement: {
            harness: seed?.harness ?? "cursor",
            cwd: seed?.cwd ?? sidebarCwd,
            model: seed?.model,
            runtimeMode: seed?.runtimeMode,
            modelSettings: open?.modelSettings,
          },
          workspace: {
            snapshot: () => ({
              tabs: tabsRef.current,
              sessions: sessionsRef.current,
              activeTabId: activeTabIdRef.current,
              dirtyFiles: dirtyFilesRef.current,
            }),
            apply: (change) => {
              if (change.type === "stopped") {
                const next = sessionsRef.current.map((session) =>
                  session.id === sessionId ? change.session : session,
                );
                sessionsRef.current = next;
                setSessions(next);
                return;
              }

              if (change.type === "orchestrationReleased") {
                const released = sessionsRef.current.map((session) =>
                  releaseOrchestrationWorker(session, change.leadId),
                );
                sessionsRef.current = released;
                setSessions(released);
                for (const [id, cached] of loadedSessionCache.current) {
                  if (
                    releaseOrchestrationWorker(cached, change.leadId) !== cached
                  )
                    invalidateLoadedSession(id);
                }
                // Pending reads may still carry the deleted lead's ownership.
                for (const id of sessionLoads.current.keys()) {
                  invalidateLoadedSession(id);
                }
                for (const [id, pending] of pendingPersist.current) {
                  pendingPersist.current.set(
                    id,
                    releaseOrchestrationWorker(pending, change.leadId),
                  );
                }
                const releaseSummary = (entry: SessionSummary) =>
                  entry.orchestrationLeadId === change.leadId
                    ? { ...entry, orchestrationLeadId: undefined }
                    : entry;
                setHistory((current) => current.map(releaseSummary));
                setStoredLinkedSessions((current) =>
                  current.map(releaseSummary),
                );
                return;
              }

              const { removal } = change;
              lastPersisted.current.delete(sessionId);
              pendingPersist.current.delete(sessionId);
              const closingFiles = filesInWorkspaceTabs(removal.closedTabs);
              setDirtyFiles((current) => {
                const next = new Set(current);
                for (const file of closingFiles) next.delete(file.id);
                return next;
              });
              sessionsRef.current = removal.sessions;
              tabsRef.current = removal.tabs;
              setSessions(removal.sessions);
              setTabs(removal.tabs);
              // r61: only Ash's own archive or delete moves him; a background removal leaves the view alone.
              const after = viewAfterRemoval(
                change.mode,
                origin,
                removal,
                activeTabIdRef.current,
              );
              if (after.activeTabId && after.reveal) {
                activateTab(after.activeTabId);
              } else if (after.activeTabId) {
                activeTabIdRef.current = after.activeTabId;
                setActiveTabIdState(after.activeTabId);
              }
              const activeTab = removal.tabs.find(
                (tab) => tab.id === removal.activeTabId,
              );
              // r30e: deleting the window's last tab shows its home (Today), not an empty "New session".
              const showHome = after.home;
              if (showHome) setHubSelection(showHome);
              setComposerFocused(
                !showHome &&
                  removal.sessions.some(
                    (session) => session.id === activeTab?.focusedId,
                  ),
              );
              if (change.mode === "archive") {
                if (change.session && shouldPersistSession(change.session)) {
                  rememberLoadedSession(
                    loadedSessionCache.current,
                    change.session,
                  );
                }
                const archived =
                  change.savedSummary ??
                  summary ??
                  (change.session && summaryFromSession(change.session));
                if (archived) {
                  setHistory((current) =>
                    mergeHistorySummary(current, {
                      ...archived,
                      archived: true,
                    }),
                  );
                }
              } else {
                setHistory((current) =>
                  current.filter((entry) => entry.id !== sessionId),
                );
                void refreshHistory(sidebarCwd);
              }
            },
          },
          confirm: async (closedTabs, removalMode) => {
            if (origin === "cli") return true;
            const files = filesInWorkspaceTabs(closedTabs);
            const unsaved = files.some(
              (file) =>
                isFilesystemTab(file) && dirtyFilesRef.current.has(file.id),
            );
            if (
              unsaved &&
              !(await confirmDiscardUnsaved(
                `${removalMode === "archive" ? "Archive" : "Delete"} this conversation with unsaved files?`,
              ))
            )
              return false;
            const terminals = files.filter((file) => file.terminal);
            return (
              terminals.length === 0 || (await confirmCloseTerminals(terminals))
            );
          },
          stop: stopSessionForRemoval,
        });
        const removed = await remover.remove(sessionId);
        // An archived or deleted chat no longer waits on Ash (Today's "Waiting on you").
        if (removed) forgetWaitingChat(sessionId);
        // A deleted chat leaves its project's coding team (an archived one can come back, and stays in it).
        if (removed && mode === "delete") {
          forgetCodingTeamChat(sessionId);
          // WP-20: deleting the home chat forgets it, so the next open can land on the Lead's chat.
          forgetCodingTeamHome(sessionId);
        }
        if (removed && deleteWorktreePath && seed) {
          try {
            await onRemoveWorktree(seed.cwd, deleteWorktreePath, false);
          } catch (error) {
            void message(
              `The session was deleted. Its worktree was kept.\n\n${String(error)}\n\nYou can manage it in Settings → Worktrees.`,
              { title: "MonoCode", kind: "warning" },
            );
          }
        }
        return removed;
      } catch (error) {
        if (origin === "cli") throw error;
        const detail = error instanceof Error ? error.message : String(error);
        void message(`Could not ${mode} this conversation.\n\n${detail}`, {
          title: "MonoCode",
          kind: "error",
        });
        return false;
      } finally {
        removingSessionIds.current.delete(sessionId);
      }
    },
    [
      activateTab,
      history,
      invalidateLoadedSession,
      refreshHistory,
      sidebarCwd,
      stopSessionForRemoval,
      tabCloseScope,
      onRemoveWorktree,
    ],
  );

  const onArchiveHistorySession = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (archived) return onRemoveHistorySession(sessionId, "archive");
      if (removingSessionIds.current.has(sessionId)) return false;
      try {
        await setSessionArchived(sessionId, false);
        setHistory((current) =>
          current.map((entry) =>
            entry.id === sessionId ? { ...entry, archived: false } : entry,
          ),
        );
        return true;
      } catch (error) {
        void message(
          `Could not unarchive this conversation.\n\n${String(error)}`,
          {
            title: "MonoCode",
            kind: "error",
          },
        );
        return false;
      }
    },
    [onRemoveHistorySession],
  );

  const onArchiveFocusedSession = useCallback(
    (event: KeyboardEvent) => {
      archiveFocusedSession(
        event,
        {
          activeTabId: activeTabIdRef.current,
          tabs: tabsRef.current,
          sessions: sessionsRef.current,
          projectTerminalFocused: projectTerminalFocusedRef.current,
          surfaceOpen: Boolean(
            monoViewIdRef.current ||
            searchViewOpenRef.current ||
            inboxViewOpenRef.current ||
            notesViewOpenRef.current ||
            automationsViewOpenRef.current ||
            settingsOpenRef.current ||
            filePickerOpenRef.current ||
            whatsNewVersionRef.current,
          ),
        },
        (sessionId) => {
          void onArchiveHistorySession(sessionId, true);
        },
      );
    },
    [onArchiveHistorySession],
  );

  const onPinHistorySession = useCallback(
    async (sessionId: string, pinned: boolean) => {
      const open = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (open && shouldPersistSession(open)) {
        await upsertSession(open).catch(() => undefined);
      }
      await setSessionPinned(sessionId, pinned).catch(() => undefined);
      setHistory((current) => {
        const existing = current.find((entry) => entry.id === sessionId);
        if (existing) {
          return mergeProjectHistorySummary(current, { ...existing, pinned });
        }
        if (!open) return current;
        return mergeProjectHistorySummary(current, {
          ...summaryFromSession(open),
          pinned,
        });
      });
    },
    [],
  );

  const onSetHistorySessionLinkedWorkItem = useCallback(
    (sessionId: string, linkedWorkItem: LinkedWorkItem | undefined) => {
      const previousLinkedWorkItem =
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.linkedWorkItem ??
        history.find((session) => session.id === sessionId)?.linkedWorkItem;
      invalidateLoadedSession(sessionId);
      loadedSessionCache.current.delete(sessionId);

      const nextSessions = sessionsRef.current.map((session) =>
        session.id === sessionId ? { ...session, linkedWorkItem } : session,
      );
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setHistory((current) =>
        current.map((session) =>
          session.id === sessionId ? { ...session, linkedWorkItem } : session,
        ),
      );
      setStoredLinkedSessions((current) =>
        linkedWorkItem
          ? current.map((session) =>
              session.id === sessionId
                ? { ...session, linkedWorkItem }
                : session,
            )
          : current.filter((session) => session.id !== sessionId),
      );
      setLinkedWorkItemPanels((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });

      void setSessionLinkedWorkItem(sessionId, linkedWorkItem).catch(
        (error) => {
          const rolledBackSessions = sessionsRef.current.map((session) =>
            session.id === sessionId &&
            session.linkedWorkItem === linkedWorkItem
              ? { ...session, linkedWorkItem: previousLinkedWorkItem }
              : session,
          );
          sessionsRef.current = rolledBackSessions;
          setSessions(rolledBackSessions);
          setHistory((current) =>
            current.map((session) =>
              session.id === sessionId &&
              session.linkedWorkItem === linkedWorkItem
                ? { ...session, linkedWorkItem: previousLinkedWorkItem }
                : session,
            ),
          );
          setStoredLinkedSessions((current) =>
            previousLinkedWorkItem
              ? current.map((session) =>
                  session.id === sessionId
                    ? {
                        ...session,
                        linkedWorkItem: previousLinkedWorkItem,
                      }
                    : session,
                )
              : current.filter((session) => session.id !== sessionId),
          );
          void refreshHistory(sidebarCwd);
          void message(
            `Could not update this conversation's GitHub link.\n\n${String(error)}`,
            { title: "MonoCode", kind: "error" },
          );
        },
      );
    },
    [history, invalidateLoadedSession, refreshHistory, sidebarCwd],
  );

  const onArchiveHistorySessions = useCallback(
    async (sessionIds: readonly string[], archived: boolean) => {
      for (const sessionId of sessionIds) {
        if (!(await onArchiveHistorySession(sessionId, archived))) break;
      }
    },
    [onArchiveHistorySession],
  );

  const onPinHistorySessions = useCallback(
    async (sessionIds: readonly string[], pinned: boolean) => {
      await Promise.all(
        sessionIds.map((sessionId) => onPinHistorySession(sessionId, pinned)),
      );
    },
    [onPinHistorySession],
  );

  // WP-111: private is per chat. Off keeps only the messages after the switch readable.
  const onPrivateHistorySession = useCallback((sessionId: string, on: boolean) => {
    const apply = (session: Session) => {
      const live = sessionsRef.current.find((item) => item.id === sessionId) ?? session;
      const next = withPrivate(live, on);
      if (next === live) return;
      if (sessionsRef.current.some((item) => item.id === sessionId)) {
        const nextSessions = sessionsRef.current.map((item) => (item.id === sessionId ? next : item));
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
      }
      setHistory((current) =>
        current.map((item) =>
          item.id === sessionId ? { ...item, private: next.private === true || undefined } : item,
        ),
      );
      void upsertSession(next).catch(() => undefined);
      // After the transcript write, so a save already in flight cannot leave the flag behind.
      void setSessionPrivate(sessionId, next.private === true, next.privateBoundaryId).catch(() => undefined);
    };
    const open = sessionsRef.current.find((session) => session.id === sessionId);
    if (open) {
      apply(open);
      return;
    }
    void getSession(sessionId)
      .then((loaded) => {
        if (loaded) apply(loaded);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    replaceLivePrivateKeys(privateChatKeys([...sessions, ...history]));
  }, [sessions, history]);

  const onDeleteWorktreeSessions = useCallback(
    async (sessionIds: readonly string[]): Promise<boolean> => {
      for (const sessionId of sessionIds) {
        if (!(await onRemoveHistorySession(sessionId, "delete", true))) {
          return false;
        }
      }
      return true;
    },
    [onRemoveHistorySession],
  );

  const onDeleteHistorySession = useCallback(
    (sessionId: string) => onRemoveHistorySession(sessionId, "delete"),
    [onRemoveHistorySession],
  );

  /** Moves the Mono and its current chat to the trash. Its files can be put back for 30 days. */
  const onDeleteMono = useCallback(
    async (monoId: string) => {
      const mono = findMono(monoId);
      if (!mono) return;
      const { name } = monoLook(mono);
      // r30e: the shared confirm, not the native sheet (Cancel focused; Enter keeps the Mono). r30f: it says only what
      // happens (monoDelete.ts). WP-76: a running chat is stopped first, and the person has already been told.
      const confirmed = await confirmDelete(name, monoDeleteDetail(!!mono.sessionId), { undoable: true });
      if (!confirmed) return;
      try {
        const moved = await deleteMonoToTrash({
          confirmed: true,
          sessionId: mono.sessionId,
          busy: Boolean(
            mono.sessionId &&
              sessionsRef.current.some(
                (session) => session.id === mono.sessionId && session.busy,
              ),
          ),
          stop: (sessionId) => stopSessionForRemoval(sessionId).then(() => undefined),
          markStopped: (sessionId) => {
            const latest = sessionsRef.current.find((session) => session.id === sessionId);
            if (!latest?.busy) return;
            const stopped = stopStreaming(latest);
            const next = sessionsRef.current.map((session) =>
              session.id === sessionId ? stopped : session,
            );
            sessionsRef.current = next;
            setSessions(next);
          },
          stillRunning: async (sessionId) => {
            const others = sessionsRef.current
              .filter((session) => session.busy)
              .map((session) => session.id);
            await publishLiveTurns(others).catch(() => undefined);
            const live = await listLiveTurns().catch(() => others);
            if (!live.includes(sessionId)) return false;
            void message(STILL_RUNNING, { title: "MonoCode", kind: "error" });
            return true;
          },
          trash: () =>
            trashMono({
              id: monoId,
              title: name,
              sessionIds: mono.sessionId ? [mono.sessionId] : undefined,
              payload: JSON.stringify(mono),
            }).then(() => undefined),
          removeChat: async () => {
            if (!mono.sessionId) return true;
            if (monoViewIdRef.current === mono.sessionId) closeMonoView();
            const listed =
              sessionsRef.current.some((session) => session.id === mono.sessionId) ||
              history.some((entry) => entry.id === mono.sessionId);
            if (!listed) return true;
            const removed = await onRemoveHistorySession(
              mono.sessionId,
              "delete",
              true,
            );
            return removed;
          },
          dropRoster: () => {
            removeMono(monoId);
            // Its team leaves the hub. The folder is in the trash with the Mono (monoTeams.ts).
            forgetMonoTeam(monoId);
          },
        });
        if (!moved) return;
      } catch (error) {
        void message(
          error instanceof Error ? error.message : "The Mono could not be moved to the trash.",
          { title: "MonoCode", kind: "error" },
        );
        return;
      }
      if (lastMonoIdRef.current === monoId) lastMonoIdRef.current = undefined;
    },
    [closeMonoView, history, onRemoveHistorySession, stopSessionForRemoval],
  );

  /**
   * Deletes a Mono's 1:1 chat (r30d), after the shared confirm. Only the conversation goes: the Mono, its soul, its
   * memory, its habits and its files stay, and its next chat starts fresh when it is opened.
   */
  const onDeleteMonoChat = useCallback(
    async (monoId: string) => {
      const mono = findMono(monoId);
      const sessionId = mono?.sessionId;
      if (!mono || !sessionId) return;
      if (!(await confirmDelete(`${monoLook(mono).name}'s chat`))) return;
      if (
        sessionsRef.current.some((session) => session.id === sessionId) ||
        history.some((entry) => entry.id === sessionId)
      ) {
        if (monoViewIdRef.current === sessionId) closeMonoView();
        if (!(await onRemoveHistorySession(sessionId, "delete", true))) return;
      }
      updateMono(monoId, ({ sessionId: _gone, ...rest }) => rest);
    },
    [closeMonoView, history, onRemoveHistorySession],
  );

  const onDeleteHistorySessions = useCallback(
    async (sessionIds: readonly string[]) => {
      if (sessionIds.length === 0) return;
      if (!(await confirmDelete(`${sessionIds.length} selected sessions`))) return;
      for (const sessionId of sessionIds) {
        if (!(await onRemoveHistorySession(sessionId, "delete", true))) break;
      }
    },
    [onRemoveHistorySession],
  );

  const sessionIdsInTitleTab = useCallback((tabId: string): string[] => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return [];
    const openSessionIds = new Set(
      sessionsRef.current.map((session) => session.id),
    );
    return leafIds(tab.layout).filter((id) => openSessionIds.has(id));
  }, []);

  const onArchiveTitleTab = useCallback(
    (tabId: string) => {
      const sessionIds = sessionIdsInTitleTab(tabId);
      void onArchiveHistorySessions(sessionIds, true);
    },
    [onArchiveHistorySessions, sessionIdsInTitleTab],
  );

  const onDeleteTitleTab = useCallback(
    (tabId: string) => {
      const sessionIds = sessionIdsInTitleTab(tabId);
      if (sessionIds.length === 1) {
        void onDeleteHistorySession(sessionIds[0]);
      } else if (sessionIds.length > 1) {
        void onDeleteHistorySessions(sessionIds);
      }
    },
    [onDeleteHistorySession, onDeleteHistorySessions, sessionIdsInTitleTab],
  );

  const onFocusDir = useCallback(
    (dir: FocusDir) => {
      if (!activeTab) return;
      const next = neighborLeafId(activeTab.layout, activeTab.focusedId, dir);
      if (next) onFocusPane(next);
    },
    [activeTab, onFocusPane],
  );

  const onRatio = useCallback(
    (tabId: string, splitId: string, index: number, ratio: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, layout: setSplitRatio(t.layout, splitId, index, ratio) }
            : t,
        ),
      );
    },
    [],
  );

  // Relink all gave chats their folders in the store: the open copies take the folder and nothing else (no move to
  // another project, nothing added to the recents, no change of the chat's own work).
  const onSessionFolderRelinked = useCallback(
    (sessionId: string, cwd: string) =>
      setSessions((prev) => withRelinkedFolder(prev, sessionId, cwd)),
    [setSessions],
  );

  const onCwdChange = useCallback(
    (sessionId: string, cwd: string) => {
      const normalized = normalizeProjectPath(cwd);
      const current = sessionsRef.current.find((s) => s.id === sessionId);
      const previous = current?.cwd;
      // Threads stay bound to their project. Switching from the composer opens a
      // new tab instead of retargeting the conversation.
      if (
        current &&
        previous &&
        looksLikeProject(previous) &&
        !sameProjectPath(previous, normalized) &&
        !isBlankSession(current)
      ) {
        setProjectCwd(normalized);
        setRecents(rememberProject(normalized));
        const session = newSession(
          current.harness,
          normalized,
          current.model,
          current.runtimeMode,
          current.modelSettings,
        );
        const tab = newTab(session.id);
        setSessions((prev) => [...prev, session]);
        appendTab(tab, normalized);
        setActiveTabId(tab.id);
        setComposerFocused(true);
        // WP-110: a new chat follows the worktree setting.
        attachNewChatWorktree(session.id, normalized, setSessions);
        return;
      }
      if (previous && !sameProjectPath(previous, normalized)) {
        // Clear bindings left by older versions before reusing a local shell.
        if (remoteSessionFor(sessionId)) rememberRemoteSession(sessionId);
        if (remotePendingWorktree(sessionId))
          rememberRemotePendingWorktree(sessionId);
      }
      if (
        previous &&
        !sameProjectPath(previous, normalized) &&
        previous !== "~"
      ) {
        void keepSessionChanges(sessionId, previous).catch(() => undefined);
      }
      setProjectCwd(normalized);
      setRecents(rememberProject(normalized));
      const folderChanged = !previous || !sameProjectPath(previous, normalized);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          // A blank session moving into a project adopts its provider defaults;
          // a conversation keeps its own provider.
          const base = isBlankSession(s)
            ? retargetSessionToProject(s, normalized)
            : s;
          const moved: Session = {
            ...base,
            cwd: normalized,
            branch: undefined,
            worktreeCwd: undefined,
            worktreeRemoved: undefined,
            workspaceMode: undefined,
            worktreeBase: undefined,
          };
          // WP-110: a choice to stay in the old folder does not carry to another one.
          return folderChanged ? withoutNewChatFolderChoice(moved) : moved;
        }),
      );
      // WP-110: a blank chat moved to another folder follows the worktree setting.
      if (folderChanged) attachNewChatWorktree(sessionId, normalized, setSessions);
      // The session's project just moved in place; a group only holds tabs that
      // share one project, so drop this tab out if it no longer matches.
      setTabs((prev) => {
        const tab = prev.find((t) => leafIds(t.layout).includes(sessionId));
        // The tab's visible project follows its focused pane; a background
        // pane changing project doesn't change what the group check should see.
        if (!tab?.groupId || tab.focusedId !== sessionId) return prev;
        const newProject = projectName(normalized);
        const othersProject = tabGroupProject(
          prev.filter((t) => t.id !== tab.id),
          tab.groupId,
          projectOfTab,
        );
        if (othersProject && newProject && othersProject !== newProject) {
          return removeTabFromGroup(prev, tab.id);
        }
        return prev;
      });
      notifyReviewChanged(sessionId);
    },
    [appendTab, projectOfTab],
  );

  const onBranchChange = useCallback(
    (sessionId: string) => {
      notifyGitChanged();
      const current = sessionsRef.current.find((s) => s.id === sessionId);
      if (!current) return;
      void forgetHarnessSession(current.harness, sessionId);
      const next = {
        ...current,
        branch: undefined,
        providerSessionId: undefined,
        context: undefined,
      };
      sessionsRef.current = sessionsRef.current.map((s) =>
        s.id === sessionId ? next : s,
      );
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? next : s)));
      persistSession(next);
      notifyReviewChanged(sessionId);
    },
    [persistSession],
  );

  const onWorkspaceModeChange = useCallback(
    (sessionId: string, mode: WorkspaceMode, base?: string) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (
            session.id !== sessionId ||
            (!isBlankSession(session) &&
              !(session.workspaceMode && !session.worktreeCwd && !session.busy))
          ) {
            return session;
          }
          const chosen: Session =
            mode === "worktree"
              ? base || session.worktreeBase
                ? {
                    ...session,
                    workspaceMode: "worktree",
                    worktreeBase: base || session.worktreeBase,
                  }
                : session
              : {
                  ...session,
                  workspaceMode: undefined,
                  worktreeBase: undefined,
                };
          // WP-110: choosing this folder keeps this chat out of a default worktree, and it is held on the chat.
          return withNewChatFolderChoice(chosen, mode);
        }),
      );
    },
    [],
  );

  const onWorktreeBaseChange = useCallback(
    (sessionId: string, base: string) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId &&
          (isBlankSession(session) ||
            (!!session.workspaceMode &&
              !session.worktreeCwd &&
              !session.busy)) &&
          session.workspaceMode === "worktree"
            ? { ...session, worktreeBase: base }
            : session,
        ),
      );
    },
    [],
  );

  const onWorktreeChange = useCallback(
    async (
      sessionId: string,
      tree: Worktree,
      fromComposer = false,
      isCurrent: () => boolean = () => true,
    ) => {
      if (!isCurrent()) return;
      const current = sessionsRef.current.find((s) => s.id === sessionId);
      if (
        !current ||
        current.busy ||
        removingSessionIds.current.has(sessionId) ||
        switchingWorktrees.current.has(sessionId)
      ) {
        throw new Error(
          "Wait for this session to finish before changing working copies.",
        );
      }
      if (
        !current.worktreeRemoved &&
        pathKey(sessionWorkCwd(current)) === pathKey(tree.path)
      )
        return;
      if (
        [...removingWorktreePaths.current].some((path) =>
          isEqualOrInside(tree.path, path),
        )
      ) {
        throw new Error(
          "This worktree is being deleted. Select another working copy.",
        );
      }
      if (!current.worktreeRemoved && current.queuedMessages?.length) {
        throw new Error(
          "Clear queued messages before changing working copies.",
        );
      }
      const run = orchestrator.forSession(sessionId);
      if (run && ["active", "paused"].includes(run.status)) {
        throw new Error(
          "Stop this orchestration run before changing working copies.",
        );
      }
      switchingWorktrees.current.set(sessionId, tree.path);
      pendingPersist.current.delete(sessionId);
      try {
        const listed = await listWorktrees(current.cwd);
        if (!isCurrent()) return;
        // WP-138: a listing has no .worktreeinclude note, so the one on the tree the picker
        // just created is carried over and a failed copy is still seen in the chat header.
        const target = listedWorktreeFor(listed.worktrees, tree);
        if (!target) {
          throw new Error(
            "This worktree is no longer available. Refresh the picker.",
          );
        }
        const source = sessionsRef.current.find((s) => s.id === sessionId);
        if (
          !source ||
          source.busy ||
          source.cwd !== current.cwd ||
          sessionWorkCwd(source) !== sessionWorkCwd(current)
        ) {
          throw new Error(
            "The session changed. Try selecting the working copy again.",
          );
        }
        const selected = sessionInWorktree(source, target);
        if (selected.id !== sessionId) {
          // Leave the original conversation, checkpoints, and live provider
          // context attached to the files they describe.
          const tab = newTab(selected.id);
          if (fromComposer)
            workspacePins.current.set(
              selected.id,
              currentWorkspace(source.cwd),
            );
          sessionsRef.current = [...sessionsRef.current, selected];
          setSessions(sessionsRef.current);
          appendTab(tab, selected.cwd);
          setActiveTabId(tab.id);
          setComposerFocused(true);
          return;
        }
        await flushSessionCheckpoint(sessionId);
        if (!isCurrent()) return;
        for (const harness of sessionChildHarnesses(source)) {
          await forgetHarnessSession(harness, sessionId);
          if (!isCurrent()) return;
        }
        const latest = sessionsRef.current.find((s) => s.id === sessionId);
        if (
          !latest ||
          (!latest.worktreeRemoved && !isBlankSession(latest)) ||
          latest.cwd !== current.cwd ||
          sessionWorkCwd(latest) !== sessionWorkCwd(current)
        ) {
          throw new Error(
            "The session changed. Try selecting the working copy again.",
          );
        }
        const next = sessionInWorktree(latest, target);
        if (fromComposer)
          workspacePins.current.set(sessionId, currentWorkspace(latest.cwd));
        else workspacePins.current.delete(sessionId);
        if (latest.worktreeRemoved)
          await keepSessionChanges(sessionId, target.path);
        pendingPersist.current.delete(sessionId);
        if (shouldPersistSession(next)) await upsertSession(next);
        if (!isCurrent()) return;
        invalidateLoadedSession(sessionId);
        sessionsRef.current = sessionsRef.current.map((s) =>
          s.id === sessionId ? next : s,
        );
        setSessions(sessionsRef.current);
        notifyGitChanged();
        notifyReviewChanged(sessionId);
        void refreshHistory(next.cwd);
      } finally {
        switchingWorktrees.current.delete(sessionId);
      }
    },
    [appendTab, invalidateLoadedSession, refreshHistory],
  );

  const onComposerWorktreeChange = useCallback(
    (sessionId: string, tree: Worktree) =>
      onWorktreeChange(sessionId, tree, true),
    [onWorktreeChange],
  );

  const onSelectWorkspace = useCallback(
    (focus?: WorktreeFocus) => {
      closeMonoView();
      setProjectCwd(sidebarCwdRef.current);
      workspaceNavigation.selectWorkspace(sidebarCwdRef.current, focus);
    },
    [workspaceNavigation.selectWorkspace, closeMonoView],
  );

  /**
   * Open a run of folders from one snapshot, committed in a single transition.
   *
   * Planning per folder from refs would read state React has not rendered yet,
   * so the whole run is planned first and applied here in selection order.
   */
  const openProjects = useCallback(
    (paths: readonly string[]) => {
      const steps = planProjectOpenRun({
        memory: readProjectReturnMemory(),
        tabs: tabsRef.current,
        sessions: sessionsRef.current,
        activeTabId: activeTabIdRef.current,
        paths,
      });
      const last = steps[steps.length - 1];
      if (!last) return;

      // After the early return, not before it. `pickFolders` hands back an
      // empty list when the picker is dismissed, and every path failing
      // `looksLikeProject` comes out the same way — so closing these first
      // meant cancelling a folder picker shut whatever the user had open.
      // Nothing below opens a project without also leaving one of these views.
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);

      // At most one folder can take the blank session, and it keeps the
      // retargeting rules `onCwdChange` already owns.
      const blank = steps.find(
        (step): step is Extract<ProjectOpenStep, { action: "reuse-blank" }> =>
          step.action === "reuse-blank",
      );
      if (blank) onCwdChange(blank.sessionId, blank.path);

      const created = steps.filter(
        (step): step is Extract<ProjectOpenStep, { action: "create" }> =>
          step.action === "create",
      );
      if (created.length > 0) {
        setSessions((prev) => [
          ...prev,
          ...created.map((step) => step.session),
        ]);
        // Each tab sits beside the one before it in the run, so the folders keep
        // their selection order.
        setTabs((prev) =>
          created.reduce(
            (tabs, step) =>
              insertBeside(tabs, step.tab, step.besideTabId, step.path),
            prev,
          ),
        );
      }

      // The folder chosen last ends up focused.
      switch (last.action) {
        case "create":
          setProjectCwd(last.path);
          setActiveTabId(last.tab.id);
          setComposerFocused(true);
          break;
        case "activate":
          setProjectCwd(last.path);
          activateTab(last.tabId, last.paneId);
          break;
        case "keep":
          setProjectCwd(last.path);
          break;
        case "reuse-blank":
          // `onCwdChange` already moved to it.
          break;
      }
      // Every project opened is remembered, the one chosen last most recently. A Mono's team folder is no project of
      // Ash's (monoTeams.ts): it opens from its Mono, never from the recent list.
      for (const step of steps) if (!isMonoTeamFolder(step.path)) setRecents(rememberProject(step.path));
    },
    [activateTab, insertBeside, onCwdChange, readProjectReturnMemory],
  );

  const onSelectProject = useCallback(
    (path: string) => {
      closeMonoView();
      workspaceNavigation.cancel();
      openProjects([path]);
      workspaceNavigation.selectProject(path);
    },
    [
      openProjects,
      closeMonoView,
      workspaceNavigation.cancel,
      workspaceNavigation.selectProject,
    ],
  );
  selectProjectRef.current = onSelectProject;

  /**
   * Open a hub project's coding team (hubNav.ts openCodingTeam): its folder's workspace and Sessions list, on its
   * Lead's chat by default (`lead`), or the chat Ash was last in there. WP-06: no folder is the no-code page, not
   * the previous project's workspace, and not Today.
   */
  // WP-20: one coding-team home per project. The Lead's existing chat, history kept. A chat is made only when there is none.
  const applyCodingTeamHomes = useCallback((list: Session[]) => {
    if (!codingTeamsOn()) return list;
    let next = list;
    let changed = false;
    for (const project of hubData().listProjects()) {
      const lead = leadMono(leadSpecFor(project));
      const settled = settleCodingTeam({
        project,
        sessions: next,
        ...(lead ? { lead: { id: lead.id, sessionId: lead.sessionId } } : {}),
        notedIds: next.flatMap((row) => (codingTeamChatProject(row.id) === project.id ? [row.id] : [])),
        present: chosenPresence(),
        newId: crypto.randomUUID(),
        allowCreate: true,
        probe: { ghSignedIn: false },
        bindLead: saveMonoSessionId,
        // WP-20: the CLIs ticked at first launch are this team's CLI. An existing chat is not rewritten.
        setLeadCli: (leadId, cli) => {
          updateMono(leadId, (mono) => (mono.engine === cli ? mono : { ...mono, engine: cli }));
        },
        inflate: (draft) => {
          const harness = (HARNESSES as readonly string[]).includes(draft.harness) ? (draft.harness as HarnessId) : "claude";
          return { ...newSession(harness, draft.cwd), id: draft.id, firstMate: true, title: draft.title };
        },
      });
      if (settled.changed) {
        next = settled.sessions;
        changed = true;
      }
    }
    return changed ? next : list;
  }, []);

  const openCodingTeam = useCallback(
    (projectId: string, target: CodingTeamTarget = {}) => {
      const project = hubData()
        .listProjects()
        .find((entry) => entry.id === projectId);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      if (!project || !projectHasCodeFolder(project.folder)) {
        closeMonoView();
        setHubSelection(projectHomeSelection({ id: projectId, folder: project?.folder ?? null }));
        return;
      }
      // WP-20: mark the home chat before the Lead opens, so the launch sees the first mate.
      const settled = applyCodingTeamHomes(sessionsRef.current);
      if (settled !== sessionsRef.current) {
        sessionsRef.current = settled;
        setSessions(settled);
      }
      const lead = leadMono(leadSpecFor(project));
      if (lead && (target.lead ?? codingTeamView(project.id) === "lead")) {
        setHubSelection(projectTapSelection(project));
        nameHubProject(project);
        void onOpenMono(lead.id);
        return;
      }
      closeMonoView();
      setHubSelection({ project: project.id, item: "coding-team" });
      nameHubProject(project);
      onSelectProject(project.folder);
    },
    [applyCodingTeamHomes, closeMonoView, onOpenMono, onSelectProject],
  );
  useEffect(() => (codingTeamsOn() ? setCodingTeamOpener(openCodingTeam) : undefined), [openCodingTeam]);
  // WP-20: a Lead chat that loads after the project opened still becomes the one home. That needs a new chat in the
  // list, so the walk over every project runs when the set of chats changes, not on each streamed block.
  const codingTeamIdsKey = useMemo(() => sessions.map((session) => session.id).join("\n"), [sessions]);
  const codingTeamIdsSeen = useRef<string | null>(null);
  useEffect(() => {
    if (codingTeamIdsSeen.current === codingTeamIdsKey) return;
    codingTeamIdsSeen.current = codingTeamIdsKey;
    const settled = applyCodingTeamHomes(sessions);
    if (settled === sessions) return;
    sessionsRef.current = settled;
    setSessions(settled);
  }, [codingTeamIdsKey, sessions, applyCodingTeamHomes]);
  /**
   * Open a Mono's own team (hubNav.ts openMonoTeam, monoTeams.ts): its folder's workspace and Sessions list, the Mono's
   * chat pinned on top and its workers under it, on the Mono's chat by default (`owner`) or the chat Ash was last in
   * there. A Mono with no team yet opens its chat.
   */
  const openMonoTeamView = useCallback(
    (monoId: string, target: MonoTeamTarget = {}) => {
      const mono = findMono(monoId);
      const team = mono ? monoTeam(monoId) : undefined;
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      if (!mono || !team) {
        if (mono) void onOpenMono(monoId);
        return;
      }
      const item = monoTeamItem(monoId);
      if (target.owner ?? codingTeamView(item) === "lead") {
        void onOpenMono(monoId, { inTeam: true });
        return;
      }
      closeMonoView();
      showAppItem(item);
      nameMonoTeam(team.folder, monoLook(mono).name);
      onSelectProject(team.folder);
    },
    [closeMonoView, onOpenMono, onSelectProject],
  );
  useEffect(() => (codingTeamsOn() ? setMonoTeamOpener(openMonoTeamView) : undefined), [openMonoTeamView]);
  // A Mono's chat opened from anywhere, Settings included (hubNav.ts openMonoChat): in its team when it has one.
  // Dropwave: every one-to-one chat has the same layout (the chat list beside the chat), so a Mono that is no project's
  // Lead gets its own team's folder the first time its chat opens. `project` opens its own chat for that project.
  useEffect(
    () =>
      setMonoChatOpener((monoId, target) => {
        if (target?.project) return void onOpenMono(monoId, { project: target.project, leaveSettings: true });
        const open = () => void onOpenMono(monoId, { inTeam: true, leaveSettings: true });
        if (!codingTeamsOn() || leadFor(monoId) || monoTeam(monoId)) return open();
        void ensureMonoTeam(monoId).catch(() => undefined).then(open);
      }),
    [onOpenMono],
  );
  // WP-34: the Creator screen starts the Creator Mono's chat through this window's sessions.
  useEffect(() => setCreatorSessionHost({
    home: homeDir,
    load: ensureOpenSession,
    create: (path) => newDefaultSession(path),
    add: (created) => {
      sessionsRef.current = [...sessionsRef.current, created];
      setSessions(sessionsRef.current);
    },
    update: (next) => {
      sessionsRef.current = sessionsRef.current.map((item) => (item.id === next.id ? next : item));
      setSessions(sessionsRef.current);
    },
  }), [ensureOpenSession]);
  /**
   * A new chat in a project's coding team, as Ash's New session there makes one: the coding team opens and the chat
   * starts in the project's folder. Its id, or null for a project with no code folder. The benches' way in
   * (verifyKickoff.ts, verifyDriver.ts).
   */
  const startCodingTeamChat = useCallback(
    (projectId: string, runtimeMode?: RuntimeMode): string | null => {
      const project = hubData()
        .listProjects()
        .find((entry) => entry.id === projectId);
      if (!project?.folder) return null;
      openCodingTeam(project.id, { lead: false });
      noteCodingTeamView(project.id, "chat");
      // Only the verify driver passes a mode (a bench scene in a dev copy); Ash's New session keeps his default.
      const session = newWorkspaceSession(project.folder, runtimeMode ?? sessionDefaults?.runtimeMode);
      sessionsRef.current = [...sessionsRef.current, session];
      setSessions(sessionsRef.current);
      const tab = newTab(session.id);
      appendTab(tab, project.folder);
      setActiveTabId(tab.id);
      setComposerFocused(true);
      // WP-110: a new chat follows the worktree setting.
      attachNewChatWorktree(session.id, project.folder, setSessions);
      return session.id;
    },
    [openCodingTeam, sessionDefaults?.runtimeMode, appendTab, setActiveTabId],
  );

  const pickProject = useCallback(async () => {
    // Several folders can be taken at once; each opens as its own project, and
    // the last one selected ends up focused.
    openProjects(await pickFolders());
  }, [openProjects]);

  const onPlaceSessionInFolder = useCallback(
    (sessionId: string, target: SessionFolderTarget) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (!source || !looksLikeProject(source.cwd)) return;
      const folders = loadSessionFolders(source.cwd);
      if (
        target.kind === "existing" &&
        !folders.some((folder) => folder.id === target.folderId)
      ) {
        return;
      }
      saveSessionFolders(
        source.cwd,
        placeSessionInFolder(
          folders,
          isRemoteProjectPath(source.cwd)
            ? (remoteSessionFor(sessionId) ?? sessionId)
            : sessionId,
          target,
        ),
      );
    },
    [],
  );

  const onRemoveProject = useCallback(
    (path: string, options: { purgeData: boolean }) => {
      const normalized = normalizeProjectPath(path);
      // WP-76: a project with a running chat stays until that chat stops.
      if (
        options.purgeData &&
        sessionsRef.current.some(
          (session) => sameProjectPath(session.cwd, normalized) && session.busy,
        )
      ) {
        void message(
          "A chat in this project is still running. Stop it, then move the project to the trash.",
          { title: "MonoCode", kind: "error" },
        );
        return;
      }
      const drop = () => {
      const wasCurrent = sameProjectPath(projectCwdRef.current, normalized);
      const remaining = options.purgeData
        ? forgetProject(normalized)
        : archiveProject(normalized);
      if (options.purgeData) {
        forgetProjectLocation(normalized);
        setSidebarTabSelection((current) =>
          sameProjectPath(current.project, normalized)
            ? { project: "~", tab: loadProjectSidebarTab("~") }
            : current,
        );
      }
      setRecents(remaining);

      const tabs = tabsRef.current;
      const sessions = sessionsRef.current;
      const projectTabs = filterTabsForProject(tabs, sessions, normalized);
      const projectTabIds = new Set(projectTabs.map((tab) => tab.id));
      const projectSessions = sessions.filter((session) =>
        sameProjectPath(session.cwd, normalized),
      );
      const projectSessionIds = new Set(
        projectSessions.map((session) => session.id),
      );

      if (options.purgeData) {
        const cachedOrLoading = new Set([
          ...loadedSessionCache.current.keys(),
          ...sessionLoads.current.keys(),
        ]);
        for (const sessionId of cachedOrLoading) {
          invalidateLoadedSession(sessionId);
        }
        for (const session of projectSessions) {
          pendingPersist.current.delete(session.id);
          if (session.busy) {
            turnGen.current.set(
              session.id,
              (turnGen.current.get(session.id) ?? 0) + 1,
            );
            for (const id of sessionChildHarnesses(session)) {
              void cancelHarnessTurn(id, session.id);
            }
          }
          for (const id of sessionChildHarnesses(session)) {
            void forgetHarnessSession(id, session.id);
          }
          lastPersisted.current.delete(session.id);
        }
      } else {
        for (const session of projectSessions) {
          if (session.busy) continue;
          if (shouldPersistSession(session)) {
            rememberLoadedSession(loadedSessionCache.current, session);
          }
          persistSession(session);
          pendingPersist.current.delete(session.id);
          for (const id of sessionChildHarnesses(session)) {
            void forgetHarnessSession(id, session.id);
          }
        }
      }

      let nextTabs = tabs.filter((tab) => !projectTabIds.has(tab.id));
      let nextSessions = sessions.filter((session) => {
        if (!projectSessionIds.has(session.id)) return true;
        return !options.purgeData && session.busy;
      });
      let nextActiveTabId = activeTabIdRef.current;

      if (nextTabs.length === 0) {
        const fallback = nextSessions[0];
        const session = newDefaultSession("~", fallback?.runtimeMode);
        const tab = newTab(session.id);
        nextSessions = [...nextSessions, session];
        nextTabs = [tab];
        nextActiveTabId = tab.id;
      } else if (projectTabIds.has(nextActiveTabId)) {
        nextActiveTabId = nextTabs[0]?.id ?? nextActiveTabId;
      }

      sessionsRef.current = nextSessions;
      tabsRef.current = nextTabs;
      activeTabIdRef.current = nextActiveTabId;
      setSessions(nextSessions);
      setTabs(nextTabs);
      if (nextActiveTabId !== activeTabId) {
        setActiveTabId(nextActiveTabId);
      }
      setDirtyFiles((prev) => {
        const updated = new Set(prev);
        for (const tab of projectTabs) {
          for (const file of [
            ...tab.editorPanes.flatMap((pane) => pane.files),
            ...(tab.terminalPanes ?? []).flatMap((pane) => pane.files),
          ]) {
            updated.delete(file.id);
          }
        }
        return updated;
      });
      setProjectTerminals((prev) =>
        prev.filter((dock) => !sameProjectPath(dock.projectPath, normalized)),
      );

      if (wasCurrent) {
        const next = remaining.find((item) => looksLikeProject(item.path));
        if (next) {
          onSelectProject(next.path);
          setProjectCwd(next.path);
        } else {
          setProjectCwd("~");
          setComposerFocused(true);
        }
      }
      };
      // WP-76: the window drops the project only after the trash accepts it.
      if (options.purgeData) {
        void removeProjectFromWindow({
          purgeData: true,
          trash: () => removeProjectData(normalized).then(() => undefined),
          applyLocal: drop,
        }).catch((error: unknown) => {
          void message(
            error instanceof Error
              ? error.message
              : "The project could not be moved to the trash.",
            { title: "MonoCode", kind: "error" },
          );
        });
        return;
      }
      drop();
    },
    [activeTabId, invalidateLoadedSession, onSelectProject, persistSession],
  );

  const onRestoreProject = useCallback(
    (path: string) => {
      setRecents(rememberProject(path));
      onSelectProject(path);
    },
    [onSelectProject],
  );

  const onFileMoved = useCallback((from: string, to: string) => {
    invalidateProjectFiles();
    setTabs((prev) =>
      prev.map((tab) => {
        return {
          ...tab,
          editorPanes: tab.editorPanes.map((pane) => ({
            ...pane,
            files: pane.files.map((file) =>
              isFilesystemTab(file)
                ? { ...file, path: rebasePath(file.path, from, to) }
                : file,
            ),
          })),
        };
      }),
    );
  }, []);

  const applyProjectLocationChange = useCallback(
    async (from: string, to: string) => {
      await rebaseProjectSessions(from, to);
      rebaseCiRepairs(from, to);

      const nextSessions = sessionsRef.current.map((session) =>
        sameProjectPath(session.cwd, from) ? { ...session, cwd: to } : session,
      );
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      for (const [id, session] of loadedSessionCache.current) {
        if (sameProjectPath(session.cwd, from)) {
          loadedSessionCache.current.set(id, { ...session, cwd: to });
        }
      }
      for (const [id, session] of pendingPersist.current) {
        if (sameProjectPath(session.cwd, from)) {
          pendingPersist.current.set(id, { ...session, cwd: to });
        }
      }
      setHistory((current) =>
        current.map((session) =>
          sameProjectPath(session.cwd, from)
            ? { ...session, cwd: to }
            : session,
        ),
      );
      setStoredLinkedSessions((current) =>
        current.map((session) =>
          sameProjectPath(session.cwd, from)
            ? { ...session, cwd: to }
            : session,
        ),
      );
      setLoadedProjects((current) => {
        const next = new Set(current);
        next.delete(normalizeProjectPath(from));
        next.add(normalizeProjectPath(to));
        return next;
      });

      if (sameProjectPath(projectCwdRef.current, from)) {
        projectCwdRef.current = to;
        setProjectCwd(to);
      }
      const nextDocks = projectTerminalsRef.current.map((dock) =>
        sameProjectPath(dock.projectPath, from)
          ? { ...dock, projectPath: to }
          : dock,
      );
      projectTerminalsRef.current = nextDocks;
      setProjectTerminals(nextDocks);
      rebaseProjectData(from, to);
      setSidebarTabSelection((current) =>
        sameProjectPath(current.project, from)
          ? { ...current, project: pathKey(to) }
          : current,
      );
      setRecents(replaceProjectPath(from, to));
      onFileMoved(from, to);
      notifyDirsChanged();
    },
    [onFileMoved],
  );

  const onFileDeleted = useCallback((path: string) => {
    invalidateProjectFiles();
    const dropped = new Set<string>();
    for (const tab of tabsRef.current) {
      for (const pane of tab.editorPanes) {
        for (const file of pane.files) {
          if (isFilesystemTab(file) && isEqualOrInside(file.path, path)) {
            dropped.add(file.id);
          }
        }
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        dropOpenFiles(tab, (filePath) => isEqualOrInside(filePath, path)),
      ),
    );
    if (dropped.size === 0) return;
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      for (const id of dropped) next.delete(id);
      return next;
    });
  }, []);

  const onOpenFile = useCallback<OpenFileFn>(
    (path, navigation, options) => {
      closeMonoView();
      void (async () => {
        const fileCwd = gitCwdRef.current;
        const fileProjectCwd = sidebarCwdRef.current;
        const resolved = await resolveFileOpenRequest(fileCwd, path, options);
        rememberOpenedFile(fileCwd, resolved);
        const tab = tabsRef.current.find(
          (entry) => entry.id === activeTabIdRef.current,
        );
        if (!tab) return;
        const file = newFileTab(
          resolved,
          fileCwd,
          false,
          undefined,
          fileProjectCwd,
        );
        const pin = !!options?.pin;
        const beside = !!options?.beside;
        if (loadFileTabMode() === "workspace") {
          // Built once: the updater may run twice in StrictMode.
          const created = newEditorWorkspaceTab(
            pin || beside ? file : { ...file, preview: true },
          );
          let target: { tabId: string; paneId?: string } | undefined;
          // Select inside the updater, not from `tabsRef`: two opens resuming
          // before a render would otherwise both miss the preview and append
          // twice. flushSync runs the updater now so `target` is set below.
          flushSync(() => {
            setTabs((prev) => {
              const result = openWorkspaceFile(
                prev,
                file,
                created,
                (tabs, tab) => insertBesideActive(tabs, tab, fileProjectCwd),
                pin,
                beside,
              );
              target = result;
              return result.tabs;
            });
          });
          if (target?.paneId) activateTab(target.tabId, target.paneId);
          else if (target) setActiveTabId(target.tabId);
          setProjectTerminalFocused(false);
          setComposerFocused(false);
          if (navigation) {
            editorNavigationToken.current += 1;
            setEditorNavigation({
              path: resolved,
              ...navigation,
              token: editorNavigationToken.current,
            });
          }
          return;
        }
        setTabs((prev) =>
          prev.map((entry) => {
            if (entry.id !== tab.id) return entry;
            const focusedSession = sessionsRef.current.find(
              (session) => session.id === entry.focusedId,
            );
            return openEditorTab(entry, file, {
              split: focusedSession?.blocks.length === 0 ? "left" : "right",
              pin,
              beside,
            });
          }),
        );
        if (navigation) {
          editorNavigationToken.current += 1;
          setEditorNavigation({
            path: resolved,
            ...navigation,
            token: editorNavigationToken.current,
          });
        }
        setComposerFocused(false);
      })();
    },
    [activateTab, insertBesideActive, closeMonoView],
  );

  const onOpenPlan = useCallback(
    (sessionId: string, blockId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === activeTabId);
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      const block = session?.blocks.find((entry) => entry.id === blockId);
      if (!tab || !session || !block) return;
      const file = {
        ...newPlanTab(
          session.id,
          block.id,
          planTitle(block.text),
          sessionWorkCwd(session),
        ),
        ...(session.worktreeCwd ? { projectCwd: session.cwd } : {}),
      };
      setTabs((prev) =>
        prev.map((entry) =>
          entry.id === tab.id ? openEditorTab(entry, file) : entry,
        ),
      );
      setComposerFocused(false);
    },
    [activeTabId],
  );

  const onPinFile = useCallback((fileId: string) => {
    setTabs((prev) => {
      const next = prev.map((tab) => pinEditorFile(tab, fileId));
      return next.some((tab, index) => tab !== prev[index]) ? next : prev;
    });
  }, []);

  const onFileDirtyChange = useCallback(
    (fileId: string, dirty: boolean) => {
      // An edited preview must not be replaced by the next click.
      if (dirty) onPinFile(fileId);
      setDirtyFiles((prev) => {
        if (prev.has(fileId) === dirty) return prev;
        const next = new Set(prev);
        if (dirty) next.add(fileId);
        else next.delete(fileId);
        return next;
      });
    },
    [onPinFile],
  );

  /** The editor reports 0 as it unmounts, so closed tabs drop out on their own. */
  const onFileErrorCountChange = useCallback(
    (fileId: string, count: number) => {
      setFileErrorCounts((prev) => {
        if ((prev.get(fileId) ?? 0) === count) return prev;
        const next = new Map(prev);
        if (count > 0) next.set(fileId, count);
        else next.delete(fileId);
        return next;
      });
    },
    [],
  );

  const onSelectFileSurface = useCallback((paneId: string, fileId: string) => {
    closeMonoView();
    setTabs((prev) =>
      prev.map((tab) => {
        const found = findSurfacePane(tab, paneId);
        if (!found) return tab;
        return withSurfacePanes(
          { ...tab, focusedId: paneId },
          found.kind,
          surfacePanes(tab, found.kind).map((pane) =>
            pane.id === paneId ? { ...pane, activeFileId: fileId } : pane,
          ),
        );
      }),
    );
    setComposerFocused(false);
  }, []);

  const onModelChange = useCallback(
    (sessionId: string, harness: HarnessId, model: string) => {
      const current = sessionsRef.current.find((s) => s.id === sessionId);
      if (!current) return;
      if (isPreparingHandoff(current)) return;
      const resolved = resolveModel(harness, model);
      // Leaving fx resets the mode: fx's Full access is its only offer and must not carry to another CLI (WP-175).
      const leavesFx = current.harness === "fx" && resolved.harness !== "fx";
      saveRecentModelChoice(resolved.harness, resolved.id);
      if (current.modelSettings) {
        saveLastModelSettings(current.modelSettings, "fill");
      }
      const modelSettings = preferredModelSettings(
        resolved,
        current.modelSettings,
      );
      const recoverLimit =
        !current.busy &&
        !!current.usageLimit &&
        (current.harness !== harness || current.model !== resolved.id);
      // WP-121: keep this thread when the target can resume. A refusal still arms the recap.
      const switched = commitMidThreadSwitch(
        {
          get: (id) => sessionsRef.current.find((session) => session.id === id),
          compareAndPut: (session, seen) => {
            let applied = false;
            // The updater runs during render. flushSync runs it now so a refused write is visible here.
            flushSync(() => {
              setSessions((prev) =>
                prev.map((s) => {
                  if (s.id !== session.id) return s;
                  if (
                    s.blocks.length !== seen.blocks ||
                    s.harness !== seen.harness ||
                    s.model !== seen.model
                  ) {
                    return s;
                  }
                  applied = true;
                  const next = recoverLimit
                    ? isMonoSession(sessionId)
                      ? resumeMonoUsageLimit(session)
                      : resumeUsageLimitedSession(session)
                    : session;
                  return leavesFx ? { ...next, runtimeMode: DEFAULT_RUNTIME_MODE } : next;
                }),
              );
            });
            return applied;
          },
        },
        sessionId,
        { harness, model: resolved.id, modelSettings },
      );
      if (switched.kind === "ok" && switched.outcome.forget) {
        void forgetHarnessSession(switched.outcome.forget, sessionId);
      }
    },
    [],
  );

  const onModelSettingsChange = useCallback(
    (sessionId: string, modelSettings: Record<string, string>) => {
      saveLastModelSettings(modelSettings);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, modelSettings } : s)),
      );
    },
    [],
  );

  const onRuntimeModeChange = useCallback(
    (sessionId: string, runtimeMode: RuntimeMode) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, runtimeMode } : s)),
      );
    },
    [],
  );

  const onSaveDraft = useCallback(
    (
      sessionId: string,
      text: string,
      attachments: Attachment[] = [],
      appRequestId?: string,
    ) => {
      const current = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (current && remoteProjectFor(current.cwd))
        return !!remoteSessionActions(sessionId)?.saveDraft(text, attachments);
      if (
        !current ||
        current.busy ||
        sessionDraftBlock(current) ||
        current.inboxAsk ||
        current.worktreeRemoved ||
        (!text.trim() && attachments.length === 0)
      ) {
        return false;
      }
      const placeholderTitle = canReplaceSessionTitle(
        current.title,
        current.harness,
        HARNESS_LABEL[current.harness],
      );
      const title = placeholderTitle
        ? titleFromPrompt(text, current.harness, attachments)
        : current.title;
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId && !sessionDraftBlock(session)
            ? {
                ...session,
                title,
                blocks: [
                  ...session.blocks,
                  {
                    id: crypto.randomUUID(),
                    role: "user",
                    text,
                    ...(attachments.length > 0 ? { attachments } : {}),
                    draft: true,
                    ...(appRequestId ? { appRequestId } : {}),
                  },
                ],
              }
            : session,
        ),
      );
      return true;
    },
    [],
  );

  const onRemoveDraft = useCallback(
    (sessionId: string, draftBlockId: string) => {
      const current = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (!current) return false;
      const withoutDraft = removeSessionDraft(current, draftBlockId);
      if (!withoutDraft) return false;

      if (!shouldPersistSession(withoutDraft)) {
        pendingPersist.current.delete(sessionId);
        lastPersisted.current.delete(sessionId);
        lastPersistedUserBlock.current.delete(sessionId);
        invalidateLoadedSession(sessionId);
        setHistory((history) =>
          history.filter((session) => session.id !== sessionId),
        );
        setStoredLinkedSessions((history) =>
          history.filter((session) => session.id !== sessionId),
        );
        void discardDraftSessionRecord(sessionId).catch(() => undefined);
      }

      setSessions((sessions) =>
        sessions.map((session) =>
          session.id === sessionId
            ? (removeSessionDraft(session, draftBlockId) ?? session)
            : session,
        ),
      );
      return true;
    },
    [invalidateLoadedSession],
  );

  const submitSession = useCallback(
    (
      sessionId: string,
      rawText: string,
      attachments: Attachment[] = [],
      options?: SubmitOptions,
    ): SubmissionAcceptance => {
      // Every turn is built from here: a hidden character never reaches the agent, whichever surface sent it.
      const text = stripHiddenCharacters(rawText).text;
      const remote = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (remote && remoteProjectFor(remote.cwd))
        return !!remoteSessionActions(sessionId)?.submit(
          text,
          attachments,
          options,
        );
      // A turn that may pick delegated work back up (a resumed cut-off turn, or the next turn of a child whose row is
      // still open) re-attaches to its row and reports to the owner when it ends.
      const delegation =
        options?.onSettled ||
        options?.managed ||
        options?.monoSessionCompletion ||
        options?.monoCheck ||
        options?.resendEdited
          ? undefined
          : delegationsRef.current?.resumeMonitor(
              sessionId,
              text,
              !!remote?.busy,
              // An automatic resume carries a note or a ship's receipt, so its text isn't the bare continue.
              !!options?.autoResume || text.trim() === CONTINUE_PROMPT,
            );
      // r84 (s14): Ash himself answering a worker whose job is open: its Lead hears his words at once (save, say what's
      // next), and the worker's turn says his words decide.
      const ashTyped =
        !!delegation &&
        !options?.monoNote &&
        !options?.managed &&
        !options?.appRequestId &&
        !options?.autoResume &&
        !options?.monoCheck &&
        text.trim() !== CONTINUE_PROMPT;
      const answeredJob = ashTyped ? openJobOf(delegationsRef.current?.known() ?? [], sessionId) : undefined;
      if (delegation)
        options = {
          ...options,
          onSettled: delegation.settled,
          onStarted: delegation.started,
          ...(answeredJob ? { ashToWorker: true } : {}),
        };
      // His answer is the answer: the job reads Working again, and its resumed turn reports to the Lead.
      if (answeredJob?.state === "question")
        void delegationsRef.current?.setQuestion(answeredJob, null, "ash", { answers: "ash-in-chat" }).catch(() => undefined);
      if (answeredJob) noteAshAnswer(answeredJob.id, text, Date.now(), { owner: answeredJob.ownerSession, project: answeredJob.project });
      // r89 (Ash): his answer drops the Lead's queued wake with this worker's question, so the Lead never asks it.
      if (answeredJob) {
        const owner = sessionsRef.current.find((s) => s.id === answeredJob.ownerSession);
        const wakes = answeredQuestionWakes(owner, sessionId);
        if (wakes.length)
          setSessions((previous) =>
            previous.map((s) => (s.id === answeredJob.ownerSession ? wakes.reduce(dequeueQueuedMessage, s) : s)),
          );
      }
      if (answeredJob)
        void queueMonoSessionCompletionRef.current(
          answeredJob.ownerSession,
          ashAnsweredLeadNote(answeredJob, text, Date.now().toString(36)),
        );
      if (editedResends.isActive(sessionId)) return false;
      // Output already received belongs before the submitted user message.
      // Flush before reading the session too, since pending errors can settle it.
      flushHarnessEvents();
      const controlError = orchestrator.submissionError(
        sessionId,
        options?.managed,
      );
      if (controlError) {
        enqueueHarnessEvent(sessionId, { type: "status", text: controlError });
        flushHarnessEvents();
        return false;
      }
      if (options?.managed) {
        const target = sessionsRef.current.find((s) => s.id === sessionId);
        if (
          !target ||
          target.busy ||
          target.pendingSwitch ||
          isPreparingHandoff(target) ||
          removingSessionIds.current.has(sessionId)
        ) {
          options.onSettled?.({
            status: "failed",
            text: "",
            error: "Session is unavailable or already running",
          });
          return false;
        }
      }
      if (
        removingSessionIds.current.has(sessionId) ||
        switchingWorktrees.current.has(sessionId) ||
        workspaceNavigation.isSwitching(sessionId)
      )
        return false;
      const storedCurrent = sessionsRef.current.find((s) => s.id === sessionId);
      if (options?.appRequestId && !options.followsUp && storedCurrent?.busy)
        return false;
      if (
        options?.ciRepair &&
        storedCurrent &&
        (storedCurrent.busy ||
          storedCurrent.pendingSwitch ||
          isPreparingHandoff(storedCurrent))
      )
        return false;
      if (
        !storedCurrent ||
        storedCurrent.worktreeRemoved ||
        [...removingWorktreePaths.current].some((path) =>
          isEqualOrInside(sessionWorkCwd(storedCurrent), path),
        )
      )
        return false;
      // Ash typed while the agent waits on its own question (AskUserQuestion): his words answer it, the way Claude
      // Code's picker takes a typed answer, never a message queued behind the question (messageQueue.ts).
      const typed = typedQuestionAnswer(storedCurrent, text, options ?? {});
      if (typed) {
        const reply: UserQuestionReply =
          typed.kind === "answer" ? typed.reply : { kind: "skipped" };
        delegationActions()?.noteAnswer?.(sessionId, typed.requestId, reply);
        respondHarnessQuestion(
          storedCurrent.harness,
          sessionId,
          typed.requestId,
          reply,
        );
        if (typed.kind === "answer") {
          const answered = sessionsRef.current.map((session) =>
            session.id === sessionId ? appendSteerUser(session, text) : session,
          );
          sessionsRef.current = answered;
          setSessions(answered);
          dismissNoticesForContinuedSession(sessionId);
          // Files or a card sent with the words follow as his next message, once the question is answered.
          if (
            attachments.length ||
            (options?.noteCard ?? storedCurrent.noteCard) ||
            (options?.handoffCard ?? storedCurrent.handoffCard)
          )
            return submitSessionRef.current(sessionId, "", attachments, options);
          return true;
        }
        // Set aside: his message goes in as usual, right after it.
      }
      const draftBlock = options?.draftBlockId
        ? storedCurrent.blocks.find(
            (block) =>
              block.id === options.draftBlockId &&
              block.role === "user" &&
              block.draft,
          )
        : undefined;
      if (options?.draftBlockId && !draftBlock) return false;
      const draftCleared = draftBlock
        ? {
            ...storedCurrent,
            blocks: storedCurrent.blocks.filter(
              (block) => block.id !== draftBlock.id,
            ),
          }
        : storedCurrent;
      let current = options?.buildTarget
        ? withPlanBuildTarget(draftCleared, options.buildTarget)
        : draftCleared;
      const editedResend = options?.resendEdited
        ? createEditedResendAttempt(current, options.onResendRejected)
        : undefined;
      if (options?.resendEdited && !editedResend) return false;
      const editedProviderTurnId = editedResend?.providerTurnId;
      if (editedResend) {
        current = { ...current, blocks: editedResend.blocks };
      }
      const intent = options?.intent ?? "default";
      if (intent === "orchestrate") {
        try {
          const run = orchestrator.forSession(sessionId);
          if (run && ["active", "paused"].includes(run.status))
            throw new Error(
              "Stop the current orchestration run before preparing another proposal.",
            );
        } catch (error) {
          enqueueHarnessEvent(sessionId, {
            type: "status",
            text: error instanceof Error ? error.message : String(error),
          });
          flushHarnessEvents();
          return false;
        }
      }
      const approvedPlan = options?.planBlockId
        ? current.blocks.find(
            (block) =>
              block.id === options.planBlockId && block.role === "plan",
          )
        : undefined;
      if (intent === "build" && !approvedPlan?.text.trim()) return false;
      if (options?.queuedMessageId) {
        const mode =
          options.followUpBehavior === "steer" ? "steer" : "dispatch";
        if (!queuedMessageForSubmit(current, options.queuedMessageId, mode)) {
          return false;
        }
      }
      const noteCard =
        options && "noteCard" in options ? options.noteCard : current.noteCard;
      const handoffCard =
        options && "handoffCard" in options
          ? options.handoffCard
          : current.handoffCard;
      if (
        !text.trim() &&
        attachments.length === 0 &&
        !noteCard &&
        !handoffCard
      ) {
        return false;
      }
      if (isPreparingHandoff(current)) return false;
      saveRecentModelChoice(current.harness, current.model);
      const initialWorkCwd = sessionWorkCwd(current);
      // A chat that came in from an export with no folder here asks for one before anything runs (the harness seam
      // refuses it too, so nothing starts however the turn was reached).
      if (!hasChatFolder(initialWorkCwd)) {
        enqueueHarnessEvent(sessionId, {
          type: "session.error",
          message: CHAT_NEEDS_FOLDER,
        });
        flushHarnessEvents();
        return false;
      }
      const createDraftWorktree =
        !current.worktreeCwd && current.workspaceMode === "worktree";
      const accountProvider = supportsProviderAccounts(current.harness)
        ? current.harness
        : undefined;
      // A chat's first turn goes to the first account in Ash's order with room when the picked one is out (E5,
      // accountWaterfall.ts); a chat already talking to an account stays there until that account refuses it.
      const startedOn =
        accountProvider && !current.providerSessionId
          ? firstTurnAccount(
              accountProvider,
              current.providerAccountId ??
                selectedProviderAccountId(accountProvider, current.cwd),
              {
                now: Date.now(),
                usageFor: (account) =>
                  getCachedRateLimits(account.provider, account.id),
              },
            )
          : undefined;
      const providerAccountId = accountProvider
        ? (startedOn?.id ??
          current.providerAccountId ??
          selectedProviderAccountId(accountProvider, current.cwd))
        : undefined;
      if (
        accountProvider &&
        providerAccountId &&
        !providerAccountExists(accountProvider, providerAccountId)
      ) {
        enqueueHarnessEvent(sessionId, {
          type: "session.error",
          message:
            "This conversation uses a removed provider account. Switch accounts from the usage control to start a new conversation.",
        });
        flushHarnessEvents();
        return false;
      }
      const submittedText = intent === "build" ? "Build approved plan" : text;
      const operatorCommand = consumeOperatorCommand(submittedText);
      if (
        operatorCommand.matched &&
        (intent !== "default" ||
          current.orchestrationLeadId ||
          current.inboxAsk ||
          orchestrator.run(sessionId))
      ) {
        enqueueHarnessEvent(sessionId, {
          type: "status",
          text: "Use /operator from a regular session turn, outside an orchestration run.",
        });
        flushHarnessEvents();
        return false;
      }
      // The Mono has app access in every turn, without the command.
      const mono = isMonoSession(sessionId);
      // WP-120: so does a chat in a hub project's coding team, on every CLI that can lead (not only Claude Code).
      // An orchestrator like the Lead, its delegate tool calls the app (codingTeam.ts). Noted before the turn,
      // so the session starts with the tool and its project.
      const team = mono ? undefined : codingTeamOf(current);
      const teamDelegates = !!team && hasDelegateTool(sessionId, current.harness);
      const queuedMonoMessage =
        mono && options?.queuedMessageId
          ? current.queuedMessages?.find(
              (message) => message.id === options.queuedMessageId,
            )
          : undefined;
      const operatorAccess =
        operatorCommand.matched ||
        mono ||
        teamDelegates ||
        operatorEnabledInThread(current.blocks);
      const monoFirstTurn =
        mono &&
        !current.blocks.some((block) => block.role === "user" && !block.draft);
      const promptText = operatorCommand.matched
        ? operatorCommand.text.trim() ||
          "Explain what you can do in MonoCode with the app CLI."
        : submittedText;
      const rawCommand =
        !operatorCommand.matched &&
        isNativeCommandPrompt(submittedText, current.harness);
      const ciContext = options?.ciRepair?.prompt ?? options?.ciContext;
      const harnessText =
        options?.ciRepair?.prompt ??
        (rawCommand ? submittedText : composeNoteMessage(noteCard, promptText));

      const pendingSwitch = pendingComposerSwitch(current);
      // WP-121: a resumable switch sends its portable transcript. A refusal still uses pendingSwitch.
      // A repair is not the person's next message, so it leaves the transcript for that message.
      const portableResume =
        pendingSwitch || options?.ciRepair ? undefined : current.portableResume;
      // WP-146: tell Ash why his message did not go into a turn that waits on his OK (approvalWait.ts).
      const sayHeld = () => {
        const heldLine = heldLineForSend(current, options);
        if (!heldLine) return;
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, blocks: [...s.blocks, { id: crypto.randomUUID(), role: "system", text: heldLine, notice: "waiting-on-you" } as Block] }
              : s,
          ),
        );
      };

      // A Mono accepts consecutive messages before its provider is connected.
      // The pending head is delivered once ready; later messages cannot overtake it.
      // Two go in ahead of what waits: the resume of a turn a restart cut (everything queued waited behind that turn),
      // and Ash's own message to a chat whose app deliveries are held behind such a turn (messageQueue waitsOnCutTurn),
      // so "send a message to carry on" works.
      const aheadOfQueue =
        !!options?.autoResume ||
        (waitsOnCutTurn(current) &&
          !options?.appRequestId &&
          !options?.waitForIdle &&
          !options?.monoCheck &&
          !options?.monoNote &&
          !options?.managed &&
          !options?.monoSessionCompletion);
      if (
        mono &&
        !options?.queuedMessageId &&
        (current.busy || (!!current.queuedMessages?.length && !aheadOfQueue))
      ) {
        const next = sessionsRef.current.map((session) =>
          session.id === sessionId
            ? options?.waitForIdle && options.appRequestId
              ? queueBriefForIdle(session, {
                  text,
                  attachments,
                  intent,
                  requestId: options.appRequestId,
                })
              : enqueueMonoMessage(
                {
                  ...session,
                  inboxCard: rawCommand ? session.inboxCard : undefined,
                  noteCard: rawCommand ? session.noteCard : undefined,
                  handoffCard: rawCommand ? session.handoffCard : undefined,
                },
                {
                  // An app brief keeps its request id, so a retried send finds it waiting and its sender can tell
                  // when it went in.
                  id: options?.appRequestId ?? crypto.randomUUID(),
                  text,
                  attachments,
                  noteCard,
                  handoffCard,
                  intent,
                  ...(options?.appRequestId
                    ? { appRequestId: options.appRequestId }
                    : {}),
                  ...(options?.waitForIdle ? { waitForIdle: true } : {}),
                },
                rawCommand ? undefined : userTurnCards(noteCard),
              )
            : session,
        );
        sessionsRef.current = next;
        setSessions(next);
        dismissNoticesForContinuedSession(sessionId);
        return true;
      }

      if (mono && current.busy && options?.queuedMessageId) {
        const message = current.queuedMessages?.find(
          (entry) => entry.id === options.queuedMessageId,
        );
        if (
          !message ||
          !canSteerQueuedHead(current) ||
          !canSteerHarness(current.harness) ||
          current.registryAgentId ||
          operatorCommand.matched
        ) {
          // WP-146: Steer on a message held behind an open approval says why it stayed.
          if (message) sayHeld();
          return false;
        }
        const gen = turnGen.current.get(sessionId);
        const change = (update: (session: Session) => Session) => {
          const next = sessionsRef.current.map((session) =>
            session.id === sessionId ? update(session) : session,
          );
          sessionsRef.current = next;
          setSessions(next);
        };
        return deliverQueuedFollowUp({
          message,
          current: () =>
            sessionsRef.current.find((session) => session.id === sessionId),
          isCurrentTurn: () => turnGen.current.get(sessionId) === gen,
          prepare: async () => {
            const latest = sessionsRef.current.find(
              (session) => session.id === sessionId,
            );
            if (latest) await upsertSession(latest);
            return {
              attachments: await prepareAttachments(attachments),
              text: await preparePrompt(harnessText, {
                harness: current.harness,
                sessionId,
                cwd: initialWorkCwd,
              }),
            };
          },
          steer: (prepared) =>
            steerHarnessTurn({
              origin: options?.origin,
              harness: current.harness,
              sessionId,
              cwd: initialWorkCwd,
              model: current.model,
              modelSettings: current.modelSettings,
              text: inboxAskPrompt(
                rawCommand ? undefined : current.inboxAsk,
                prepared.text,
              ),
              attachments: prepared.attachments,
            }),
          delivered: () => {
            change((session) =>
              acknowledgeMonoMessage(session, message, {
                mode: "follow-up",
                text: submittedText,
                attachments: displayAttachments(attachments),
                cards: {
                  ...userTurnCards(noteCard),
                  // A steered app brief: its sender's row sees it went in.
                  ...(message.appRequestId
                    ? { appRequestId: message.appRequestId }
                    : {}),
                  // A room's wake steered into the work: hidden, a quiet line.
                  ...(message.monoNote
                    ? { internal: true, monoNote: message.monoNote }
                    : {}),
                },
              }),
            );
            flushHarnessEvents();
          },
          deferred: () =>
            change((session) => ({ ...session, turnReady: false })),
          failed: (error) =>
            change((session) => ({
              ...session,
              queueStatus: "paused",
              queuedMessages: session.queuedMessages?.map((entry) =>
                entry.id === message.id ? { ...entry, error } : entry,
              ),
            })),
        });
      }

      if (current.busy && !pendingSwitch && !portableResume) {
        // Ash wrote to a chat held on his OK: it can't read him until he decides, so say so now (S14). WP-146: the
        // same when he presses Steer on a message already waiting (it stays queued), and only when the message
        // really waits (not for the background-tasks branch, which hands it over now).
        sayHeld();
        if (
          operatorCommand.matched &&
          options?.queuedMessageId &&
          options.followUpBehavior === "steer"
        ) {
          enqueueHarnessEvent(sessionId, {
            type: "status",
            text: "/operator starts a new turn after the current turn finishes.",
          });
          flushHarnessEvents();
          return false;
        }
        // WP-146: a message does not go into a turn that is still waiting on approval. The background-tasks
        // branch keeps precedence: parksForApproval is false when only background work is left.
        const parkForApproval = parksForApproval(current);
        // A message already in the queue (its own Steer button) stays where it is, and the line above says why.
        // This stays ahead of followUpWhenBusy so it is never added to the queue a second time.
        if (parkForApproval && options?.queuedMessageId) return false;
        // The app is compacting this idle chat in the background (WP-115). Its
        // busy flag is ours, there is no reply to steer into, and a message
        // written now would land inside the compact.
        const compacting = !!current.idleCompacting;
        // WP-134b: a More agents chat cannot be steered; its message waits for the turn to finish.
        const registryChat = Boolean(current.registryAgentId);
        const steerable =
          isLiveHarness(current.harness) &&
          canSteerHarness(current.harness) &&
          !compacting &&
          !registryChat;
        const followUpBehavior = followUpWhenBusy({
          setting: options?.followUpBehavior ?? loadFollowUpBehavior(),
          mustWait: !!(
            parkForApproval ||
            current.worktreePreparing ||
            intent === "plan" ||
            intent === "orchestrate" ||
            operatorCommand.matched ||
            options?.waitForIdle
          ),
          onlyBackgroundWork: !!current.backgroundTasks?.length,
          mono: !!mono,
          steerable,
          cannotRedirect: registryChat || harnessCannotSteer(current.harness),
          compacting,
          alreadyQueued: !!options?.queuedMessageId,
        });
        if (followUpBehavior === "stay") {
          // Already in the queue and not to go in now: it stays where it is.
          enqueueHarnessEvent(sessionId, {
            type: "status",
            text: QUEUED_MESSAGE_WAITS,
          });
          flushHarnessEvents();
          return false;
        }
        if (followUpBehavior === "queue") {
          if (registryChat) {
            enqueueHarnessEvent(sessionId, { type: "status", text: WAITS });
            flushHarnessEvents();
          }
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionId
                ? {
                    ...s,
                    inboxCard: rawCommand ? s.inboxCard : undefined,
                    noteCard: rawCommand ? s.noteCard : undefined,
                    handoffCard: rawCommand ? s.handoffCard : undefined,
                    queuedMessages: [
                      ...(s.queuedMessages ?? []),
                      {
                        // An app request's ID, so a retried request finds it queued.
                        id: options?.appRequestId ?? crypto.randomUUID(),
                        text,
                        attachments,
                        noteCard,
                        handoffCard,
                        intent,
                        ...(options?.appRequestId
                          ? { appRequestId: options.appRequestId }
                          : {}),
                        ...(options?.waitForIdle ? { waitForIdle: true } : {}),
                      },
                    ],
                    queueStatus:
                      s.queueStatus === "paused" ? "paused" : "active",
                  }
                : s,
            ),
          );
          dismissNoticesForContinuedSession(sessionId);
          return true;
        }
        if (!steerable) {
          // WP-115: a stale button must not drop the message. A known refusal
          // names the redirect; anything not live keeps the mid-turn line.
          enqueueHarnessEvent(sessionId, {
            type: "status",
            text: compacting
              ? COMPACTING_NOTE
              : harnessCannotSteer(current.harness)
                ? cantRedirectTurn(current.harness)
                : cantTakeFollowUp(current.harness),
          });
          flushHarnessEvents();
          return false;
        }
        dismissNoticesForContinuedSession(sessionId);
        const visible = displayAttachments(attachments);
        const cards = userTurnCards(noteCard);
        const nextSessions = sessionsRef.current.map((s) => {
          if (s.id !== sessionId) return s;
          let next: Session = {
            ...s,
            inboxCard: rawCommand ? s.inboxCard : undefined,
            noteCard: rawCommand ? s.noteCard : undefined,
            handoffCard: rawCommand ? s.handoffCard : undefined,
          };
          if (options?.queuedMessageId) {
            next = dequeueQueuedMessage(next, options.queuedMessageId);
          }
          return appendSteerUser(next, submittedText, visible, {
            ...cards,
            ...(options?.appRequestId
              ? { appRequestId: options.appRequestId }
              : {}),
          });
        });
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        void (async () => {
          try {
            const prepared = await prepareAttachments(attachments);
            const prompt = await preparePrompt(harnessText, {
              harness: current.harness,
              sessionId,
              cwd: initialWorkCwd,
            });
            await steerHarnessTurn({
              origin: options?.origin,
              harness: current.harness,
              sessionId,
              cwd: initialWorkCwd,
              model: current.model,
              modelSettings: current.modelSettings,
              text: inboxAskPrompt(
                rawCommand ? undefined : current.inboxAsk,
                prompt,
              ),
              attachments: prepared,
            });
          } catch (error: unknown) {
            const message =
              error instanceof Error
                ? error.message
                : `${current.harness} could not steer the active turn`;
            enqueueHarnessEvent(sessionId, {
              type: "session.error",
              message,
            });
            flushHarnessEvents();
          }
        })();
        return true;
      }

      if (
        !options?.projectLocationReady &&
        looksLikeProject(current.cwd) &&
        !current.worktreeCwd
      ) {
        const key = pathKey(current.cwd);
        let sync = projectLocationSyncs.current.get(key);
        if (!sync) {
          sync = synchronizeProjectLocation(current.cwd);
          projectLocationSyncs.current.set(key, sync);
          void sync.then(
            () => projectLocationSyncs.current.delete(key),
            () => projectLocationSyncs.current.delete(key),
          );
        }
        return submitAfterProjectSync({
          cwd: current.cwd,
          sync,
          applyLocationChange: applyProjectLocationChange,
          submit: async () => {
            const accepted = await submitAfterProjectSyncRef.current(
              sessionId,
              text,
              attachments,
              { ...options, projectLocationReady: true },
            );
            if (!accepted) {
              editedResend?.reject();
              options?.onSettled?.({
                status: "failed",
                text: "",
                error:
                  "The chat became unavailable before the request could start. Try again when it is ready.",
              });
            }
            return accepted;
          },
          onError: (error: unknown) => {
            const message =
              error instanceof Error
                ? error.message
                : "The project folder could not be opened.";
            enqueueHarnessEvent(sessionId, {
              type: "session.error",
              message,
            });
            flushHarnessEvents();
            editedResend?.reject();
            options?.onSettled?.({
              status: "failed",
              text: "",
              error: message,
            });
          },
        });
      }

      // A Mono's chat never ends, but the provider session behind it does:
      // once it fills most of the model's context window, this turn starts
      // a fresh one, briefed on where the conversation was.
      const monoRotationReason =
        mono && !pendingSwitch && !editedResend
          ? rotationReason(current)
          : undefined;
      const monoRotation = monoRotationReason
        ? planRotation(
            current.blocks,
            loadMonoRotation(sessionId),
            monoRotationReason,
            Date.now(),
          )
        : undefined;

      const gen = (turnGen.current.get(sessionId) ?? 0) + 1;
      turnGen.current.set(sessionId, gen);
      const proposalId =
        intent === "orchestrate" ? crypto.randomUUID() : undefined;
      let proposalDraft: OrchestrationProposal | undefined = proposalId
        ? {
            version: 1,
            leadId: sessionId,
            cwd: current.cwd,
            checkoutCwd: initialWorkCwd,
            request: harnessText,
            author: {
              harness: current.harness,
              model: current.model,
              name: resolveModel(current.harness, current.model).name,
            },
            settings: { choices: [], maxWorkers: 2 },
            status: "planning",
            title: "Orchestration plan",
            summary: "",
            // WP-91: the model fills these from the request; a plan without a finish line is refused.
            goal: "",
            check: { command: "", expectExit: 0 },
            tasks: [],
          }
        : undefined;
      const isFirstTurn = current.blocks.length === 0;
      const placeholderTitle =
        canReplaceSessionTitle(
          current.title,
          current.harness,
          HARNESS_LABEL[current.harness],
        ) || !!draftBlock;
      const titleSeed =
        isFirstTurn &&
        !current.inboxCard &&
        !current.noteCard &&
        placeholderTitle
          ? titleFromPrompt(
              operatorCommand.matched ? promptText : submittedText,
              current.harness,
              attachments,
            )
          : current.title;
      const visible = displayAttachments(attachments);
      const card =
        options?.secondOpinion ??
        (handoffCard ? handoffTurnCard(handoffCard) : undefined);
      const visibleText = operatorCommand.matched
        ? promptText
        : card?.kind === "handoff"
          ? submittedText
          : card
            ? SECOND_OPINION_TITLE
            : submittedText;
      const cards = {
        ...(rawCommand ? undefined : userTurnCards(noteCard, card)),
        ...(ciContext ? { ciContext } : {}),
        ...(operatorCommand.matched ? { monocode: true } : {}),
        ...(intent === "plan" || intent === "orchestrate" ? { intent } : {}),
        ...(options?.appRequestId
          ? { appRequestId: options.appRequestId }
          : {}),
        // The orchestrator writes these turns, not the user; hide them.
        ...(options?.managed || options?.monoSessionCompletion || options?.monoCheck || options?.monoNote
          ? { internal: true }
          : {}),
        ...(options?.monoNote ? { monoNote: options.monoNote } : {}),
        ...(options?.monoSessionCompletion
          ? { monoSessionCompletion: options.monoSessionCompletion }
          : {}),
        ...(options?.monoCheck ? { monoCheck: options.monoCheck } : {}),
      };
      const live = isLiveHarness(current.harness);
      // WP-123: a forked chat's first send carries the chat copied into it; its provider has never seen it. That recap
      // covers the whole copy, so it stands in for an older handoff recap that came along with the messages.
      const queuedFork =
        live && !pendingSwitch ? pendingForkBrief(current) : null;
      const queuedHandoff =
        live && !pendingSwitch && !queuedFork ? pendingHandoff(current) : null;

      if (current.busy && (pendingSwitch || portableResume)) {
        void cancelHarnessTurn(
          (pendingSwitch ?? portableResume)!.from,
          sessionId,
        );
      }

      dismissNoticesForContinuedSession(sessionId);
      const commitSubmittedTurn = () => {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s;
            const draftRemoved = draftBlock
              ? {
                  ...s,
                  blocks: s.blocks.filter(
                    (block) => block.id !== draftBlock.id,
                  ),
                }
              : s;
            const selected = options?.buildTarget
              ? withPlanBuildTarget(draftRemoved, options.buildTarget)
              : draftRemoved;
            const titled = isFirstTurn ? titleSeed : selected.title;
            let next: Session = {
              ...selected,
              ...(startedOn?.line
                ? {
                    blocks: [
                      ...selected.blocks,
                      {
                        id: crypto.randomUUID(),
                        role: "system",
                        text: startedOn.line,
                        notice: "account-moved",
                      } as Block,
                    ],
                  }
                : {}),
              providerAccountId,
              usageLimit: undefined,
              autoResumes: options?.autoResume,
              // A resume carries what was cut forward until Claude has the prompt (claude.ts clears it then).
              cutWork: options?.autoResume ? selected.cutWork : undefined,
              worktreePreparing: createDraftWorktree
                ? true
                : selected.worktreePreparing,
              inboxCard:
                rawCommand || options?.ciRepair ? s.inboxCard : undefined,
              noteCard:
                rawCommand || options?.ciRepair ? s.noteCard : undefined,
              handoffCard:
                rawCommand || options?.ciRepair ? s.handoffCard : undefined,
              // WP-121: this send consumes the switch notice. The timeline marker stays.
              // A slash command or a repair is not that send.
              ...(rawCommand || options?.ciRepair
                ? {}
                : { portableResume: undefined, midThread: undefined }),
            };
            if (editedResend) {
              next = editedResend.replace(next);
            }
            if (approvedPlan && intent === "build") {
              next = {
                ...next,
                blocks: next.blocks.map((block) =>
                  block.id === approvedPlan.id && block.role === "plan"
                    ? {
                        ...block,
                        plan: {
                          ...(block.plan ?? { status: "ready" as const }),
                          status: "building" as const,
                          approvedText: block.text,
                        },
                      }
                    : block,
                ),
              };
            }
            if (options?.queuedMessageId) {
              next = dequeueQueuedMessage(next, options.queuedMessageId);
            }
            if (!live) {
              return {
                ...next,
                title: titled,
                pendingSwitch: undefined,
                busy: false,
                blocks: [
                  ...next.blocks,
                  ...(queuedMonoMessage?.blockId
                    ? []
                    : [
                        {
                          id: crypto.randomUUID(),
                          role: "user",
                          text: visibleText,
                          ...(visible.length > 0
                            ? { attachments: visible }
                            : {}),
                          ...cards,
                        } as Block,
                      ]),
                  {
                    id: crypto.randomUUID(),
                    role: "system",
                    text: `${next.harness} is not connected yet — install and sign in to that provider, then retry.`,
                    notice: "error",
                  },
                ],
              };
            }
            if (pendingSwitch) {
              const sealed = stopStreaming({
                ...next,
                title: titled,
                pendingSwitch: undefined,
              });
              const prepared = appendPreparingHandoff(
                sealed,
                pendingSwitch.from,
                next.harness,
              );
              return queuedMonoMessage
                ? acknowledgeMonoMessage(prepared, queuedMonoMessage, {
                    mode: "new-turn",
                    text: visibleText,
                    attachments: visible,
                    cards,
                  })
                : appendUser(prepared, visibleText, visible, cards);
            }
            return queuedMonoMessage
              ? acknowledgeMonoMessage(
                  { ...next, title: titled },
                  queuedMonoMessage,
                  {
                    mode: "new-turn",
                    text: visibleText,
                    attachments: visible,
                    cards,
                  },
                )
              : appendUser(
                  { ...next, title: titled },
                  visibleText,
                  visible,
                  cards,
                );
          }),
        );
      };
      if (!options?.resendEdited) {
        flushSync(commitSubmittedTurn);
        options?.onStarted?.();
      }

      const launchTitleGeneration = (workCwd: string) => {
        if (
          !live ||
          !shouldGenerateSessionTitle(
            isFirstTurn,
            placeholderTitle,
            options?.refreshTitle,
          )
        ) {
          return;
        }
        const titleMessage =
          harnessText || attachments.map((file) => file.name).join(", ");
        void generateTitleWithTextModel(current.harness, {
          sessionId,
          cwd: workCwd,
          message: titleMessage,
          providerAccountId,
        })
          .then(async (generated) => {
            if (
              options?.refreshTitle &&
              !isFirstTurn &&
              turnGen.current.get(sessionId) !== gen
            ) {
              return;
            }
            const linkedWorkItem = await resolveLinkedWorkItem(
              titleMessage,
              workCwd,
              generated?.workItem ?? null,
            );
            if (!generated && !linkedWorkItem) return;
            setSessions((prev) =>
              prev.map((s) => {
                if (s.id !== sessionId) return s;
                let next = s;
                if (
                  generated &&
                  (options?.refreshTitle ||
                    canReplaceSessionTitle(s.title, s.harness, titleSeed))
                ) {
                  next = {
                    ...next,
                    title: formatSessionTitle(s.harness, generated.title),
                  };
                }
                if (linkedWorkItem && !next.linkedWorkItem) {
                  next = { ...next, linkedWorkItem };
                }
                return next;
              }),
            );
          })
          .catch(() => undefined);
      };

      if (!live) {
        if (pendingSwitch) {
          void forgetHarnessSession(pendingSwitch.from, sessionId);
        }
        editedResend?.reject();
        options?.onSettled?.({
          status: "failed",
          text: "",
          error: "Harness is not connected",
        });
        return true;
      }
      if (editedResend && canRewindHarnessLastTurn(current.harness)) {
        editedResends.start(sessionId);
        const locked = sessionsRef.current.map((session) =>
          session.id === sessionId
            ? { ...session, busy: true, idleCompacting: undefined }
            : session,
        );
        sessionsRef.current = locked;
        syncDockBadge(locked);
        setSessions(locked);
      }

      if (proposalId && proposalDraft) {
        const draft = proposalDraft;
        setSessions((prev) =>
          prev.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  blocks: [...session.blocks, proposalBlock(proposalId, draft)],
                }
              : session,
          ),
        );
      }

      let controlOutcome: ControlOutcome = {
        status: "failed",
        text: "",
        error: "Turn did not complete",
      };
      let controlText = "";
      let proposalText = "";
      let nativeProposalText = "";
      let completedProposal: OrchestrationProposal | undefined;
      void (async () => {
        // A brief that waited in the queue is saved as gone in before Claude reads it, so a crash in between can't
        // bring it back from the saved queue and send it twice.
        if (options?.queuedMessageId && options.appRequestId) {
          const sent = sessionsRef.current.find(
            (session) => session.id === sessionId,
          );
          if (sent && shouldPersistSession(sent))
            await upsertSession(sent).catch(() => null);
        }
        let workCwd = initialWorkCwd;
        // WP-110: ask and always start a new chat in a worktree. A refusal keeps
        // the creation function's own message.
        const tree = await openNewChatWorktree(
          newChatWorktreeOpenFor(current, {
            setting: loadNewChatWorktree(),
            isFirstTurn,
            toggleOn: createDraftWorktree,
          }),
          {
            gitOnThisComputer: gitRepositoryOnThisComputer,
            offerCheck: pendingNewChatOfferCheck,
            createWorktree,
          },
        );
        if (tree) {
          workCwd = tree.path;
          // r86 (c02 run 2, +364s: the README worker's copy was the last commit, so it never saw the health route or the
          // shared type that had already landed, uncommitted, in the project): a delegated worker's new copy starts from
          // the project as it is now, landed work included, and that is its starting point for its own landing.
          if (sessionId.startsWith("app-")) await refreshWorkerCopy({ checkout: tree.path, project: current.cwd });
          workspacePins.current.set(sessionId, currentWorkspace(current.cwd));
          if (proposalDraft)
            proposalDraft = { ...proposalDraft, checkoutCwd: tree.path };
          // The project's setup holds the first turn (and the queue) until it ends.
          const setupHolds = !!(tree.setup?.hold && tree.setup.run);
          // WP-138: the include note stays with this chat. The session row does not store it.
          const include = rememberWorktreeInclude(sessionId, tree);
          setSessions((prev) =>
            prev.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    worktreeCwd: tree.path,
                    branch: tree.branch ?? undefined,
                    workspaceMode: undefined,
                    worktreeBase: undefined,
                    worktreePreparing: setupHolds ? true : undefined,
                    ...(include.note ? { includeNote: include.note } : {}),
                    ...(include.warning ? { includeWarning: include.warning } : {}),
                  }
                : session,
            ),
          );
          notifyReviewChanged(sessionId);

          const branchMessage =
            harnessText || attachments.map((file) => file.name).join(", ");
          void generateBranchWithTextModel(
            pickTextHarness(current.harness),
            workCwd,
            branchMessage,
          )
            .then(async (fragment) => {
              const branch = fragment ? namedWorktreeBranch(fragment) : null;
              if (!branch) return;
              const renamed = await renameWorktreeBranch(
                current.cwd,
                tree.path,
                branch,
              );
              setSessions((prev) =>
                prev.map((session) =>
                  session.id === sessionId &&
                  pathKey(sessionWorkCwd(session)) === pathKey(tree.path)
                    ? { ...session, branch: renamed.branch ?? undefined }
                    : session,
                ),
              );
            })
            .catch(() => undefined);
          if (tree.setup) {
            await showWorktreeSetup(tree.setup, {
              emit: (event) => {
                enqueueHarnessEvent(sessionId, event);
                flushHarnessEvents();
              },
              cancelled: () => turnGen.current.get(sessionId) !== gen,
            });
            if (setupHolds)
              setSessions((prev) =>
                prev.map((session) =>
                  session.id === sessionId && session.worktreePreparing
                    ? { ...session, worktreePreparing: undefined }
                    : session,
                ),
              );
          }
        }
        launchTitleGeneration(workCwd);
        if (turnGen.current.get(sessionId) !== gen) return;
        if (proposalDraft && proposalId) {
          const settings = await discoverOrchestrationSettings();
          if (turnGen.current.get(sessionId) !== gen) return;
          proposalDraft = { ...proposalDraft, settings };
          const discovering = proposalDraft;
          setSessions((prev) =>
            prev.map((session) =>
              session.id === sessionId
                ? withOrchestrationProposal(session, proposalId, discovering)
                : session,
            ),
          );
        }
        let wrap: {
          from: HarnessId;
          to: HarnessId;
          text: string;
          portable?: boolean;
          /** WP-123: a fork's recap, worded as a fork's rather than a handoff's. */
          fork?: boolean;
        } | null = handoffCard
          ? {
              from: handoffCard.from,
              to: current.harness,
              text: handoffCard.brief,
            }
          : (queuedFork ?? queuedHandoff);
        if (pendingSwitch) {
          let agentText = "";
          if (
            shouldAskOutgoingAgent(current) &&
            isLiveHarness(pendingSwitch.from)
          ) {
            try {
              agentText = await requestOutgoingHandoff({
                harness: pendingSwitch.from,
                sessionId,
                cwd: workCwd,
                model: pendingSwitch.fromModel,
                modelSettings: pendingSwitch.fromSettings,
                providerAccountId: pendingSwitch.fromProviderAccountId,
                userRequest: text,
              });
            } catch {
              agentText = "";
            }
          }
          if (turnGen.current.get(sessionId) !== gen) return;
          const latest = sessionsRef.current.find((s) => s.id === sessionId);
          const brief = chooseHandoffBrief(agentText, latest ?? current, text);
          await forgetHarnessSession(pendingSwitch.from, sessionId);
          if (turnGen.current.get(sessionId) !== gen) return;
          wrap = { from: pendingSwitch.from, to: current.harness, text: brief };
        } else if (portableResume) {
          if (portableResume.from !== current.harness) {
            await forgetHarnessSession(portableResume.from, sessionId);
          }
          if (turnGen.current.get(sessionId) !== gen) return;
          wrap = {
            from: portableResume.from,
            to: current.harness,
            // Built now, not when the picker changed: output since the switch is in it.
            text: buildPortableTranscript(
              current.blocks,
              portableResume.messageIds,
            ),
            portable: true,
          };
        }

        const revealHandoff = (brief: string) => {
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId || !isPreparingHandoff(s)) return s;
              return { ...completeHandoff(s, brief), busy: true, idleCompacting: undefined };
            }),
          );
        };

        const planEventKey = planTurnKey(gen);
        let nativePlanSeen = false;
        let providerFailureSeen = false;
        // The provider's saved conversation was gone and this turn went on in a fresh one (claude.ts).
        let providerLost = false;
        const routePlanEvent = (event: HarnessEvent): HarnessEvent | null => {
          if (event.type === "session.error") providerFailureSeen = true;
          if (proposalDraft) {
            if (event.type === "message.delta") {
              proposalText = (proposalText + event.text).slice(-200_000);
              return null;
            }
            if (event.type === "message.completed") {
              proposalText += "\n";
              return null;
            }
            if (event.type === "plan") {
              nativeProposalText = event.append
                ? nativeProposalText + event.text
                : event.text;
              return null;
            }
          }
          if (intent !== "plan") return event;
          if (event.type === "plan") {
            nativePlanSeen = true;
            return {
              ...event,
              key: planEventKey,
            };
          }
          return event;
        };

        // WP-121: set once the provider has accepted the portable transcript.
        let portableDelivered = false;
        const pendingEditedEvents: HarnessEvent[] = [];
        const applyTurnEvent = (event: HarnessEvent) => {
          if (event.type === "session.providerLost") providerLost = true;
          orchestrator.observe(sessionId, event);
          // A finished assistant message is its own paragraph. One newline glues "rest.Six".
          if (options?.onSettled)
            controlText = appendControlEvent(controlText, event);
          if (event.type === "session.error")
            controlOutcome = withProviderFailure(controlOutcome, event);
          if (
            wrap &&
            (event.type === "session.started" ||
              event.type === "session.providerBound")
          ) {
            revealHandoff(wrap.text);
            // WP-121: the provider has the transcript. A later failure must not send it again.
            if (wrap.portable) portableDelivered = true;
          }
          nudgeOpenEditors(event, workCwd);
          if (!orchestrator.forSession(sessionId))
            trackSessionEdits(sessionId, workCwd, event);
          const routed = routePlanEvent(event);
          if (routed) enqueueHarnessEvent(sessionId, routed);
        };
        const routeTurnEvent = (event: HarnessEvent) => {
          if (turnGen.current.get(sessionId) !== gen) return;
          if (editedResend && !editedResend.isAccepted()) {
            pendingEditedEvents.push(event);
            return;
          }
          applyTurnEvent(event);
        };
        const acceptEditedResend = () => {
          if (!editedResend || editedResend.isAccepted()) return;
          flushSync(commitSubmittedTurn);
          editedResend.markAccepted();
          for (const event of pendingEditedEvents) applyTurnEvent(event);
          pendingEditedEvents.length = 0;
        };
        const recoverEditedResend = () => {
          if (!editedResend || editedResend.isAccepted()) return;
          pendingEditedEvents.length = 0;
          const previous = sessionsRef.current.find(
            (session) => session.id === sessionId,
          );
          const recovered = previous
            ? editedResend.recoverAfterFailure(previous)
            : undefined;
          flushSync(() => {
            setSessions((prev) =>
              prev.map((session) =>
                session.id === sessionId && recovered ? recovered : session,
              ),
            );
          });
        };

        const checkpointTurnId =
          !current.inboxAsk && !orchestrator.forSession(sessionId)
            ? await beginSessionTurn(
                sessionId,
                workCwd,
                sessionEditPaths(current.blocks),
              )
            : undefined;
        if (turnGen.current.get(sessionId) !== gen) {
          if (checkpointTurnId) {
            await finishSessionTurn(sessionId, workCwd, {
              turnId: checkpointTurnId,
            });
          }
          return;
        }
        let buildSucceeded = false;
        try {
          const prepared = await prepareAttachments(attachments);
          const prompt =
            intent === "build" && approvedPlan
              ? buildPlanPrompt(approvedPlan.text)
              : await preparePrompt(harnessText, {
                  harness: current.harness,
                  sessionId,
                  cwd: workCwd,
                });
          const turnPrompt = proposalDraft
            ? options?.orchestrationRetry?.response
              ? orchestrationRepairPrompt({
                  ...proposalDraft,
                  error: options.orchestrationRetry.error,
                  response: options.orchestrationRetry.response,
                })
              : orchestrationPlanningPrompt(
                  prompt,
                  proposalDraft.settings,
                  proposalDraft.checkoutCwd ?? proposalDraft.cwd,
                )
            : intent === "plan" && !rawCommand
              ? planTurnPrompt(prompt)
              : prompt;
          const earlier = queuedFork
            ? queuedFork.earlier
            : queuedHandoff
              ? userMessagesAfterHandoff(current)
              : [];
          if (editedResend && canRewindHarnessLastTurn(current.harness)) {
            try {
              await rewindHarnessLastTurn({
                harness: current.harness,
                sessionId,
                cwd: workCwd,
                model: current.model,
                modelSettings: current.modelSettings,
                providerAccountId,
                runtimeMode: current.runtimeMode,
                ephemeral: current.ephemeral === true,
                codexStore: mono ? "mono" : undefined,
                controlsAgents:
                  operatorAccess ||
                  orchestrator.run(sessionId)?.status === "active",
                ...firstMateLaunch(current),
                ...crewLaunch(current, crewRows()), // WP-143
                ...(editedProviderTurnId
                  ? { providerTurnId: editedProviderTurnId }
                  : {}),
                onEvent: (event) => {
                  if (turnGen.current.get(sessionId) !== gen) return;
                  enqueueHarnessEvent(sessionId, event);
                },
              });
            } catch (error) {
              flushHarnessEvents();
              editedResend.reject();
              throw error;
            }
            editedResend.markProviderRewound();
            flushHarnessEvents();
            if (turnGen.current.get(sessionId) !== gen) {
              const latest = sessionsRef.current.find(
                (session) => session.id === sessionId,
              );
              if (
                !latest ||
                (!latest.busy &&
                  latest.providerSessionId === current.providerSessionId)
              ) {
                await forgetHarnessSession(current.harness, sessionId);
                if (latest) {
                  setSessions((prev) =>
                    prev.map((session) =>
                      session.id === sessionId &&
                      session.providerSessionId === current.providerSessionId
                        ? { ...session, providerSessionId: undefined }
                        : session,
                    ),
                  );
                }
              }
              recoverEditedResend();
              return;
            }
          }
          const sendTurn = (text: string, turnAttachments = prepared) => {
            // WP-134b: a More agents chat runs on its entry through the route set here, never on the placeholder
            // CLI's own start. A refusal is not a success.
            if (current.registryAgentId) {
              const registryPlan = registrySendPlan({
                registryAgentId: current.registryAgentId,
                enabled: loadMoreAgentsEnabled(),
                agents: loadRegistryDocument().agents,
                busy: false,
              });
              if (registryPlan.action === "refuse") {
                routeTurnEvent({
                  type: "session.error",
                  message: registryPlan.sentence,
                  retryable: registryPlan.retryable,
                });
                return Promise.resolve();
              }
              if (registryPlan.action !== "prompt") {
                routeTurnEvent({ type: "session.error", message: AGENT_GONE, retryable: false });
                return Promise.resolve();
              }
              openMoreAgentSession(sessionId, registryPlan.agent.id);
            }
            return sendHarnessTurn({
              // WP-176: the caller's origin. Only the composer sets "person"; an omitted origin is automated.
              origin: options?.origin,
              harness: current.harness,
              sessionId,
              cwd: workCwd,
              model: current.model,
              modelSettings: current.modelSettings,
              providerAccountId,
              runtimeMode: current.runtimeMode,
              ephemeral: current.ephemeral === true,
              codexStore: mono ? "mono" : undefined,
              intent: intent === "orchestrate" ? "plan" : intent,
              // A /operator user turn enables app access for this thread;
              // orchestration leads retain their separate control access.
              controlsAgents:
                operatorAccess ||
                orchestrator.run(sessionId)?.status === "active",
              appAccess: operatorAccess,
              ...firstMateLaunch(current),
              ...crewLaunch(current, crewRows()), // WP-143
              text,
              attachments: turnAttachments,
              ...(editedResend ? { onAccepted: acceptEditedResend } : {}),
              // A conversation whose saved transcript is gone starts again from the chat's own brief.
              resumeFallback: (prompt) =>
                wrapRecoveredPrompt(
                  buildDeterministicHandoff(
                    sessionsRef.current.find((s) => s.id === sessionId) ??
                      current,
                    submittedText,
                  ),
                  prompt,
                ),
              onEvent: routeTurnEvent,
            });
          };
          let sendText = orchestrator.prompt(
            sessionId,
            inboxAskPrompt(
              rawCommand ? undefined : current.inboxAsk,
              wrap && !rawCommand
                ? wrap.portable
                  ? wrapPortableResume(
                      wrap.text,
                      wrap.from,
                      turnPrompt.trim() || CONTINUE_PROMPT,
                      earlier,
                    )
                  : wrap.fork
                    ? wrapForkPrompt(
                        wrap.text,
                        turnPrompt.trim() || CONTINUE_PROMPT,
                        earlier,
                      )
                    : wrapHandoffPrompt(
                        wrap.text,
                        wrap.from,
                        turnPrompt.trim() || CONTINUE_PROMPT,
                        earlier,
                      )
                : turnPrompt,
            ),
          );
          if (monoRotation) {
            if (current.harness === "codex" && current.providerSessionId) {
              await migrateMonoCodexSession({
                sessionId,
                threadId: current.providerSessionId,
                cwd: workCwd,
                providerAccountId,
              });
            }
            await forgetHarnessSession(current.harness, sessionId);
            const fresh = (session: Session) =>
              session.id === sessionId
                ? {
                    ...session,
                    providerSessionId: undefined,
                    context: undefined,
                  }
                : session;
            current = fresh(current);
            sessionsRef.current = sessionsRef.current.map(fresh);
            setSessions((prev) => prev.map(fresh));
            saveMonoRotation(sessionId, monoRotation.rotation);
          }
          // The agent's soul and memory live in its folder. A native session
          // is handed them once, and memory again only when it changes.
          const monoRecord = mono ? monoForSession(sessionId) : undefined;
          const agentLook = monoRecord ? monoLook(monoRecord) : undefined;
          const agentFiles = monoRecord
            ? await loadMonoFiles(monoRecord.id).catch(() => undefined)
            : undefined;
          // Who it is counts as part of its soul: a rename or a change to its
          // projects is handed over too, and so is a change to the fixed rules.
          // The delegate tool's rules come with the tool (hubMcp.ts): a change of harness hands them over again.
          const delegateTool = mono && hasDelegateTool(sessionId, current.harness);
          const handedFiles = agentFiles &&
            agentLook && {
              ...agentFiles,
              soulHash: `${agentFiles.soulHash}:${agentLook.name}:${agentLook.projects
                .map((project) => project.path)
                .join("|")}:${MONO_PROMPT_VERSION}${delegateTool ? ":delegate" : ""}:plain:${plainEnglishEndings() ? "1" : "0"}`,
            };
          const agentPlan = handedFiles
            ? planAgentContext(
                sessionId,
                current.providerSessionId,
                handedFiles,
              )
            : undefined;
          const handAgent = agentPlan ? agentPlan.soul : monoFirstTurn;
          // What the app adds to the user's message rather than them.
          const appContext: string[] = [];
          // r83 (P9): a standing rule in Ash's message to a Lead or coding-team chat is flagged with it, saved on turn one.
          const ruleNote =
            !rawCommand && (isCodingTeamChat(sessionId) || isProjectLeadId(monoForSession(sessionId)?.id ?? ""))
              ? standingRuleSendNote(turnPrompt)
              : undefined;
          if (ruleNote) appContext.push(ruleNote);
          if (options?.ashToWorker) appContext.push(ashWordsNote());
          if (monoRotation) {
            appContext.push(monoRotation.brief(sessionId));
          }
          // A long-chat Mono's fresh conversation opens on its tree's view, ahead of the message: the system prompt
          // stays as it is, so its cache holds (monoTreeStore.ts treeContext).
          // WP-51: a first mate past the size uses the same tree, even without "Keep one long chat".
          const treePick = pickSummaryTree({
            sessionId,
            mono: !!mono,
            teamId: team?.id,
            raw: !!rawCommand,
            hasProviderSession: !!current.providerSessionId,
            blocks: current.blocks,
            own: mono ? monoForSession(sessionId) : undefined,
            lead: team ? findMono(`${team.id}-lead`) : undefined,
          });
          if (treePick) {
            const treeNote = await treeContext(
              treePick.id,
              appCliCommand(await invoke<string | null>("app_cli_path")),
              treePick.evenWithoutSetting ? { evenWithoutSetting: true } : undefined,
            ).catch(() => undefined);
            if (treeNote) appContext.push(treeNote);
          }
          // Habit posts land in the chat outside any turn, so the Mono's
          // session has not seen them; the next message carries them once.
          const habitPosts = mono ? unseenHabitPosts(current.blocks) : [];
          if (habitPosts.length) {
            appContext.push(habitPostsContext(habitPosts));
          }
          // r66: Chief of Staff reads the live Mono list every turn (retired ones are off it), never from memory.
          const monosNow = mono && !rawCommand ? liveMonosNote(monoForSession(sessionId)?.id) : undefined;
          if (monosNow) appContext.push(monosNow);
          // On Claude Code the hub's note, soul and memory go on Claude Code's own system prompt (hubNote.ts); another
          // engine reads them ahead of the message. A memory change reaches a running Claude Code in the message.
          // WP-04: this is the engine alone; it used to ride on "has the Ash OS tools", which no chat has any more.
          const appended = appendsHubNote(current.harness, !!rawCommand);
          let notedMono = false;
          if (agentFiles && agentLook && agentPlan && handedFiles) {
            // WP-41: the contract is part of the note, and the key changes with the plain-English switch.
            // WP-156: the standing block is part of the key too, so a running chat picks up a change. A failed read keeps the previous token.
            const previousNote = hubNoteFor(sessionId)?.key;
            const readStanding = Boolean(agentPlan.soul || appended);
            let standingAnswers: string | undefined;
            let standingFailed = false;
            if (readStanding) {
              try {
                standingAnswers = (await leadStandingBlock(sessionId, readStandingBrief)) ?? "";
              } catch {
                standingFailed = true;
              }
            }
            const standingPart = readStanding
              ? standingKeyPart(standingFailed ? undefined : standingAnswers, previousNote)
              : undefined;
            let noteKey = `${handedFiles.soulHash}\nplain-english:${plainEnglishEndings() ? "1" : "0"}${standingPart !== undefined ? `\nstanding:${standingPart}` : ""}`;
            const fresh = appended ? previousNote !== noteKey : agentPlan.soul || agentPlan.memory;
            if (fresh && standingFailed) {
              standingAnswers = undefined;
              noteKey = `${handedFiles.soulHash}\nplain-english:${plainEnglishEndings() ? "1" : "0"}\nstanding:`;
            }
            if (fresh) {
              // A project Lead's fresh conversation starts on its project's memory and Ash's global one (hubMemoryPrimer.ts).
              const projectMemory = agentPlan.soul || appended
                ? await leadMemoryBlock(sessionId, current.harness).catch(() => undefined)
                : undefined;
              // WP-21: a Mono's turn is the first mate contract plus its soul.
              const note = monoTurnNote(agentLook, agentFiles, appended ? { soul: true, memory: true } : agentPlan, {
                delegate: delegateTool,
                cli: appCliCommand(await invoke<string | null>("app_cli_path")),
                ...(projectMemory ? { projectMemory } : {}),
                ...(standingAnswers ? { standingAnswers } : {}),
                // Every Mono but a Lead briefs project Leads (monoTeams.ts).
                ...(delegateTool && briefsLeads(monoForSession(sessionId)?.id ?? "")
                  ? {
                      teams: true,
                      leads: leadTargetsFor(monoForSession(sessionId)!.id, hubData().listProjects()).map(leadNoteName),
                    }
                  : {}),
              });
              if (appended) setHubNote(sessionId, { key: noteKey, text: note });
              else appContext.push(note);
              notedMono = true;
            } else if (appended && agentPlan.memory && !agentPlan.soul) {
              appContext.push(monoContext(agentLook, agentFiles, { soul: false, memory: true }));
            }
          }
          // A coding-team chat is told who it is and its project's memory once per conversation (codingTeamContext).
          // WP-156: the standing block is part of this key too. A failed read keeps the previous token.
          const teamBase =
            team && teamDelegates && !rawCommand
              ? `team:${team.id}:${team.folder}:${MONO_PROMPT_VERSION}:delegate:plain:${plainEnglishEndings() ? "1" : "0"}`
              : undefined;
          const previousTeam = hubNoteFor(sessionId)?.key;
          let teamStanding: string | undefined;
          let teamStandingFailed = false;
          if (teamBase) {
            try {
              teamStanding = (await leadStandingBlock(sessionId, readStandingBrief)) ?? "";
            } catch {
              teamStandingFailed = true;
            }
          }
          let teamStandingPart = teamBase
            ? standingKeyPart(teamStandingFailed ? undefined : teamStanding, previousTeam)
            : undefined;
          if (teamBase && teamStandingFailed && previousTeam !== `${teamBase}\nstanding:${teamStandingPart}`) {
            teamStanding = undefined;
            teamStandingPart = "";
          }
          const teamHanded = teamBase
            ? { soulHash: `${teamBase}\nstanding:${teamStandingPart}`, memoryHash: "" }
            : undefined;
          const teamPlan = teamHanded
            ? planAgentContext(sessionId, current.providerSessionId, teamHanded)
            : undefined;
          if (team && teamHanded && (appended ? hubNoteFor(sessionId)?.key !== teamHanded.soulHash : teamPlan?.soul)) {
            const projectMemory = await leadMemoryBlock(sessionId, current.harness).catch(() => undefined);
            const standingAnswers = teamStanding;
            const note = withFirstMateContract(codingTeamContext(
              {
                projectId: team.id,
                projectName: team.name,
                folder: team.folder!,
                leadName: leadSpecFor(team).name,
              },
              {
                ...(projectMemory ? { projectMemory } : {}),
                ...(standingAnswers ? { standingAnswers } : {}),
              },
            ));
            if (appended) setHubNote(sessionId, { key: teamHanded.soulHash, text: note });
            else appContext.push(note);
          }
          if (operatorCommand.matched || (handAgent && !notedMono)) {
            const cli = appCliCommand(await invoke<string | null>("app_cli_path"));
            appContext.push(
              `<monocode_app>\n${handAgent ? "App access is always enabled in this thread." : "The user's Operator command enables app access in this thread, including later turns without the command."} Run \`${cli} --help\` for its commands (sessions, worktrees, notes and more). Its credential is already in your environment; never print it.\n</monocode_app>`,
            );
          }
          // A Mono reads who it is ahead of the message, so it never takes it
          // for something the user pasted. A command must stay first.
          if ((mono || teamPlan?.soul) && !rawCommand) sendText = monoTurn(sendText, appContext);
          else if (appContext.length)
            sendText += `\n\n${appContext.join("\n\n")}`;
          // WP-51: reviewed memory rides in the turn, fenced as untrusted, never in the system prompt.
          if (!rawCommand) {
            const memoryMate =
              mono && monoForSession(sessionId)?.sessionId === sessionId
                ? monoForSession(sessionId)?.id
                : team
                  ? `${team.id}-lead`
                  : undefined;
            // WP-88: a Mono that reads every project recalls every mate's reviewed memory.
            // The soul file counts, the same way the tools do. A timeout still recalls nothing.
            const recallWide = (await turnRecallWide(monoForSession(sessionId), async () => {
              if (!agentFiles) throw new Error("unread");
              return agentFiles.soul;
            }))
              ? { everyMate: true as const, mateIds: listMonos().map((item) => item.id) }
              : undefined;
            // WP-99: one conversation shows each memory once; a compaction lets them all return.
            // WP-100: a fact an engine other than this chat's wrote is labelled with the engine that did.
            const recallScope = {
              sessionId,
              compacted: compactionCount(sessionsRef.current.find((s) => s.id === sessionId)?.blocks ?? current.blocks),
              // WP-111: a private chat is not given memory.
              private: (sessionsRef.current.find((s) => s.id === sessionId) ?? current).private === true,
            };
            const recallNote = await recalledFence(
              memoryMate,
              turnPrompt,
              recallWide ? { ...recallWide, ...recallScope } : recallScope,
              current.harness,
            );
            if (recallNote) sendText = `${sendText}\n\n${recallNote}`;
            // WP-83: opinions for a judgment call. Voice only when this turn drafts in the person's name.
            const profile = await profileNote(turnPrompt);
            if (profile) sendText = `${sendText}\n\n${profile}`;
          }
          await sendTurn(sendText);
          // WP-121: the turn was handed over, so the transcript is not sent again.
          if (wrap?.portable && !rawCommand) portableDelivered = true;
          if (teamHanded && teamPlan?.soul && !providerLost) {
            recordAgentContext(
              sessionId,
              sessionsRef.current.find((session) => session.id === sessionId)
                ?.providerSessionId ?? current.providerSessionId,
              teamHanded,
            );
          }
          // A fresh conversation after a lost one never got the soul and memory: leave them unrecorded so the next
          // turn hands them over again.
          if (agentFiles && !providerLost) {
            recordAgentContext(
              sessionId,
              sessionsRef.current.find((session) => session.id === sessionId)
                ?.providerSessionId ?? current.providerSessionId,
              handedFiles ?? agentFiles,
            );
          }
          acceptEditedResend();
          if (proposalDraft && !providerFailureSeen) {
            completedProposal = await completeOrRepairOrchestrationProposal(
              proposalDraft,
              nativeProposalText || proposalText,
              async (repairPrompt) => {
                proposalText = "";
                nativeProposalText = "";
                await sendTurn(repairPrompt, []);
                if (providerFailureSeen)
                  throw new Error(
                    controlOutcome.error ??
                      "The lead could not repair the proposal.",
                  );
                return nativeProposalText || proposalText;
              },
              () =>
                turnGen.current.get(sessionId) === gen &&
                !isProviderFailureText(nativeProposalText || proposalText),
              // WP-91: the graph is checked as the plan is read, so two tasks that could run at once on the same
              // files, or a plan with no verify task, are refused with the fix named.
              (nodes) => orchestrator.checkPlan(nodes),
            );
          }
          if (turnGen.current.get(sessionId) !== gen) return;
          if (wrap) {
            // Settle the ref too: the flush in `finally` rebuilds sessions from
            // it, and a stale ref would drop the consumed flag and resend the
            // recap with every later turn.
            sessionsRef.current = sessionsRef.current.map((s) => {
              if (s.id !== sessionId) return s;
              const ready = isPreparingHandoff(s)
                ? completeHandoff(s, wrap.text)
                : s;
              // A command owns its arguments; deliver the recap with the next chat prompt.
              return rawCommand
                ? ready
                : consumeForkPoint(consumeHandoff(ready));
            });
            setSessions(sessionsRef.current);
          }
          buildSucceeded = true;
        } catch (error: unknown) {
          recoverEditedResend();
          if (turnGen.current.get(sessionId) !== gen) return;
          if (wrap) revealHandoff(wrap.text);
          // WP-121: a timeout or a provider that never started is not the end of the switch.
          if (wrap?.portable && !portableDelivered && portableResume) {
            const resume = portableResume;
            const notice = current.midThread;
            sessionsRef.current = sessionsRef.current.map((session) =>
              session.id === sessionId
                ? restoreUnsentPortableResume(session, resume, notice, {
                    harness: current.harness,
                    model: current.model,
                  })
                : session,
            );
            setSessions(sessionsRef.current);
          }
          const message =
            error instanceof Error
              ? error.message
              : String(error) || `${current.harness} adapter failed`;
          controlOutcome.error = message;
          if (!providerFailureSeen) {
            enqueueHarnessEvent(sessionId, {
              type: "session.error",
              message,
            });
          }
          providerFailureSeen = true;
        } finally {
          // A failed provider can leave its process writing after the event
          // stream ends. Stop it before recording the final workspace state.
          if (providerFailureSeen && turnGen.current.get(sessionId) === gen) {
            await stopHarnessSession(current.harness, sessionId).catch(
              () => undefined,
            );
          }
          if (checkpointTurnId) {
            await finishSessionTurn(sessionId, workCwd, {
              turnId: checkpointTurnId,
            });
          }
          if (turnGen.current.get(sessionId) !== gen) return;
          flushHarnessEvents();
          controlOutcome = {
            status:
              providerFailureSeen ||
              isProviderFailureText(controlText) ||
              !buildSucceeded
                ? "failed"
                : "completed",
            text: controlText.trim(),
            ...(providerFailureSeen ? providerFailureOf(controlOutcome) : {}),
          };
          await flushSessionCheckpoint(sessionId);
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sessionId) return s;
              const stopped = stopStreaming(s);
              const providerFailed =
                providerFailureSeen ||
                isProviderFailureText(lastAssistantTextInTurn(stopped));
              const finalized =
                proposalDraft && proposalId
                  ? withOrchestrationProposal(
                      stopped,
                      proposalId,
                      completedProposal && !providerFailed && buildSucceeded
                        ? completedProposal
                        : completeOrchestrationProposal(
                            proposalDraft,
                            nativeProposalText || proposalText,
                            providerFailed || !buildSucceeded
                              ? (controlOutcome.error ??
                                  "The lead could not finish planning.")
                              : undefined,
                          ),
                    )
                  : intent === "plan" && !nativePlanSeen && !providerFailed
                    ? promoteLastAssistantToPlan(stopped, planEventKey)
                    : stopped;
              return approvedPlan && intent === "build"
                ? withPlanStatus(
                    finalized,
                    approvedPlan.id,
                    buildSucceeded && !providerFailed ? "built" : "ready",
                  )
                : finalized;
            }),
          );
          // A worktree removed outside the app fails every turn. Detach the
          // session as an in-app removal would, so it can pick a new checkout.
          const worktreePath = current.worktreeCwd;
          if (providerFailureSeen && worktreePath) {
            void worktreeDeletedExternally(worktreePath)
              .then((deleted) => {
                if (!deleted || switchingWorktrees.current.has(sessionId))
                  return;
                // Through the ref too, or a pending event flush puts it back.
                sessionsRef.current = sessionsRef.current.map((s) =>
                  s.id === sessionId &&
                  !s.busy &&
                  !s.worktreeRemoved &&
                  s.worktreeCwd === worktreePath
                    ? detachSessionWorktree(s, s.cwd, worktreePath)
                    : s,
                );
                setSessions(sessionsRef.current);
              })
              .catch(() => undefined);
          }
          // WP-164: a turn that failed is announced as a failure, which quiet hours never hold.
          const turnFailed = controlOutcome.status === "failed";
          // Next tick: the flush above has rendered by then, so the banner
          // quotes the reply's final text rather than the previous batch.
          window.setTimeout(() => {
            const finished = sessionsRef.current.find(
              (s) => s.id === sessionId,
            );
            const visible = sessionId === activeSessionIdRef.current;
            // A habit's hidden run speaks through its Mono's chat instead; an answer to the checker stays quiet.
            if (finished && !isHabitRun(sessionId) && !inCheckTurn(finished))
              void announceSessionFinished(finished, visible, turnFailed);
          }, 0);
          notifyReviewChanged(sessionId);
          notifyGitChanged();
          nudgeWorkspace(workCwd);
          nudgeWatchedFiles();
          window.setTimeout(() => nudgeWatchedFiles(), 150);
        }
      })()
        .catch((error: unknown) => {
          controlOutcome = {
            status: "failed",
            text: controlText,
            error: error instanceof Error ? error.message : String(error),
          };
          if (turnGen.current.get(sessionId) === gen) {
            enqueueHarnessEvent(sessionId, {
              type: "session.error",
              message: controlOutcome.error!,
            });
            flushHarnessEvents();
            setSessions((prev) =>
              prev.map((session) => {
                if (session.id !== sessionId) return session;
                const stopped = {
                  ...stopStreaming(session),
                  worktreePreparing: undefined,
                };
                return proposalId && proposalDraft
                  ? withOrchestrationProposal(
                      stopped,
                      proposalId,
                      completeOrchestrationProposal(
                        proposalDraft,
                        "",
                        controlOutcome.error,
                      ),
                    )
                  : stopped;
              }),
            );
          }
        })
        .finally(() => {
          editedResend?.reject();
          if (editedResend) editedResends.finish(sessionId);
          options?.onSettled?.(
            turnGen.current.get(sessionId) !== gen
              ? { status: "cancelled", text: controlText }
              : controlOutcome,
          );
        });
      return true;
    },
    [
      applyProjectLocationChange,
      dismissNoticesForContinuedSession,
      enqueueHarnessEvent,
      flushHarnessEvents,
    ],
  );
  submitAfterProjectSyncRef.current = submitSession;
  // Interactive callers use the immediate result to clear their composer. The
  // queued-launch receiver uses submitSession to await the actual acceptance.
  const onSubmit = useCallback(
    (...args: Parameters<Submit>): boolean => {
      // Reject before async preparation can make the composer clear its draft.
      if (workspaceNavigation.isSwitching(args[0])) return false;
      const result = submitSession(...args);
      if (typeof result === "boolean") return result;
      // Deferred errors have already been displayed by submitAfterProjectSync.
      void result.catch(() => undefined);
      return true;
    },
    [submitSession],
  );

  // The composer's own send is the person's turn for the spend gate. Other callers of onSubmit are automated.
  const onComposerSubmit = useCallback(
    (sessionId: string, text: string, attachments: Attachment[] = [], options?: ComposerTurnOptions): boolean =>
      onSubmit(sessionId, text, attachments, { ...options, origin: "person" }),
    [onSubmit],
  );

  /**
   * The bench's way into a Mono's chat (below): open the Mono as Ash's click does, then the chat to type into, which is
   * the Mono's own. While its chat loads, something else at startup (a tab the window restores) can take the view, which
   * leaves the view empty or on another chat; the message still goes to the Mono it was meant for.
   */
  const openVerifyMonoChat = useCallback(
    async (monoId: string) => {
      await onOpenMono(monoId);
      const view = monoViewIdRef.current;
      const own = findMono(monoId)?.sessionId ?? null;
      return { view, own, chat: own ?? view };
    },
    [onOpenMono],
  );

  // The fake-Claude test bench (scripts/hub-verify-live.mjs): a dev copy with a verify plan opens a Mono on the plan's
  // scratch project and sends its first message, once per run. No plan reaches the daily app (src/verify_live.rs).
  const verifyKickoffStarted = useRef(false);
  const verifyKickoffNoted = useRef(false);
  useEffect(() => {
    if (verifyKickoffStarted.current) return;
    if (windowTransfer) {
      traceVerifyKickoff("held-by-window-transfer");
      return;
    }
    const kickoff = pendingVerifyKickoff();
    if (!kickoff) {
      // A plan whose kickoff this window won't send (already claimed by an earlier launch of the run, or none).
      if (!verifyKickoffNoted.current && verifyRun()) traceVerifyKickoff("not-pending");
      verifyKickoffNoted.current = true;
      return;
    }
    verifyKickoffStarted.current = true;
    claimVerifyKickoff(kickoff.runId);
    traceVerifyKickoff("claimed", { monoId: kickoff.monoId ?? null, project: kickoff.project });
    // Each change in what the window knows of the Mono it waits for, so a kickoff that never goes says why.
    let seen = "";
    void verifyKickoffMono(kickoff, {
      create: (project, name) => {
        const mono = createMono([project]);
        saveMonoName(mono.id, name);
        return mono.id;
      },
      // A plan naming an existing Mono waits until the hub has tied it to the project.
      ready: (monoId, project) => {
        const mono = findMono(monoId);
        const state = JSON.stringify({ found: !!mono, projects: mono?.projects ?? [], monos: listMonos().length });
        if (state !== seen) {
          seen = state;
          traceVerifyKickoff("mono-state", JSON.parse(state) as Record<string, unknown>);
        }
        return !!mono && monoWorksOn(mono, project);
      },
    }).then(async (monoId) => {
      if (!monoId) {
        traceVerifyKickoff("gave-up", { seen });
        console.error(`verify kickoff: ${kickoff.monoId} never worked on ${kickoff.project}`);
        return;
      }
      traceVerifyKickoff("opening", { monoId });
      const { view, own, chat } = await openVerifyMonoChat(monoId);
      // "sending-to-mono-chat": the open lost the view to something else, so the send names the Mono's chat itself.
      traceVerifyKickoff(!chat ? "no-chat-open" : chat === view ? "sending" : "sending-to-mono-chat", {
        monoId,
        view,
        monoChat: own,
      });
      if (chat) onSubmit(chat, kickoff.prompt);
    });
  }, [openVerifyMonoChat, onSubmit, windowTransfer]);
  // ...and Ash's messages the bench sends mid-run (WP-04: the plan's messages file, verify_live.rs): each into its Mono's chat, as
  // he would type it there, once per run.
  useEffect(() => {
    const runId = verifyRun();
    if (!runId || windowTransfer) return;
    return watchVerifyMessages(runId, {
      list: () => invoke("verify_live_messages"),
      send: async (message) => {
        // Into a group room, as Ash writes there (hub/model/roomConductor.ts).
        if (message.room) return sendVerifyRoomMessage(message.room, message.prompt);
        // A new chat in a project's coding team, as Ash starts one there.
        if (message.codingTeam) {
          const sessionId = startCodingTeamChat(message.codingTeam);
          if (!sessionId) throw new Error(`no coding team for ${message.codingTeam}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          onSubmit(sessionId, message.prompt);
          return;
        }
        // A new Mono of Ash's own (New mono), on a project or none, and its first message.
        if (message.newMono) {
          const mono = createMono(message.newMono.project ? [message.newMono.project] : []);
          saveMonoName(mono.id, message.newMono.name);
          const { chat } = await openVerifyMonoChat(mono.id);
          if (!chat) throw new Error(`no chat for the new Mono ${message.newMono.name}`);
          onSubmit(chat, message.prompt);
          return;
        }
        const { chat } = await openVerifyMonoChat(message.monoId);
        if (!chat) throw new Error(`no chat for ${message.monoId}`);
        onSubmit(chat, message.prompt);
      },
    });
  }, [openVerifyMonoChat, onSubmit, startCodingTeamChat, windowTransfer]);

  // onApproval is created once; it reaches the current helper through this.
  const decideMonoBlockRef = useRef<
    (
      monoId: string,
      blockId: string,
      decided: "allow" | "deny" | "cancelled",
    ) => void
  >(() => {});
  /** Adds a block to a Mono's chat outside any turn, once no reply is streaming. */
  const appendToMono = (
    monoId: string,
    block: Block | Block[],
    then?: (mono: Session) => void,
    attempt = 0,
  ) => {
    const added = Array.isArray(block) ? block : [block];
    const mono = sessionsRef.current.find((session) => session.id === monoId);
    if (!mono) return;
    if (mono.busy && attempt < 120) {
      window.setTimeout(
        () => appendToMono(monoId, added, then, attempt + 1),
        5_000,
      );
      return;
    }
    const next: Session = { ...mono, blocks: [...mono.blocks, ...added] };
    sessionsRef.current = sessionsRef.current.map((session) =>
      session.id === monoId ? next : session,
    );
    setSessions(sessionsRef.current);
    persistSession(next);
    then?.(next);
  };
  const decideMonoBlock = (
    monoId: string,
    blockId: string,
    decided: "allow" | "deny" | "cancelled",
  ) => {
    const decide = (session: Session) =>
      session.id === monoId
        ? {
            ...session,
            blocks: session.blocks.map((block) =>
              block.id === blockId && block.approval
                ? { ...block, approval: { ...block.approval, decided } }
                : block,
            ),
          }
        : session;
    sessionsRef.current = sessionsRef.current.map(decide);
    setSessions(sessionsRef.current);
    persistSession(
      sessionsRef.current.find((session) => session.id === monoId),
    );
  };
  decideMonoBlockRef.current = decideMonoBlock;

  useMonoHabits({
    sessions: () => sessionsRef.current,
    open: async (id) => (await ensureOpenSession(id)) ?? undefined,
    add: (session) => {
      sessionsRef.current = [...sessionsRef.current, session];
      setSessions(sessionsRef.current);
    },
    run: (id, prompt) =>
      new Promise((resolve) => {
        void submitWithSettlement({
          submit: (onSettled) => submitSession(id, prompt, [], { onSettled }),
          onSettled: resolve,
          rejectionMessage: "The habit's run could not start.",
        });
      }),
    remove: async (id) => {
      const open = await stopSessionForRemoval(id);
      if (open)
        await Promise.all(
          sessionChildHarnesses(open).map((harness) =>
            forgetHarnessSession(harness, id),
          ),
        );
      await deleteSession(id, []);
      sessionsRef.current = sessionsRef.current.filter(
        (session) => session.id !== id,
      );
      setSessions(sessionsRef.current);
    },
    post: (monoId, habit, text, name, artifacts, launches, cards) =>
      appendToMono(
        monoId,
        [
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text,
            monoHabit: { id: habit.id, name: habit.name, at: Date.now() },
            ...(artifacts?.length ? { artifactCards: artifacts } : {}),
            ...(launches?.length ? { monoSpawnedSessions: launches } : {}),
          },
          ...(cards ?? []).map((card) => ({
            id: crypto.randomUUID(),
            role: "assistant" as const,
            text: monoCardText(card),
            monoCard: card,
            monoHabit: { id: habit.id, name: habit.name, at: Date.now() },
          })),
        ],
        (posted) => {
          monoReplies.noteReply(monoId);
          void announceSessionFinished(
            { ...posted, title: name },
            monoId === activeSessionIdRef.current,
          );
        },
      ),
    // The chat shows it like any approval, and the usual approval banner
    // fires for the Mono; the answer is routed back in onApproval.
    askApproval: (monoId, habit, runId, block) => {
      const blockId = crypto.randomUUID();
      const requestId = relayApproval({
        monoId,
        runId,
        requestId: block.approval!.requestId,
        blockId,
      });
      appendToMono(monoId, {
        id: blockId,
        role: "approval",
        text: block.text,
        ...(block.tool ? { tool: block.tool } : {}),
        approval: { requestId, at: Date.now() },
        monoHabit: { id: habit.id, name: habit.name, at: Date.now() },
      });
    },
    endApprovals: (runId) => {
      for (const relay of dropRelays(runId))
        decideMonoBlock(relay.monoId, relay.blockId, "cancelled");
    },
  }, appPolicy().habits && !shipHold);

  const automationSessionReservations = useRef(new Set<string>());
  const automationRecoveryRef = useRef<Promise<void> | null>(null);
  const automationRecoveryCutoffRef = useRef(Date.now());

  const launchAutomation = useCallback(
    async (
      automation: Automation,
      run: AutomationRun,
      reveal = false,
      prompt = run.prompt ?? automation.prompt,
      sourceWorkItem?: LinkedWorkItem,
    ) => {
      let reservationId: string | undefined;
      let releaseAfterSettle = false;
      const releaseReservation = () => {
        if (!reservationId) return;
        automationSessionReservations.current.delete(reservationId);
        reservationId = undefined;
      };
      try {
        const eventRun = run.trigger === "event";
        const linkedWorkItem =
          sourceWorkItem ?? linkedWorkItemFromAutomationEvent(run);
        let session =
          automation.reuseSession && automation.lastSessionId
            ? sessionsRef.current.find(
                (entry) =>
                  entry.id === automation.lastSessionId &&
                  entry.harness === automation.harness &&
                  !entry.busy &&
                  !entry.worktreeRemoved &&
                  !automationSessionReservations.current.has(entry.id) &&
                  (automation.workspaceMode === "current"
                    ? entry.workspaceMode !== "worktree" &&
                      !entry.worktreeCwd &&
                      pathKey(entry.cwd) === pathKey(automation.cwd)
                    : automation.workspaceMode === "existing"
                      ? pathKey(sessionWorkCwd(entry)) ===
                        pathKey(automation.worktreeCwd ?? "")
                      : false),
              )
            : undefined;

        if (!session) {
          session = {
            ...newSession(
              automation.harness,
              automation.cwd,
              automation.model,
              automation.runtimeMode,
              automation.modelSettings,
            ),
            title: eventRun
              ? HARNESS_LABEL[automation.harness]
              : formatSessionTitle(automation.harness, automation.name),
            automationId: automation.id,
            ...(linkedWorkItem ? { linkedWorkItem } : {}),
            ...(automation.workspaceMode === "worktree"
              ? { workspaceMode: "worktree" as const, worktreeBase: "HEAD" }
              : automation.workspaceMode === "existing" &&
                  automation.worktreeCwd
                ? { worktreeCwd: automation.worktreeCwd }
                : {}),
          };
          const nextSessions = [...sessionsRef.current, session];
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
          const tab = newTab(session.id);
          appendTab(tab, automation.cwd);
          if (reveal) {
            setActiveTabId(tab.id);
            setComposerFocused(false);
          }
        } else {
          const stamped = {
            ...session,
            automationId: automation.id,
            model: automation.model,
            modelSettings: automation.modelSettings ?? {},
            runtimeMode: automation.runtimeMode,
            ...(linkedWorkItem ? { linkedWorkItem } : {}),
          };
          session = stamped;
          const nextSessions = sessionsRef.current.map((entry) =>
            entry.id === stamped.id ? stamped : entry,
          );
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
          if (reveal) {
            focusOpenSession(session.id);
          }
        }

        reservationId = session.id;
        automationSessionReservations.current.add(session.id);

        if (automation.sessionFolderId && looksLikeProject(automation.cwd)) {
          saveSessionFolders(
            automation.cwd,
            placeSessionInFolder(
              loadSessionFolders(automation.cwd),
              session.id,
              { kind: "existing", folderId: automation.sessionFolderId },
            ),
          );
        }

        if (reveal) {
          setSearchViewOpen(false);
          setInboxViewOpen(false);
          setNotesViewOpen(false);
          setAutomationsViewOpen(false);
          setSidebarTab("sessions", session.cwd);
        }

        await updateAutomationRun(run.id, "running", {
          sessionId: session.id,
        });
        // From here the settlement callback owns reservation cleanup, including
        // a rejected submission that never starts an agent turn.
        releaseAfterSettle = true;
        await submitWithSettlement({
          submit: (onSettled) =>
            submitSession(session.id, prompt, [], {
              refreshTitle: eventRun,
              onSettled,
            }),
          rejectionMessage:
            "The selected agent session could not start this run.",
          onSettled: (outcome) => {
            const status =
              outcome.status === "completed"
                ? "succeeded"
                : outcome.status === "cancelled"
                  ? "cancelled"
                  : "failed";
            void updateAutomationRun(run.id, status, {
              sessionId: session.id,
              ...(outcome.error ? { error: outcome.error } : {}),
            })
              .catch(() => undefined)
              .finally(releaseReservation);
          },
        });
      } catch (reason: unknown) {
        await updateAutomationRun(run.id, "failed", {
          error: reason instanceof Error ? reason.message : String(reason),
        }).catch(() => undefined);
        throw reason;
      } finally {
        if (!releaseAfterSettle) releaseReservation();
      }
    },
    [appendTab, focusOpenSession, submitSession],
  );

  const queueMonoSessionCompletion = useCallback(
    async (
      monoId: string,
      message: QueuedMessage,
      current: () => QueuedMessage | undefined = () => message,
    ) => {
      // A worker's report goes to the chat Ash talks to that started it: a Mono's, or a coding-team chat.
      if (!isOrchestratorChat(monoId) || removingSessionIds.current.has(monoId))
        return;
      if (
        !(await ensureOpenSession(monoId)) ||
        removingSessionIds.current.has(monoId)
      )
        return;
      setSessions((previous) => {
        const latest = current();
        return latest
          ? previous.map((session) =>
              session.id === monoId
                ? enqueueMonoSessionCompletion(session, latest)
                : session,
            )
          : previous;
      });
    },
    [ensureOpenSession],
  );
  const queueMonoSessionCompletionRef = useRef(queueMonoSessionCompletion);
  queueMonoSessionCompletionRef.current = queueMonoSessionCompletion;
  // WP-60: a remote project's result lands in the chat that started it, once.
  useEffect(
    () =>
      bindRemoteReports({
        isOrchestrator: isOrchestratorChat,
        isRemoving: (id) => removingSessionIds.current.has(id),
        ensureOpen: (id) => ensureOpenSession(id),
        place: (entry) => {
          let placed = false;
          updateSessionState(sessionsRef, setSessions, (current) => {
            const next = placeRemoteReport(current, entry);
            placed = next.placed;
            return next.sessions;
          });
          return placed;
        },
      }),
    [ensureOpenSession],
  );
  const monoCompletionBatches = useRef<MonoSessionCompletionBatches | null>(
    null,
  );
  if (!monoCompletionBatches.current) {
    monoCompletionBatches.current = new MonoSessionCompletionBatches(
      async (monoId, message, current, requestIds) => {
        // The rows learn which message carries their reports before it enters the queue.
        await delegationsRef.current?.queued(monoId, requestIds, message.id);
        return queueMonoSessionCompletionRef.current(monoId, message, current);
      },
    );
  }
  const delegations = useDelegations({
    sessions,
    sessionsRef,
    openSession: ensureOpenSession,
    queueReport: (monoId, message) =>
      queueMonoSessionCompletionRef.current(monoId, message),
    quitting: isAppQuitting,
    // r84 (s14): the worker Ash answered finishes in a resumed turn; its changes land like a first report's.
    land: async (result) => {
      const landing = landingDue(result, sessionsRef.current.find((session) => session.id === result.sessionId));
      return landing ? withLanding(result, await landWorkerCopy(landing)) : result;
    },
    // WP-13: a failed task is recorded from the CLI the child actually ran.
    crewFailure: (row, result) => {
      const child = sessionsRef.current.find((session) => session.id === row.childSession);
      return recordCrewFailure(
        row,
        result,
        {
          cli: child?.harness,
          model: child?.model,
          effort: child?.modelSettings?.effort,
        },
        row.project ? hubProjectFolder(row.project) : undefined,
      );
    },
  });
  delegationsRef.current = delegations;
  // Briefs queued behind or steered into a busy chat, and leadership briefs to a Lead: reported by watching the chat.
  useFollowedBriefs({
    tracker: delegations,
    sessions,
    sessionsRef,
    // A Lead asked for its report on its own (a message steered into its last turn on the brief): like a report.
    ask: (chatId, message) => queueMonoSessionCompletionRef.current(chatId, message),
    // r78: a Lead or coding-team chat that listed Ash's asks and started no worker is asked to start them.
    startsWorkers: (chatId) => isCodingTeamChat(chatId) || isProjectLeadId(monoForSession(chatId)?.id ?? ""),
    // "Still running: N" when a Lead says it's done with work it delegated still out (monos/model/leadFlow.ts).
    note: (chatId, block) =>
      setSessions((previous) =>
        previous.map((session) =>
          session.id === chatId && !session.blocks.some((entry) => entry.id === block.id)
            ? { ...session, blocks: [...session.blocks, block] }
            : session,
        ),
      ),
    renote: (chatId, block) =>
      setSessions((previous) =>
        previous.map((session) =>
          session.id === chatId && session.blocks.some((entry) => entry.id === block.id)
            ? { ...session, blocks: session.blocks.map((entry) => (entry.id === block.id ? block : entry)) }
            : session,
        ),
      ),
    unnote: (chatId, blockId) =>
      setSessions((previous) =>
        previous.map((session) =>
          session.id === chatId && session.blocks.some((entry) => entry.id === blockId)
            ? { ...session, blocks: session.blocks.filter((entry) => entry.id !== blockId) }
            : session,
        ),
      ),
    onLeadReport: ({ row, receipt, report, answer }) =>
      row.project && row.ownerMono
        ? postLeadReport({
            receipt,
            projectId: row.project,
            leadChat: row.childSession,
            ownerMono: row.ownerMono,
            title: row.title ?? "",
            report,
            answer,
          })
        : undefined,
  });
  // Double delegation: a leadership Mono's brief goes into the Lead's own long-running chat, as a followed row with the
  // leadership Mono as owner (leadershipDelegation.ts, followedBriefs.ts).
  useEffect(
    () =>
      setLeadDelegator(async (input) => {
        const tracker = delegationsRef.current;
        if (!tracker) throw new Error("Delegations are still loading; try again in a moment");
        const from = findMono(input.fromMonoId);
        const ownerSession = input.ownerSession ?? from?.sessionId;
        if (!from || !ownerSession) throw new Error("Brief a Lead from your own chat.");
        const lead = await ensureMonoSession(input.target.leadId, {
          home: homeDir,
          load: (id) => ensureOpenSessionRef.current(id),
          create: (path) => newDefaultSession(path),
          add: (created) => {
            sessionsRef.current = [...sessionsRef.current, created];
            setSessions(sessionsRef.current);
          },
        });
        if (!lead) throw new Error(`${input.target.leadName}'s chat isn't available.`);
        // The chat exists now, so judge the CLI it will run before the brief is launched.
        await refuseBriefedLeadHarness(lead, input.target, input.fromMonoId, crewPolicyInForce);
        const fromName = monoLook(from).name;
        const text =
          typeof input.brief === "string"
            ? leadBriefPrompt(fromName, input.brief, input.goal)
            : formatLeadBrief(fromName, input.brief);
        const requestId = input.requestId ?? `app-${ownerSession}-lead-${crypto.randomUUID()}`;
        const launch = tracker.launch({
          ownerSession,
          ownerMono: from.id,
          requestId,
          childSession: lead.id,
          project: input.target.projectId,
          title:
            input.title ??
            (typeof input.brief === "string" ? input.brief : input.brief.outcome).split("\n")[0].slice(0, 200),
          brief: text,
          ...(input.goal ? { goal: input.goal } : {}),
          ...(input.askIds?.length ? { askIds: input.askIds } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
          follow: "lead",
          by: `owner:${ownerSession}`,
        });
        const row = await launch.row;
        if (!row) throw new Error("The brief couldn't be stored, so it wasn't sent.");
        const current = sessionsRef.current.find((s) => s.id === lead.id) ?? lead;
        // A retried brief that already went in (or waits) is not sent twice.
        if (briefSentAt(row, current) >= 0) return { taskId: row.id, childSessionId: lead.id, delivery: "started" as const };
        if (briefWaiting(row, current)) return { taskId: row.id, childSessionId: lead.id, delivery: "queued" as const };
        const delivery = deliveryFor(
          current,
          input.mode ?? "queue",
          isLiveHarness(current.harness) && canSteerHarness(current.harness) && !current.registryAgentId,
        );
        const accepted = await submitSessionRef.current(lead.id, text, [], {
          appRequestId: requestId,
          followsUp: true,
          ...(delivery === "started"
            ? {}
            : { followUpBehavior: delivery === "steered" ? "steer" : "queue" }),
          ...(delivery === "queued" ? { waitForIdle: true } : {}),
        });
        if (!accepted) {
          launch.refuse();
          throw new Error(`${input.target.leadName} couldn't take the brief right now.`);
        }
        return { taskId: row.id, childSessionId: lead.id, delivery };
      }),
    [],
  );
  const prWatches = usePrWatches({
    sessionsRef,
    queueWake: (monoId, message) =>
      queueMonoSessionCompletionRef.current(monoId, message),
  });
  prWatchesRef.current = prWatches;
  firstMateWakesRef.current = useFirstMateWakes({
    sessionsRef,
    queueWake: (ownerId, message) =>
      queueMonoSessionCompletionRef.current(ownerId, message),
  });
  // WP-160: the First Mate's lead tick, while the app is open.
  useLeadTick({
    sessions: () => sessionsRef.current,
    open: async (id) => (await ensureOpenSession(id)) ?? undefined,
    openRows: () => openDelegationRows(),
  });
  const prWatchVersion = useSyncExternalStore(
    prWatches.subscribe,
    prWatches.snapshot,
  );
  // A long-chat Mono's finished turns go into its summary tree, in the background (monoTreeStore.ts).
  useMonoTrees(sessions, IS_HUB_BUNDLE);
  // WP-51: after a first mate's turn, one unreviewed fact or a skill proposal.
  useMemoryCurator(sessions, IS_HUB_BUNDLE);
  // The checker's notes reach the chats that own Ash's messages, one quiet turn when each is idle (hub/model/hubChecks.ts).
  useHubChecks(
    {
      sessions,
      sessionsRef,
      openSession: ensureOpenSession,
      openMono: (monoId) =>
        ensureMonoSession(monoId, {
          home: homeDir,
          load: (id) => ensureOpenSession(id),
          create: (path) => newDefaultSession(path),
          add: (created) => updateSessionState(sessionsRef, setSessions, (current) => [...current, created]),
        }),
      submit: (sessionId, text, options) => submitSession(sessionId, text, [], options),
      openJobs: (sessionId) =>
        (delegationsRef.current?.known() ?? [])
          .filter((row) => row.ownerSession === sessionId && !row.follow && isOpenDelegation(row))
          .map((row) => row.title || "its job"),
    },
    IS_HUB_BUNDLE,
  );
  useEffect(() => {
    monoCompletionBatches.current!.closeInactive(({ monoId, turn }) => {
      const mono = sessionsRef.current.find((session) => session.id === monoId);
      return !!mono?.busy && turnGen.current.get(monoId) === turn;
    });
  }, [sessions]);

  const launchQuickSession = useCallback(
    (
      launch: QuickLaunch,
      deliveryId: string,
      placement?: AppSessionPlacement,
      onSettled?: (outcome: ControlOutcome) => void,
      openTab?: boolean,
    ) =>
      acceptQuickLaunch(
        launch,
        deliveryId,
        {
          getSessions: () => sessionsRef.current,
          updateSessions: (update) => {
            sessionsRef.current = update(sessionsRef.current);
            // Compose with submission's queued transcript updates.
            setSessions(update);
          },
          appendTab,
          placeSession: (sessionId, target, cwd) => {
            const anchor = sessionsRef.current.find(
              (session) => session.id === target.besideSessionId,
            );
            const tab = tabsRef.current.find((entry) =>
              leafIds(entry.layout).includes(target.besideSessionId),
            );
            if (!anchor || !sameProjectPath(anchor.cwd, cwd) || !tab)
              throw new Error(
                "The target session must be open in this project",
              );
            const nextTabs = tabsRef.current.map((entry) =>
              entry.id === tab.id
                ? {
                    ...entry,
                    layout: splitPane(
                      entry.layout,
                      target.besideSessionId,
                      target.direction,
                      sessionId,
                    ),
                    focusedId: launch.reveal ? sessionId : entry.focusedId,
                    diffFocused: launch.reveal ? false : entry.diffFocused,
                  }
                : entry,
            );
            tabsRef.current = nextTabs;
            setTabs(nextTabs);
            return tab.id;
          },
          setProjectCwd,
          setRecents,
          revealTab: (id, cwd) => {
            setActiveTabId(id);
            setComposerFocused(false);
            setSearchViewOpen(false);
            setInboxViewOpen(false);
            setNotesViewOpen(false);
            setAutomationsViewOpen(false);
            setSidebarTab("sessions", cwd);
          },
          submit: (id, text, attachments, options) =>
            onSettled
              ? submitWithSettlement({
                  submit: (settle) =>
                    submitSession(id, text, attachments, {
                      ...options,
                      origin: "person",
                      appRequestId: deliveryId,
                      onSettled: settle,
                    }),
                  onSettled,
                  rejectionMessage: "The monitored session could not start.",
                })
              : submitSession(id, text, attachments, { ...options, origin: "person" }),
          saveDraft: (id, prompt, attachments, requestId) =>
            flushSync(() => onSaveDraft(id, prompt, attachments, requestId)),
        },
        placement,
        openTab,
      ),
    [appendTab, submitSession, onSaveDraft],
  );
  useQuickComposerLaunches(launchQuickSession);
  const launchQuickSessionRef = useRef(launchQuickSession);
  launchQuickSessionRef.current = launchQuickSession;
  const submitSessionRef = useRef(submitSession);
  submitSessionRef.current = submitSession;
  const saveDraftRef = useRef(onSaveDraft);
  saveDraftRef.current = onSaveDraft;
  const ensureOpenSessionRef = useRef(ensureOpenSession);
  ensureOpenSessionRef.current = ensureOpenSession;
  // WP-150: inbox, crew status, and one tool call. Refused in Rust when phone access is off.
  const mobileApprovalRef = useRef<
    (sessionId: string, requestId: number, decision: ApprovalDecision) => boolean
  >(() => false);
  // Hivra WP-14: a first mate's messages to its running workers, stored first and delivered from the store.
  const steering = useSteering(sessions, {
    chat: async (id) => (await ensureOpenSessionRef.current(id)) ?? undefined,
    canSteer: (chat) => !chat.registryAgentId && isLiveHarness(chat.harness) && canSteerHarness(chat.harness),
    submit: async (id, text, { appRequestId, steer }) =>
      await submitSessionRef.current(id, text, [], steer ? { appRequestId, followsUp: true, followUpBehavior: "steer" } : { appRequestId }),
  });

  useMobileWorkspace({
    sessions,
    defaultRuntimeMode: sessionDefaults?.runtimeMode,
    command: async (method, params, commandId) => {
      // WP-150: inbox, crew status, and one tool call. Refused in Rust when phone access is off.
      if (
        method === "inbox.list" ||
        method === "crew.status" ||
        method === "session.approve" ||
        method === "session.deny"
      ) {
        // WP-150: the inbox and an approve or deny match only the calls the catalog
        // publishes, so a room session or unlisted chat is never offered or answered.
        const published = await mobileCatalog(sessionsRef.current, sessionDefaults?.runtimeMode);
        // Read after the await: the calls and chats are the window's current ones, not the ones
        // the catalog was built from. A call decided meanwhile is no longer offered or answered.
        const listed = new Set(published.sessions.map((session) => session.id));
        const roster = listMonos();
        return runMobilePairing(method, params, {
          sessions: sessionsRef.current,
          now: Date.now(),
          approve: (sessionId, requestId, decision) =>
            mobileApprovalRef.current(sessionId, requestId, decision),
          remoteBlocked: (session) =>
            !!remoteProjectFor(session.cwd) && !remoteSessionActions(session.id),
          privateIds: await mobilePrivateSessionIds(sessionsRef.current),
          approvals: (live) => publishedApprovalRows(live, listed, roster),
        });
      }
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (
        (method === "session.start" || method === "conversation.send") &&
        ((!text && !hasMobileAttachments(params.attachments)) || text.length > 100_000)
      )
        throw new Error("Enter a message under 100,000 characters");
      if (method === "session.start") {
        const paths = [...loadRecents().map((project) => project.path), ...loadPinnedProjects(), ...listMonos().flatMap((mono) => mono.projects)];
        const cwd = paths.find((path) => mobileProjectId(path) === params.projectId);
        if (!cwd) throw new Error("Project is no longer available");
        const id = String(params.sessionId ?? "");
        if (!id) throw new Error("Missing mobile session ID");
        const existing = sessionsRef.current.find(current => current.id === id) ?? await getSession(id);
        if (existing?.blocks.some(block => block.appRequestId === commandId)) return { sessionId: id };
        // Staged before the session exists, so a bad file leaves nothing behind.
        const attachments = await mobileAttachments(params.attachments);
        const session = existing ?? {
          ...applyMobileChoice(mobileNewSession(cwd, sessionDefaults?.runtimeMode), params),
          ...(await mobileWorkspaceChoice(cwd, params)),
        };
        // A placeholder title, so the first send seeds and generates one as the composer does.
        session.id = id;
        if (!existing) session.title = HARNESS_LABEL[session.harness];
        if (!sessionsRef.current.some(current => current.id === id))
          updateSessionState(sessionsRef, setSessions, (current) => [...current, session]);
        if (!submitSessionRef.current(session.id, text, attachments, { appRequestId: commandId }))
          throw new Error("Desktop could not start this session");
        await upsertSession(sessionsRef.current.find((current) => current.id === session.id) ?? session);
        return { sessionId: session.id };
      }
      const conversationId = String(params.conversationId ?? "");
      const mono = conversationId.startsWith("mono:") ? findMono(conversationId.slice(5)) : undefined;
      if (conversationId.startsWith("mono:") && !mono) throw new Error("Mono is no longer available");
      if (method === "session.rename") {
        // As the sidebar's rename, which also renames a session that isn't open.
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title || title.length > 200) throw new Error("Enter a title under 200 characters");
        if (mono) throw new Error("A Mono's conversation can't be renamed");
        await onRenameHistorySession(conversationId, title);
        return { sessionId: conversationId };
      }
      if (method === "session.delete" || method === "session.archive") {
        // As the CLI's delete and archive: no desktop dialogs, and the worktree stays.
        const mode = method === "session.archive" ? "archive" : "delete";
        const verb = mode === "archive" ? "archived" : "deleted";
        const target = mono ? undefined : await ensureOpenSessionRef.current(conversationId);
        if (!target || target.orchestrationLeadId || isMonoSession(target.id) || isHabitRun(target.id))
          throw new Error(`This session can't be ${verb} from the phone`);
        if (!(await onRemoveHistorySession(target.id, mode, true, "cli")))
          throw new Error(`Session could not be ${verb}; another session operation is in progress`);
        return { sessionId: target.id };
      }
      const monoSession = mono ? await ensureMonoSession(mono.id, {
        home: homeDir,
        load: ensureOpenSessionRef.current,
        create: (path) => newDefaultSession(path),
        add: (created) => updateSessionState(sessionsRef, setSessions, (current) => [...current, created]),
      }) : undefined;
      const sessionId = monoSession?.id ?? conversationId;
      const session = monoSession ?? await ensureOpenSessionRef.current(sessionId);
      if (!session) throw new Error("Session is no longer available");
      if (method === "session.resumeUsage" || method === "session.resumeUsageAtReset") {
        await recoverMobileUsage({
          session: sessionsRef.current.find((current) => current.id === session.id),
          token: params.token,
          automatic: method === "session.resumeUsageAtReset",
          enabled: params.enabled,
          pending: mobileUsagePending.current,
          resume: mobileUsageActions.current!.resume,
          setAutomatic: mobileUsageActions.current!.automatic,
        });
        return { sessionId: session.id };
      }
      if (method === "session.cancel") {
        await onStop(session.id);
        return { sessionId: session.id };
      }
      if (method === "session.configure") {
        // The phone's model sheet, through the same paths as the composer's pickers (mobileWorkspace.applyMobileConfigure).
        return applyMobileConfigure(session, params, {
          openMode: (id) => sessionsRef.current.find((current) => current.id === id)?.runtimeMode,
          onModelChange,
          onModelSettingsChange,
          onRuntimeModeChange,
        });
      }
      if (method === "session.answerQuestion" || method === "session.keepQuestionOpen") {
        // As the composer's question card; only the question still waiting,
        // read as it is now since opening the session may have taken a while.
        const live = sessionsRef.current.find((current) => current.id === session.id);
        if (!live || live.worktreeRemoved) throw new Error("Session is no longer available");
        const question = live.pendingQuestion;
        if (!question || question.requestId !== params.requestId)
          throw new Error("This question was already answered");
        if (method === "session.keepQuestionOpen") {
          onQuestionInteraction(live.id, question.requestId);
          return { sessionId: live.id };
        }
        // A remote session answers through its open tab; without one it would be dropped.
        if (remoteProjectFor(live.cwd) && !remoteSessionActions(live.id))
          throw new Error("Open this session on the desktop to answer it");
        const reply = mobileQuestionReply(params.reply, question);
        if (!reply) throw new Error("Choose an answer or skip the question");
        onQuestionReply(live.id, question.requestId, reply);
        return { sessionId: live.id };
      }
      if (method !== "conversation.send") throw new Error("Unsupported mobile command");
      if (
        session.blocks.some((block) => block.appRequestId === commandId) ||
        session.queuedMessages?.some((message) => message.id === commandId)
      )
        return { sessionId: session.id };
      const attachments = await mobileAttachments(params.attachments);
      // Mid-turn it steers or queues, as a message typed in the composer would.
      if (!submitSessionRef.current(session.id, text, attachments, { appRequestId: commandId, followsUp: true }))
        throw new Error("Desktop could not accept the message. Wait for the current turn to finish and try again.");
      await upsertSession(sessionsRef.current.find(current => current.id === session.id) ?? session);
      return { sessionId: session.id };
    },
  });

  // Rooms (group chats) take turns on the same Mono sessions, model, tools and settlement signal as a direct
  // conversation; a busy Mono gets the room's wake in its queue. Also its router, private messages between Monos, and
  // work delegated from a room coming back to it (app/hooks/useRoomRunner.ts).
  const onStopRef = useRef<(sessionId: string, managed?: boolean) => unknown>(() => undefined);
  // WP-23: a seat tab opens that seat's session. Read on each open, so the first render is not frozen in.
  const showCouncilSeatRef = useRef<(sessionId: string) => void>(() => undefined);
  showCouncilSeatRef.current = (sessionId) => {
    if (focusOpenSession(sessionId)) return;
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;
    const tab = newTab(session.id);
    appendTab(tab, session.cwd);
    setActiveTabId(tab.id);
    setComposerFocused(false);
  };
  useEffect(() => {
    // WP-23: each seat is a session on its own CLI, its tab opens that session, and the first mate who convened gets the brief.
    let folder = "~";
    void homeDir().then((dir) => {
      if (dir.trim()) folder = dir;
    });
    return bindCouncilApp({
      sessions: () => sessionsRef.current,
      add: (session) => {
        sessionsRef.current = [...sessionsRef.current, session];
        setSessions(sessionsRef.current);
      },
      submit: (sessionId, text, options) => submitSessionRef.current(sessionId, text, [], options),
      stop: (sessionId) => {
        void onStopRef.current(sessionId, true);
      },
      show: (sessionId) => showCouncilSeatRef.current(sessionId),
      cwd: () => folder,
      hand: (monoId, text) => {
        void ensureMonoSession(monoId, {
          home: homeDir,
          load: (id) => ensureOpenSessionRef.current(id),
          create: (path) => newDefaultSession(path),
          add: (created) => {
            sessionsRef.current = [...sessionsRef.current, created];
            setSessions(sessionsRef.current);
          },
        }).then((session) => {
          if (session) void submitSessionRef.current(session.id, text, [], { followsUp: true });
        });
      },
    });
  }, []);
  useEffect(() => {
    // WP-144: fresh-eyes reviewers are cheap sessions with an empty history. Off until a project turns the review on.
    let folder = "~";
    void homeDir().then((dir) => {
      if (dir.trim()) folder = dir;
    });
    return bindFreshEyesApp({
      sessions: () => sessionsRef.current,
      add: (session) => {
        sessionsRef.current = [...sessionsRef.current, session];
        setSessions(sessionsRef.current);
      },
      submit: (sessionId, text, _history, options) => submitSessionRef.current(sessionId, text, [], options),
      // WP-141 round 6: a reviewer is a launch like a worker: its CLI passes the crew gate before its session starts.
      crewGate: (session, reviewed) => crewLaunchCheck({ cli: session.harness, folder: reviewed, sessionId: session.id }),
      stop: (sessionId) => {
        void onStopRef.current(sessionId, true);
      },
      remove: (sessionId) => {
        sessionsRef.current = sessionsRef.current.filter((session) => session.id !== sessionId);
        setSessions(sessionsRef.current);
      },
      cwd: () => folder,
    });
  }, []);
  useEffect(() => {
    // WP-203: the reviewer session for each security review the app recorded a running row for. The finish settles the row.
    const started = new Set<string>();
    const hooks: ReviewHooks = {
      add: (session) => {
        sessionsRef.current = [...sessionsRef.current, session];
        setSessions(sessionsRef.current);
      },
      submit: (sessionId, text, _history, options) => submitSessionRef.current(sessionId, text, [], options),
      cwd: () => "~",
    };
    const run = () => {
      void startPendingReviews(tauriDelegations, hooks, started).catch(() => undefined);
    };
    run();
    let off: (() => void) | undefined;
    void listen(DELEGATIONS_CHANGED, run)
      .then((unlisten) => {
        off = unlisten;
      })
      .catch(() => undefined);
    return () => off?.();
  }, []);
  const roomsHost = useRoomRunner({
    sessions,
    sessionsRef,
    setSessions,
    submit: (id, text, { attachments, ...options }) => submitSessionRef.current(id, text, attachments ?? [], options),
    openMono: (monoId) =>
      ensureMonoSession(monoId, {
        home: homeDir,
        load: (id) => ensureOpenSessionRef.current(id),
        create: (path) => newDefaultSession(path),
        add: (created) => {
          sessionsRef.current = [...sessionsRef.current, created];
          setSessions(sessionsRef.current);
        },
      }),
    stop: (id) => onStopRef.current(id, true),
    // r52: each room conversation has its own session per Mono; its 1:1 chat keeps only what Ash says there.
    openRoom: (monoId, chatId, convId) =>
      ensureMonoRoomSession(monoId, chatId, convId, {
        home: homeDir,
        load: (id) => ensureOpenSessionRef.current(id),
        create: (path) => newDefaultSession(path),
        add: (created) => {
          sessionsRef.current = [...sessionsRef.current, created];
          setSessions(sessionsRef.current);
        },
      }),
    // The room's own housekeeping, not Ash's: it never moves the view (r61).
    dropSession: (id) => onRemoveHistorySession(id, "delete", true, "app"),
  });
  const roomsHostRef = useRef(roomsHost);
  roomsHostRef.current = roomsHost;

  const appReceipts = useRef(
    new Map<string, { signature: string; promise: Promise<unknown> }>(),
  );

  const ensureAutomationRecovery = useCallback(() => {
    if (!automationRecoveryRef.current) {
      const recovery = (async () => {
        const pending = await recoverAutomationRuns(
          automationRecoveryCutoffRef.current,
        );
        for (const item of pending) {
          await launchAutomation(
            item.automation,
            item.run,
            false,
            item.run.prompt ?? item.automation.prompt,
          ).catch(() => undefined);
        }
      })();
      automationRecoveryRef.current = recovery.catch((error: unknown) => {
        automationRecoveryRef.current = null;
        throw error;
      });
    }
    return automationRecoveryRef.current;
  }, [launchAutomation]);

  useEffect(() => {
    let disposed = false;
    let evaluating = false;
    const evaluate = async () => {
      // A build on trial runs no automations until it commits (src-tauri/src/ship.rs).
      if (disposed || evaluating || shipHoldRef.current) return;
      evaluating = true;
      try {
        await ensureAutomationRecovery();
        const due = await claimDueAutomations();
        for (const item of due) {
          if (disposed) break;
          void launchAutomation(item.automation, item.run).catch(
            () => undefined,
          );
        }
      } catch {
        // Scheduling retries on the next tick; individual claimed runs record
        // launch failures in launchAutomation.
      } finally {
        evaluating = false;
      }
    };
    void evaluate();
    const timer = window.setInterval(() => void evaluate(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void evaluate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ensureAutomationRecovery, launchAutomation, shipHold]);

  // WP-115: compact an idle Claude chat shortly before its prompt cache expires.
  const idleCompactEvent = useRef(enqueueHarnessEvent);
  idleCompactEvent.current = enqueueHarnessEvent;
  useEffect(() => {
    return watchIdleClaudeCompaction({
      sessions: () => sessionsRef.current,
      toInput: (session) => ({
        sessionId: session.id,
        cwd: sessionWorkCwd(session),
        model: session.model,
        modelSettings: session.modelSettings,
        providerAccountId: supportsProviderAccounts(session.harness)
          ? (session.providerAccountId ??
            selectedProviderAccountId(session.harness, session.cwd))
          : undefined,
        runtimeMode: session.runtimeMode,
        ephemeral: session.ephemeral === true,
        controlsAgents:
          isMonoSession(session.id) ||
          operatorEnabledInThread(session.blocks) ||
          orchestrator.run(session.id)?.status === "active",
        ...firstMateLaunch(session),
      }),
      onEvent: (id, event) => idleCompactEvent.current(id, event),
      // WP-115: hold the chat busy while compacting, so a send queues and a second look waits.
      // Claimed once, then published. The store assigns the ref as well, so a
      // diverged ref is put back afterwards.
      markBusy: (sessionId, busy) => {
        const result = commitIdleCompactBusy(
          sessionState.snapshot(),
          sessionsRef.current,
          sessionId,
          busy,
          turnGen.current,
          idleCompactOwners.current,
        );
        if (result.store !== sessionState.snapshot()) {
          setSessions([...result.store]);
          // Same array means the store publish already pointed the ref at it.
          if (result.ref === result.store) return result.ok;
        }
        if (sessionsRef.current !== result.ref) sessionsRef.current = [...result.ref];
        return result.ok;
      },
    });
  }, []);

  const onInboxAppeared = useCallback(
    (items: Parameters<typeof claimInboxAutomationRuns>[0]) => {
      if (shipHoldRef.current) return;
      void ensureAutomationRecovery()
        .then(() => claimInboxAutomationRuns(items))
        .then((due) => {
          for (const item of due) {
            void launchAutomation(
              item.automation,
              item.run,
              false,
              item.prompt,
              item.linkedWorkItem,
            ).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    },
    [ensureAutomationRecovery, launchAutomation],
  );

  const onUpdatePlan = useCallback(
    (sessionId: string, blockId: string, text: string) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (remoteProjectFor(session.cwd)) return session;
          if (session.id !== sessionId || session.busy) return session;
          return {
            ...session,
            blocks: session.blocks.map((block) => {
              if (
                block.id !== blockId ||
                block.role !== "plan" ||
                block.plan?.status === "streaming" ||
                block.plan?.status === "building" ||
                block.plan?.status === "built"
              ) {
                return block;
              }
              const originalText = block.plan?.originalText ?? block.text;
              return {
                ...block,
                text,
                plan: {
                  ...(block.plan ?? { status: "ready" as const }),
                  status: "ready" as const,
                  originalText,
                  edited: text !== originalText,
                },
              };
            }),
          };
        }),
      );
    },
    [],
  );

  const onBuildPlan = useCallback(
    (sessionId: string, blockId: string, target?: PlanBuildTarget) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      if (session && remoteProjectFor(session.cwd)) {
        buildRemotePlan(sessionId, blockId, target);
        return;
      }
      const block = session?.blocks.find((entry) => entry.id === blockId);
      if (
        !session ||
        session.busy ||
        block?.role !== "plan" ||
        !!block.orchestration ||
        !block.text.trim() ||
        block.plan?.status === "streaming" ||
        block.plan?.status === "building" ||
        block.plan?.status === "built"
      ) {
        return;
      }
      if (target && session.modelSettings) {
        saveLastModelSettings(session.modelSettings, "fill");
      }
      onSubmit(sessionId, "Build approved plan", [], {
        intent: "build",
        planBlockId: blockId,
        buildTarget: target,
      });
    },
    [onSubmit],
  );

  useEffect(() => {
    const timers: number[] = [];
    const scheduled = new Set<string>();
    for (const session of sessions) {
      const queued = session.queuedMessages ?? [];
      if (queued.length === 0) continue;

      if (!session.busy && session.queueStatus === "resuming") {
        setSessions((prev) =>
          prev.map((entry) =>
            entry.id === session.id
              ? { ...entry, queueStatus: "active" }
              : entry,
          ),
        );
        continue;
      }
      if (
        !(
          canDispatchQueuedHead(session) ||
          (monoForSession(session.id) &&
            canSteerQueuedHead(session) &&
            canSteerHarness(session.harness) &&
            !session.registryAgentId &&
            !consumeOperatorCommand(queued[0].text).matched)
        ) ||
        queueDispatchingRef.current.has(session.id)
      ) {
        continue;
      }

      const next = queued[0];
      if (!next) continue;
      queueDispatchingRef.current.add(session.id);
      scheduled.add(session.id);
      timers.push(
        window.setTimeout(async () => {
          scheduled.delete(session.id);
          const latest = sessionsRef.current.find(
            (entry) => entry.id === session.id,
          );
          const head = latest?.queuedMessages?.[0];
          if (
            !latest ||
            !head ||
            head.id !== next.id ||
            !(
              canDispatchQueuedHead(latest) ||
              (monoForSession(latest.id) &&
                canSteerQueuedHead(latest) &&
                canSteerHarness(latest.harness) &&
                !latest.registryAgentId &&
                !consumeOperatorCommand(head.text).matched)
            )
          ) {
            queueDispatchingRef.current.delete(session.id);
            return;
          }
          // A brief that waited is checked against its row first: one cancelled meanwhile (task_cancel, a cascade
          // Stop) leaves the queue instead of going in, even when a restart brought it back from a queue saved before
          // the cancel took it out.
          if (isWaitingBrief(head) && !latest.busy) {
            const requestId = head.appRequestId!;
            const rows = await (tauriDelegations.followedInto?.(session.id, [requestId]) ?? Promise.resolve([])).catch(
              () => [],
            );
            const now = sessionsRef.current.find((entry) => entry.id === session.id);
            if (briefCancelled(rows, requestId)) {
              setSessions((prev) =>
                prev.map((entry) =>
                  entry.id === session.id ? withoutQueuedBrief(entry, head) : entry,
                ),
              );
              queueDispatchingRef.current.delete(session.id);
              setQueueDispatchVersion((value) => value + 1);
              return;
            }
            if (!now || now.queuedMessages?.[0]?.id !== head.id || !canDispatchQueuedHead(now)) {
              queueDispatchingRef.current.delete(session.id);
              setQueueDispatchVersion((value) => value + 1);
              return;
            }
          }
          const steering = latest.busy;
          if (steering)
            setSessions((prev) =>
              prev.map((entry) =>
                entry.id === session.id
                  ? { ...entry, sendingQueuedMessageId: head.id }
                  : entry,
              ),
            );
          try {
            const accepted = await submitSession(
              session.id,
              head.text,
              head.attachments,
              {
                queuedMessageId: head.id,
                followUpBehavior: steering ? "steer" : undefined,
                noteCard: head.noteCard,
                handoffCard: head.handoffCard,
                intent: head.intent,
                ...(head.monoSessionCompletion
                  ? {
                      monoSessionCompletion: head.monoSessionCompletion,
                      appRequestId: head.id,
                    }
                  : head.monoNote
                    ? // A room's wake or another Mono's message goes in hidden, under its id (the room watches for it).
                      { monoNote: head.monoNote, appRequestId: head.appRequestId ?? head.id, followsUp: true }
                    : head.appRequestId
                    ? // A queued app brief goes in under its request id (followedBriefs.ts watches for it).
                      { appRequestId: head.appRequestId, followsUp: true }
                    : {}),
              },
            );
            if (accepted && head.monoSessionCompletion) {
              delegationsRef.current?.delivered(head.id);
              prWatchesRef.current?.delivered(head.id);
              void firstMateWakesRef.current?.delivered(head.id);
            }
            // A preflight rejection must not repeatedly retry or hide the message.
            if (!accepted && monoForSession(session.id)) {
              const current = sessionsRef.current.find(
                (entry) => entry.id === session.id,
              );
              if (
                current &&
                (steering
                  ? canSteerQueuedHead(current)
                  : canDispatchQueuedHead(current)) &&
                current.queuedMessages?.[0] === head
              ) {
                setSessions((prev) =>
                  prev.map((entry) =>
                    entry.id === session.id
                      ? {
                          ...entry,
                          queueStatus: "paused",
                          queuedMessages: entry.queuedMessages?.map(
                            (message) =>
                              message.id === head.id
                                ? {
                                    ...message,
                                    error:
                                      "Delivery is unavailable. Retry when the agent is ready.",
                                  }
                                : message,
                          ),
                        }
                      : entry,
                  ),
                );
              }
            }
            if (accepted || steering)
              setQueueDispatchVersion((value) => value + 1);
          } catch (error) {
            setSessions((prev) =>
              prev.map((entry) =>
                entry.id === session.id
                  ? {
                      ...entry,
                      queueStatus: "paused",
                      queuedMessages: entry.queuedMessages?.map((message) =>
                        message.id === head.id
                          ? {
                              ...message,
                              error:
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                            }
                          : message,
                      ),
                    }
                  : entry,
              ),
            );
          } finally {
            queueDispatchingRef.current.delete(session.id);
            if (steering)
              setSessions((prev) =>
                prev.map((entry) =>
                  entry.id === session.id
                    ? { ...entry, sendingQueuedMessageId: undefined }
                    : entry,
                ),
              );
          }
        }, 0),
      );
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      for (const id of scheduled) queueDispatchingRef.current.delete(id);
    };
  }, [submitSession, sessions, queueDispatchVersion]);

  const onDeleteQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      delegationsRef.current?.discarded(messageId);
      prWatchesRef.current?.discarded(messageId);
      firstMateWakesRef.current?.discarded(messageId);
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? dequeueQueuedMessage(session, messageId)
            : session,
        ),
      );
    },
    [],
  );

  const onQueuedMessageEditingChange = useCallback(
    (sessionId: string, messageId?: string) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? { ...session, editingQueuedMessageId: messageId }
            : session,
        ),
      );
    },
    [],
  );

  const onEditQueuedMessage = useCallback(
    (sessionId: string, messageId: string, text: string) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                queuedMessages: session.queuedMessages?.map((message) =>
                  message.id === messageId
                    ? {
                        ...message,
                        text: stripHiddenCharacters(text).text,
                        error: undefined,
                      }
                    : message,
                ),
                editingQueuedMessageId: undefined,
              }
            : session,
        ),
      );
    },
    [],
  );

  const onSteerQueuedMessage = useCallback(
    (sessionId: string, messageId: string) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      const message = session
        ? queuedMessageForSubmit(session, messageId, "steer")
        : undefined;
      if (!session || !message) return;
      if (message.intent === "orchestrate" && session.busy) {
        enqueueHarnessEvent(sessionId, {
          type: "status",
          text: "Orchestration planning will start after the current turn finishes.",
        });
        flushHarnessEvents();
        return;
      }
      onSubmit(sessionId, message.text, message.attachments, {
        followUpBehavior: "steer",
        queuedMessageId: message.id,
        noteCard: message.noteCard,
        handoffCard: message.handoffCard,
        intent: message.intent,
      });
    },
    [onSubmit, enqueueHarnessEvent, flushHarnessEvents],
  );

  const onResumeQueue = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      if (
        !session ||
        (session.busy && !monoForSession(sessionId)) ||
        session.queueStatus !== "paused" ||
        !session.queuedMessages?.length
      ) {
        return;
      }
      if (monoForSession(sessionId)) {
        setSessions((prev) =>
          prev.map((entry) =>
            entry.id === sessionId
              ? entry.usageLimit
                ? resumeMonoUsageLimit(entry)
                : {
                    ...entry,
                    queueStatus: "active",
                    queuedMessages: entry.queuedMessages?.map((message) => ({
                      ...message,
                      error: undefined,
                    })),
                  }
              : entry,
          ),
        );
        return;
      }
      setSessions((prev) =>
        prev.map((entry) =>
          entry.id === sessionId
            ? { ...entry, queueStatus: "resuming" }
            : entry,
        ),
      );
      onSubmit(sessionId, CONTINUE_PROMPT, [], {
        followUpBehavior: "steer",
      });
    },
    [onSubmit],
  );

  const onUsageLimitDismiss = useCallback((sessionId: string) => {
    updateSessionState(sessionsRef, setSessions, (prev) =>
      prev.map((session) =>
        session.id === sessionId && session.usageLimit
          ? { ...session, usageLimit: undefined }
          : session,
      ),
    );
  }, []);

  const onUsageLimitResumeAtReset = useCallback(
    (sessionId: string, enabled: boolean) => {
      updateSessionState(sessionsRef, setSessions, (prev) =>
        prev.map((session) =>
          session.id === sessionId && session.usageLimit
            ? {
                ...session,
                usageLimit: { ...session.usageLimit, resumeAtReset: enabled },
              }
            : session,
        ),
      );
    },
    [],
  );

  const onUsageLimitResume = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const session = sessionsRef.current.find((entry) => entry.id === sessionId);
      if (!session?.usageLimit || session.busy) return false;
      if (isMonoSession(sessionId)) {
        updateSessionState(sessionsRef, setSessions, (prev) =>
          prev.map((entry) => entry.id === sessionId ? resumeMonoUsageLimit(entry) : entry),
        );
        return true;
      }
      onUsageLimitDismiss(sessionId);
      try {
        if (await submitSession(sessionId, CONTINUE_PROMPT)) return true;
      } catch { /* The submission path reports its desktop error. */ }
      // A rejected continuation previously cleared the limit entirely. Keep
      // that one-attempt scheduler behavior, but retain a manual retry notice.
      updateSessionState(sessionsRef, setSessions, (prev) => prev.map((entry) =>
        entry.id === sessionId && !entry.busy && !entry.usageLimit
          ? { ...entry, usageLimit: { ...session.usageLimit!, resumeAtReset: false } } : entry));
      return false;
    },
    [submitSession, onUsageLimitDismiss],
  );

  mobileUsageActions.current = { resume: onUsageLimitResume, automatic: onUsageLimitResumeAtReset };

  const usageLimitSwitching = useRef(new Set<string>());
  const onUsageLimitAccountChange = useCallback(
    async (sessionId: string, accountId: string) => {
      const session = sessionsRef.current.find(
        (entry) => entry.id === sessionId,
      );
      if (
        !session?.usageLimit ||
        session.busy ||
        !supportsProviderAccounts(session.harness) ||
        !providerAccountExists(session.harness, accountId) ||
        sameProviderAccountId(session.providerAccountId, accountId) ||
        usageLimitSwitching.current.has(sessionId)
      )
        return;
      const mono = isMonoSession(sessionId);
      // Copy the native transcript so the other account resumes the very same
      // provider session. Mono Codex threads live in a private store instead.
      let carried = false;
      if (
        session.providerSessionId &&
        (session.harness === "claude" ||
          (session.harness === "codex" && !mono))
      ) {
        usageLimitSwitching.current.add(sessionId);
        try {
          await transferHarnessSessionAccount({
            harness: session.harness,
            threadId: sessionId,
            providerSessionId: session.providerSessionId,
            cwd: sessionWorkCwd(session),
            fromAccountId: session.providerAccountId,
            toAccountId: accountId,
            blocks: session.blocks,
          });
          carried = true;
        } catch (error) {
          console.warn(
            "Could not carry the conversation to the other account; continuing from a handoff",
            error,
          );
        } finally {
          usageLimitSwitching.current.delete(sessionId);
        }
        const latest = sessionsRef.current.find(
          (entry) => entry.id === sessionId,
        );
        // The user moved on while the transcript was copied.
        if (
          !latest?.usageLimit ||
          latest.busy ||
          latest.providerSessionId !== session.providerSessionId ||
          !sameProviderAccountId(
            latest.providerAccountId,
            session.providerAccountId,
          )
        )
          return;
      }
      if (mono) {
        updateSessionState(sessionsRef, setSessions, (sessions) =>
          sessions.map((entry) =>
            entry.id === sessionId
              ? switchMonoUsageLimitAccount(entry, accountId, carried)
              : entry,
          ),
        );
        return;
      }
      updateSessionState(sessionsRef, setSessions, (sessions) =>
        sessions.map((entry) =>
          entry.id === sessionId
            ? withUsageLimitAccount(entry, accountId, carried)
            : entry,
        ),
      );
      onUsageLimitResume(sessionId);
    },
    [onUsageLimitResume],
  );
  usageLimitAccountChangeRef.current = onUsageLimitAccountChange;

  // E5: a chat refused for its limit moves to the next account in Ash's order with room, by itself, and says so in
  // one line (accountWaterfall.ts). Once per refusal: the account it was on is remembered until the limit clears.
  const waterfallSeen = useRef(new Map<string, string>());
  useEffect(() => {
    const now = Date.now();
    for (const session of sessions) {
      const account = session.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
      if (!session.usageLimit) {
        waterfallSeen.current.delete(session.id);
        continue;
      }
      if (
        session.busy ||
        !supportsProviderAccounts(session.harness) ||
        waterfallSeen.current.get(session.id) === account
      )
        continue;
      waterfallSeen.current.set(session.id, account);
      const plan = reactToLimit(session, session.harness, {
        now,
        usageFor: (entry) => getCachedRateLimits(entry.provider, entry.id),
      });
      if (plan.action !== "move") continue;
      updateSessionState(sessionsRef, setSessions, (all) =>
        all.map((entry) =>
          entry.id === session.id
            ? {
                ...entry,
                blocks: [
                  ...entry.blocks,
                  {
                    id: crypto.randomUUID(),
                    role: "system",
                    text: plan.line,
                    notice: "account-moved",
                  } as Block,
                ],
              }
            : entry,
        ),
      );
      void onUsageLimitAccountChange(session.id, plan.to);
    }
  }, [sessions, onUsageLimitAccountChange]);

  const [usageLimitTick, setUsageLimitTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const timers: number[] = [];
    const scheduled = new Set<string>();
    let nextCheck = Number.POSITIVE_INFINITY;
    for (const session of sessions) {
      const limit = session.usageLimit;
      if (!limit?.resumeAtReset || limit.resetsAt == null) continue;
      if (!usageLimitResumeDue(session, now)) {
        nextCheck = Math.min(
          nextCheck,
          (usageLimitResumeAt(limit) ??
            limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS) - now,
        );
        continue;
      }
      if (usageResumingRef.current.has(session.id)) continue;
      usageResumingRef.current.add(session.id);
      scheduled.add(session.id);
      timers.push(
        window.setTimeout(() => {
          usageResumingRef.current.delete(session.id);
          const latest = sessionsRef.current.find(
            (entry) => entry.id === session.id,
          );
          if (latest && usageLimitResumeDue(latest, Date.now())) {
            onUsageLimitResume(session.id);
          }
        }, 0),
      );
    }
    if (Number.isFinite(nextCheck)) {
      // Re-check every minute at most: timers drift while the machine sleeps.
      timers.push(
        window.setTimeout(
          () => setUsageLimitTick((tick) => tick + 1),
          Math.max(1_000, Math.min(nextCheck, 60_000)),
        ),
      );
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      for (const id of scheduled) usageResumingRef.current.delete(id);
    };
  }, [onUsageLimitResume, sessions, usageLimitTick]);

  // The stream does not always say when the limit resets; ask the provider.
  useEffect(() => {
    for (const session of sessions) {
      const limit = session.usageLimit;
      if (!limit || limit.resetsAt != null) continue;
      if (usageResetLookups.current.has(limit)) continue;
      const fetchLimits =
        session.harness === "claude"
          ? fetchClaudeRateLimits
          : session.harness === "codex"
            ? fetchCodexRateLimits
            : undefined;
      if (!fetchLimits) continue;
      usageResetLookups.current.add(limit);
      void fetchLimits(session.providerAccountId).then((limits) => {
        const resetsAt = exhaustedWindowResetAt(limits);
        if (resetsAt == null) return;
        setSessions((prev) =>
          prev.map((entry) =>
            entry.id === session.id && entry.usageLimit === limit
              ? { ...entry, usageLimit: { ...limit, resetsAt } }
              : entry,
          ),
        );
      });
    }
  }, [sessions]);

  const openSessionBeside = useCallback(
    (
      sourceId: string,
      session: Session,
      cwd: string,
      focusComposer = false,
    ) => {
      const nextSessions = [...sessionsRef.current, session];
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);

      const tab = tabsRef.current.find((entry) =>
        leafIds(entry.layout).includes(sourceId),
      );
      if (tab) {
        const nextTabs = tabsRef.current.map((entry) =>
          entry.id === tab.id
            ? {
                ...entry,
                layout: splitPane(entry.layout, sourceId, "right", session.id),
                focusedId: session.id,
                diffFocused: false,
              }
            : entry,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        if (tab.id !== activeTabIdRef.current) setActiveTabId(tab.id);
      } else {
        const nextTab = newTab(session.id);
        appendTab(nextTab, cwd);
        setActiveTabId(nextTab.id);
      }

      setProjectTerminalFocused(false);
      setComposerFocused(focusComposer);
    },
    [appendTab],
  );

  const onSecondOpinion = useCallback(
    (sourceId: string, target: ModelTarget, turn: Block[]) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sourceId,
      );
      if (!source || source.worktreeRemoved) return;
      const { harness, model, modelSettings } = target;
      const cwd = sessionWorkCwd(source);
      const from = harnessForTurn(source.blocks, turn, source.harness);
      const request = buildSecondOpinionRequest({
        from,
        to: harness,
        turn,
        cwd,
      });
      const session = {
        ...newSession(harness, source.cwd, model, source.runtimeMode),
        worktreeCwd: source.worktreeCwd,
        branch: source.branch,
        modelSettings: mergeModelSettings(
          resolveModel(harness, model),
          modelSettings,
        ),
        title: formatSessionTitle(harness, SECOND_OPINION_TITLE),
      };
      openSessionBeside(sourceId, session, source.cwd);
      onSubmit(session.id, request.prompt, [], request.options);
    },
    [onSubmit, openSessionBeside],
  );
  const updateBtwThread = useCallback(
    (
      sessionId: string,
      userBlockId: string,
      threadId: string,
      update: (thread: BtwThread | undefined) => BtwThread | undefined,
    ): Session | undefined => {
      const previous = sessionsRef.current;
      let updatedSession: Session | undefined;
      const next = previous.map((session) => {
        if (session.id !== sessionId) return session;
        const blockIndex = session.blocks.findIndex(
          (block) => block.id === userBlockId && block.role === "user",
        );
        if (blockIndex < 0) return session;
        const block = session.blocks[blockIndex];
        const current = block.btwThreads?.find(
          (thread) => thread.id === threadId,
        );
        const nextThread = update(current);
        if (!nextThread) return session;
        // WP-112: attach the side thread only. Do not append, compact, or start a parent turn.
        const blocks = withSideThread(session.blocks, userBlockId, nextThread);
        if (!blocks) return session;
        updatedSession = { ...session, blocks };
        return updatedSession;
      });
      if (!updatedSession) return undefined;
      sessionsRef.current = next;
      setSessions(next);
      persistSession(updatedSession);
      return updatedSession;
    },
    [persistSession],
  );

  const removeBtwThread = useCallback(
    (
      sessionId: string,
      userBlockId: string,
      threadId: string,
    ): Session | undefined => {
      const previous = sessionsRef.current;
      let updatedSession: Session | undefined;
      const next = previous.map((session) => {
        if (session.id !== sessionId) return session;
        const blockIndex = session.blocks.findIndex(
          (block) => block.id === userBlockId && block.role === "user",
        );
        if (blockIndex < 0) return session;
        const block = session.blocks[blockIndex];
        const threads = block.btwThreads ?? [];
        if (!threads.some((thread) => thread.id === threadId)) return session;
        const nextThreads = threads.filter((thread) => thread.id !== threadId);
        const nextBlock = {
          ...block,
          btwThreads: nextThreads.length > 0 ? nextThreads : undefined,
        };
        const blocks = session.blocks.slice();
        blocks[blockIndex] = nextBlock;
        updatedSession = { ...session, blocks };
        return updatedSession;
      });
      if (!updatedSession) return undefined;
      sessionsRef.current = next;
      setSessions(next);
      persistSession(updatedSession);
      return updatedSession;
    },
    [persistSession],
  );

  const runBtwRequest = useCallback(
    (input: {
      sessionId: string;
      userBlockId: string;
      source: Session;
      thread: BtwThread;
      harness: HarnessId;
    }) => {
      const harness = input.harness;
      if (!supportsBtwHarness(harness)) return;
      const cwd = sessionWorkCwd(input.source);
      const model = nativeModelId(
        input.thread.model ?? input.source.model,
      ).trim();
      if (!cwd || cwd === "~") {
        updateBtwThread(
          input.sessionId,
          input.userBlockId,
          input.thread.id,
          (thread) =>
            thread
              ? {
                  ...thread,
                  status: "error",
                  updatedAt: Date.now(),
                  error:
                    "A project working directory is required for this question.",
                }
              : undefined,
        );
        return;
      }
      if (!model && harness === "codex") {
        updateBtwThread(
          input.sessionId,
          input.userBlockId,
          input.thread.id,
          (thread) =>
            thread
              ? {
                  ...thread,
                  status: "error",
                  updatedAt: Date.now(),
                  error: "The selected Codex model is unavailable.",
                }
              : undefined,
        );
        return;
      }

      let prompt: string;
      try {
        prompt = buildBtwPrompt({
          blocks: input.source.blocks,
          thread: input.thread,
          cwd,
        });
      } catch (error) {
        updateBtwThread(
          input.sessionId,
          input.userBlockId,
          input.thread.id,
          (thread) =>
            thread
              ? {
                  ...thread,
                  status: "error",
                  updatedAt: Date.now(),
                  error:
                    error instanceof Error
                      ? error.message
                      : "The completed turn is no longer available.",
                }
              : undefined,
        );
        return;
      }

      const key = `${input.sessionId}:${input.thread.id}`;
      btwRequestsRef.current.get(key)?.controller.abort();
      const controller = new AbortController();
      btwRequestsRef.current.set(key, {
        sessionId: input.sessionId,
        controller,
      });

      const userMessageId =
        input.thread.messages[input.thread.messages.length - 1]?.id ??
        input.thread.id;
      const responseModel = model || input.source.model;

      void runHarnessTextPrompt({
        harness,
        cwd,
        providerAccountId: input.source.providerAccountId,
        model: model || undefined,
        modelSettings: input.thread.modelSettings ?? input.source.modelSettings,
        ephemeral: false,
        codexStore: isMonoSession(input.source.id) ? "mono" : undefined,
        threadId: input.thread.providerThreadId,
        onThreadId: (providerThreadId) => {
          if (controller.signal.aborted) return;
          updateBtwThread(
            input.sessionId,
            input.userBlockId,
            input.thread.id,
            (thread) =>
              thread && thread.providerThreadId !== providerThreadId
                ? {
                    ...thread,
                    providerThreadId,
                    updatedAt: Date.now(),
                  }
                : thread,
          );
        },
        onEvent: (event) => {
          if (controller.signal.aborted) return;
          updateBtwThread(
            input.sessionId,
            input.userBlockId,
            input.thread.id,
            (thread) =>
              thread?.status === "running"
                ? {
                    ...thread,
                    updatedAt: Date.now(),
                    pendingBlocks: applyBtwHarnessEvent(
                      thread.pendingBlocks ?? [],
                      event,
                      harness,
                      responseModel,
                      userMessageId,
                    ),
                  }
                : undefined,
          );
        },
        intent: "plan",
        prompt,
        signal: controller.signal,
      })
        .then((output) => {
          if (controller.signal.aborted) return;
          const text = output.trim();
          if (!text) {
            throw new Error(
              `${HARNESS_TITLE[harness]} returned an empty side answer.`,
            );
          }
          updateBtwThread(
            input.sessionId,
            input.userBlockId,
            input.thread.id,
            (thread) => {
              if (!thread) return undefined;
              const pendingBlocks = thread.pendingBlocks ?? [];
              const blocks =
                pendingBlocks.length > 0
                  ? sealBtwResponseBlocks(
                      pendingBlocks,
                      harness,
                      responseModel,
                      userMessageId,
                    )
                  : undefined;
              return {
                ...thread,
                status: "ready",
                updatedAt: Date.now(),
                pendingBlocks: undefined,
                messages: [
                  ...thread.messages,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    text,
                    createdAt: Date.now(),
                    ...(blocks?.length ? { blocks } : {}),
                  },
                ],
                error: undefined,
              };
            },
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message =
            error instanceof Error
              ? error.message
              : `${HARNESS_TITLE[harness]} could not answer this side question.`;
          updateBtwThread(
            input.sessionId,
            input.userBlockId,
            input.thread.id,
            (thread) =>
              thread
                ? {
                    ...thread,
                    status: "error",
                    updatedAt: Date.now(),
                    pendingBlocks: undefined,
                    error: message,
                  }
                : undefined,
          );
        })
        .finally(() => {
          if (btwRequestsRef.current.get(key)?.controller === controller) {
            btwRequestsRef.current.delete(key);
          }
        });
    },
    [updateBtwThread],
  );

  const onBtwSubmit = useCallback(
    (
      sessionId: string,
      turn: Block[],
      threadId: string,
      messageId: string,
      text: string,
      model?: string,
      modelSettings?: Record<string, string>,
    ) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const sourceUserId = turn.find((block) => block.role === "user")?.id;
      const sourceEndBlockId = turn[turn.length - 1]?.id;
      const turnHarness = source
        ? harnessForTurn(source.blocks, turn, source.harness)
        : undefined;
      const turnModel = turn.find((block) => block.role === "user")?.turnModel
        ?.id;
      const sourceBlockEarly = source?.blocks.find(
        (block) => block.id === sourceUserId && block.role === "user",
      );
      const existingEarly = sourceBlockEarly?.btwThreads?.find(
        (thread) => thread.id === threadId,
      );
      const requestHarness = source
        ? supportsBtwHarness(turnHarness)
          ? turnHarness
          : (existingEarly?.harness ??
            btwTurnHarness(source.blocks, turn, source.harness))
        : undefined;
      if (
        !source ||
        !supportsBtwHarness(requestHarness) ||
        source.worktreeRemoved ||
        !sourceUserId ||
        !sourceEndBlockId
      ) {
        return false;
      }
      const sourceBlock = sourceBlockEarly;
      if (!sourceBlock) return false;
      const existing = existingEarly;
      const selectedModel =
        model?.trim() ||
        existing?.model ||
        turnModel ||
        nativeModelId(source.model).trim();
      const selectedModelSettings =
        modelSettings ??
        existing?.modelSettings ??
        preferredModelSettings(
          resolveModel(requestHarness!, selectedModel || source.model),
          source.modelSettings,
        );
      if (existing?.status === "running") return false;
      if (existing && existing.sourceEndBlockId !== sourceEndBlockId) {
        return false;
      }
      const now = Date.now();
      const thread: BtwThread = existing
        ? {
            ...existing,
            harness: existing.harness ?? turnHarness,
            model: selectedModel || undefined,
            modelSettings: selectedModelSettings,
            status: "running",
            updatedAt: now,
            error: undefined,
            pendingBlocks: [],
            messages: [
              ...existing.messages,
              { id: messageId, role: "user", text, createdAt: now },
            ],
          }
        : {
            id: threadId,
            sourceEndBlockId,
            createdAt: now,
            updatedAt: now,
            status: "running",
            pendingBlocks: [],
            harness: requestHarness,
            ...(selectedModel ? { model: selectedModel } : {}),
            modelSettings: selectedModelSettings,
            messages: [{ id: messageId, role: "user", text, createdAt: now }],
          };
      const updated = updateBtwThread(
        sessionId,
        sourceUserId,
        threadId,
        () => thread,
      );
      if (!updated) return false;
      runBtwRequest({
        sessionId,
        userBlockId: sourceUserId,
        source,
        thread,
        harness: thread.harness ?? requestHarness!,
      });
      return true;
    },
    [runBtwRequest, updateBtwThread],
  );

  const onBtwModelChange = useCallback(
    (
      sessionId: string,
      turn: Block[],
      threadId: string,
      model: string,
      modelSettings: Record<string, string>,
    ) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const sourceUserId = turn.find((block) => block.role === "user")?.id;
      const turnHarness = source
        ? harnessForTurn(source.blocks, turn, source.harness)
        : undefined;
      const nextModel = model.trim();
      const sourceBlock = source?.blocks.find(
        (block) => block.id === sourceUserId && block.role === "user",
      );
      const threadHarness = source
        ? (sourceBlock?.btwThreads?.find((thread) => thread.id === threadId)
            ?.harness ??
          btwTurnHarness(source.blocks, turn, source.harness) ??
          turnHarness)
        : undefined;
      if (
        !source ||
        !supportsBtwHarness(threadHarness) ||
        source.worktreeRemoved ||
        !sourceUserId ||
        !nextModel
      ) {
        return;
      }
      updateBtwThread(sessionId, sourceUserId, threadId, (thread) =>
        thread
          ? {
              ...thread,
              model: nextModel,
              modelSettings,
              updatedAt: Date.now(),
            }
          : undefined,
      );
    },
    [updateBtwThread],
  );

  const onBtwDelete = useCallback(
    (sessionId: string, turn: Block[], threadId: string) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const sourceUserId = turn.find((block) => block.role === "user")?.id;
      const turnHarness = source
        ? harnessForTurn(source.blocks, turn, source.harness)
        : undefined;
      const sourceBlock = source?.blocks.find(
        (block) => block.id === sourceUserId && block.role === "user",
      );
      const threadHarness = source
        ? (sourceBlock?.btwThreads?.find((thread) => thread.id === threadId)
            ?.harness ??
          btwTurnHarness(source.blocks, turn, source.harness) ??
          turnHarness)
        : undefined;
      if (
        !source ||
        !supportsBtwHarness(threadHarness) ||
        source.worktreeRemoved ||
        !sourceUserId
      ) {
        return;
      }
      const requestKey = `${sessionId}:${threadId}`;
      btwRequestsRef.current.get(requestKey)?.controller.abort();
      btwRequestsRef.current.delete(requestKey);
      removeBtwThread(sessionId, sourceUserId, threadId);
    },
    [removeBtwThread],
  );

  // Stopping keeps whatever the side answer had streamed, like stopping a
  // main turn, and leaves the thread ready for the next question.
  const onBtwStop = useCallback(
    (sessionId: string, turn: Block[], threadId: string) => {
      const sourceUserId = turn.find((block) => block.role === "user")?.id;
      if (!sourceUserId) return;
      const key = `${sessionId}:${threadId}`;
      btwRequestsRef.current.get(key)?.controller.abort();
      btwRequestsRef.current.delete(key);
      updateBtwThread(sessionId, sourceUserId, threadId, (thread) => {
        if (!thread || thread.status !== "running") return thread;
        const harness = thread.harness;
        const userMessageId =
          thread.messages[thread.messages.length - 1]?.id ?? thread.id;
        const pending = thread.pendingBlocks ?? [];
        const blocks =
          pending.length > 0 && harness
            ? sealBtwResponseBlocks(
                pending,
                harness,
                thread.model ?? "",
                userMessageId,
              )
            : [];
        const text = blocks
          .filter((block) => block.role === "assistant")
          .map((block) => block.text)
          .join("\n\n")
          .trim();
        const now = Date.now();
        return {
          ...thread,
          status: "ready",
          updatedAt: now,
          pendingBlocks: undefined,
          error: undefined,
          messages: blocks.length
            ? [
                ...thread.messages,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  text,
                  createdAt: now,
                  blocks,
                },
              ]
            : thread.messages,
        };
      });
    },
    [updateBtwThread],
  );

  const onBtwRetry = useCallback(
    (sessionId: string, turn: Block[], threadId: string) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      const sourceUserId = turn.find((block) => block.role === "user")?.id;
      const turnHarness = source
        ? harnessForTurn(source.blocks, turn, source.harness)
        : undefined;
      const sourceBlock = source?.blocks.find(
        (block) => block.id === sourceUserId && block.role === "user",
      );
      const existing = sourceBlock?.btwThreads?.find(
        (thread) => thread.id === threadId,
      );
      const threadHarness = source
        ? (existing?.harness ??
          btwTurnHarness(source.blocks, turn, source.harness) ??
          turnHarness)
        : undefined;
      if (
        !source ||
        !supportsBtwHarness(threadHarness) ||
        source.worktreeRemoved ||
        !sourceUserId
      ) {
        return;
      }
      if (!sourceBlock || !existing || existing.status !== "error") return;
      const thread: BtwThread = {
        ...existing,
        status: "running",
        updatedAt: Date.now(),
        error: undefined,
        pendingBlocks: [],
      };
      const updated = updateBtwThread(
        sessionId,
        sourceUserId,
        threadId,
        () => thread,
      );
      if (!updated) return;
      runBtwRequest({
        sessionId,
        userBlockId: sourceUserId,
        source: updated,
        thread,
        harness: thread.harness ?? threadHarness!,
      });
    },
    [runBtwRequest, updateBtwThread],
  );

  const onHandoff = useCallback(
    (sourceId: string, target: ModelTarget, turn: Block[]) => {
      const source = sessionsRef.current.find(
        (session) => session.id === sourceId,
      );
      if (!source || source.worktreeRemoved) return;
      const { harness, model, modelSettings } = target;
      const cwd = sessionWorkCwd(source);
      const from = harnessForTurn(source.blocks, turn, source.harness);
      const sliced = sessionThroughTurn(source, turn);
      const userRequest = turnUserRequest(turn);
      const files = turnEditedFiles(sliced.blocks, cwd);
      const display = sessionDisplayTitle(source.title, source.harness);
      const session = {
        ...newSession(harness, source.cwd, model, source.runtimeMode),
        worktreeCwd: source.worktreeCwd,
        branch: source.branch,
        modelSettings: mergeModelSettings(
          resolveModel(harness, model),
          modelSettings,
        ),
        title: formatSessionTitle(
          harness,
          display === "New session" ? HANDOFF_TITLE : display,
        ),
        handoffCard: buildHandoffComposerCard({
          from,
          to: harness,
          brief: buildDeterministicHandoff(sliced),
          userRequest,
          files,
        }),
      };
      openSessionBeside(sourceId, session, source.cwd, true);
    },
    [openSessionBeside],
  );

  const shipResumes = useRef(new Set<string>());
  /** The chats this window has auto-continued, by chat and resume count (inFlight.ts claimAutoContinue). */
  const autoContinued = useRef(new Set<string>());
  const autoContinueKey = sessions
    .filter(
      (session) => canAutoContinue(session) && isLiveHarness(session.harness),
    )
    .map((session) => session.id)
    .join("\n");

  /**
   * A turn the app has restarted under too often (`MAX_AUTO_RESUMES`) stops resuming itself: its chat says so and
   * reads Needs you, it leaves the quit snapshot so the next boot doesn't mark it interrupted again, and a Lead
   * waiting on it (a delegated worker's row) hears it failed, with why.
   */
  const stopResuming = useCallback(
    (session: Session) => {
      const stopped = markResumeStopped(session);
      sessionsRef.current = sessionsRef.current.map((entry) =>
        entry.id === session.id ? stopped : entry,
      );
      setSessions(sessionsRef.current);
      persistSession(stopped);
      void dropInFlightSession(session.id).catch(() => undefined);
      const owed = delegationsRef.current?.resumeMonitor(
        session.id,
        CONTINUE_PROMPT,
        false,
        true,
      );
      owed?.started();
      owed?.settled({ status: "failed", text: "", error: RESUME_STOPPED_MESSAGE });
    },
    [persistSession],
  );

  useEffect(() => {
    // A dev copy shows a cut-off chat as interrupted but never continues it on its own, and a build on trial waits
    // until it has committed (src-tauri/src/ship.rs): if it is rolled back, the old build resumes them instead.
    if (!autoContinueKey || !appPolicy().autoResume || shipHold) return;
    const ids = autoContinueKey.split("\n");
    const stillDue = (id: string) => {
      const session = sessionsRef.current.find((entry) => entry.id === id);
      return session && canAutoContinue(session) && isLiveHarness(session.harness)
        ? session
        : null;
    };
    // Delay past React StrictMode's dev remount so Continue is not claimed
    // against a discarded tree (sessionStorage also survives Vite reloads).
    const timer = window.setTimeout(() => {
      for (const id of ids) {
        const session = stillDue(id);
        if (!session) continue;
        // Cut by restart after restart: stop and wait for Ash instead of looping.
        if (resumeBlocked(session)) {
          stopResuming(session);
          continue;
        }
        // Once per restart: this effect runs again whenever another chat's resumability changes.
        if (!claimAutoContinue(autoContinued.current, session)) continue;
        const autoResume = (session.autoResumes ?? 0) + 1;
        const ship = interruptingShip(session);
        if (!ship) {
          // With what the restart cut, if anything was running in the background. A Continue refused outright may be
          // tried again the next time this runs.
          if (!onSubmit(id, resumePrompt(session), [], { autoResume }))
            autoContinued.current.delete(`${id}:${session.autoResumes ?? 0}`);
          continue;
        }
        // Cut by a ship's restart: resume once, with what the ship did.
        if (shipResumes.current.has(id)) continue;
        shipResumes.current.add(id);
        void loadShipNote(ship).then((note) => {
          const due = stillDue(id);
          if (due) onSubmit(id, resumePrompt(due, { note }), [], { autoResume });
          shipResumes.current.delete(id);
        });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoContinueKey, onSubmit, shipHold, stopResuming]);

  const onCompactContext = useCallback(
    (sessionId: string) => {
      const current = sessionsRef.current.find(
        (session) => session.id === sessionId,
      );
      if (current && remoteProjectFor(current.cwd))
        return remoteSessionActions(sessionId)?.compact() ?? false;
      if (!current || current.busy || current.worktreeRemoved) return false;
      if (!canCompactHarnessContext(current.harness)) {
        const unsupported = sessionsRef.current.map((session) =>
          session.id === sessionId
            ? applyHarnessEvent(session, {
                type: "status",
                text: `${HARNESS_TITLE[current.harness]} does not support manual context compaction.`,
              })
            : session,
        );
        sessionsRef.current = unsupported;
        syncDockBadge(unsupported);
        setSessions(unsupported);
        return true;
      }

      const gen = (turnGen.current.get(sessionId) ?? 0) + 1;
      turnGen.current.set(sessionId, gen);
      const workCwd = sessionWorkCwd(current);
      const started = sessionsRef.current.map((session) =>
        session.id === sessionId
          ? applyHarnessEvent(
              { ...session, busy: true },
              { type: "status", text: "Compacting context…" },
            )
          : session,
      );
      sessionsRef.current = started;
      syncDockBadge(started);
      setSessions(started);

      void (async () => {
        try {
          await compactHarnessContext({
            harness: current.harness,
            sessionId,
            cwd: workCwd,
            model: current.model,
            modelSettings: current.modelSettings,
            providerAccountId: supportsProviderAccounts(current.harness)
              ? (current.providerAccountId ??
                selectedProviderAccountId(current.harness, current.cwd))
              : undefined,
            runtimeMode: current.runtimeMode,
            ephemeral: current.ephemeral === true,
            codexStore: isMonoSession(sessionId) ? "mono" : undefined,
            controlsAgents:
              isMonoSession(sessionId) ||
              operatorEnabledInThread(current.blocks) ||
              orchestrator.run(sessionId)?.status === "active",
            ...firstMateLaunch(current),
            ...crewLaunch(current, crewRows()), // WP-143
            onEvent: (event) => {
              if (turnGen.current.get(sessionId) !== gen) return;
              enqueueHarnessEvent(sessionId, event);
            },
          });
          if (turnGen.current.get(sessionId) !== gen) return;
          enqueueHarnessEvent(sessionId, {
            type: "status",
            text: "Compacted context",
          });
        } catch (error: unknown) {
          if (turnGen.current.get(sessionId) !== gen) return;
          enqueueHarnessEvent(sessionId, {
            type: "session.error",
            message:
              error instanceof Error
                ? error.message
                : `${current.harness} could not compact this context`,
          });
        } finally {
          if (turnGen.current.get(sessionId) !== gen) return;
          flushHarnessEvents();
          const finished = sessionsRef.current.map((session) =>
            session.id === sessionId ? { ...session, busy: false } : session,
          );
          sessionsRef.current = finished;
          syncDockBadge(finished);
          setSessions(finished);
        }
      })();
      return true;
    },
    [enqueueHarnessEvent, flushHarnessEvents],
  );

  const onStop = useCallback(
    (sessionId: string, managed = false) => {
      const remote = sessionsRef.current.find((s) => s.id === sessionId);
      if (remote && remoteProjectFor(remote.cwd)) {
        remoteSessionActions(sessionId)?.stop();
        return;
      }
      if (!managed) {
        const stopping = orchestrator.stopForSession(sessionId);
        if (stopping) {
          void stopping.catch(console.error);
          return stopping;
        }
      }
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      turnGen.current.set(sessionId, (turnGen.current.get(sessionId) ?? 0) + 1);
      flushHarnessEvents();
      const cancelling = Promise.all(
        (session ? sessionChildHarnesses(session) : []).map(async (id) => {
          try {
            await cancelHarnessTurn(id, sessionId);
          } finally {
            await stopHarnessSession(id, sessionId);
          }
        }),
      );
      const checkpointFinished = session
        ? finishSessionTurn(sessionId, sessionWorkCwd(session), {
            after: cancelling.catch(() => undefined),
          })
        : Promise.resolve();
      void cancelling.catch(console.error);
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const stopped = stopStreaming(s);
          const completed = isPreparingHandoff(stopped)
            ? completeHandoff(stopped, buildDeterministicHandoff(stopped))
            : stopped;
          const ready = { ...completed, worktreePreparing: undefined };
          return ready.queuedMessages?.length
            ? { ...ready, queueStatus: "paused" }
            : ready;
        }),
      );
      if (session) {
        notifyReviewChanged(sessionId);
        nudgeWorkspace(sessionWorkCwd(session));
        notifyGitChanged();
        nudgeWatchedFiles();
        window.setTimeout(() => nudgeWatchedFiles(), 150);
      } else {
        notifyReviewChanged(sessionId);
      }
      return Promise.all([cancelling, checkpointFinished]);
    },
    [flushHarnessEvents],
  );
  // The delegation tree (H4): workers' questions go to the Mono that delegated them, and Ash's Stop on a Mono with
  // work out stops everything beneath it (monos/hooks/useDelegationTree.ts).
  const delegationTree = useDelegationTree({
    sessions,
    sessionsRef,
    setSessions,
    tracker: () => delegationsRef.current,
    batches: () => monoCompletionBatches.current,
    queueWake: (owner, message) =>
      queueMonoSessionCompletionRef.current(owner, message),
    stopSession: (id, managed) => onStop(id, managed),
    retryTurn: (id) => retryFailedTurnRef.current(id),
    openMono: onOpenMono,
    monoView: () => monoViewIdRef.current,
    showLaunched: showMonoLaunchedSession,
    openSession: openReminderSession,
  });
  const onStopFromUser = delegationTree.stopFromUser;

  // The real-Claude test bench (scripts/hub-realtest.mjs): a dev copy whose verify plan names a driver folder takes Ash's
  // scripted actions through the same handlers his composer, Stop button and rail use. No plan reaches the daily app.
  const verifyDriverHost = useRef<VerifyDriverHost | null>(null);
  verifyDriverHost.current = {
    sessions: () => sessionsRef.current,
    openMono: async (monoId) => {
      await onOpenMono(monoId);
      return monoViewIdRef.current ?? null;
    },
    submit: (sessionId, text) => onSubmit(sessionId, text),
    stop: (sessionId) => onStopFromUser(sessionId),
    showHub: (selection) => {
      // The coding team is the project's folder with its Sessions list, opened as Ash's click on it does.
      if (selection.item === "coding-team" && selection.project !== NO_PROJECT) return openCodingTeam(selection.project);
      closeMonoView();
      setHubSelection(selection);
    },
    startCodingTeamChat: (projectId, runtimeMode) => startCodingTeamChat(projectId, runtimeMode),
    // A bench scene's own mode for a Mono's chat, set and put back by the run (dev copy only).
    setRuntimeMode: (sessionId, runtimeMode) => onRuntimeModeChange(sessionId, runtimeMode),
    // Called after this render, so onApproval (declared below) is set by then.
    // bench: Allow, or Deny when the run refuses a permission card.
    approve: (sessionId, requestId, decision) => onApproval(sessionId, requestId, decision ?? "allow"),
    // The run's teardown: the sidebar's Archive, no confirm. Declared below, so read through its ref.
    archive: (sessionId) => removeSessionRef.current(sessionId, "archive", true),
    openSession: (sessionId, owner) => {
      const actions = delegationActions();
      if (owner && actions) actions.openChild(owner, sessionId);
      else void Promise.resolve(openReminderSession(sessionId)).catch(() => undefined);
    },
    setDefaults: (model, effort) => {
      try {
        localStorage.setItem("monocode.lastModel", JSON.stringify({ harness: "claude", model }));
        localStorage.setItem("monocode.defaultModels", JSON.stringify({ claude: model }));
        localStorage.setItem("monocode.lastModelSettings", JSON.stringify({ effort }));
      } catch {
        // no storage: the bench's claude wrapper still holds every turn to the budget
      }
      for (const session of sessionsRef.current) {
        if (session.harness !== "claude") continue;
        if (session.model !== model) onModelChange(session.id, "claude", model);
        if (session.modelSettings?.effort !== effort)
          onModelSettingsChange(session.id, { ...(session.modelSettings ?? {}), effort });
      }
    },
  };
  useEffect(() => {
    if (!verifyDriverEnabled()) return;
    return startVerifyDriver({
      sessions: () => verifyDriverHost.current!.sessions(),
      openMono: (monoId) => verifyDriverHost.current!.openMono(monoId),
      submit: (sessionId, text) => verifyDriverHost.current!.submit(sessionId, text),
      stop: (sessionId) => verifyDriverHost.current!.stop(sessionId),
      openSession: (sessionId, owner) => verifyDriverHost.current!.openSession(sessionId, owner),
      setDefaults: (model, effort) => verifyDriverHost.current!.setDefaults(model, effort),
      showHub: (selection) => verifyDriverHost.current!.showHub(selection),
      startCodingTeamChat: (projectId, runtimeMode) =>
        verifyDriverHost.current!.startCodingTeamChat?.(projectId, runtimeMode) ?? null,
      setRuntimeMode: (sessionId, runtimeMode) =>
        verifyDriverHost.current!.setRuntimeMode?.(sessionId, runtimeMode),
      approve: (sessionId, requestId, decision) => verifyDriverHost.current!.approve?.(sessionId, requestId, decision),
      archive: async (sessionId) => (await verifyDriverHost.current!.archive?.(sessionId)) ?? false,
    });
  }, []);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      const focusedBusySessionId = () => {
        const agentId = monoViewIdRef.current;
        if (agentId) {
          return sessionsRef.current.find((session) => session.id === agentId)
            ?.busy
            ? agentId
            : undefined;
        }
        return focusedBusyAgentSessionId(
          activeTabIdRef.current,
          tabsRef.current,
          sessionsRef.current,
          projectTerminalFocusedRef.current,
        );
      };
      const target = event.target instanceof Element ? event.target : null;
      const inTerminal = Boolean(target?.closest(".monocode-terminal"));
      const activeTabId = activeTabIdRef.current;
      const sessionId = focusedBusySessionId();
      if (
        !sessionId ||
        !shouldStopFocusedTurnOnEscape(event, {
          inTerminal,
          focusedSessionBusy: true,
        })
      ) {
        return;
      }

      // Other surfaces (drag/reorder included) can claim Escape later in the
      // same keydown dispatch. Defer the destructive stop until every handler
      // has had a chance to preventDefault, then verify focus did not move.
      deferUnhandledEscape(event, () => {
        const stillFocusedSessionId = focusedBusySessionId();
        if (
          activeTabIdRef.current !== activeTabId ||
          stillFocusedSessionId !== sessionId
        ) {
          return;
        }
        onStopFromUser(sessionId);
      });
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onStopFromUser]);

  // Returns false when the decision was not sent (the call is gone), so the phone is
  // told the truth and the call stays answerable.
  const onApproval = useCallback(
    (sessionId: string, requestId: number, decision: ApprovalDecision): boolean => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.worktreeRemoved) return false;
      // An approval a habit's hidden run asked for, put to the user in the
      // Mono's chat: answer the run, and settle the question in the chat.
      if (isMonoSession(sessionId)) {
        const asked = session.blocks.find(
          (block) => block.monoHabit && block.approval?.requestId === requestId,
        );
        if (asked) {
          const relay = takeRelayedApproval(sessionId, requestId);
          const run = relay
            ? sessionsRef.current.find((s) => s.id === relay.runId)
            : undefined;
          if (relay && run)
            respondHarnessApproval(
              run.harness,
              run.id,
              relay.requestId,
              decision,
            );
          decideMonoBlockRef.current(
            sessionId,
            asked.id,
            relay && run
              ? decision === "deny"
                ? "deny"
                : "allow"
              : "cancelled",
          );
          // No relay waiting: the block was settled as cancelled, the tool did not run.
          return !!(relay && run);
        }
      }
      if (remoteProjectFor(session.cwd)) {
        const actions = remoteSessionActions(sessionId);
        if (!actions) return false;
        return actions.approve(requestId, decision);
      }
      return respondHarnessApproval(session.harness, sessionId, requestId, decision);
    },
    [],
  );
  mobileApprovalRef.current = onApproval;

  const onQuestionReply = useCallback(
    (sessionId: string, requestId: number, reply: UserQuestionReply) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session || session.worktreeRemoved) return;
      if (remoteProjectFor(session.cwd)) {
        remoteSessionActions(sessionId)?.answer(requestId, reply);
        return;
      }
      respondHarnessQuestion(session.harness, sessionId, requestId, reply);
    },
    [],
  );

  // WP-212: Home's box uses the Chief of Staff's own chat, the same session the sidebar opens.
  useEffect(() => setHomeChiefHost({
    ensure: (monoId, projectId) => {
      const sessionHost = {
        home: homeDir,
        load: ensureOpenSession,
        create: (path: string) => newDefaultSession(path),
        add: (created: Session) => {
          sessionsRef.current = [...sessionsRef.current, created];
          setSessions(sessionsRef.current);
        },
      };
      // Dropwave: a project home's box starts in the Chief of Staff's own chat for that project.
      const project = projectId ? hubData().listProjects().find((entry) => entry.id === projectId) : undefined;
      return project ? ensureMonoProjectSession(monoId, project, sessionHost) : ensureMonoSession(monoId, sessionHost);
    },
    submit: (sessionId, text) => submitSession(sessionId, text),
    answer: (sessionId, requestId, reply) => onQuestionReply(sessionId, requestId, reply),
    read: (sessionId) => {
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return undefined;
      const pending = session.pendingQuestion;
      return {
        id: session.id,
        busy: session.busy,
        blocks: session.blocks.map((block) => ({
          role: block.role,
          text: block.text,
          internal: block.internal,
          draft: block.draft,
          streaming: block.streaming,
          monoNote: block.monoNote,
          monoSessionCompletion: block.monoSessionCompletion,
          monoCheck: block.monoCheck,
        })),
        pendingQuestion: pending
          ? {
              requestId: pending.requestId,
              questions: pending.questions.map((question) => ({
                id: question.id,
                prompt: question.prompt,
                options: question.options.map((option) => ({ id: option.id, label: option.label })),
              })),
            }
          : undefined,
      };
    },
  }), [ensureOpenSession, submitSession, onQuestionReply, homeDir]);
  useEffect(() => {
    notifyHomeChief();
  }, [sessions]);

  // Autopilot: covered chats take their own recommendation (red list waits for Ash), agents resume at a limit's
  // reset, and armed resumes come back after a restart (features/autopilot).
  useAutopilot({
    sessions,
    sessionsRef,
    updateSession: (id, change) =>
      updateSessionState(sessionsRef, setSessions, (all) =>
        all.map((entry) => (entry.id === id ? change(entry) : entry)),
      ),
    approve: onApproval,
    openSession: ensureOpenSession,
    isDelegated: (id) => !!delegationsRef.current?.openRowFor(id),
    openChat: (id) => {
      const mono = monoForSession(id);
      if (mono) void onOpenMono(mono.id);
      else if (!focusOpenSession(id)) void onSelectHistorySession(id);
    },
  });

  const onQuestionInteraction = useCallback(
    (sessionId: string, requestId: number) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (session && remoteProjectFor(session.cwd)) return;
      if (session && !session.worktreeRemoved)
        keepHarnessQuestionOpen(session.harness, sessionId, requestId);
    },
    [],
  );

  // Today's "Waiting on you" (hub/model/waitingChats.ts): the chats whose agent asked Ash something. The store reads the
  // chats as they change and borrows these hands to answer in place, send his words into a chat, or open it.
  // A worker's question is its Lead's, never Today's (H4): the delegation tree's router decides which.
  const delegationQuestions = delegationTree.questions;
  useEffect(
    () =>
      IS_HUB_BUNDLE
        ? setWorkerQuestionRouter(delegationQuestions.routes)
        : undefined,
    [delegationQuestions],
  );
  // r101 (2, 8): a Mono asked how things stand gets the live count of its Inbox asks with the question (wire only).
  useEffect(() => {
    if (!IS_HUB_BUNDLE) return;
    setTurnTextDecorator((id, text) => {
      // r103 (3, 4): "running" and "done" from the app: the Lead's own chat and every chat as they are now.
      const all = sessionsRef.current;
      const chat = all.find((s) => s.id === id);
      return withInboxCount(id, text, (sid) => !!monoForSession(sid), undefined, chat ? { blocks: chat.blocks, sessions: all } : undefined);
    });
    return () => setTurnTextDecorator(undefined);
  }, []);
  useEffect(() => {
    if (IS_HUB_BUNDLE) noteChats(sessions);
    // A Mono whose last turn failed (out of credits, overloaded, a limit) shows on the rail, Today and Being built.
    noteMonoFailures(sessions);
  }, [sessions]);
  // The one Try again, for the failure card and for harness self-repair: Ash's message held by the failure goes in
  // again; a turn that failed before the agent did anything sends its message again (a plain "continue" would take up
  // whatever the agent was on before); else it carries on.
  const retryFailedTurn = useCallback(
    (id: string) => {
      const session = sessionsRef.current.find((entry) => entry.id === id);
      if (!session || session.busy) return false;
      if (session.queueStatus === "paused" && session.queuedMessages?.length) onResumeQueue(id);
      else {
        const unsent = failedTurnMessage(session);
        if (unsent) return onSubmit(id, unsent.text);
        if (session.usageLimit) onUsageLimitResume(id);
        else return onSubmit(id, CONTINUE_PROMPT);
      }
      return true;
    },
    [onResumeQueue, onUsageLimitResume, onSubmit],
  );
  retryFailedTurnRef.current = retryFailedTurn;
  useEffect(
    () =>
      setMonoFailuresHost({
        retry: retryFailedTurn,
        open: (monoId) => void onOpenMono(monoId),
      }),
    [retryFailedTurn, onOpenMono],
  );
  // Once a launch: a waiting chat whose conversation was deleted (by any path) leaves Today.
  useEffect(() => {
    if (!IS_HUB_BUNDLE) return;
    void pruneWaitingChats(async (id) =>
      sessionsRef.current.some((s) => s.id === id) || (await readSession(id)) !== null,
    );
  }, []);
  useEffect(() => {
    if (!IS_HUB_BUNDLE) return;
    return setWaitingChatsHost({
      liveQuestion: (id) => sessionsRef.current.find((s) => s.id === id)?.pendingQuestion,
      respond: (id, requestId, reply) => onQuestionReply(id, requestId, reply),
      // r99 (Critiquito 3): one row of a card answered, as an app note into a Lead or Mono chat (hidden from Ash).
      note: async (id, message) => {
        if (!isOrchestratorChat(id)) return false;
        await queueMonoSessionCompletionRef.current(id, message);
        return true;
      },
      // r77: a held tool call answered from the Waiting card, the same as its own Allow/Deny.
      decide: (id, requestId, decision) => onApproval(id, requestId, decision),
      send: async (id, text) => {
        const session = sessionsRef.current.find((s) => s.id === id) ?? (await ensureOpenSessionRef.current(id));
        if (!session) return false;
        // Mid-turn it steers or queues, as a message typed in the composer would.
        if (!(await Promise.resolve(submitSessionRef.current(session.id, text, [], { followsUp: true })))) return false;
        await upsertSession(sessionsRef.current.find((s) => s.id === session.id) ?? session);
        return true;
      },
      open: (id, projectId) => {
        const mono = monoForSession(id);
        if (mono) return void onOpenMono(mono.id);
        // The hub steps aside for the project's coding view, where the chat opens.
        const project = hubData().listProjects().find((p) => p.id === projectId && p.folder);
        if (project) setHubSelection({ project: project.id, item: "coding-team" });
        void openReminderSession(id).catch(() => undefined);
      },
    });
  }, [onQuestionReply, onOpenMono, openReminderSession, onApproval]);

  // Pages (features/pages/model/pageActions.ts): a kept page's taps borrow the same hands as Ash's own: the question
  // reply in a chat, the composer's send, a chat's or a Mono's own view.
  useEffect(() => {
    if (!IS_HUB_BUNDLE) return;
    return setPageActionsHost({
      liveQuestion: (id) => sessionsRef.current.find((s) => s.id === id)?.pendingQuestion,
      respond: (id, requestId, reply) => onQuestionReply(id, requestId, reply),
      send: async (id, text) => {
        const session = sessionsRef.current.find((s) => s.id === id) ?? (await ensureOpenSessionRef.current(id));
        if (!session) return false;
        if (!(await Promise.resolve(submitSessionRef.current(session.id, text, [], { followsUp: true })))) return false;
        await upsertSession(sessionsRef.current.find((s) => s.id === session.id) ?? session);
        return true;
      },
      open: (id) => {
        const mono = monoForSession(id);
        if (mono) void onOpenMono(mono.id);
        else if (!focusOpenSession(id)) void onSelectHistorySession(id);
      },
      openMono: (monoId) => void onOpenMono(monoId),
    });
  }, [onQuestionReply, onOpenMono, focusOpenSession, onSelectHistorySession]);

  const onOpenApprovalSession = useCallback(
    (sessionId: string) => {
      const parentId =
        sessionsRef.current.find((session) => session.id === sessionId)
          ?.orchestrationLeadId ?? orchestrator.forSession(sessionId)?.leadId;
      if (parentId && parentId !== sessionId) {
        setInspectedWorkerId(sessionId);
        if (!focusOpenSession(parentId)) void onSelectHistorySession(parentId);
      } else if (!focusOpenSession(sessionId)) {
        void onSelectHistorySession(sessionId);
      }
    },
    [focusOpenSession, onSelectHistorySession],
  );

  useEffect(() => {
    setSessions((prev) => attachOrchestrationWorkers(prev, orchestrationRuns));
  }, [orchestrationRuns]);

  useEffect(() => {
    const next = consolidateOrchestrationTabs(
      tabs,
      activeTabId,
      orchestrationRuns,
    );
    if (next.tabs !== tabs) setTabs(next.tabs);
    // Reconciling a run's worker tabs is bookkeeping, not navigation: it never closes a Mono's chat over them (r61).
    if (next.activeTabId !== activeTabId) setActiveTabIdState(next.activeTabId);
  }, [tabs, activeTabId, orchestrationRuns]);

  useLayoutEffect(() => {
    orchestrator.bind({
      session: (id) => sessionsRef.current.find((session) => session.id === id),
      sessions: () => sessionsRef.current,
      choices: () =>
        HARNESSES.filter(isHarnessAvailable).map((harness) => ({
          harness,
          models: modelsFor(harness).map(({ id, name }) => ({ id, name })),
        })),
      // WP-141 round 6: the CLIs on Never use for a folder, so an approved card is filtered before a worker starts.
      crewPolicy: (folder, leadId) =>
        crewPolicyForLead(folder, leadId, {
          project: (owner) => projectWorkerDefault(hubProjectIdFor(owner) ?? owner),
          system: () => systemWorkerDefault(),
          // WP-141 round 11: hub project folders, so a Lead in a worktree finds the project's worker default.
          roots: hubProjectFolders(),
        }),
      // WP-91: an irreversible step's decision sits under the hub project of the run's folder, like a delegation does.
      decisionProject: hubProjectIdFor,
      createWorker: async (run, task) => {
        const projectCwd = orchestrationProjectCwd(run);
        const leadCheckoutCwd = orchestrationCheckoutCwd(run);
        const lead = sessionsRef.current.find(
          (session) => session.id === run.leadId,
        );
        if (!lead) throw new Error("Lead session is unavailable");
        const workspace =
          task.workspacePolicy === "shared"
            ? workspaceIdentity(projectCwd, leadCheckoutCwd)
            : task.workspace
              ? await listWorktrees(leadCheckoutCwd).then((listed) => {
                  const tree = listed.worktrees.find(
                    (entry) =>
                      pathKey(entry.path) ===
                      pathKey(task.workspace!.checkoutCwd),
                  );
                  if (!tree)
                    throw new Error(
                      "This worker's retained worktree is missing. Its saved changes cannot be retried automatically.",
                    );
                  return workspaceIdentity(
                    projectCwd,
                    tree.path,
                    tree.branch ?? task.workspace!.branch,
                  );
                })
              : await createOrchestrationWorktree(
                  leadCheckoutCwd,
                  orchestrationWorktreeBranchName(task.id),
                  // WP-82: the crew id is the lease holder.
                  task.id,
                ).then((tree) => {
                  // WP-138: the worker's header can say the include files were copied.
                  rememberWorktreeInclude(task.sessionId, tree);
                  return workspaceIdentity(
                    projectCwd,
                    tree.path,
                    tree.branch ?? undefined,
                  );
                });
        const checkoutCwd = workspace.checkoutCwd;
        const scratchDir = await invoke<string>("control_attach_worker", {
          leadId: run.leadId,
          sessionId: task.sessionId,
        });
        const existing = sessionsRef.current.find(
          (session) => session.id === task.sessionId,
        );
        if (existing) {
          if (
            existing.harness !== task.harness ||
            existing.model !== task.model ||
            !sameProjectPath(existing.cwd, projectCwd) ||
            (!existing.worktreeRemoved &&
              !sameProjectPath(sessionWorkCwd(existing), checkoutCwd))
          )
            throw new Error(
              "This worker's configuration changed. Restore its approved harness, model and project before retrying.",
            );
          // The lead's runtime mode governs its agents, including across a
          // change mid-run: auto stays auto, supervised asks the lead.
          const synced = {
            ...existing,
            cwd: projectCwd,
            worktreeCwd: sameProjectPath(projectCwd, checkoutCwd)
              ? undefined
              : checkoutCwd,
            branch: workspace.branch,
            worktreeRemoved: false,
            runtimeMode: lead.runtimeMode,
            orchestrationLeadId: run.leadId,
          };
          await upsertSession(synced);
          const next = sessionsRef.current.map((session) =>
            session.id === synced.id ? synced : session,
          );
          sessionsRef.current = next;
          setSessions(next);
          return { scratchDir, workspace };
        }
        const restored = await getSession(task.sessionId);
        if (
          restored &&
          (restored.harness !== task.harness || restored.model !== task.model)
        )
          throw new Error(
            "The saved worker no longer matches its approved model. Create a new assignment.",
          );
        const fresh = {
          ...newSession(task.harness, projectCwd, task.model, lead.runtimeMode),
          ...(sameProjectPath(projectCwd, checkoutCwd)
            ? {}
            : { worktreeCwd: checkoutCwd, branch: workspace.branch }),
          ...(task.modelSettings
            ? {
                modelSettings: mergeModelSettings(
                  resolveModel(task.harness, task.model),
                  task.modelSettings,
                ),
              }
            : {}),
        };
        const base = restored
          ? {
              ...restored,
              busy: false,
              cwd: projectCwd,
              worktreeCwd: sameProjectPath(projectCwd, checkoutCwd)
                ? undefined
                : checkoutCwd,
              branch: sameProjectPath(projectCwd, checkoutCwd)
                ? undefined
                : workspace.branch,
              worktreeRemoved: false,
              runtimeMode: lead.runtimeMode,
            }
          : {
              ...fresh,
              id: task.sessionId,
              title: task.title,
            };
        const worker = { ...base, orchestrationLeadId: run.leadId };
        // WP-134: a More agents worker is routed from the row before its saved ACP session is bound.
        bindRestoredHarness(worker);
        await upsertSession(worker);
        const next = [...sessionsRef.current, worker];
        sessionsRef.current = next;
        setSessions(next);
        // Workers belong to the lead's agent panel; no workspace tab is created.
        return { scratchDir, workspace };
      },
      integrateWorker: async (run, task) => {
        const fromCwd = task.workspace?.checkoutCwd;
        if (!fromCwd)
          throw new Error("This worker's isolated checkout is unavailable");
        const session = sessionsRef.current.find(
          (entry) => entry.id === task.sessionId,
        );
        if (session)
          await Promise.all(
            sessionChildHarnesses(session).map((harness) =>
              stopHarnessSession(harness, task.sessionId),
            ),
          );
        await invoke("harness_kill", { sessionId: task.sessionId });
        await invoke("control_turn_finished", { sessionId: task.sessionId });
        await flushSessionCheckpoint(task.sessionId);
        const listed = await listWorktrees(orchestrationCheckoutCwd(run));
        const workerTree = listed.worktrees.find((tree) =>
          sameProjectPath(tree.path, fromCwd),
        );
        const leadTree = listed.worktrees.find((tree) =>
          sameProjectPath(tree.path, orchestrationCheckoutCwd(run)),
        );
        if (!workerTree || !leadTree)
          throw new Error(
            "The worker or lead checkout is no longer registered. The worker worktree was kept.",
          );
        if (workerTree.head !== leadTree.head)
          throw new Error(
            "The worker or lead branch moved while this task was running. The worker worktree was kept for manual review.",
          );
        return applySessionCheckpoint(
          task.sessionId,
          fromCwd,
          orchestrationCheckoutCwd(run),
        );
      },
      // WP-91: WP-40's check on this worker's own copy, in its own words, so the run's verdict has a real input. The
      // check runs in the worker's checkout (or the lead's, for a shared task), through the same runner WP-40 uses;
      // only a project with no check returns null.
      gateWorker: async (run, task) => {
        const checkout = task.workspace?.checkoutCwd ?? orchestrationCheckoutCwd(run);
        const projectId =
          hubProjectIdFor(orchestrationProjectCwd(run)) ??
          orchestrationProjectCwd(run);
        return workerGateWord(runTaskGate, {
          projectId,
          checkout,
          signedOff: false,
        });
      },
      cleanupWorker: async (run, task, onlyIfUnchanged) => {
        const workspace = task.workspace;
        if (!workspace || workspace.kind !== "worktree") return true;
        const path = workspace.checkoutCwd;
        await flushSessionCheckpoint(task.sessionId);
        const listed = await listWorktrees(orchestrationCheckoutCwd(run));
        const exists = listed.worktrees.some(
          (tree) => pathKey(tree.path) === pathKey(path),
        );
        if (!exists && onlyIfUnchanged) return false;
        const workerTree = listed.worktrees.find(
          (tree) => pathKey(tree.path) === pathKey(path),
        );
        const leadTree = listed.worktrees.find((tree) =>
          sameProjectPath(tree.path, orchestrationCheckoutCwd(run)),
        );
        if (
          exists &&
          (!workerTree || !leadTree || workerTree.head !== leadTree.head)
        ) {
          if (onlyIfUnchanged) return false;
          throw new Error(
            "The worker or lead branch moved before cleanup. The worker worktree was kept for manual review.",
          );
        }
        if (onlyIfUnchanged) {
          const safe = await sessionCheckpointCleanupSafe(task.sessionId, path);
          if (!safe) return false;
        } else if (exists) {
          // Re-verify immediately before destructive cleanup. The operation is
          // idempotent, so this also finishes a partially applied integration.
          await applySessionCheckpoint(
            task.sessionId,
            path,
            orchestrationCheckoutCwd(run),
          );
        }

        if (exists) {
          onStop(task.sessionId, true);
          const session = sessionsRef.current.find(
            (entry) => entry.id === task.sessionId,
          );
          if (session) {
            await Promise.all(
              sessionChildHarnesses(session).map((harness) =>
                stopHarnessSession(harness, task.sessionId),
              ),
            );
          }
          await invoke("harness_kill", { sessionId: task.sessionId });
          await invoke("control_turn_finished", {
            sessionId: task.sessionId,
          });
          await flushSessionWrites();
          checkOpenWorktreeFiles(path);
          const removed = await removeOrchestrationWorktree(
            orchestrationCheckoutCwd(run),
            path,
          );
          const affected = new Set([task.sessionId, ...removed.sessionIds]);
          sessionsRef.current = sessionsRef.current.map((session) =>
            affected.has(session.id)
              ? detachSessionWorktree(session, removed.projectCwd, path)
              : session,
          );
          setSessions(sessionsRef.current);
          const detachSummary = (entry: SessionSummary) =>
            affected.has(entry.id)
              ? detachSessionWorktree(entry, removed.projectCwd, path)
              : entry;
          setHistory((current) => current.map(detachSummary));
          setStoredLinkedSessions((current) => current.map(detachSummary));
          if (session)
            await Promise.allSettled(
              sessionChildHarnesses(session).map((harness) =>
                forgetHarnessSession(harness, task.sessionId),
              ),
            );
        } else {
          const detached = sessionsRef.current.find(
            (entry) => entry.id === task.sessionId,
          );
          if (detached && !detached.worktreeRemoved) {
            const next = detachSessionWorktree(
              detached,
              orchestrationProjectCwd(run),
              path,
            );
            sessionsRef.current = sessionsRef.current.map((entry) =>
              entry.id === task.sessionId ? next : entry,
            );
            setSessions(sessionsRef.current);
            if (shouldPersistSession(next)) await upsertSession(next);
          }
        }
        if (workspace.branch)
          await removeOrchestrationBranch(
            orchestrationCheckoutCwd(run),
            workspace.branch,
          );
        await forgetSessionCheckpoint(task.sessionId);
        notifyReviewChanged(task.sessionId);
        return true;
      },
      submit: (id, text, done) => {
        void submitWithSettlement({
          submit: (onSettled) => {
            let acceptance: SubmissionAcceptance = false;
            // Commit an immediate turn before another scheduler update. A
            // deferred submission flushes its own turn after synchronization.
            flushSync(() => {
              acceptance = submitSession(id, text, [], {
                managed: true,
                onSettled,
              });
            });
            return acceptance;
          },
          onSettled: done,
          rejectionMessage:
            "The selected agent session could not accept this turn.",
        }).catch(console.error);
      },
      steer: async (id, text) => {
        flushHarnessEvents();
        const session = sessionsRef.current.find((entry) => entry.id === id);
        if (!session) throw new Error("This agent is no longer available");
        if (!session.busy)
          throw new Error(
            "This agent is not running a turn; send it a fresh one with message.",
          );
        if (
          !isLiveHarness(session.harness) ||
          !canSteerHarness(session.harness) ||
          session.registryAgentId
        )
          throw new Error(
            `${session.harness} cannot take guidance mid-turn. Wait for the turn to finish, then use message.`,
          );
        // Record it on the worker before dispatch, so its own transcript shows
        // why it changed course even if the harness call then fails.
        const next = sessionsRef.current.map((entry) =>
          entry.id === id ? appendSteerUser(entry, text) : entry,
        );
        sessionsRef.current = next;
        setSessions(next);
        await steerHarnessTurn({
          harness: session.harness,
          sessionId: id,
          cwd: sessionWorkCwd(session),
          model: session.model,
          modelSettings: session.modelSettings,
          text,
        });
      },
      respondApproval: (id, requestId, decision) => {
        const session = sessionsRef.current.find((entry) => entry.id === id);
        if (session)
          respondHarnessApproval(session.harness, id, requestId, decision);
      },
      answerQuestion: (id, requestId, reply) => {
        const session = sessionsRef.current.find((entry) => entry.id === id);
        if (session)
          respondHarnessQuestion(session.harness, id, requestId, reply);
      },
      stop: async (id) => {
        const session = sessionsRef.current.find((entry) => entry.id === id);
        onStop(id, true);
        try {
          if (session)
            await Promise.all(
              sessionChildHarnesses(session).map((harness) =>
                stopHarnessSession(harness, id),
              ),
            );
        } finally {
          // Also reap processes left behind by a renderer reload, before the
          // corresponding session has been restored in this window.
          await invoke("harness_kill", { sessionId: id });
          await invoke("control_turn_finished", { sessionId: id });
        }
      },
    });
  }, [checkOpenWorktreeFiles, submitSession, onStop, flushHarnessEvents]);

  useEffect(() => {
    orchestrator.sync();
  }, [sessions]);

  // WP-91: a decision answered anywhere (the Inbox, Home or a chat) starts the irreversible step that waited on it.
  useEffect(
    () =>
      watchDecisions(
        (event, handler) => listen(event, () => handler()),
        () => orchestrator.decisionsChanged(),
      ),
    [],
  );

  const stopSessionRef = useRef(onStop);
  stopSessionRef.current = onStop;
  onStopRef.current = onStop;
  const delegationTreeRef = useRef(delegationTree);
  delegationTreeRef.current = delegationTree;
  const controlRequestRef = useRef<
    | ((payload: {
        namespace: string;
        sessionId: string;
        requestId: string;
        action: string;
        input: Record<string, unknown>;
      }) => Promise<unknown>)
    | undefined
  >(undefined);
  // H8: every chat's open worker rows (a project's count, its checkouts and the ports in use): the recent rows the
  // UI reads, and the ones this window launched since.
  const openDelegationRows = (): Delegation[] => {
    const byId = new Map<string, Delegation>();
    for (const row of [...delegationRows(), ...(delegationsRef.current?.known() ?? [])]) {
      const seen = byId.get(row.id);
      if (!seen || row.version >= seen.version) byId.set(row.id, row);
    }
    return [...byId.values()].filter(isOpenDelegation);
  };
  // WP-171: what a waiting task of a fan-out waits for (the tasks that provide what it requires, delivered and checked).
  const fanout = useFanoutHost({
    rows: () => [...delegationRows(), ...(delegationsRef.current?.known() ?? [])],
    folder: (session) => sessionsRef.current.find((entry) => entry.id === session)?.cwd,
  });
  // WP-171: the waiting card reads the same dependency the pump does, so a held task is not labelled as a free worker.
  setQueueDependency(fanout.dependency);
  useEffect(() => () => setQueueDependency(undefined), [fanout]);
  const providerRoomNow = (harness: string) =>
    workerRoom(harness, {
      now: Date.now(),
      usageFor: (entry) => getCachedRateLimits(entry.provider, entry.id),
      // WP-16: on the DeepSeek launcher a Claude account's sign-in doesn't hold a worker back.
      elsewhere: harness === "claude" && claudeRunsOnSubscriptionBridge(),
    });
  // Waiting workers start by themselves, in order, when a worker frees up or a provider's limit resets (H8).
  const pumpingWorkers = useRef(false);
  const pumpWorkersNow = useCallback(() => {
    if (pumpingWorkers.current || !controlRequestRef.current || !delegationsRef.current) return;
    if (!queuedWorkers().length) return;
    pumpingWorkers.current = true;
    void pumpWorkers({
      openRows: openDelegationRows,
      room: providerRoomNow,
      dependency: fanout.dependency,
      settle: fanout.settle,
      // A Lead's chat that isn't open in this window keeps its workers waiting until it is.
      canStart: (job) => sessionsRef.current.some((session) => session.id === job.ownerSession),
      start: (job: QueuedWorker) => {
        // Its first ask answered "waiting"; this one starts it under the same request, so the same chat and card.
        appReceipts.current.delete(`${job.ownerSession}:${job.requestId}`);
        return controlRequestRef.current!({
          namespace: "app",
          sessionId: job.ownerSession,
          requestId: job.requestId,
          action: "tasks.delegate",
          // Hivra WP-10: a worker queued before briefs carried an intent and a goal still starts.
          // WP-171: the link and the quoted request are the app's, not an agent's. Mark after the spread, which drops it.
          input: markAppDelegate(withLegacyBriefParts(job.input, job.title)),
        });
      },
      failed: (job, error) => {
        console.warn(`A waiting worker (${job.title}) could not start`, error);
        // WP-171: a waiting task that is dropped is told to the chat that asked, once. A cap refusal never gets here.
        const line = droppedTaskLine(job, error);
        void queueMonoSessionCompletionRef.current(job.ownerSession, {
          id: `dropped-${job.id}`,
          text: `[MonoCode] ${line} (this is the app, not the person.)`,
          attachments: [],
          monoNote: { kind: "message", from: "Tasks", line: line.length > 160 ? `${line.slice(0, 157)}...` : line },
        });
      },
      // WP-171: a task that becomes held wakes the chat that asked, once per hold. A later hold uses a new id.
      held: (_job, note) => {
        const line = note.line;
        void queueMonoSessionCompletionRef.current(_job.ownerSession, {
          id: note.id,
          text: `[MonoCode] ${line} (this is the app, not the person.)`,
          attachments: [],
          monoNote: { kind: "message", from: "Tasks", line: line.length > 160 ? `${line.slice(0, 157)}...` : line },
        });
      },
    })
      .catch(console.error)
      .finally(() => {
        pumpingWorkers.current = false;
      });
  }, []);
  useEffect(() => {
    pumpWorkersNow();
  }, [sessions, pumpWorkersNow]);
  useEffect(() => {
    const offRows = subscribeDelegations(pumpWorkersNow);
    // A provider's reset changes no row: look again then, and now and then anyway.
    let timer = 0;
    const arm = () => {
      // WP-161: waiting builders also look at the machine again soon, so a pause that clears starts them, and the
      // Needs you line for a held disk reads a fresh sample.
      const resets = nextWake(providerRoomNow, Date.now());
      const recheck = nextHealthCheck(Date.now());
      const wake = resets === undefined ? recheck : recheck === undefined ? resets : Math.min(resets, recheck);
      timer = window.setTimeout(
        () => {
          pumpWorkersNow();
          arm();
        },
        Math.min(60_000, Math.max(1_000, (wake ?? Infinity) - Date.now())),
      );
    };
    // WP-161: a builder joining the queue (or a health read landing) sets the next look again, so a wait that began
    // after the timer was set is not left to the 60 second cap.
    const offPool = subscribeWorkerPool(() => {
      pumpWorkersNow();
      window.clearTimeout(timer);
      arm();
    });
    // WP-176: raising a spend limit starts a builder that was waiting on it, without waiting for the timer.
    const offSpend = subscribeSpend(pumpWorkersNow);
    arm();
    return () => {
      offRows();
      offPool();
      offSpend();
      window.clearTimeout(timer);
    };
  }, [pumpWorkersNow]);
  // WP-144: a brief held for a fresh-eyes review starts when the person approves or skips it. It is the same
  // tasks.delegate call asked again under the same request ID, with the call that was reviewed, the way a waiting
  // worker starts, so the checks, the worker limits and the waiting line all apply. The brief is kept with the review
  // (in the app's database), so a restart does not lose it.
  const steeringRef = useRef(steering);
  steeringRef.current = steering;
  useEffect(() => {
    const unbind = bindHeldStarter({
      canStart: (owner) =>
        !!controlRequestRef.current && sessionsRef.current.some((session) => session.id === owner),
      start: (owner, requestId, input) => {
        // Its first ask answered "waiting" and that answer is remembered; this one starts it.
        appReceipts.current.delete(`${owner}:${requestId}`);
        return controlRequestRef.current!({
          namespace: "app",
          sessionId: owner,
          requestId,
          action: "tasks.delegate",
          // WP-171: a held brief starts as the app's own call, so a fan-out task can keep its link.
          input: markAppDelegate({ ...input }),
        });
      },
    });
    // The Inbox and the chat that asked, for the review: the question, its close, the person's answer, a note to the chat.
    const unbindBackend = bindFreshEyesBackend(backendFrom(steeringRef.current.backend));
    const release = () => void releaseHeld();
    const off = subscribeFreshEyes(release);
    // What was left half done by the last run: reviewers that died with the window run again (or the person is asked),
    // and an approved brief starts. Again every half minute, for a start that failed and for a lease that ran out.
    const resume = () => {
      void resumeReviews();
      release();
    };
    resume();
    const timer = window.setInterval(resume, 30_000);
    // An answer given in the Inbox or Home reaches the review the same way a click on the crew card does. Only the
    // person's own answer counts (gate.ts isPersonAnswer): a chat answering ask_person for them does not.
    const offDecisions = watchDecisions(
      (event, handler) => listen(event, () => handler()),
      () => void syncHeldDecisions(),
    );
    return () => {
      window.clearInterval(timer);
      offDecisions();
      off();
      unbindBackend();
      unbind();
    };
  }, []);
  // A chat opened after a restart can take the brief it asked for.
  const openChatIds = useMemo(() => sessions.map((session) => session.id).join("\n"), [sessions]);
  useEffect(() => {
    void releaseHeld();
  }, [openChatIds]);
  // A worker the provider refused for its limit keeps its task (H8): with no other account to move to (E5), it
  // carries on by itself, once per refusal. A refusal that named no reset gets E5's (heldRetryAt): the latest usage
  // reading's, else five hours on; a fresh reading that shows room brings the retry forward.
  const heldWorkers = useRef(new Map<string, HeldSeen>());
  const heldSessions = (all: readonly Session[]) => {
    const open = new Set(openDelegationRows().filter((row) => !row.follow).map((row) => row.childSession));
    return all.filter((session) => session.usageLimit && !session.busy && open.has(session.id));
  };
  const readingFor = (session: Session) =>
    supportsProviderAccounts(session.harness)
      ? getCachedRateLimits(session.harness, session.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID)
      : undefined;
  useEffect(() => {
    for (const session of sessions) if (!session.usageLimit) heldWorkers.current.delete(session.id);
    for (const session of heldSessions(sessions)) {
      const plan = planHeld({
        limit: session.usageLimit!,
        seen: heldWorkers.current.get(session.id),
        now: Date.now(),
        reading: readingFor(session),
      });
      heldWorkers.current.set(session.id, plan.seen);
      const resetsAt = plan.arm;
      if (resetsAt == null) continue;
      updateSessionState(sessionsRef, setSessions, (all) =>
        all.map((entry) =>
          entry.id === session.id && entry.usageLimit
            ? { ...entry, usageLimit: { ...entry.usageLimit, resetsAt, resumeAtReset: true } }
            : entry,
        ),
      );
    }
  }, [sessions]);
  const onUsageLimitResumeRef = useRef(onUsageLimitResume);
  onUsageLimitResumeRef.current = onUsageLimitResume;
  useEffect(() => {
    // Early retry: the provider's usage reading, taken after the refusal, shows room again.
    const look = () => {
      const now = Date.now();
      for (const session of heldSessions(sessionsRef.current)) {
        const seen = heldWorkers.current.get(session.id);
        if (seen && retryNow(readingFor(session), seen.refusedAt, now)) onUsageLimitResumeRef.current(session.id);
      }
    };
    look();
    const timer = window.setInterval(look, 60_000);
    return () => window.clearInterval(timer);
  }, [sessions]);
  useEffect(() => {
    // The waiting queue lives in the app's database: survives a restart, shared by every window (worker_queue.rs).
    void setWorkerQueueBackend(tauriWorkerQueue);
  }, []);
  useEffect(() => {
    // WP-89: the line in force reads this project's crew rules, and a plugin's.
    // WP-141: the line sees the project's rules, then everything's (the project's come first, as the route reads them).
    setLineRulesSource(async (project) => {
      const own = await invoke<{ rules?: unknown; plugins?: unknown } | undefined>("crew_rules_get", {
        scope: "project",
        scopeId: project,
        project,
      });
      const system = await invoke<{ rules?: unknown } | undefined>("crew_rules_get", {
        scope: "system",
        scopeId: "system",
        project,
      }).catch(() => undefined);
      const rules = [
        ...(Array.isArray(own?.rules) ? own.rules : []),
        ...(Array.isArray(system?.rules) ? system.rules : []),
      ];
      return { rules, plugins: own?.plugins };
    });
    return () => setLineRulesSource(undefined);
  }, []);
  const removeSessionRef = useRef(onRemoveHistorySession);
  removeSessionRef.current = onRemoveHistorySession;

  useEffect(() => {
    const listening = listen<{
      id: string;
      namespace: string;
      sessionId: string;
      requestId: string;
      action: string;
      input: Record<string, unknown>;
    }>("monocode-control-request", ({ payload }) => {
      void runControlRequest(payload)
        .then(
          (result) =>
            invoke("control_reply", {
              id: payload.id,
              response: { ok: true, result },
            }),
          (error: unknown) =>
            invoke("control_reply", {
              id: payload.id,
              response: {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
            }),
        )
        .catch(console.error);
    });
    // A worker that waited for a free worker (H8) starts through its own delegate_task, asked again by the app.
    controlRequestRef.current = runControlRequest;
    // WP-15: Retry re-delegates through tasks.delegate, the same path as a redo, which keeps the attempt ledger.
    registerCrewDelegate((ownerSession, requestId, input) =>
      runControlRequest({
        namespace: "app",
        sessionId: ownerSession,
        requestId,
        action: "tasks.delegate",
        // WP-171: a retry is the app asking again, so it may carry the link and the request.
        input: markAppDelegate({ ...input }),
      }),
    );
    // WP-15: Stop uses tasks.cancel as the row's owner, so a busy child stops and a queued worker never starts.
    registerCrewCancel((ownerSession, requestId, input) =>
      runControlRequest({
        namespace: "app",
        sessionId: ownerSession,
        requestId,
        action: "tasks.cancel",
        input: { taskId: input.taskId, reason: input.reason },
      }),
    );
    async function runControlRequest(payload: {
      namespace: string;
      sessionId: string;
      requestId: string;
      action: string;
      input: Record<string, unknown>;
    }): Promise<unknown> {
      const handle = async () => {
        if (payload.namespace === "control") {
          return orchestrator.handle(
            payload.sessionId,
            payload.requestId,
            payload.action,
            payload.input,
          );
        }
        if (payload.namespace !== "app")
          throw new Error("Unknown CLI namespace");
        const source = sessionsRef.current.find(
          (session) => session.id === payload.sessionId,
        );
        if (
          !source ||
          source.inboxAsk ||
          source.orchestrationLeadId ||
          orchestrator.run(source.id)
        )
          throw new Error("This session cannot use the MonoCode app CLI");
        const key = `${source.id}:${payload.requestId}`;
        const signature = JSON.stringify([payload.action, payload.input]);
        const previous = appReceipts.current.get(key);
        if (previous) {
          if (previous.signature !== signature)
            throw new Error("Request ID was already used with different input");
          return previous.promise;
        }
        const sourceMono =
          monoForSession(source.id) ?? findMono(habitRunMono(source.id) ?? "");
        // A Mono's own team's folder is its own too (monoTeams.ts): its workers run there.
        const sourceTeam = sourceMono && codingTeamsOn() ? monoTeam(sourceMono.id) : undefined;
        const canAccessProject = (cwd: string) =>
          canAccessAgentAppProject(
            source,
            cwd,
            sourceMono ? [...sourceMono.projects, ...(sourceTeam ? [sourceTeam.folder] : [])] : undefined,
          );
        const sourceTurn = turnGen.current.get(source.id) ?? 0;
        const sourceTurns = isMonoSession(source.id)
          ? groupMonoTurns(source.blocks)
          : [];
        const sourceTurnId = sourceTurns[sourceTurns.length - 1]?.[0]?.id;
        const rememberSession = (entry: MonoSpawnedSession) => {
          // A habit run is thrown away when it ends; its launches go on the
          // report it posts to the Mono's chat instead.
          if (isHabitRun(source.id)) {
            noteHabitRunLaunch(source.id, entry);
            return;
          }
          if (!sourceTurnId) return;
          // A worker that waited (H8) already has its card, from the turn that asked for it.
          const asked = sessionsRef.current.find((session) => session.id === source.id);
          const waiting = asked?.blocks.some((block) =>
            block.monoSpawnedSessions?.some((card) => card.sessionId === entry.sessionId),
          );
          if (waiting) {
            // WP-89: a waiting card follows the start, including a usual model that names no source.
            const next = sessionsRef.current.map((session) => {
              if (session.id !== source.id) return session;
              let touched = false;
              const blocks = session.blocks.map((block) => {
                if (!block.monoSpawnedSessions?.some((card) => card.sessionId === entry.sessionId))
                  return block;
                let blockTouched = false;
                const monoSpawnedSessions = block.monoSpawnedSessions.map((card) => {
                  if (card.sessionId !== entry.sessionId) return card;
                  const updated = waitingCardAfterStart(card, entry);
                  if (!updated) return card;
                  blockTouched = true;
                  return updated;
                });
                if (!blockTouched) return block;
                touched = true;
                return { ...block, monoSpawnedSessions };
              });
              return touched ? { ...session, blocks } : session;
            });
            if (next.some((session, index) => session !== sessionsRef.current[index])) {
              sessionsRef.current = next;
              setSessions(next);
            }
            return;
          }
          const next = sessionsRef.current.map((session) =>
            session.id === source.id
              ? recordMonoSpawnedSession(session, sourceTurnId, entry)
              : session,
          );
          if (
            next.every(
              (session, index) => session === sessionsRef.current[index],
            )
          )
            return;
          sessionsRef.current = next;
          setSessions(next);
        };
        const monitorCompletion = async (
          monoId: string,
          sessionId: string,
          requestId: string,
          project: string,
          prompt: string,
          title: string,
          delegation?: DelegationMeta,
        ) => {
          // The stored row comes first: it is what survives a restart. The batch below is its cache for this run.
          // Ash OS gets the hub project id, which it resolves directly; a folder outside the hub's projects stays a path.
          // A Lead's worker goes under the leadership brief it is working on, so that brief's report waits for it
          // (followedBriefs.ts) and the tree shows it there (H4's cascade Stop).
          const ownerChat = sessionsRef.current.find((session) => session.id === monoId);
          const working = ownerChat
            ? currentLeadBrief(delegationsRef.current?.known() ?? [], ownerChat)
            : undefined;
          const launch = delegationsRef.current?.launch({
            ownerSession: monoId,
            ownerMono: monoForSession(monoId)?.id,
            batchId: sourceTurnId ?? `turn-${sourceTurn}`,
            requestId,
            childSession: sessionId,
            ...(working ? { parentId: working.id } : {}),
            project: delegation?.project ?? hubProjectIdFor(project) ?? project,
            title: delegation?.title ?? title,
            brief: prompt,
            ...(delegation?.askIds.length ? { askIds: delegation.askIds } : {}),
            ...(delegation?.goal ? { goal: delegation.goal } : {}),
            ...(delegation?.taskId ? { taskId: delegation.taskId } : {}),
            // WP-141: why the crew picked this CLI, kept on the row's first line for the Crew tab.
            ...(delegation?.pickReason ? { pickReason: delegation.pickReason } : {}),
            // WP-176 round 5: the redo's link is written with its row, in the same transaction, before its first turn.
            ...(delegation?.redoes ? { redoes: delegation.redoes.id } : {}),
            // A7: written on the row, not only in the worker's brief, so the store refuses a done settle without it even
            // when the turn settles through a restart's recovery path.
            ...(delegation ? { reviewRequired: true } : {}),
            by: `owner:${monoId}`,
          });
          const row = await launch?.row;
          // A redo whose link could not be recorded does not start: its turn would be judged without its parent.
          const refusal = redoLinkRefusal(delegation, row);
          if (refusal) throw new Error(refusal);
          // Dev-only (D5 scripted test): a worker started while a tester armed dev-faults/fail-next-workers runs, then
          // reports a failure. Off by default; see devFault.ts and docs/DEV-FAULTS.md.
          const fault = await takeWorkerFault();
          // A faulted worker is stopped soon after it starts (FAULT_STOP_MS), and that stop is its failure.
          const faultStop = faultStopper(fault, () => onStopRef.current(sessionId, true));
          const settle = monoCompletionBatches.current!.watch(
            { monoId, turn: sourceTurn },
            requestId,
            sessionId,
            // Its title names it in "still running: ..." while the others report (monoSessionCompletion.ts).
            { awaitAcceptance: true, generation: row?.generation ?? 1, title: delegation?.title ?? title },
          );
          // A7: a delegated worker's report has to end with its self-review (workerReview.ts) before the task settles.
          // One without it is asked for once — the same entry, so the report still goes out with this turn's others —
          // and a second miss settles failed with the plain reason, so a Lead never reads "done" without the checks.
          const reviewRequired = !!delegation;
          let settled = false;
          let asked = false;
          // r82: the report the re-ask was about; the re-ask's turn sends back only the self-review.
          let firstReport: string | undefined;
          // r82: the project's routes check (gates.rs) on the worker's copy when it reports done; two failed runs and
          // its Lead hears it failed, with the check's words.
          let gateFailures = 0;
          // r84: a clashed copy is brought up to date once.
          let refreshed = false;
          const workerStarted = Date.now();
          const finish = (result: MonoSessionCompletionResult) => {
            // WP-84: a phase worker's reply moves the task. A coding worker is unchanged.
            if (isPhaseSession(sessionId)) deliverPhaseResult(sessionId, phaseFinish(result.status, result.result));
            if (settled) return;
            settled = true;
            // WP-13: an account failure can name the next signed-in CLI. A timeout of that note still reports the failure.
            if (result.status === "failed") {
              void Promise.resolve(launch?.settle(result))
                .then((note) => settle(withCrewAdvice(result, note)))
                .catch(() => settle(result));
              return;
            }
            launch?.settle(result);
            settle(result);
          };
          const turnEnded = async (outcome: ControlOutcome, latestTurn: boolean) => {
            faultStop.done();
            const result = monoSessionCompletionResult({
              requestId,
              sessionId,
              project,
              prompt,
              outcome: faultedOutcome(outcome, fault, faultStop.stopped()),
              ...faultedReply(outcome, fault, faultStop.stopped()),
              session: sessionsRef.current.find(
                (session) => session.id === sessionId,
              ),
              // The re-ask's answer is the session's latest turn, not the block the request named.
              ...(latestTurn ? { latestTurn: true } : {}),
              ...(latestTurn && firstReport ? { earlierReport: firstReport } : {}),
              ...(reviewRequired ? { reviewRequired: true } : {}),
            });
            // WP-13: the row stays open. H8/E5 resumes it. The crew only notes the pause.
            if (holdForLimit(result)) {
              if (settled) return;
              settled = true;
              if (row) {
                const child = sessionsRef.current.find((session) => session.id === row.childSession);
                void recordCrewPause(row, result, {
                  cli: child?.harness,
                  model: child?.model,
                  effort: child?.modelSettings?.effort,
                }).catch(() => undefined);
              }
              settle.discard();
              return;
            }
            // r84 (s14): stopped on a choice that is Ash's: its Lead hears the stop now, and the job stays open (not
            // completed) for his answer; his message in the worker's chat picks it back up (resumeMonitor). Before the
            // self-review ask and the routes check, which failed the held job in s14 blind 2.
            if (row && stoppedForAsh(result)) {
              settled = true;
              void delegationsRef.current?.setQuestion(row, stopQuestion(result), `worker:${sessionId}`).catch(() => undefined);
              settle(withStopHeld(result, row.id));
              return;
            }
            if (result.status === "completed" && result.reviewProblem && !asked) {
              asked = true;
              firstReport = result.result;
              // Sending it now carries the worker on into the second turn; `onSettled` keeps that turn's own report
              // on this same row, with the review it is asked for.
              const accepted = await submitSessionRef.current(sessionId, reviewAsk(result.reviewProblem), [], {
                // A system note, never a turn that reads as Ash's own (r67).
                monoNote: reviewAskNote(),
                onSettled: (next) => void turnEnded(next, true),
              });
              if (!accepted) finish(result);
              return;
            }
            if (gateDue(result)) {
              const checkout = gateCheckout(sessionsRef.current.find((session) => session.id === sessionId));
              const projectId = delegation?.project ?? hubProjectIdFor(project);
              // WP-40: a brief with gates is checked in code; one without keeps the routes check below.
              // No copy on hand is not a pass when a plan was stored: the id is not a checkout, so those gates
              // come back as not run. A brief with no plan still returns nothing and falls through.
              const briefGates = row
                ? await briefGatesFor({
                    delegationId: row.id,
                    checkout: checkout ?? row.id,
                    projectId,
                    signedOff: signedOffFor(workerStarted, monoId, delegation?.project ?? hubProjectIdFor(project) ?? project, delegationsRef.current?.known() ?? []),
                    report: result.result ?? "",
                    failures: gateFailures,
                  })
                : null;
              if (briefGates?.action === "resend") {
                gateFailures += 1;
                firstReport = undefined;
                const accepted = await submitSessionRef.current(sessionId, briefGates.ask, [], {
                  monoNote: briefGates.note,
                  onSettled: (next) => void turnEnded(next, true),
                });
                if (accepted && row) {
                  // WP-157: the checks sent this work back. A repeat of the same try keeps the first line.
                  void invoke("delegations_sent_back", {
                    id: row.id,
                    rework: gateFailures,
                    report: result.result,
                  }).catch(() => undefined);
                } else if (!accepted) finish(briefGates.failed(result));
                return;
              }
              if (briefGates?.action === "fail" || briefGates?.action === "unsure") {
                finish(briefGates.apply(result));
                return;
              }
              if (!briefGates) {
                const run = checkout && projectId
                  ? await runWorkerGate({ projectId, checkout, signedOff: signedOffFor(workerStarted, monoId, delegation?.project ?? hubProjectIdFor(project) ?? project, delegationsRef.current?.known() ?? []) })
                  : null;
                if (run && !run.ok) gateFailures += 1;
                const verdict = gateVerdict(run, gateFailures);
                if (verdict === "resend" && run) {
                  // The worker's next report is a whole one again, not a self-review joined to this one.
                  firstReport = undefined;
                  const accepted = await submitSessionRef.current(sessionId, gateAsk(run), [], {
                    monoNote: gateAskNote(run),
                    onSettled: (next) => void turnEnded(next, true),
                  });
                  if (accepted && row) {
                    // WP-157: the checks sent this work back. A repeat of the same try keeps the first line.
                    void invoke("delegations_sent_back", {
                      id: row.id,
                      rework: gateFailures,
                      report: result.result,
                    }).catch(() => undefined);
                  } else if (!accepted) finish(gateFailedResult(result, run));
                  return;
                }
                if (verdict === "deliver-failed" && run) {
                  finish(gateFailedResult(result, run));
                  return;
                }
              }
            }
            // r84: a finished worker's changes go into the project, and its Lead reads what happened first.
            const landing = landingDue(result, sessionsRef.current.find((session) => session.id === sessionId));
            const landed = landing ? await landWorkerCopy(landing) : null;
            // A clash with work that landed first: once, the project is merged into its copy and it settles the rest.
            if (landing && landed?.outcome === "conflict" && !refreshed) {
              refreshed = true;
              const marked = await refreshWorkerCopy(landing);
              const accepted =
                marked &&
                (await submitSessionRef.current(sessionId, refreshAsk(landed, marked), [], {
                  monoNote: refreshAskNote(),
                  onSettled: (next) => void turnEnded(next, true),
                }));
              if (accepted) {
                firstReport = undefined;
                return;
              }
            }
            finish(withLanding(result, landed));
          };
          return Object.assign(
            (outcome: ControlOutcome) => {
              void turnEnded(outcome, false);
            },
            {
              accept: () => {
                settle.accept();
                faultStop.start();
              },
              discard: () => {
                faultStop.done();
                launch?.refuse();
                settle.discard();
              },
            },
          );
        };
        // The Mono doesn't need this child's report any more: out of the batch cache and its queue.
        const dropReport = (monoId: string, sessionId: string) => {
          monoCompletionBatches.current!.dismissSession(monoId, sessionId);
          flushSync(() =>
            setSessions((previous) =>
              previous.map((session) =>
                session.id === monoId
                  ? dismissQueuedMonoSessionCompletion(session, sessionId)
                  : session,
              ),
            ),
          );
        };
        const dismissCompletion = (sessionId: string) => {
          if (!isOrchestratorChat(source.id)) return;
          void delegationsRef.current?.stopOwned(source.id, sessionId);
          dropReport(source.id, sessionId);
        };
        const promise = handleAgentApp(
          source,
          payload.requestId,
          payload.action,
          payload.input,
          {
            start: async (launch, id, placement, notifyMonoId, delegation) => {
              const rememberLaunch = () => {
                const created =
                  sessionsRef.current.find((session) => session.id === id) ??
                  existing;
                rememberSession({
                  sessionId: id,
                  cwd: created?.cwd ?? launch.cwd,
                  // A delegation's card names the job, not the brief's "[MonoCode brief from ...]" opening line.
                  title:
                    delegation?.title ??
                    created?.title ??
                    launch.prompt.trim().slice(0, 300),
                  harness: created?.harness ?? launch.harness,
                  model:
                    created?.model ??
                    resolveModel(launch.harness, launch.model).id,
                  // WP-89: the start card names the effort and where the CLI, model and effort came from.
                  ...(launch.ranEffort ? { effort: launch.ranEffort } : {}),
                  ...(launch.ranFrom ? { from: launch.ranFrom } : {}),
                  ...(launch.cliFallback ? { cliFallback: launch.cliFallback } : {}),
                });
              };
              const open = sessionsRef.current.find(
                (session) => session.id === id,
              );
              const stored = open ? null : await getSession(id);
              const existing = open ?? stored;
              const previous = existing?.blocks.find(
                (block) => block.appRequestId === id,
              );
              if (previous) {
                if (
                  previous.text !== launch.prompt ||
                  (!launch.draft && !!previous.draft)
                )
                  throw new Error(
                    "Request ID was already used for another session launch",
                  );
                rememberLaunch();
                return;
              }
              if (
                existing?.blocks.some(
                  (block) => block.role === "user" && !block.draft,
                )
              ) {
                rememberLaunch();
                return;
              }
              if (existing && sessionDraftBlock(existing))
                throw new Error("Session ID already has a different draft");
              const onSettled = notifyMonoId
                ? await monitorCompletion(
                    notifyMonoId,
                    id,
                    id,
                    launch.cwd,
                    launch.prompt,
                    launch.prompt.trim().split("\n")[0].slice(0, 200),
                    delegation,
                  )
                : undefined;
              try {
                // Started sessions wait in the sidebar, under the session
                // that started them, until the user opens one. Only an
                // explicit split, or a reveal from a regular session, puts
                // one in the workspace.
                await launchQuickSessionRef.current(
                  launch,
                  id,
                  placement,
                  onSettled,
                  !!placement || (!isMonoSession(source.id) && launch.reveal),
                );
                rememberLaunch();
                onSettled?.accept();
              } catch (error) {
                onSettled?.discard();
                throw error;
              }
            },
            sessions: async (cwd): Promise<AppSessionListing[]> => {
              const stored = await listSessionsByProject(cwd);
              const byId = new Map<string, AppSessionListing>();
              for (const session of stored) {
                if (session.orchestrationLeadId) continue;
                byId.set(session.id, {
                  id: session.id,
                  title: session.title,
                  harness: session.harness,
                  model: session.model,
                  busy: false,
                  hasDraft: !!session.draft,
                  archived: !!session.archived,
                });
              }
              for (const session of sessionsRef.current) {
                if (
                  session.orchestrationLeadId ||
                  isHabitRun(session.id) ||
                  !sameProjectPath(session.cwd, cwd)
                )
                  continue;
                byId.set(session.id, {
                  id: session.id,
                  title: session.title,
                  harness: session.harness,
                  model: session.model,
                  busy: !!session.busy,
                  hasDraft: !!sessionDraftBlock(session),
                  archived: byId.get(session.id)?.archived ?? false,
                });
              }
              return [...byId.values()];
            },
            session: async (id) => {
              const target =
                sessionsRef.current.find((session) => session.id === id) ??
                (await getSession(id));
              return target &&
                !target.orchestrationLeadId &&
                canAccessProject(target.cwd)
                ? target
                : null;
            },
            readConversation: async (target, options) =>
              isMonoSession(target.id)
                ? readMonoConversation(target, options)
                : sessionConversationPage(target, options),
            send: async (id, prompt, requestId, notifyMonoId, mode = "auto") => {
              const target = await ensureOpenSessionRef.current(id);
              if (
                !target ||
                target.orchestrationLeadId ||
                !canAccessProject(target.cwd) ||
                orchestrator.run(id)
              )
                throw new Error("Session is unavailable in this project");
              const rememberFollowUp = () => {
                const current =
                  sessionsRef.current.find((session) => session.id === id) ??
                  target;
                rememberSession({
                  sessionId: id,
                  cwd: current.cwd,
                  title: current.title,
                  harness: current.harness,
                  model: current.model,
                });
              };
              const previous = target.blocks.find(
                (block) => block.appRequestId === requestId,
              );
              if (previous) {
                if (previous.text !== prompt)
                  throw new Error(
                    "Request ID was already used with another prompt",
                  );
                if (previous.draft)
                  throw new Error("Request ID belongs to an unsent draft");
                rememberFollowUp();
                return { alreadySubmitted: true };
              }
              // A retried brief that still waits in the queue.
              const waiting = briefWaiting({ requestId }, target);
              if (waiting) {
                if (waiting.text !== prompt)
                  throw new Error(
                    "Request ID was already used with another prompt",
                  );
                return { alreadySubmitted: true, delivery: "queued" as const };
              }
              if (sessionDraftBlock(target))
                throw new Error(
                  "Session already has a draft; send or remove it first",
                );
              // A busy session takes the brief behind its current work, or into it when the sender asked to steer
              // (followedBriefs.ts). Its report, if asked for, is a followed row: decided by watching the session.
              const delivery = deliveryFor(
                target,
                mode,
                isLiveHarness(target.harness) &&
                  canSteerHarness(target.harness) &&
                  !target.registryAgentId,
              );
              if (delivery !== "started") {
                const follow = delivery === "steered" ? "steer" : "queue";
                const launch = notifyMonoId
                  ? delegationsRef.current?.launch({
                      ownerSession: notifyMonoId,
                      ownerMono: monoForSession(notifyMonoId)?.id,
                      batchId: sourceTurnId ?? `turn-${sourceTurn}`,
                      requestId,
                      childSession: id,
                      project: hubProjectIdFor(target.cwd) ?? target.cwd,
                      title: target.title,
                      brief: prompt,
                      follow,
                      by: `owner:${notifyMonoId}`,
                    })
                  : undefined;
                await launch?.row;
                const accepted = await submitSessionRef.current(id, prompt, [], {
                  appRequestId: requestId,
                  followsUp: true,
                  followUpBehavior: follow,
                  ...(follow === "queue" ? { waitForIdle: true } : {}),
                });
                if (!accepted) {
                  launch?.refuse();
                  throw new Error("Session could not take the brief");
                }
                rememberFollowUp();
                return { alreadySubmitted: false, delivery };
              }
              const onSettled = notifyMonoId
                ? await monitorCompletion(
                    notifyMonoId,
                    id,
                    requestId,
                    target.cwd,
                    prompt,
                    target.title,
                  )
                : undefined;
              const accepted = onSettled
                ? await submitWithSettlement({
                    submit: (onSettled) =>
                      submitSessionRef.current(id, prompt, [], {
                        appRequestId: requestId,
                        onSettled,
                      }),
                    onSettled,
                    rejectionMessage:
                      "The monitored follow-up could not start.",
                  })
                : await submitSessionRef.current(id, prompt, [], {
                    appRequestId: requestId,
                  });
              if (!accepted) {
                onSettled?.discard();
                throw new Error("Session could not accept the follow-up");
              }
              rememberFollowUp();
              onSettled?.accept();
              return { alreadySubmitted: false, delivery: "started" as const };
            },
            queued: async (caller, sessionId) =>
              sessionsRef.current.flatMap((session) =>
                (sessionId === undefined || session.id === sessionId) &&
                canAccessProject(session.cwd)
                  ? (session.queuedMessages ?? []).flatMap((message, index) =>
                      message.appRequestId?.startsWith(`app-${caller}-`)
                        ? [
                            {
                              sessionId: session.id,
                              title: session.title,
                              requestId: message.appRequestId,
                              position: index + 1,
                              prompt: message.text.slice(0, 500),
                            },
                          ]
                        : [],
                    )
                  : [],
              ),
            unqueue: async (caller, requestId) => {
              if (!requestId.startsWith(`app-${caller}-`)) return false;
              const holder = sessionsRef.current.find(
                (session) =>
                  canAccessProject(session.cwd) &&
                  session.queuedMessages?.some(
                    (message) => message.appRequestId === requestId,
                  ),
              );
              const message = holder?.queuedMessages?.find(
                (entry) => entry.appRequestId === requestId,
              );
              if (!holder || !message) return false;
              const next = sessionsRef.current.map((session) =>
                session.id === holder.id
                  ? withoutQueuedBrief(session, message)
                  : session,
              );
              sessionsRef.current = next;
              flushSync(() => setSessions(next));
              // Its row (when a report was asked for) is cancelled: nothing is owed for a brief that never went in.
              const rows = await tauriDelegations
                .owned({ ownerSession: caller, requestIds: [requestId] })
                .catch(() => []);
              if (rows.length)
                await delegationsRef.current?.cancelOwned(
                  caller,
                  rows,
                  "Taken back out of the queue by its sender.",
                );
              return true;
            },
            draft: async (id, prompt, requestId) => {
              const target = await ensureOpenSessionRef.current(id);
              if (
                !target ||
                target.orchestrationLeadId ||
                !canAccessProject(target.cwd) ||
                orchestrator.run(id)
              )
                throw new Error("Session is unavailable in this project");
              const previous = target.blocks.find(
                (block) => block.appRequestId === requestId,
              );
              if (previous) {
                if (previous.text !== prompt)
                  throw new Error(
                    "Request ID was already used with another prompt",
                  );
                return { alreadySaved: true, draft: !!previous.draft };
              }
              if (target.busy)
                throw new Error("Session is busy; try again when it finishes");
              if (sessionDraftBlock(target))
                throw new Error(
                  "Session already has a draft; send or remove it first",
                );
              const saved = flushSync(() =>
                saveDraftRef.current(id, prompt, [], requestId),
              );
              if (!saved) throw new Error("Session could not accept a draft");
              return { alreadySaved: false, draft: true };
            },
            stop: async (id) => {
              if (
                removingSessionIds.current.has(id) ||
                switchingWorktrees.current.has(id)
              )
                throw new Error(
                  "Session is being removed or changing worktrees",
                );
              const target = sessionsRef.current.find(
                (session) => session.id === id,
              );
              if (!target) {
                dismissCompletion(id);
                return;
              }
              if (
                target.orchestrationLeadId ||
                !canAccessProject(target.cwd) ||
                isMonoSession(id) ||
                isHabitRun(id)
              )
                throw new Error("Session is unavailable in this project");
              await flushSync(() => stopSessionRef.current(id));
              flushHarnessEvents();
              dismissCompletion(id);
            },
            // sessions.stop {"cascade":true}: the session, then everything beneath it (H4).
            stopTree: async (id) => {
              if (
                removingSessionIds.current.has(id) ||
                switchingWorktrees.current.has(id)
              )
                throw new Error(
                  "Session is being removed or changing worktrees",
                );
              const target = sessionsRef.current.find(
                (session) => session.id === id,
              );
              if (
                target &&
                (target.orchestrationLeadId ||
                  !canAccessProject(target.cwd) ||
                  isMonoSession(id) ||
                  isHabitRun(id))
              )
                throw new Error("Session is unavailable in this project");
              const result = await delegationTreeRef.current.stopTree(
                id,
                "Stopped by its owner.",
                `owner:${source.id}`,
              );
              flushHarnessEvents();
              dismissCompletion(id);
              return result;
            },
            remove: async (id, mode) => {
              const target = await ensureOpenSessionRef.current(id);
              if (
                !target ||
                target.orchestrationLeadId ||
                !canAccessProject(target.cwd) ||
                isMonoSession(id) ||
                isHabitRun(id)
              )
                throw new Error("Session is unavailable in this project");
              const removed = await removeSessionRef.current(
                id,
                mode,
                true,
                "cli",
              );
              if (!removed)
                throw new Error(
                  `Session could not be ${mode === "archive" ? "archived" : "deleted"}; another session operation is in progress`,
                );
              dismissCompletion(id);
            },
            worktrees: (cwd) => listWorktrees(cwd),
            ship: (input) => startShip(input),
            shipStatus: () => shipStatus().current,
            createWorktree: (cwd, branch, base, existing, options) =>
              createWorktree(cwd, branch, base, existing, options),
            projectActions: (cwd) => listProjectActions(cwd),
            // WP-90: a crew reads the stack's names and fake services, never starts a real one.
            stacks: (cwd) => invoke("stack_status", { cwd }),
            runProjectAction: (checkoutCwd, actionId) =>
              runProjectAction(checkoutCwd, actionId, "agent"),
            waitProjectAction: (runId, timeoutMs) =>
              waitProjectAction(runId, timeoutMs),
            notes: () => invoke("notes_list"),
            note: (id) => invoke("notes_get", { id }),
            saveNote: async (note) => {
              const saved = await upsertNote(note);
              window.dispatchEvent(new Event(NOTES_CHANGED_EVENT));
              return saved;
            },
            // WP-72: docs are notes. Agents read and write them through the same store.
            docs: {
              list: () => invoke("docs_list"),
              get: (id) => invoke("docs_get", { id }),
              create: (page) => invoke("docs_create", { page }),
              update: (page) => invoke("docs_update", { page }),
            },
            artifacts: () => invoke("artifacts_list"),
            artifact: getArtifact,
            saveArtifact,
            postArtifact: async (sessionId, card) => {
              const latest = sessionsRef.current.find(
                (session) => session.id === sessionId,
              );
              const anchor =
                sourceTurnId ??
                latest?.blocks
                  .slice()
                  .reverse()
                  .find((block) => block.role === "user")?.id;
              if (
                !latest ||
                !anchor ||
                !latest.blocks.some((block) => block.id === anchor)
              )
                throw new Error(
                  "The artifact's conversation turn is no longer available",
                );
              const updated = recordArtifactCard(latest, anchor, card);
              sessionsRef.current = sessionsRef.current.map((session) =>
                session.id === sessionId ? updated : session,
              );
              setSessions(sessionsRef.current);
              if (!isHabitRun(sessionId)) await upsertSession(updated);
            },
            isMono: (id) => isMonoSession(id),
            isHabitRun: (id) => isHabitRun(id),
            // WP-89: a worker-default change lands in this chat, and in the activity log.
            postCard: (sessionId, card) => {
              if (isHabitRun(sessionId)) {
                holdRunCard(sessionId, card);
                return;
              }
              const latest = sessionsRef.current.find((session) => session.id === sessionId);
              if (!latest) return;
              const updated = {
                ...latest,
                blocks: [
                  ...latest.blocks,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant" as const,
                    text: monoCardText(card),
                    monoCard: card,
                  },
                ],
              };
              sessionsRef.current = sessionsRef.current.map((session) =>
                session.id === sessionId ? updated : session,
              );
              setSessions(sessionsRef.current);
              void upsertSession(updated);
            },
            noteActivity: (entry) => {
              // WP-89: the log refuses a summary over 500 characters, so a long line is shortened here.
              void invoke("activity_note", { ...entry, summary: activityNoteSummary(entry.summary) }).catch(
                () => undefined,
              );
            },
            tree: {
              on: (monoId) => longChatOn(monoId),
              zoom: (monoId, id, n, at) => treeZoom(monoId, id, n, at),
              date: (monoId, id) => treeDate(monoId, id),
            },
            // A chat in a hub project's coding team delegates and watches pull requests like the Lead (codingTeam.ts).
            codingTeamOf: (id) => {
              const projectId = codingTeamChatProject(id);
              const project = projectId
                ? hubData().listProjects().find((entry) => entry.id === projectId)
                : undefined;
              return project?.folder
                ? { project: project.id, name: codingTeamName(project), folder: project.folder }
                : undefined;
            },
            // WP-70: the shared task list. The handler sets who is asking.
            taskStore: (command, args) => invoke(command, args),
            // WP-159: the programme board. The handler sets who is asking.
            programmeStore: (command, args) => invoke(command, args),
            // WP-88: projects on this copy, the activity log, and reviewed memory.
            knownProjects: () => hubData().listProjects().map((project) => ({
              id: project.id,
              name: project.name,
              folder: project.folder ?? null,
            })),
            activityList: (query) => invoke("activity_list", { query }),
            memoryDoc: async () => {
              const loaded = await invoke<{ doc?: unknown } | null>("memory_review_load");
              return loaded?.doc ?? null;
            },
            // WP-100: a Mono reading memory through its tool is a use, so those facts are topped up.
            markMemoryUsed: (ids, at) => recordUse(memoryUsePorts(), ids, at),
            mateIds: () => listMonos().map((item) => item.id),
            monoOf: (id) => {
              const mono =
                monoForSession(id) ?? findMono(habitRunMono(id) ?? "");
              return (
                mono && {
                  id: mono.id,
                  name: monoLook(mono).name,
                  projects: mono.projects,
                  showStartedSessionsInSidebar:
                    mono.showStartedSessionsInSidebar,
                  ...(mono.useSidebarFolders
                    ? {
                        folder: {
                          name: monoLook(mono).name,
                          color: mono.color,
                        },
                      }
                    : {}),
                  // Its own team's folder, once it has one (monoTeams.ts).
                  ...(codingTeamsOn() && monoTeam(mono.id)
                    ? { team: monoTeam(mono.id)!.folder }
                    : {}),
                  // WP-21: this Mono's crew rules go with the route.
                  ...(mono.crewRules?.length ? { crewRules: mono.crewRules } : {}),
                  ...(mono.instructions ? { instructions: mono.instructions } : {}),
                  ...(mono.everyProject === true ? { everyProject: true } : {}),
                  // WP-89: this Mono's worker default goes with the route.
                  ...(mono.workerDefault ? { workerDefault: mono.workerDefault } : {}),
                }
              );
            },
            // A worker works as the Mono it was started under, so its skills are that Mono's (A7). Not `monoOf`: a
            // worker may not write a soul or memory.
            ownerMonoOf: (id) => chatMonoOwner(id),
            monoNameOf: (monoId) => {
              const mono = findMono(monoId);
              return mono ? monoLook(mono).name : undefined;
            },
            habits: {
              load: async (monoId: string) => {
                const list = await loadHabits(monoId);
                // WP-88: the morning note is one habit. An edited one is left alone. A timeout keeps the old list.
                if (!readsEveryProject(findMono(monoId))) return list;
                try {
                  await ensureMorningHabit(monoId, loadHabits, async (id, change) => updateHabits(id, change), Date.now());
                } catch {
                  return list;
                }
                return loadHabits(monoId).catch(() => list);
              },
              update: updateHabits,
            },
            tasks: delegationTasksHost({
              backend: tauriDelegations,
              firstMate: steering,
              // WP-172: the fan-out checkpoint store (a plan cut short by a crash can be resumed).
              fanoutCheckpoints: tauriFanoutCheckpoints,
              tracker: () => delegationsRef.current,
              session: (id) =>
                sessionsRef.current.find((session) => session.id === id),
              stop: async (id) => {
                await flushSync(() => stopSessionRef.current(id));
                flushHarnessEvents();
              },
              dropReport,
              respond: (child, requestId, reply) =>
                respondHarnessQuestion(child.harness, child.id, requestId, reply),
              stopTask: (row, reason, by) =>
                delegationTreeRef.current.stopTask(row, reason, by),
              waits: delegationTreeRef.current.waits,
              questions: delegationTreeRef.current.questions,
              hubProjectId: hubProjectIdFor,
              hubProjectFolder,
              // WP-141 round 11: hub project folders, so a worktree's session, brief and pick share the project's default.
              hubProjectRoots: hubProjectFolders,
              unqueue: (childSession, requestId) => {
                const next = sessionsRef.current.map((session) => {
                  if (session.id !== childSession) return session;
                  const waiting = briefWaiting({ requestId }, session);
                  return waiting ? withoutQueuedBrief(session, waiting) : session;
                });
                sessionsRef.current = next;
                flushSync(() => setSessions(next));
              },
              // Sub-chats only ever live in a team (monoTeams.ts): a Mono hands a project's work to its coding team and
              // starts workers of its own only in its own team's folder. A hub thing: plain MonoCode has no teams.
              ...(codingTeamsOn()
                ? {
                    monoWork: {
                      isLead: (monoId: string) => !!leadFor(monoId),
                      codingTeam: (named: string) => codingTeamNamed(named, hubData().listProjects()),
                      ownTeam: async (mono: { id: string; name?: string }) => {
                        const team = await ensureMonoTeam(mono.id);
                        return { folder: team.folder, name: monoTeamName(mono.name) };
                      },
                    },
                  }
                : {}),
              // WP-13: the start of a delegated task asks which CLI, model and effort to use.
              crewRoute: (query) => crewRouteFor(query),
              // WP-141: tasks.pick, the crew's pick across CLIs and the Leads this Mono may brief.
              crewPick: (query) => crewPickFor(query),
              pickMonos: (monoId) => pickMonosFrom(leadTargetsFor(monoId, hubData().listProjects()), listMonos()),
              pool: workerPoolHost({
                openRows: openDelegationRows,
                room: providerRoomNow,
                dependency: fanout.dependency,
                card: (job, launch) =>
                  rememberSession({
                    sessionId: job.id,
                    cwd: launch.cwd,
                    title: job.title,
                    harness: launch.harness as HarnessId,
                    model: launch.model || launch.harness,
                    // WP-89: a waiting worker's card names the effort and where it came from.
                    ...(launch.ranEffort ? { effort: launch.ranEffort } : {}),
                    ...(launch.ranFrom ? { from: launch.ranFrom } : {}),
                    ...(launch.cliFallback ? { cliFallback: launch.cliFallback } : {}),
                  }),
              }),
              // The Lead a brief names must exist: asked before a fresh-eyes review, so an unknown one is never reviewed.
              checkLead: async (_owner, mono, lead) => {
                const target = findLeadTarget(mono.id, hubData().listProjects(), lead);
                if (!target)
                  throw new Error(
                    `No Lead "${lead}" among the ones you can brief (a Lead of a project you and it are both members of).`,
                  );
                // WP-141 LOW 7: a Lead on Never use is not briefed, read from the Lead's own project, whatever the brief says.
                // The CLI is the one the brief will run: the open chat, else the saved chat, else the chat a new session starts.
                const cli = await cliForLeadBrief({
                  mono: findMono(target.leadId),
                  openSessions: sessionsRef.current,
                  load: (id) => ensureOpenSessionRef.current(id),
                  createDefault: async () => {
                    const folder = leadWorkingFolder(target.leadId) ?? (await homeDir());
                    return newDefaultSession(folder);
                  },
                });
                await refuseNeverUseLead({ ...target, cli }, mono.id, crewPolicyInForce);
              },
              crewPolicy: (monoId, folder) => crewPolicyInForce(monoId, folder),
              // WP-141: the one gate every worker and session launch passes before its process starts.
              crewGate: (input) => crewLaunchCheck(input),
              crewAnyLock: () => crewAnyLock(),
              // WP-156: a Lead's brief carries that Lead's project, not the chat that writes it.
              leadProject: (_owner, mono, lead) =>
                findLeadTarget(mono.id, hubData().listProjects(), lead)?.projectId,
              briefLead: async (owner, mono, input) => {
                const projects = hubData().listProjects();
                const target = findLeadTarget(mono.id, projects, input.lead);
                if (!target)
                  throw new Error(
                    `No Lead "${input.lead}" among the ones you can brief (a Lead of a project you and it are both members of).`,
                  );
                const out = await delegateToLead(mono.id, target, input.brief, projects, {
                  ownerSession: owner.id,
                  requestId: input.requestId,
                  title: input.title,
                  ...(input.goal ? { goal: input.goal } : {}),
                  ...(input.taskId ? { taskId: input.taskId } : {}),
                  askIds: input.askIds,
                  mode: input.mode,
                });
                const [row] = await tauriDelegations.owned({
                  ownerSession: owner.id,
                  ids: [out.taskId],
                });
                return {
                  row: row ?? null,
                  childSessionId: out.childSessionId ?? target.sessionId ?? "",
                  delivery: out.delivery ?? "started",
                  leadName: target.leadName,
                };
              },
            }),
            rooms: roomsHostRef.current,
            prs: {
              add: (input) => tauriPrWatches.add(input),
              remove: (input) => tauriPrWatches.remove(input),
              list: (ownerSession) => tauriPrWatches.list(ownerSession),
              hubProjectId: hubProjectIdFor,
            },
            // WP-92: a worker's keys. Rust checks and asks; the values are armed for the child and never come back here.
            secretsWorkerArm: (sessionId, request) =>
              invoke<WorkerArmOutcome>("plugin:hub|secrets_worker_arm", { sessionId, request }),
            agentFiles: (monoId) => loadMonoFiles(monoId),
            readAgentFile: (monoId, path) => readAgentFile(monoId, path),
            writeAgentFile: (monoId, path, text, hash) =>
              writeAgentFile(monoId, path, text, hash),
          },
        );
        appReceipts.current.set(key, { signature, promise });
        void promise.catch(() => {
          if (appReceipts.current.get(key)?.promise === promise)
            appReceipts.current.delete(key);
        });
        if (appReceipts.current.size > 256) {
          const first = appReceipts.current.keys().next().value;
          if (first) appReceipts.current.delete(first);
        }
        return promise;
      };
      return handle();
    }
    return () => {
      controlRequestRef.current = undefined;
      registerCrewDelegate(null);
      registerCrewCancel(null);
      void listening.then((unlisten) => unlisten());
    };
  }, []);

  const confirmingOrchestration = useRef(new Set<string>());
  const queueWorkerPanes = useCallback(
    (workers: OrchestrationWorkerDetail[]) => {
      // Finished workers are not open; load stored transcripts before the
      // tabs appear so the pane does not flash the empty state.
      void prepareOrchestrationWorkerDetails(workers, {
        openLead: async (leadId) => {
          if (!focusOpenSession(leadId)) await onSelectHistorySession(leadId);
        },
        openWorker: ensureOpenSession,
        hasSession: (id) =>
          sessionsRef.current.some((session) => session.id === id),
      })
        .then((request) => {
          if (request?.workers.length) setWorkerDetailRequest(request);
        })
        .catch(console.error);
    },
    [ensureOpenSession, focusOpenSession, onSelectHistorySession],
  );
  const onOpenWorkerDetails = useCallback(
    (worker: OrchestrationWorkerDetail) => {
      setInspectedWorkerId(worker.sessionId);
      queueWorkerPanes([worker]);
    },
    [queueWorkerPanes],
  );
  useEffect(() => {
    if (!workerDetailRequest) return;
    const { leadId, workers } = workerDetailRequest;
    const tab = tabs.find((entry) => leafIds(entry.layout).includes(leadId));
    if (!tab) {
      // Still opening: this runs again on the commit that lands the lead. If
      // the lead never arrived at all, drop the request rather than let it
      // fire against some later tab change.
      if (!sessionsRef.current.some((entry) => entry.id === leadId)) {
        setWorkerDetailRequest(null);
      }
      return;
    }
    setWorkerDetailRequest(null);
    // Every agent of a run shares one pane, the way files do: `openEditorTab`
    // focuses an open tab, adds to the pane already beside the lead, or splits
    // one off when there is none.
    const cwd =
      sessionsRef.current.find((entry) => entry.id === leadId)?.cwd ??
      projectCwdRef.current;
    const files = workers.map((worker) =>
      newAgentTab(worker.title, cwd, {
        sessionId: worker.sessionId,
        leadId,
        harness: worker.harness,
      }),
    );
    setTabs((prev) =>
      prev.map((entry) => {
        if (entry.id !== tab.id) return entry;
        const opened = files.reduce(
          (next, file) => openEditorTab(next, file),
          entry,
        );
        // Leave the first worker focused so View agents lands on the start
        // of the run rather than the last tab added.
        return files[0] ? openEditorTab(opened, files[0]) : opened;
      }),
    );
    setActiveTabId(tab.id);
    setComposerFocused(false);
  }, [tabs, workerDetailRequest]);
  const orchestrationWorkers = useMemo(
    () => ({
      selectedId: inspectedWorkerId,
      inspect: setInspectedWorkerId,
      openDetails: onOpenWorkerDetails,
    }),
    [inspectedWorkerId, onOpenWorkerDetails],
  );
  const updateOrchestrationCard = useCallback(
    (leadId: string, blockId: string, proposal: OrchestrationProposal) => {
      const next = sessionsRef.current.map((session) =>
        session.id === leadId
          ? withOrchestrationProposal(session, blockId, proposal)
          : session,
      );
      sessionsRef.current = next;
      setSessions(next);
      return next.find((session) => session.id === leadId);
    },
    [],
  );
  const orchestrationActions = useMemo(
    () => ({
      open: onOpenApprovalSession,
      openAgents: queueWorkerPanes,
      update: (
        leadId: string,
        blockId: string,
        edited: OrchestrationProposal,
      ) => {
        const session = sessionsRef.current.find(
          (entry) => entry.id === leadId,
        );
        const proposal = session?.blocks.find(
          (block) => block.id === blockId,
        )?.orchestration;
        if (
          !session ||
          session.busy ||
          proposal?.status !== "ready" ||
          confirmingOrchestration.current.has(leadId)
        )
          return;
        // Keep the discovered catalog authoritative while allowing task and parallelism edits.
        const settings = validateOrchestrationSettings({
          ...proposal.settings,
          maxWorkers: edited.settings.maxWorkers,
        });
        updateOrchestrationCard(leadId, blockId, {
          ...proposal,
          settings,
          tasks: edited.tasks,
        });
      },
      confirm: async (leadId: string, blockId: string) => {
        if (confirmingOrchestration.current.has(leadId)) return;
        confirmingOrchestration.current.add(leadId);
        let proposal: OrchestrationProposal | undefined;
        try {
          await orchestrator.hydrate(leadId);
          const session = sessionsRef.current.find(
            (entry) => entry.id === leadId,
          );
          proposal = session?.blocks.find(
            (block) => block.id === blockId,
          )?.orchestration;
          if (!session || session.busy || proposal?.status !== "ready")
            throw new Error(
              "Wait for the proposal to finish before confirming.",
            );
          if (
            session.harness !== proposal.author.harness ||
            session.model !== proposal.author.model
          )
            throw new Error(
              "The lead model has changed. Switch back to the model shown on this card, or generate a new proposal.",
            );
          const starting = updateOrchestrationCard(leadId, blockId, {
            ...proposal,
            status: "starting",
          })!;
          // Save the edited card before anything can execute.
          await upsertSession(starting);
          await orchestrator.startApproved(leadId, blockId, proposal);
          updateOrchestrationCard(leadId, blockId, {
            ...proposal,
            status: "approved",
          });
        } catch (error) {
          if (proposal)
            updateOrchestrationCard(leadId, blockId, {
              ...proposal,
              status: "ready",
            });
          throw error;
        } finally {
          confirmingOrchestration.current.delete(leadId);
        }
      },
      retry: (leadId: string, blockId: string) => {
        const session = sessionsRef.current.find(
          (entry) => entry.id === leadId,
        );
        const proposal = session?.blocks.find(
          (block) => block.id === blockId,
        )?.orchestration;
        if (!session || session.busy || !proposal) return;
        onSubmit(leadId, proposal.request, [], {
          intent: "orchestrate",
          orchestrationRetry: proposal,
        });
      },
    }),
    [
      onOpenApprovalSession,
      queueWorkerPanes,
      onSubmit,
      updateOrchestrationCard,
    ],
  );

  const onSelectLiveAgent = useCallback(
    (sessionId: string) => {
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      onOpenApprovalSession(sessionId);
    },
    [onOpenApprovalSession],
  );

  const orderedTitleTabs: TitleTab[] = orderByIds(
    [
      ...deckProjectTabs.map((tab) =>
        toTitleTab(tab, sessions, dirtyFiles, unseenFinishedIds),
      ),
      ...(insetLayout
        ? openAppViews
            .filter((view) => view !== "notes" || notesEnabled)
            .map((view): TitleTab => ({
              id: appViewTabId(view),
              appView: view,
              project: "",
              title: APP_VIEW_LABELS[view],
              more: [],
              sessionCount: 0,
              harnesses: [],
              busyHarnesses: [],
              files: [],
            }))
        : []),
      ...shownMonoTabs.flatMap((monoId): TitleTab[] => {
        const mono = findMono(monoId);
        // Like the sidebar's Monos, a Mono's tab shows in the projects it
        // works on; it keeps its place for when the project comes back.
        if (!mono || !monoWorksOn(mono, sidebarCwd)) return [];
        const look = monoLook(mono);
        const session = mono.sessionId
          ? sessions.find((entry) => entry.id === mono.sessionId)
          : undefined;
        return [
          {
            id: monoTabId(monoId),
            mono: {
              mascot: look.mascot,
              color: look.color,
              status: session ? monoState(session).status : "idle",
            },
            project: "",
            title: look.name,
            more: [],
            sessionCount: 0,
            harnesses: [],
            busyHarnesses: [],
            files: [],
          },
        ];
      }),
    ],
    insetLayout ? titleTabOrder : [],
  );
  // Like a browser, a Mono or app tab can be the only tab. The project's lone
  // blank session tab stays underneath, out of the strip, until closing the
  // last of them shows it again.
  const shownViewTabId = settingsOpen
    ? undefined
    : monoCovers
      ? monoViewTabId
      : activeAppView
        ? appViewTabId(activeAppView)
        : undefined;
  const placeholderTab =
    insetLayout &&
    shownViewTabId &&
    orderedTitleTabs.some((tab) => tab.id === shownViewTabId) &&
    deckProjectTabs.length === 1 &&
    isBlankWorkspaceTab(deckProjectTabs[0], sessions)
      ? deckProjectTabs[0].id
      : undefined;
  const nextTitleTabs = placeholderTab
    ? orderedTitleTabs.filter((tab) => tab.id !== placeholderTab)
    : orderedTitleTabs;
  tabProjectsRef.current = new Map(
    nextTitleTabs.map((tab) => [tab.id, tab.project]),
  );
  const titleTabsRef = useRef(nextTitleTabs);
  if (!titleTabsEqual(titleTabsRef.current, nextTitleTabs)) {
    titleTabsRef.current = nextTitleTabs;
  }
  const titleTabs = titleTabsRef.current;

  // `history` now spans every visited project; consumers that expect the
  // current project only get this slice.
  const projectHistory = useMemo(
    () => history.filter((entry) => sameProjectPath(entry.cwd, sidebarCwd)),
    [history, sidebarCwd],
  );

  // WP-85: a terminal Claude session joins this project's chats.
  const terminalMirror = useTerminalMirror();
  const sidebarHistoryRows = useMemo(
    () =>
      mergeTerminalSessions(
        historyWithLiveSessions(
          history,
          // A habit's hidden run is never one of the project's chats.
          promptableSessions,
          sidebarCwd,
          {
            ...(projectBranches?.current
              ? { branch: projectBranches.current }
              : {}),
            ...(sidebarCwd && sidebarCwd !== "~"
              ? { repo: projectName(sidebarCwd) }
              : {}),
          },
          orchestrationRuns,
        ),
        terminalMirror.sessions,
        sidebarCwd,
      ),
    [
      history,
      projectBranches,
      promptableSessions,
      sidebarCwd,
      orchestrationRuns,
      terminalMirror.sessions,
    ],
  );
  const sidebarHistory = useStableValue(
    sidebarHistoryRows,
    sameSessionSummaries,
  );
  const {
    unseen: inboxUnseen,
    linkedSessionUpdateIds,
    linkedSessionUpdates,
  } = useInboxActivity(recents, sidebarCwd, sidebarHistory, {
    onAppeared: onInboxAppeared,
    scopeProject: appViewScope,
  });
  linkedSessionUpdatesRef.current = linkedSessionUpdates;
  const inboxRelatedSessions = useMemo(() => {
    const byId = new Map<string, SessionSummary>();
    for (const session of storedLinkedSessions) byId.set(session.id, session);
    for (const session of history) {
      if (session.linkedWorkItem) byId.set(session.id, session);
    }
    for (const session of sessions) {
      if (session.inboxAsk || !session.linkedWorkItem) continue;
      const current = byId.get(session.id);
      const summary = summaryFromSession(session);
      byId.set(
        session.id,
        current
          ? {
              ...current,
              harness: summary.harness,
              model: summary.model,
              runtimeMode: summary.runtimeMode,
              title: summary.title,
              cwd: summary.cwd,
              linkedWorkItem: summary.linkedWorkItem,
            }
          : summary,
      );
    }
    return [...byId.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
  }, [history, sessions, storedLinkedSessions]);
  const repairSessions = useMemo(
    () => ciRepairSessions(history, sessions),
    [history, sessions],
  );
  const openProjectSessionRows = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            !session.inboxAsk &&
            !session.ephemeral &&
            !session.orchestrationLeadId &&
            sameProjectPath(session.cwd, sidebarCwd),
        )
        .map((session) =>
          summaryFromSession(session, {
            ...(projectBranches?.current
              ? { branch: projectBranches.current }
              : {}),
            ...(sidebarCwd && sidebarCwd !== "~"
              ? { repo: projectName(sidebarCwd) }
              : {}),
          }),
        ),
    [projectBranches, sessions, sidebarCwd],
  );
  const openProjectSessions = useStableValue(
    openProjectSessionRows,
    sameSessionSummaries,
  );

  const onToggleSessionSidebar = useCallback(() => {
    setSessionSidebarOpen((open) => {
      const next = !open;
      saveSessionSidebarOpen(next);
      return next;
    });
  }, []);

  // The inset layout has no project rail, so its sidebar takes the primary
  // toggle.
  const onToggleSidebar = useCallback(() => {
    if (insetLayout) {
      onToggleSessionSidebar();
      return;
    }
    setProjectRailOpen((open) => {
      const next = !open;
      saveProjectRailOpen(next);
      return next;
    });
  }, [insetLayout, onToggleSessionSidebar]);

  // The inset layout's sidebar already answers the primary toggle, so the
  // session sidebar's shortcut takes the right panel instead.
  const rightPanelToggleRef = useRef<(() => void) | null>(null);
  const onToggleSessionSidebarShortcut = useCallback(() => {
    if (insetLayout) {
      rightPanelToggleRef.current?.();
      return;
    }
    onToggleSessionSidebar();
  }, [insetLayout, onToggleSessionSidebar]);

  const onToggleProjectRail = useCallback(() => {
    setProjectRailOpen((open) => {
      const next = !open;
      saveProjectRailOpen(next);
      return next;
    });
  }, []);

  // The palette's input takes focus as it opens, so keep what had it before.
  const paletteFocusRef = useRef<Element | null>(null);
  const rememberPaletteFocus = () => {
    paletteFocusRef.current = focusBeforePalette(document.activeElement);
  };
  const onGoToFile = useCallback(() => {
    rememberPaletteFocus();
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    setFinderMode(false);
    setFilePickerInitialQuery("");
    setFilePickerResetToken((token) => token + 1);
    setFilePickerOpen(true);
  }, []);
  const onOpenCommandPalette = useCallback(() => {
    rememberPaletteFocus();
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    setFinderMode(true);
    setFilePickerInitialQuery(">");
    setFilePickerResetToken((token) => token + 1);
    setFilePickerOpen(true);
  }, []);
  // WP-74: ⌘K opens the same palette, ready to search every kind.
  const onOpenFinder = useCallback(() => {
    rememberPaletteFocus();
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    setFinderMode(true);
    setFilePickerInitialQuery("");
    setFilePickerResetToken((token) => token + 1);
    setFilePickerOpen(true);
  }, []);
  const onReload = useCallback(() => {
    void (async () => {
      if (!(await confirmReload(dirtyFilesRef.current.size > 0))) return;
      window.location.reload();
    })();
  }, []);

  const onFindInProject = useCallback(() => {
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    setSidebarTab("files");
    setFilesSearchOpen(true);
    setSearchFocusToken((token) => token + 1);
  }, []);

  const onOpenSearch = useCallback(() => {
    workspaceNavigation.cancel();
    startTransition(() => {
      // With the Mono closed in the same commit, no frame shows the
      // workspace tab between the two views.
      closeMonoView();
      rememberAppView("search");
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      setSearchViewOpen(true);
      setSearchViewFocusToken((token) => token + 1);
    });
  }, []);

  const onLeaveSearch = useCallback(() => {
    setSearchViewOpen(false);
  }, []);

  const onOpenInbox = useCallback(() => {
    workspaceNavigation.cancel();
    startTransition(() => {
      closeMonoView();
      rememberAppView("inbox");
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setSearchViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      setInboxViewOpen(true);
    });
  }, []);

  const onOpenLinkedWorkItem = useCallback(
    (item: LinkedWorkItem, sessionId: string) => {
      const request = linkedWorkItemPanelRequest.current + 1;
      linkedWorkItemPanelRequest.current = request;
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setSearchViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      setInboxViewOpen(false);
      const cwd =
        sessionsRef.current.find((session) => session.id === sessionId)?.cwd ??
        history.find((session) => session.id === sessionId)?.cwd ??
        sidebarCwd;
      void onSelectHistorySession(sessionId).then(() => {
        if (linkedWorkItemPanelRequest.current !== request) return;
        if (!sessionsRef.current.some((session) => session.id === sessionId)) {
          return;
        }
        setLinkedWorkItemPanels((current) => {
          const next = new Map(current);
          // Reinsert the panel so it wins if this workspace tab contains
          // multiple sessions with remembered panels.
          next.delete(sessionId);
          next.set(sessionId, { item, sessionId, cwd });
          return next;
        });
      });
    },
    [history, onSelectHistorySession, sidebarCwd],
  );

  const onLeaveInbox = useCallback(() => {
    setInboxViewOpen(false);
  }, []);

  const onOpenInboxSession = useCallback(
    (sessionId: string) => {
      setInboxViewOpen(false);
      const cwd =
        sessionsRef.current.find((session) => session.id === sessionId)?.cwd ??
        history.find((session) => session.id === sessionId)?.cwd;
      setSidebarTab("sessions", cwd);
      void onSelectHistorySession(sessionId);
    },
    [history, onSelectHistorySession],
  );

  const onRepairChecks = useCallback(
    async (item: InboxItem, request: CiRepairRequest, sessionId?: string) => {
      const cwd = item.projectPath;
      if (!cwd) throw new Error("Choose a local project for this PR first.");
      let session = sessionId ? await ensureOpenSession(sessionId) : undefined;
      if (
        sessionId &&
        (!session ||
          session.inboxAsk ||
          session.orchestrationLeadId ||
          !sameProjectPath(session.cwd, cwd))
      ) {
        throw new Error("Choose a chat from this project.");
      }
      if (
        session &&
        (session.busy || session.pendingSwitch || isPreparingHandoff(session))
      ) {
        throw new Error(
          "This chat is busy. Choose another chat or start a new one.",
        );
      }
      if (!session) {
        session = {
          ...newDefaultSession(cwd, sessionDefaults?.runtimeMode),
          title: `Fix CI #${item.number}: ${item.title}`,
          linkedWorkItem: linkedWorkItemFromInboxItem(item) ?? undefined,
        };
        const next = [...sessionsRef.current, session];
        sessionsRef.current = next;
        setSessions(next);
      }
      const repairSessionId = session.id;
      trackCiRepair(cwd, request, repairSessionId, (settle) =>
        onSubmit(repairSessionId, request.text, [], {
          ciRepair: request,
          noteCard: undefined,
          handoffCard: undefined,
          onSettled: (outcome) => settle(outcome.status),
        }),
      );
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setSearchViewOpen(false);
      setSidebarTab("sessions", cwd);
      await onSelectHistorySession(session.id);
    },
    [
      ensureOpenSession,
      onSubmit,
      onSelectHistorySession,
      sessionDefaults?.runtimeMode,
    ],
  );

  const onOpenNotes = useCallback(() => {
    workspaceNavigation.cancel();
    if (!loadNotesEnabled()) return;
    startTransition(() => {
      closeMonoView();
      rememberAppView("notes");
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setAutomationsViewOpen(false);
      setNotesViewOpen(true);
    });
  }, []);

  const onLeaveNotes = useCallback(() => {
    setNotesViewOpen(false);
  }, []);

  const onOpenAutomations = useCallback(() => {
    workspaceNavigation.cancel();
    startTransition(() => {
      closeMonoView();
      rememberAppView("automations");
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setPagesMode(false);
      setAutomationsViewOpen(true);
    });
  }, []);

  const onOpenPages = useCallback(() => {
    workspaceNavigation.cancel();
    startTransition(() => {
      // Like the other views since the inset layout: a Mono in view closes.
      closeMonoView();
      setFilePickerOpen(false);
      setSettingsOpen(false);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setPagesMode(true);
      setAutomationsViewOpen(true);
    });
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      switch ((event as CustomEvent<string>).detail) {
        case "pages": onOpenPages(); break;
        case "notes": onOpenNotes(); break;
        case "automations": onOpenAutomations(); break;
      }
    };
    window.addEventListener("monocode:home-open", open);
    return () => window.removeEventListener("monocode:home-open", open);
  }, [onOpenPages, onOpenNotes, onOpenAutomations]);

  const onLeaveAutomations = useCallback(() => {
    setAutomationsViewOpen(false);
  }, []);

  const onOpenAutomationSession = useCallback(
    async (sessionId: string) => {
      const session = await ensureOpenSession(sessionId);
      if (!session)
        throw new Error("This conversation is no longer available.");
      setAutomationsViewOpen(false);
      setSearchViewOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setSettingsOpen(false);
      setFilePickerOpen(false);
      setSidebarTab("sessions", session.cwd);
      setProjectCwd(session.cwd);
      setRecents(rememberProject(session.cwd));
      await onSelectHistorySession(sessionId);
    },
    [ensureOpenSession, onSelectHistorySession],
  );

  const openSettings = useCallback(
    (section?: SettingsSectionId, anchor?: SettingsAnchor) => {
      workspaceNavigation.cancel();
      if (!settingsOpenRef.current) {
        settingsReturnViewRef.current = {
          search: searchViewOpenRef.current,
          inbox: inboxViewOpenRef.current,
          notes: notesViewOpenRef.current,
          automations: automationsViewOpenRef.current,
        };
      }
      startTransition(() => {
        setFilePickerOpen(false);
        setSearchViewOpen(false);
        setInboxViewOpen(false);
        setNotesViewOpen(false);
        setAutomationsViewOpen(false);
        if (section) {
          setSettingsSection(section);
          saveSettingsSection(section);
        }
        setSettingsAnchor(anchor ?? null);
        setNotificationProjectPath(null);
        setSettingsOpen(true);
      });
    },
    [],
  );

  const onOpenSettings = useCallback(() => openSettings(), [openSettings]);
  useEffect(() => {
    const openConnections = () => openSettings("connections");
    window.addEventListener(OPEN_CONNECTIONS_EVENT, openConnections);
    return () =>
      window.removeEventListener(OPEN_CONNECTIONS_EVENT, openConnections);
  }, [openSettings]);
  const [remoteProjectDialogOpen, setRemoteProjectDialogOpen] = useState(false);
  useEffect(() => {
    const open = () => setRemoteProjectDialogOpen(true);
    window.addEventListener(OPEN_REMOTE_PROJECT_EVENT, open);
    return () => window.removeEventListener(OPEN_REMOTE_PROJECT_EVENT, open);
  }, []);

  // Hub: a Sign in on Today opens that connector on Settings > Connectors; a Mono proposal opens Settings > Teams.
  useEffect(() => {
    const onConnector = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id;
      if (id) focusConnector(id);
      openSettings("connectors", id ? `connector-${id}` : undefined);
    };
    const onTeams = () => openSettings("teams");
    // A team's room (a hub group chat) opened from Settings > Teams: leave Settings for the hub view.
    const onOpenHub = (event: Event) => {
      // WP-06: Decisions → Open asks for "inbox", which is the retired Today item. That opens the Inbox.
      const open = resolveHubOpen((event as CustomEvent).detail);
      if (!open) return;
      if (open.kind === "inbox") {
        onOpenInbox();
        return;
      }
      setSettingsOpen(false);
      setHubSelection(open.selection);
    };
    window.addEventListener(OPEN_CONNECTOR_EVENT, onConnector);
    window.addEventListener(OPEN_TEAMS_EVENT, onTeams);
    window.addEventListener(OPEN_HUB_EVENT, onOpenHub);
    return () => {
      window.removeEventListener(OPEN_CONNECTOR_EVENT, onConnector);
      window.removeEventListener(OPEN_TEAMS_EVENT, onTeams);
      window.removeEventListener(OPEN_HUB_EVENT, onOpenHub);
    };
  }, [onOpenInbox, openSettings]);

  useEffect(() => {
    const onOpenMcp = () => openSettings("mcp");
    window.addEventListener("monocode:open-mcp-settings", onOpenMcp);
    return () =>
      window.removeEventListener("monocode:open-mcp-settings", onOpenMcp);
  }, [openSettings]);

  const onOpenNotificationSettings = useCallback(
    (path?: string) => {
      openSettings("inbox", "project-notifications");
      setNotificationProjectPath(path ?? null);
      setNotificationSettingsRequest((request) => request + 1);
    },
    [openSettings],
  );

  const onOpenInboxIntegrations = useCallback(
    (source: ConnectableInboxSource) => openSettings("inbox", source),
    [openSettings],
  );

  const onCloseSettings = useCallback(() => {
    const returnView = settingsReturnViewRef.current;
    setSearchViewOpen(returnView.search);
    setInboxViewOpen(returnView.inbox);
    setNotesViewOpen(returnView.notes && loadNotesEnabled());
    setAutomationsViewOpen(returnView.automations);
    setSettingsOpen(false);
  }, []);

  const onSelectSettingsSection = useCallback((section: SettingsSectionId) => {
    setSettingsSection(section);
    saveSettingsSection(section);
  }, []);

  const onOpenArchivedSession = useCallback(
    (sessionId: string) => {
      setSettingsOpen(false);
      void onSelectHistorySession(sessionId);
    },
    [onSelectHistorySession],
  );

  const onRailBack = useCallback(() => {
    if (settingsOpen) {
      onCloseSettings();
      return;
    }
    if (searchViewOpen) {
      setSearchViewOpen(false);
      return;
    }
    if (inboxViewOpen) {
      setInboxViewOpen(false);
      return;
    }
    if (notesViewOpen) {
      setNotesViewOpen(false);
      return;
    }
    if (automationsViewOpen) {
      setAutomationsViewOpen(false);
      return;
    }
    if (monoViewIdRef.current) {
      closeMonoView();
      setComposerFocused(true);
      return;
    }
    onVisitBack();
  }, [
    onCloseSettings,
    onVisitBack,
    closeMonoView,
    searchViewOpen,
    settingsOpen,
    inboxViewOpen,
    notesViewOpen,
    automationsViewOpen,
  ]);

  const onRailForward = useCallback(() => {
    setSearchViewOpen(false);
    setSettingsOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    onVisitForward();
  }, [onVisitForward]);

  useEffect(() => {
    if (sidebarTab === "inbox") setSidebarTab("sessions");
  }, [sidebarTab]);

  useEffect(() => {
    if (!dockVisible) setProjectTerminalFocused(false);
  }, [dockVisible]);

  const openFilePaths = useMemo(() => {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const tab of tabs) {
      for (const pane of tab.editorPanes) {
        for (const file of pane.files) {
          if (!isFilesystemTab(file) || seen.has(file.path)) continue;
          seen.add(file.path);
          paths.push(file.path);
        }
      }
    }
    return paths;
  }, [tabs]);

  useEffect(() => {
    void invoke("set_traffic_lights_visible", { visible: true }).catch(
      () => {},
    );
  }, []);

  const onSessionNavigationOrder = useCallback((ids: readonly string[]) => {
    sessionNavigationIdsRef.current = ids;
  }, []);

  const onNavigateSessionList = useCallback(
    (delta: number, inCurrentTab = false) => {
      const activeWorkspace = tabsRef.current.find(
        (entry) => entry.id === activeTabIdRef.current,
      );
      if (!activeWorkspace || activeWorkspace.diffFocused) return;
      const current = sessionsRef.current.find(
        (session) => session.id === activeWorkspace.focusedId,
      );
      if (!current) return;
      const remoteProject = isRemoteProjectPath(current.cwd);
      const navigationId = remoteProject
        ? remoteSessionFor(current.id)
        : current.id;
      if (!navigationId) return;

      const next = adjacentItemId(
        sessionNavigationIdsRef.current,
        navigationId,
        delta,
      );
      if (!next || next === navigationId) return;
      if (remoteProject) {
        if (inCurrentTab) {
          rememberRemoteSession(current.id, next);
          setComposerFocused(true);
        } else {
          onSelectRemoteSession(current.cwd, next);
        }
        return;
      }
      // Stepping gives no hover to warm the transcript, so load the one a
      // further step away once this switch has its own session.
      const prefetchAhead = () => {
        const ahead = adjacentItemId(
          sessionNavigationIdsRef.current,
          next,
          delta,
        );
        if (ahead && ahead !== current.id) onPrefetchHistorySession(ahead);
      };
      if (!inCurrentTab) {
        void onSelectHistorySession(next).then(prefetchAhead);
        return;
      }
      const activeTabId = activeWorkspace.id;
      const focusedId = current.id;
      void ensureOpenSession(next).then((session) => {
        prefetchAhead();
        if (!session || session.inboxAsk) return;
        if (activeTabIdRef.current !== activeTabId) return;
        const currentTab = tabsRef.current.find(
          (tab) => tab.id === activeTabId,
        );
        if (currentTab?.focusedId !== focusedId) return;
        setTabs(
          (prev) =>
            switchSessionInTab(prev, activeTabId, focusedId, next) ?? prev,
        );
        setComposerFocused(true);
        const linkedUpdate = linkedSessionUpdatesRef.current.get(next);
        if (linkedUpdate) revealLinkedSessionUpdate(next, linkedUpdate);
      });
    },
    [
      ensureOpenSession,
      onPrefetchHistorySession,
      onSelectHistorySession,
      onSelectRemoteSession,
      revealLinkedSessionUpdate,
    ],
  );

  const onNavigateProjectList = useCallback(
    (delta: number) => {
      const current = normalizeProjectPath(projectCwdRef.current);
      const ids = projectRailItems(loadRecents(), current).map(
        (project) => project.path,
      );
      const next = adjacentItemId(ids, current, delta);
      if (!next || sameProjectPath(next, current)) return;
      noteProjectStep(next, delta);
      onSelectProject(next);
    },
    [onSelectProject],
  );

  const onSelectTitleTab = useCallback(
    (id: string) => {
      const monoId = monoForTab(id);
      if (monoId) {
        void onOpenMono(monoId);
        return;
      }
      const view = appViewForTab(id);
      if (view) {
        const open = {
          search: onOpenSearch,
          inbox: onOpenInbox,
          notes: onOpenNotes,
          automations: onOpenAutomations,
        };
        open[view]();
        return;
      }
      setSearchViewOpen(false);
      setSettingsOpen(false);
      setInboxViewOpen(false);
      setNotesViewOpen(false);
      setAutomationsViewOpen(false);
      activateTab(id);
    },
    [
      activateTab,
      onOpenMono,
      onOpenSearch,
      onOpenInbox,
      onOpenNotes,
      onOpenAutomations,
    ],
  );

  displayedTabNavigation.current = {
    tabs: insetLayout ? titleTabs : [],
    activeId: settingsOpen
      ? ""
      : monoCovers
        ? (monoViewTabId ?? "")
        : activeAppView
          ? appViewTabId(activeAppView)
          : activeTabId,
    select: onSelectTitleTab,
  };

  const onCloseAppView = useCallback((view: AppView, selectNeighbor = true) => {
    const navigation = displayedTabNavigation.current;
    const nextId = selectNeighbor
      ? nextDisplayedTabAfterClose(
          navigation.tabs,
          navigation.activeId,
          appViewTabId(view),
        )
      : undefined;
    startTransition(() => {
      setOpenAppViews((current) => current.filter((entry) => entry !== view));
      setTitleTabOrder((current) =>
        current.filter((id) => id !== appViewTabId(view)),
      );
      if (view === "search") setSearchViewOpen(false);
      if (view === "inbox") setInboxViewOpen(false);
      if (view === "notes") setNotesViewOpen(false);
      if (view === "automations") setAutomationsViewOpen(false);
      if (nextId) navigation.select?.(nextId);
    });
  }, []);
  /** Closing a Mono's tab puts its view away when it is the one shown. */
  const onCloseMonoTab = useCallback(
    (monoId: string, selectNeighbor = true) => {
      const navigation = displayedTabNavigation.current;
      const id = monoTabId(monoId);
      const showing = navigation.activeId === id;
      const nextId =
        selectNeighbor && showing
          ? nextDisplayedTabAfterClose(navigation.tabs, navigation.activeId, id)
          : undefined;
      startTransition(() => {
        setOpenMonoTabs((current) =>
          current.filter((entry) => entry !== monoId),
        );
        setTitleTabOrder((current) => current.filter((entry) => entry !== id));
        if (nextId) navigation.select?.(nextId);
        else if (showing) closeMonoView();
      });
    },
    [closeMonoView],
  );
  const closeViewTab = useCallback(
    (id: string, selectNeighbor?: boolean) => {
      const view = appViewForTab(id);
      if (view) onCloseAppView(view, selectNeighbor);
      const monoId = monoForTab(id);
      if (monoId) onCloseMonoTab(monoId, selectNeighbor);
    },
    [onCloseAppView, onCloseMonoTab],
  );
  const onCloseDisplayedTab = useCallback(
    (id: string) => {
      if (isViewTab(id)) closeViewTab(id);
      else onCloseTitleTab(id);
    },
    [closeViewTab, onCloseTitleTab],
  );
  const onCloseDisplayedTabs = useCallback(
    (ids: string[], fallbackId: string) => {
      const navigation = displayedTabNavigation.current;
      const closing = new Set(ids);
      const workspaceIds = ids.filter((id) => !isViewTab(id));
      startTransition(() => {
        for (const id of ids) {
          if (isViewTab(id)) closeViewTab(id, false);
        }
        if (workspaceIds.length > 0) {
          // Kept from a view tab, the workspace beneath falls back to one of
          // this project's shown tabs that stays open; with none left, Close
          // All keeps a blank one rather than reaching into another project.
          const workspaceFallback = isViewTab(fallbackId)
            ? [
                activeTabIdRef.current,
                ...navigation.tabs.map((tab) => tab.id),
              ].find(
                (id) =>
                  !closing.has(id) &&
                  !isViewTab(id) &&
                  navigation.tabs.some((tab) => tab.id === id),
              )
            : fallbackId;
          if (workspaceFallback) onCloseTabs(workspaceIds, workspaceFallback);
          else onCloseEveryTab(workspaceIds);
        }
        if (closing.has(navigation.activeId)) navigation.select?.(fallbackId);
      });
    },
    [closeViewTab, onCloseTabs, onCloseEveryTab],
  );
  const onCloseAllDisplayedTabs = useCallback(
    (ids: readonly string[]) => {
      startTransition(() => {
        for (const id of ids) {
          if (isViewTab(id)) closeViewTab(id, false);
        }
        onCloseEveryTab(ids.filter((id) => !isViewTab(id)));
      });
    },
    [closeViewTab, onCloseEveryTab],
  );
  const onReorderDisplayedTabs = useCallback(
    (ids: string[], movedId?: string) => {
      setTitleTabOrder((current) =>
        mergeOrderedSubset(
          current.map((id) => ({ id })),
          ids.map((id) => ({ id })),
        ).map((tab) => tab.id),
      );
      onReorderTabs(
        ids.filter((id) => !isViewTab(id)),
        isViewTab(movedId ?? "") ? undefined : movedId,
      );
    },
    [onReorderTabs],
  );
  const onCloseVisibleTab = useCallback(() => {
    if (insetLayout && monoCovers && monoViewTabId) closeViewTab(monoViewTabId);
    else if (insetLayout && activeAppView) onCloseAppView(activeAppView);
    else onCloseFocused();
  }, [
    insetLayout,
    monoCovers,
    monoViewTabId,
    activeAppView,
    closeViewTab,
    onCloseAppView,
    onCloseFocused,
  ]);
  const onCycleVisibleTab = useCallback(
    (delta: number) => {
      if (!insetLayout) {
        (delta > 0 ? onNext : onPrev)();
        return;
      }
      const current =
        monoCovers && monoViewTabId
          ? monoViewTabId
          : activeAppView
            ? appViewTabId(activeAppView)
            : activeTabId;
      const index = titleTabs.findIndex((tab) => tab.id === current);
      const next =
        titleTabs[(index + delta + titleTabs.length) % titleTabs.length];
      if (next) onSelectTitleTab(next.id);
    },
    [
      insetLayout,
      monoCovers,
      monoViewTabId,
      activeAppView,
      activeTabId,
      titleTabs,
      onSelectTitleTab,
      onNext,
      onPrev,
    ],
  );
  const onActivateVisibleTab = useCallback(
    (slot: number) => {
      if (!insetLayout) {
        onActivate(slot);
        return;
      }
      const tab = slot < 0 ? titleTabs[titleTabs.length - 1] : titleTabs[slot];
      if (tab) onSelectTitleTab(tab.id);
    },
    [insetLayout, titleTabs, onSelectTitleTab, onActivate],
  );

  // The inset layout's shortcuts close every kind of title tab, like its
  // tab menu.
  const onCloseOtherVisibleTabs = useCallback(() => {
    if (!insetLayout) {
      onCloseOtherTabs();
      return;
    }
    const { tabs: shown, activeId } = displayedTabNavigation.current;
    if (!shown.some((tab) => tab.id === activeId)) return;
    onCloseDisplayedTabs(
      shown.filter((tab) => tab.id !== activeId).map((tab) => tab.id),
      activeId,
    );
  }, [insetLayout, onCloseOtherTabs, onCloseDisplayedTabs]);
  const onCloseAllVisibleTabs = useCallback(() => {
    if (!insetLayout) {
      onCloseAllTabs();
      return;
    }
    onCloseAllDisplayedTabs(
      displayedTabNavigation.current.tabs.map((tab) => tab.id),
    );
  }, [insetLayout, onCloseAllTabs, onCloseAllDisplayedTabs]);

  const actions = useRef({
    onNewFocused,
    onArchiveFocusedSession,
    onCloseOtherTabs: onCloseOtherVisibleTabs,
    onCloseAllTabs: onCloseAllVisibleTabs,
    onCloseFocused: onCloseVisibleTab,
    onNext: () => onCycleVisibleTab(1),
    onPrev: () => onCycleVisibleTab(-1),
    onVisitBack,
    onVisitForward,
    onActivate: onActivateVisibleTab,
    onSplit,
    onFocusDir,
    onToggleSidebar,
    onToggleSessionSidebar: onToggleSessionSidebarShortcut,
    onToggleMono,
    onGoToFile,
    onOpenCommandPalette,
    onReload,
    onFindInProject,
    onOpenSearch,
    onOpenFinder,
    onOpenInbox,
    onOpenNotes,
    pickProject,
    onNewTerminal,
    onNewTerminalTab,
    onToggleProjectTerminal,
    onNavigateSessionList,
    onNavigateProjectList,
    openSettings,
    onOpenApprovalSession,
  });
  actions.current = {
    onNewFocused,
    onArchiveFocusedSession,
    onCloseOtherTabs: onCloseOtherVisibleTabs,
    onCloseAllTabs: onCloseAllVisibleTabs,
    onCloseFocused: onCloseVisibleTab,
    onNext: () => onCycleVisibleTab(1),
    onPrev: () => onCycleVisibleTab(-1),
    onVisitBack,
    onVisitForward,
    onActivate: onActivateVisibleTab,
    onSplit,
    onFocusDir,
    onToggleSidebar,
    onToggleSessionSidebar: onToggleSessionSidebarShortcut,
    onToggleMono,
    onGoToFile,
    onOpenCommandPalette,
    onReload,
    onFindInProject,
    onOpenSearch,
    onOpenFinder,
    onOpenInbox,
    onOpenNotes,
    pickProject,
    onNewTerminal,
    onNewTerminalTab,
    onToggleProjectTerminal,
    onNavigateSessionList,
    onNavigateProjectList,
    openSettings,
    onOpenApprovalSession,
  };

  const debounce = useRef({ name: "", at: 0 });
  const run = useCallback((name: string, fn: () => void) => {
    const now = performance.now();
    if (name === debounce.current.name && now - debounce.current.at < 80)
      return;
    debounce.current = { name, at: now };
    fn();
  }, []);

  // WP-93: the command palette's rows for what the app can do right now, and
  // the one runner that sends each row to the handler its shortcut uses.
  // Read fresh on the render that opens the palette, so "now" means now.
  // Esc stops the Mono's chat while the Mono view is open, else the focused
  // tab's busy chat; Stop chat in the palette reads the same way.
  const paletteStopTarget: string | null = monoViewId
    ? sessions.find((session) => session.id === monoViewId)?.busy
      ? monoViewId
      : null
    : focusedBusyAgentSessionId(
        activeTabId,
        tabs,
        sessions,
        projectTerminalFocusedRef.current,
      );
  const paletteContext: PaletteContext = {
    project:
      isLocalProject(sidebarCwd) || isRemoteProjectPath(sidebarCwd)
        ? sidebarCwd
        : null,
    terminal: isLocalProject(projectCwd),
    chat: Boolean(activeSessionId),
    busy: Boolean(paletteStopTarget),
    ...paletteFocusOf(paletteFocusRef.current),
    editor: Boolean(activeFile && isFilesystemTab(activeFile)),
  };
  const paletteStopTargetRef = useRef<string | null>(null);
  paletteStopTargetRef.current = paletteStopTarget;
  // WP-123: the chat Fork from here acts on: the one in view, and none while a file tab is.
  const paletteForkTargetRef = useRef<string | null>(null);
  paletteForkTargetRef.current =
    activeSessionId && !(activeFile && isFilesystemTab(activeFile))
      ? activeSessionId
      : null;
  const runPaletteCommandFromFinder = useCallback(
    (row: Parameters<typeof runPaletteRow>[0]) =>
      runPaletteCommand(row, actions.current, {
        run,
        stopChat: () => paletteStopTargetRef.current,
        stop: (id) => onStopFromUser(id),
        // The shortcut's own handler, as if it were pressed where focus was.
        archiveFocused: () =>
          onArchiveFocusedSession({
            defaultPrevented: false,
            target: focusBeforePalette(paletteFocusRef.current),
            preventDefault: () => undefined,
            stopPropagation: () => undefined,
          } as unknown as KeyboardEvent),
        showHome: () => showAppItem("home"),
        showChanges: onShowSourceControl,
        openModelPicker: () =>
          window.dispatchEvent(new Event("open_model_picker")),
        newWindow: () => void invoke("open_new_window"),
        zoom: (action) => {
          const next =
            action === "zoom-in"
              ? saveUiScale(zoomInUiScale(loadUiScale()))
              : action === "zoom-out"
                ? saveUiScale(zoomOutUiScale(loadUiScale()))
                : UI_SCALE_DEFAULT;
          saveUiScale(next);
          void applyUiScale(next);
        },
        editor: (action) => {
          if (action === "replace") openReplaceInActiveEditor();
          else openFindInActiveEditor();
        },
        // WP-123: fork the chat in focus from its latest message.
        forkChat: () => {
          const id = paletteForkTargetRef.current;
          if (!id) return;
          forkFocusedChat(sessionsRef.current.find((session) => session.id === id));
        },
      }),
    [run, onShowSourceControl, onStopFromUser, onArchiveFocusedSession],
  );

  useEffect(() => {
    if (!IS_MAC) return;
    void invoke("autosave_set_enabled", { enabled: loadAutosave() }).catch(
      console.error,
    );
    void invoke("keybindings_set_overrides", {
      overrides: loadKeybindingOverrides(),
    }).catch(console.error);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The Quick Composer recorder owns the next key combination, including
      // bindings that the workspace would normally handle in capture phase.
      // It records only while focused, so check the focused element: a
      // document-wide query walked the whole DOM on every keystroke.
      if (
        document.activeElement?.getAttribute(
          "data-shortcut-recorder-active",
        ) === "true"
      )
        return;
      // Never act on a chord while an IME is composing: tabCommand and the
      // editor guards already do, and the app shortcut resolver does too, so
      // this keeps the whole handler consistent for whatever is added next.
      if (e.isComposing) return;
      const customCommand = matchCustomKeybinding(e);
      const pressed = (command: string, defaultMatch: boolean) =>
        keybindingPressed(command, e, defaultMatch);
      // A rebound zoom chord may be Option-only, so it is resolved outside the
      // Cmd/Ctrl guard that only the browser-standard defaults need.
      const zoom = resolveZoomKeybinding(e);
      // An image preview under the pointer zooms the image instead; its own
      // listener runs next.
      if (zoom && document.querySelector("[data-image-zoom]")) return;
      if (zoom) {
        e.preventDefault();
        e.stopPropagation();
        if (zoom === "zoom-in") {
          const next = saveUiScale(zoomInUiScale(loadUiScale()));
          void applyUiScale(next);
        } else if (zoom === "zoom-out") {
          const next = saveUiScale(zoomOutUiScale(loadUiScale()));
          void applyUiScale(next);
        } else {
          saveUiScale(UI_SCALE_DEFAULT);
          void applyUiScale(UI_SCALE_DEFAULT);
        }
        return;
      }
      const cmd = customCommand
        ? tabCommandForKeybinding(customCommand, e)
        : tabCommand(e);
      if (cmd && pressed(tabCommandKeybinding(cmd), !customCommand)) {
        if (cmd === "archive-session") {
          if (e.repeat) return;
          actions.current.onArchiveFocusedSession(e);
          return;
        }
        const target = e.target instanceof Element ? e.target : null;
        const listNavigation =
          cmd === "prev-session" ||
          cmd === "next-session" ||
          cmd === "prev-session-in-tab" ||
          cmd === "next-session-in-tab" ||
          cmd === "prev-project" ||
          cmd === "next-project";
        if (listNavigation) {
          const blockedTarget = Boolean(
            target?.closest(
              'input, textarea, select, [contenteditable="true"], .cm-editor, .monocode-terminal, [role="dialog"], [data-model-picker], [data-file-picker], [data-branch-picker], [data-skill-picker], [data-mention-picker], [data-app-search]',
            ),
          );
          const emptyComposerTarget = Boolean(
            target?.matches('textarea[data-composer-empty="true"]'),
          );
          const surfaceOpen =
            searchViewOpenRef.current ||
            inboxViewOpenRef.current ||
            notesViewOpenRef.current ||
            automationsViewOpenRef.current ||
            settingsOpenRef.current ||
            filePickerOpenRef.current ||
            Boolean(whatsNewVersionRef.current);
          if (
            !shouldHandleListNavigation({
              blockedTarget,
              emptyComposerTarget,
              surfaceOpen,
            })
          ) {
            return;
          }
        }
        if (
          target?.closest(".monocode-terminal") &&
          e.ctrlKey &&
          !e.metaKey &&
          (cmd === "back" ||
            cmd === "forward" ||
            /Mac|iPhone|iPad/.test(navigator.platform))
        ) {
          return;
        }
        if (
          (cmd === "split-right" || cmd === "split-down") &&
          target?.closest(".cm-editor")
        ) {
          return;
        }
        const inPicker =
          target &&
          target.closest(
            "[data-model-picker], [data-file-picker], [data-branch-picker], [data-skill-picker], [data-mention-picker], [data-app-search]",
          );
        if (
          inPicker &&
          typeof cmd === "object" &&
          "activate" in cmd &&
          !(insetLayoutRef.current && target?.closest("[data-app-search]"))
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const a = actions.current;
        if (cmd === "new") run("new", a.onNewFocused);
        else if (cmd === "close-others")
          run("close-others", a.onCloseOtherTabs);
        else if (cmd === "close-all") run("close-all", a.onCloseAllTabs);
        else if (cmd === "close") run("close", a.onCloseFocused);
        else if (cmd === "next") run("next", a.onNext);
        else if (cmd === "prev") run("prev", a.onPrev);
        else if (cmd === "cycle-next") run("next", a.onNext);
        else if (cmd === "cycle-prev") run("prev", a.onPrev);
        else if (cmd === "back") run("back", a.onVisitBack);
        else if (cmd === "forward") run("forward", a.onVisitForward);
        else if (cmd === "split-right")
          run("split-right", () => a.onSplit("right"));
        else if (cmd === "split-down")
          run("split-down", () => a.onSplit("down"));
        else if (cmd === "new-terminal") run("new-terminal", a.onNewTerminal);
        else if (cmd === "new-terminal-tab")
          run("new-terminal-tab", a.onNewTerminalTab);
        else if (cmd === "toggle-terminal")
          run("toggle-terminal", a.onToggleProjectTerminal);
        else if (cmd === "prev-session")
          run("prev-session", () => a.onNavigateSessionList(-1));
        else if (cmd === "next-session")
          run("next-session", () => a.onNavigateSessionList(1));
        else if (cmd === "prev-session-in-tab")
          run("prev-session-in-tab", () => a.onNavigateSessionList(-1, true));
        else if (cmd === "next-session-in-tab")
          run("next-session-in-tab", () => a.onNavigateSessionList(1, true));
        else if (cmd === "prev-project")
          run("prev-project", () => a.onNavigateProjectList(-1));
        else if (cmd === "next-project")
          run("next-project", () => a.onNavigateProjectList(1));
        else if (typeof cmd === "object" && "focus" in cmd)
          run(`focus-${cmd.focus}`, () => a.onFocusDir(cmd.focus));
        else if (typeof cmd === "object" && "activate" in cmd)
          run(`activate-${cmd.activate}`, () => a.onActivate(cmd.activate));
        return;
      }
      if (
        !searchViewOpenRef.current &&
        !inboxViewOpenRef.current &&
        !notesViewOpenRef.current &&
        !automationsViewOpenRef.current &&
        !(
          e.target instanceof Element &&
          e.target.closest("[data-session-drop], [data-agent-tab]")
        ) &&
        handleEditorFindKey(e)
      ) {
        e.stopPropagation();
        return;
      }
      const shortcut = resolveAppShortcut(e);
      if (shortcut) {
        // WP-74: ⌘K opens the finder. Ctrl+K in the terminal stays with the terminal.
        if (
          finderShortcutAction(
            shortcut,
            e.target instanceof Element && !!e.target.closest(".monocode-terminal"),
            e.ctrlKey,
            e.metaKey,
          ) === "leave"
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const a = actions.current;
        if (shortcut === "App: New Window")
          run("new_window", () => void invoke("open_new_window"));
        else if (shortcut === "App: Open Project")
          run("open_project", () => void a.pickProject());
        else if (shortcut === "App: Toggle Sidebar")
          run("toggle_sidebar", a.onToggleSidebar);
        else if (shortcut === "App: Toggle Session Sidebar")
          run("toggle_session_sidebar", a.onToggleSessionSidebar);
        else if (shortcut === "App: Toggle Mono")
          run("toggle_mono", a.onToggleMono);
        else if (shortcut === "App: Go to File")
          run("go_to_file", a.onGoToFile);
        else if (shortcut === "App: Command Palette")
          run("open_command_palette", a.onOpenCommandPalette);
        else if (shortcut === "View: Reload") run("reload", a.onReload);
        else if (shortcut === "App: Search") run("open_finder", a.onOpenFinder);
        else if (shortcut === "App: Settings")
          run("open_settings", () => a.openSettings());
        else if (shortcut === "App: Find in Files")
          run("find_in_project", a.onFindInProject);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run]);

  useEffect(() => {
    const unlisten: Array<Promise<() => void>> = [
      listen("new_tab", () => run("new", actions.current.onNewFocused)),
      listen("close_other_tabs", () =>
        run("close-others", actions.current.onCloseOtherTabs),
      ),
      listen("close_all_tabs", () =>
        run("close-all", actions.current.onCloseAllTabs),
      ),
      listen("close_tab", () => run("close", actions.current.onCloseFocused)),
      listen<boolean>("toggle_autosave", ({ payload }) => {
        const saved = saveAutosave(payload);
        if (saved !== payload && IS_MAC) {
          void invoke("autosave_set_enabled", { enabled: saved });
        }
      }),
      listen("next_tab", () => run("next", actions.current.onNext)),
      listen("prev_tab", () => run("prev", actions.current.onPrev)),
      listen("back_tab", () => run("back", actions.current.onVisitBack)),
      listen("forward_tab", () =>
        run("forward", actions.current.onVisitForward),
      ),
      listen("split_right", () =>
        run("split-right", () => actions.current.onSplit("right")),
      ),
      listen("split_down", () =>
        run("split-down", () => actions.current.onSplit("down")),
      ),
      listen("new_terminal", () =>
        run("new-terminal", actions.current.onNewTerminal),
      ),
      listen("new_terminal_tab", () =>
        run("new-terminal-tab", actions.current.onNewTerminalTab),
      ),
      listen("toggle_terminal", () =>
        run("toggle-terminal", actions.current.onToggleProjectTerminal),
      ),
      listen("focus_left", () =>
        run("focus-left", () => actions.current.onFocusDir("left")),
      ),
      listen("focus_right", () =>
        run("focus-right", () => actions.current.onFocusDir("right")),
      ),
      listen("focus_up", () =>
        run("focus-up", () => actions.current.onFocusDir("up")),
      ),
      listen("focus_down", () =>
        run("focus-down", () => actions.current.onFocusDir("down")),
      ),
      listen("toggle_sidebar", () =>
        run("toggle_sidebar", actions.current.onToggleSidebar),
      ),
      listen("toggle_session_sidebar", () =>
        run("toggle_session_sidebar", actions.current.onToggleSessionSidebar),
      ),
      listen("open_project", () => {
        void actions.current.pickProject();
      }),
      listen("go_to_file", () => run("go_to_file", actions.current.onGoToFile)),
      listen("open_command_palette", () =>
        run("open_command_palette", actions.current.onOpenCommandPalette),
      ),
      listen("reload", () => run("reload", actions.current.onReload)),
      listen("open_search", () => actions.current.onOpenSearch()),
      listen("open_inbox", () => actions.current.onOpenInbox()),
      listen("open_notes", () => actions.current.onOpenNotes()),
      listen("open_settings", () => actions.current.openSettings()),
      listen("check_for_updates", () => {
        void runUpdateFlow(true);
      }),
      listen("sidebar_opacity", () => {
        actions.current.openSettings("appearance");
      }),
      listen("find_in_project", () => actions.current.onFindInProject()),
      listen("find", () => {
        openFindInActiveEditor();
      }),
      listen("open_model_picker", () => {
        window.dispatchEvent(new Event("open_model_picker"));
      }),
      // Every window hears the click; only the one holding the session acts.
      listen<string>(NOTIFICATION_CLICK_EVENT, ({ payload: sessionId }) => {
        if (!sessionsRef.current.some((s) => s.id === sessionId)) return;
        const win = getCurrentWindow();
        // Windows leaves a minimized window minimized when it is only focused.
        void win
          .unminimize()
          .then(() => win.setFocus())
          .catch(() => {});
        actions.current.onOpenApprovalSession(sessionId);
      }),
      listen("zoom_in", () => {
        const next = zoomInUiScale(loadUiScale());
        saveUiScale(next);
        void applyUiScale(next);
      }),
      listen("zoom_out", () => {
        const next = zoomOutUiScale(loadUiScale());
        saveUiScale(next);
        void applyUiScale(next);
      }),
      listen("zoom_reset", () => {
        saveUiScale(UI_SCALE_DEFAULT);
        void applyUiScale(UI_SCALE_DEFAULT);
      }),
    ];
    return () => {
      void Promise.all(unlisten).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [run]);

  const dockGridRef = useRef<HTMLDivElement>(null);
  const dockDragSize = useRef<number | null>(null);
  const paintDockSize = useCallback((size: number) => {
    const dock = findProjectTerminal(
      projectTerminalsRef.current,
      projectCwdRef.current,
    );
    const el = dockGridRef.current;
    if (!dock || !el || monoViewIdRef.current) return;
    dockDragSize.current = size;
    applyDockGridStyle(el, dock.side, size);
  }, []);
  const commitDockSize = useCallback(
    (size: number) => {
      dockDragSize.current = null;
      onProjectTerminalSize(size);
    },
    [onProjectTerminalSize],
  );
  const dockWasOpen = useRef<{ path: string; open: boolean } | null>(null);
  const dockAnimation = useRef<{ key: string; stop: () => void } | null>(
    null,
  );
  // The project whose dock stays rendered while it slides shut.
  const [dockClosing, setDockClosing] = useState<string | null>(null);
  const dockClosingShown =
    dockClosing != null &&
    !monoCovers &&
    !!currentProjectDock &&
    !currentProjectDock.open &&
    sameProjectPath(dockClosing, projectCwd);
  useLayoutEffect(() => {
    if (monoCovers) dockDragSize.current = null;
    if (dockDragSize.current != null) return;
    const el = dockGridRef.current;
    if (!el) return;
    const dock = currentProjectDock;
    const open = dockVisible && !monoCovers && !!dock;
    const side = dock && (open || dockClosingShown) ? dock.side : null;
    const size = dock?.size ?? 0;
    // Only a dock opening or closing in place slides; a project switch or a
    // mono covering the workspace shows or hides it at once.
    const previous = dockWasOpen.current;
    const inPlace = !!previous && sameProjectPath(previous.path, projectCwd);
    dockWasOpen.current = { path: projectCwd, open };
    const key = side ? `${open ? "open" : "close"}:${side}:${size}` : "";
    // Unrelated dock updates, like a terminal retitling itself, leave a
    // running slide alone.
    if (inPlace && dockAnimation.current?.key === key) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const animates =
      insetLayout && !reduceMotion && typeof el.animate === "function";
    // Render the dock once more so it can slide out; the grid keeps its
    // track until then.
    if (
      animates &&
      inPlace &&
      previous.open &&
      !open &&
      dock &&
      !monoCovers
    ) {
      setDockClosing(projectCwd);
      return;
    }
    const host = el.querySelector<HTMLElement>(":scope > [data-dock-shown]");
    const vertical = side ? isVerticalDock(side) : true;
    // A reversal mid-slide starts from wherever the track currently is.
    const current = host
      ? vertical
        ? host.getBoundingClientRect().height
        : host.getBoundingClientRect().width
      : 0;
    const reversing = !!dockAnimation.current;
    dockAnimation.current?.stop();
    dockAnimation.current = null;
    applyDockGridStyle(el, side, size);
    const opening = open && inPlace && (!previous.open || reversing);
    const closing = !open && !!side;
    if (!side || !animates || !(opening || closing)) return;
    const section = host?.firstElementChild;
    if (!host || !(section instanceof HTMLElement)) return;
    // The terminal keeps its full size and rides the moving edge, so it fits
    // once instead of on every frame.
    const property = vertical ? "gridTemplateRows" : "gridTemplateColumns";
    const leading = side === "top" || side === "left";
    host.style.display = "flex";
    host.style.flexDirection = vertical ? "column" : "row";
    host.style.justifyContent = leading ? "flex-end" : "flex-start";
    section.style.flexShrink = "0";
    if (vertical) section.style.height = `${size}px`;
    else section.style.width = `${size}px`;
    const track = (px: number) =>
      leading ? `${px}px minmax(0, 1fr)` : `minmax(0, 1fr) ${px}px`;
    const from = reversing ? current : opening ? 0 : size;
    const endTransition = beginLayoutTransition();
    const animation = el.animate(
      [{ [property]: track(from) }, { [property]: track(opening ? size : 0) }],
      {
        duration: opening ? 240 : 200,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
        fill: "forwards",
      },
    );
    // Mounting the terminal can hold up the next frame; the slide starts
    // once that frame is out, not partway through.
    animation.pause();
    const start = requestAnimationFrame(() => animation.play());
    const stop = () => {
      cancelAnimationFrame(start);
      animation.onfinish = null;
      animation.cancel();
      host.style.display = "";
      host.style.flexDirection = "";
      host.style.justifyContent = "";
      section.style.flexShrink = "";
      section.style.height = "";
      section.style.width = "";
      endTransition();
      if (dockAnimation.current?.stop === stop) dockAnimation.current = null;
      if (closing) setDockClosing(null);
    };
    // A closed dock holds its last frame until it is no longer rendered.
    animation.onfinish = opening ? stop : () => setDockClosing(null);
    dockAnimation.current = { key, stop };
  }, [
    currentProjectDock,
    dockVisible,
    dockClosingShown,
    monoCovers,
    insetLayout,
    projectCwd,
  ]);
  useEffect(() => () => dockAnimation.current?.stop(), []);

  const lastRemoteSnapshot = useRef(new Map<string, HostSession>());
  const onRemoteSnapshot = useCallback(
    (shellId: string, snapshot?: HostSession) => {
      if (!snapshot) {
        lastRemoteSnapshot.current.delete(shellId);
        setSessions((current) =>
          current.map((entry) =>
            entry.id === shellId
              ? {
                  ...entry,
                  title: "New remote session",
                  blocks: [],
                  busy: false,
                }
              : entry,
          ),
        );
        return;
      }
      if (lastRemoteSnapshot.current.get(shellId) === snapshot) return;
      lastRemoteSnapshot.current.set(shellId, snapshot);
      setSessions((current) => {
        const shell = current.find((entry) => entry.id === shellId);
        if (!shell) return current;
        const project = remoteProjectFor(shell.cwd);
        if (!project) return current;
        return current.map((entry) =>
          entry.id === shellId
            ? remoteSessionState(entry, snapshot, project)
            : entry,
        );
      });
    },
    [],
  );

  const onManageWorktrees = useCallback(
    () => openSettings("worktrees"),
    [openSettings],
  );

  useFloatingMono(sessions, monosSnap, monosEnabled, {
    open: (monoId) =>
      ensureMonoSession(monoId, {
        home: homeDir,
        load: ensureOpenSession,
        create: newDefaultSession,
        add: (created) => {
          sessionsRef.current = [...sessionsRef.current, created];
          setSessions(sessionsRef.current);
        },
      }),
    submit: onComposerSubmit,
    stop: onStopFromUser,
    approval: onApproval,
    question: onQuestionReply,
    questionInteraction: onQuestionInteraction,
    reveal: onOpenMono,
    openArtifact: async (monoId, id) => {
      await onOpenMono(monoId);
      const sessionId = findMono(monoId)?.sessionId;
      if (sessionId) onOpenMonoArtifact(sessionId, id);
    },
    openFile: onOpenFile,
    resume: onUsageLimitResume,
    create: () => createMono().id,
  });

  // WP-135: a discarded loser is stopped first, the same as pressing Stop in that chat.
  const stopFanOutChild = useCallback(
    async (childId: string) => {
      const child = sessionsRef.current.find((session) => session.id === childId);
      if (!child?.busy) return;
      await onStop(childId);
    },
    [onStop],
  );

  // WP-135: the composer confirms the cap and the paid turns, then this starts one chat per model, each in its own
  // worktree. A model that could not get a worktree does not start, and a compare that cannot start two, or cannot be
  // saved, says why and gives back the worktrees it made.
  const fanOutBusy = useRef(new Set<string>());
  const onCompareModels = useCallback(
    async (
      sessionId: string,
      prompt: string,
      targets: readonly { provider: HarnessId; model: string }[],
    ) => {
      if (fanOutBusy.current.has(sessionId)) return false;
      const source = sessionsRef.current.find((session) => session.id === sessionId);
      if (!source || source.worktreeRemoved) return false;
      fanOutBusy.current.add(sessionId);
      try {
        const takeBack = fanOutJanitorPort(source.cwd, onRemoveWorktree, stopFanOutChild);
        const result = await startFanOut(
          {
            prompt,
            targets,
            cwd: source.cwd,
            runtimeMode: source.runtimeMode,
            sourceId: sessionId,
            now: Date.now(),
          },
          {
            git: gitRepositoryOnThisComputer,
            branchName: temporaryWorktreeBranchName,
            // The project's setup waits until two worktrees exist and the compare is saved: a setup that had already
            // started would leave a worktree that could not be given back.
            createWorktree: async (cwd, branch) => {
              const tree = await createWorktree(cwd, branch, source.worktreeBase || "HEAD", false, {
                runSetup: false,
              });
              return { path: tree.path, branch: tree.branch ?? branch, head: tree.head };
            },
            allowedRoots: defaultWorktreeRoots,
            release: (worktrees) => releaseFanOutWorktrees(worktrees, takeBack),
            save: putCompare,
          },
        );
        if (!result.ok) return result.message;
        const known = new Set(sessionsRef.current.map((session) => session.id));
        const added = result.sessions.filter((session) => !known.has(session.id));
        if (added.length === 0) return false;
        sessionsRef.current = [...sessionsRef.current, ...added];
        setSessions(sessionsRef.current);
        // The project's setup starts now that the compare is saved; the chats start with the whole prompt, while the
        // saved record keeps a capped copy.
        for (const child of result.record.children) {
          if (child.worktree.kind === "assigned") void startFanOutSetup(source.cwd, child.worktree.path);
        }
        for (const session of added) onSubmit(session.id, prompt);
        return true;
      } finally {
        fanOutBusy.current.delete(sessionId);
      }
    },
    [onSubmit, onRemoveWorktree, stopFanOutChild],
  );

  // WP-135: the compare sits on the chat it was started from. Picking leaves the winner's worktree.
  const fanOutCompares = useSyncExternalStore(subscribeCompares, listCompares, listCompares);
  const fanOutForSession = (sessionId: string) => {
    const record = [...fanOutCompares].reverse().find((item) => item.sourceId === sessionId);
    if (!record) return null;
    return {
      rows: fanOutCompareRows(record, sessionsRef.current),
      notStarted: fanOutNotStartedLines(record),
      onPick: (childId: string) => pickFanOutInStore(record.id, childId),
      onDiscard: (childId: string) => {
        const source = sessionsRef.current.find((item) => item.id === sessionId);
        if (!source) return;
        return discardFanOutLoser(
          record.id,
          childId,
          fanOutJanitorPort(source.cwd, onRemoveWorktree, stopFanOutChild),
        );
      },
    };
  };

  const sessionPaneProps = {
    workspaceSwitchingSessionId: workspaceNavigation.pending
      ? active?.id
      : undefined,
    recents,
    hideProjectPicker: true,
    onFocus: onFocusPane,
    onClose: onClosePane,
    onCwdChange,
    onBranchChange,
    onWorktreeChange: onComposerWorktreeChange,
    onRemoteSnapshot,
    onWorkspaceModeChange,
    onWorktreeBaseChange,
    onManageWorktrees,
    onModelChange,
    onModelSettingsChange,
    onRuntimeModeChange,
    onSaveDraft,
    onRemoveDraft,
    onSubmit: onComposerSubmit,
    onCompareModels,
    fanOutForSession,
    onStop: onStopFromUser,
    // A Mono's own Stop: its turn only (UniiChat stops "Unii's turn", not the agents at work).
    onStopTurn: (sessionId: string) => onStop(sessionId),
    onCompactContext,
    onPlaceSessionInFolder,
    onDeleteQueuedMessage,
    onEditQueuedMessage,
    onQueuedMessageEditingChange,
    onSteerQueuedMessage,
    onResumeQueue,
    onUsageLimitResume,
    onUsageLimitResumeAtReset,
    onUsageLimitDismiss,
    onUsageLimitAccountChange,
    onInboxCardDismiss,
    onLinkedWorkItemUpdateCardDismiss,
    onNoteCardDismiss,
    onHandoffCardDismiss,
    onOpenLinkedWorkItem,
    onArchiveSession: onArchiveHistorySession,
    onDeleteSession: onDeleteHistorySession,
    onApproval,
    onQuestionReply,
    onQuestionInteraction,
    onOpenFile,
    onOpenDiff,
    onOpenPlan,
    onBuildPlan,
    onSecondOpinion,
    onHandoff,
    onBtwSubmit,
    onBtwRetry,
    onBtwDelete,
    onBtwStop,
    onBtwModelChange,
    onNewTerminal: onNewTerminalInSession,
  };

  // Renames, mascot picks and new projects show up on the rail.
  const monoViewMono = monoViewId ? monoForSession(monoViewId) : undefined;
  const selectedMonoActivity = resolveMonoActivity(
    monoActivity,
    monoViewSession,
  );
  // The chat marks the turn whose activity the overview is showing.
  const monoActivityShownTurnId =
    monoOverviewOpen && monoOverviewTab === "activity"
      ? selectedMonoActivity?.turnId
      : undefined;
  const monoViewBlocks = monoViewSession?.blocks;
  const monoViewBusy = !!monoViewSession?.busy;
  const monoViewCwd = monoViewSession ? sessionWorkCwd(monoViewSession) : "";
  const monoEditedPaths = useMemo(
    () =>
      monoViewBlocks && !monoViewBusy
        ? sessionEditPaths(monoViewBlocks)
        : undefined,
    [monoViewBlocks, monoViewBusy],
  );
  // The session's changes, on the overview's tab instead of under a message.
  const monoChangeTotals = useSessionChangeTotals(
    monoViewSession?.id ?? "",
    monoViewCwd,
    {
      enabled: !monoViewSession?.worktreeRemoved,
      busy: monoViewBusy,
      editedPaths: monoEditedPaths,
    },
  );
  const monoLaunches = useMemo(
    () => (monoViewBlocks ? monoSpawnedSessions(monoViewBlocks) : []),
    [monoViewBlocks],
  );
  const monoDocuments = useMemo(
    () => (monoViewBlocks ? artifactCards(monoViewBlocks) : []),
    [monoViewBlocks],
  );
  const monoActivityView =
    monoViewSession && selectedMonoActivity ? (
      <MonoActivityView
        key={selectedMonoActivity.turnId}
        blocks={selectedMonoActivity.blocks}
        live={selectedMonoActivity.live}
        cwd={sessionWorkCwd(monoViewSession)}
        onApproval={
          monoViewSession.worktreeRemoved
            ? undefined
            : (requestId, decision) =>
                onApproval(monoViewSession.id, requestId, decision)
        }
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff}
      />
    ) : null;
  // Status for the cards of the sessions the open Mono launched, rebuilt only
  // when one changes state or title rather than on every streamed token. One
  // that is no longer open cannot be running, so it reads as done.
  // A card names its session as the sidebar does. One that is not open has
  // its saved title fetched, rather than the prompt it was launched with, so
  // opening it does not rename the card.
  const [storedLaunchTitles, setStoredLaunchTitles] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  const unopenedLaunchesKey = JSON.stringify(
    monoLaunches.flatMap((launch) =>
      storedLaunchTitles.has(launch.sessionId) ||
      sessions.some((entry) => entry.id === launch.sessionId)
        ? []
        : [launch.sessionId],
    ),
  );
  useEffect(() => {
    const ids: string[] = JSON.parse(unopenedLaunchesKey);
    if (ids.length === 0) return;
    let current = true;
    void Promise.all(ids.map((id) => getSession(id).catch(() => null))).then(
      (stored) => {
        if (!current) return;
        setStoredLaunchTitles((previous) => {
          const next = new Map(previous);
          stored.forEach((session, index) =>
            next.set(ids[index], session?.title ?? ""),
          );
          return next;
        });
      },
    );
    return () => {
      current = false;
    };
  }, [unopenedLaunchesKey]);
  const monoLaunchesKey = JSON.stringify(
    monoLaunches.map((launch) => {
      const live = sessions.find((entry) => entry.id === launch.sessionId);
      // Out of usage and held (H8): when it tries again by itself.
      const retryAt =
        live?.usageLimit?.resumeAtReset && !live.busy ? usageLimitResumeAt(live.usageLimit) : undefined;
      return live
        ? [
            launch.sessionId,
            launchedSessionState(live),
            live.title,
            ...(retryAt ? [retryAt, providerName(live.harness)] : []),
          ]
        : [
            launch.sessionId,
            "done",
            storedLaunchTitles.get(launch.sessionId) || launch.title,
          ];
    }),
  );
  const monoLaunchedSessions = useMemo(
    () =>
      new Map<string, LaunchedSessionView>(
        (
          JSON.parse(monoLaunchesKey) as [
            string,
            LaunchedSessionState,
            string,
            number?,
            string?,
          ][]
        ).map(([id, state, title, retryAt, provider]) => [
          id,
          { state, title, ...(retryAt ? { retryAt, provider } : {}) },
        ]),
      ),
    [monoLaunchesKey],
  );
  const monoShownSessionPane = shownMonoSessionId
    ? sessions.find((session) => session.id === shownMonoSessionId)
    : undefined;
  const monoShownSessionActive =
    !!monoShownSessionPane && monoShownSessionFocused;
  const monoShownSessionView = monoShownSessionPane
    ? {
        sessionId: monoShownSessionPane.id,
        title: sessionDisplayTitle(
          monoShownSessionPane.title,
          monoShownSessionPane.harness,
        ),
        pane: (
          <SessionPane
            {...sessionPaneProps}
            session={monoShownSessionPane}
            // The Mono view covers the workspace, so a review opens
            // beside the chat rather than in a hidden tab.
            onOpenDiff={onOpenMonoDiff}
            // The Mono runs this session; handing it off or asking for a
            // second opinion belongs in its own tab.
            onSecondOpinion={undefined}
            onHandoff={undefined}
            visible={monoCovers}
            focused={monoShownSessionActive && !projectTerminalFocused}
            inSplit={false}
            addToChatTarget={false}
            composerFocused={
              monoShownSessionActive &&
              composerFocused &&
              !projectTerminalFocused
            }
            composerFocusToken={composerFocusToken}
          />
        ),
      }
    : undefined;
  const monoOverviewPanel =
    monoViewMono && monoViewSession ? (
      <MonoOverview
        key={monoViewMono.id}
        open={monoOverviewOpen}
        monoId={monoViewMono.id}
        cwd={monoViewSession.cwd}
        agent={monoLook(monoViewMono)}
        state={monoState(monoViewSession)}
        launches={monoLaunches}
        sessions={sessions}
        history={history}
        documents={monoDocuments}
        activity={monoActivityView}
        changes={{
          sessionId: monoViewSession.id,
          cwd: monoViewCwd,
          totals: monoChangeTotals,
          request: monoChangesRequest,
          textHarness: monoViewSession.harness,
          projects: monoViewMono.projects,
        }}
        tab={monoOverviewTab}
        onTabChange={setMonoOverviewTab}
        onOpenSession={(sessionId) =>
          showMonoLaunchedSession(monoViewSession.id, sessionId)
        }
        shownSession={monoShownSessionView}
        // Back lands on every session it started.
        onBackFromSession={() => {
          setMonoShownSession(null);
          setMonoShownSessionFocused(false);
        }}
        onOpenSessionInWorkspace={onOpenMonoLaunchedSession}
        onOpenDocument={(id) => {
          setMonoShownSession(null);
          setMonoOverviewDocument(id);
        }}
        shownDocumentId={monoOverviewDocument ?? undefined}
        onBackFromDocument={() => setMonoOverviewDocument(null)}
        onOpenFile={onOpenFile}
        onClose={() => setMonoOverviewOpen(false)}
        windowControls={monoCovers && !IS_MAC ? <WindowControls /> : undefined}
      />
    ) : null;
  const monoSettingsDialog =
    monoCovers &&
    monoViewMono &&
    monoViewSession &&
    monoSettingsFor === monoViewMono.id ? (
      <MonoSettingsDialog
        key={monoViewMono.id}
        monoId={monoViewMono.id}
        agent={monoLook(monoViewMono)}
        status={monoState(monoViewSession).status}
        cwd={monoViewSession.cwd}
        harness={monoViewSession.harness}
        model={monoViewSession.model}
        modelSettings={monoViewSession.modelSettings}
        runtimeMode={monoViewSession.runtimeMode}
        busy={!!monoViewSession.busy}
        onModelChange={(harness, model) =>
          onModelChange(monoViewSession.id, harness, model)
        }
        onModelSettingsChange={(settings) =>
          onModelSettingsChange(monoViewSession.id, settings)
        }
        onRuntimeModeChange={(mode) =>
          onRuntimeModeChange(monoViewSession.id, mode)
        }
        onReset={() => onResetMono(monoViewSession.id)}
        onClose={() => setMonoSettingsFor(null)}
      />
    ) : null;
  const monoRailState = useMemo(() => {
    const states = new Map<string, MonoState>();
    const unseen = new Map<string, number>();
    for (const mono of listMonos()) {
      const session = mono.sessionId
        ? sessions.find((entry) => entry.id === mono.sessionId)
        : undefined;
      if (session) {
        // An idle Mono that is waiting on a pull request says so instead of nothing.
        const state = overlayLiveWorking(
          monoState(session),
          liveBusySessionIds.has(session.id),
        );
        const waiting =
          state.status === "idle"
            ? waitingActivity(prWatches.watchingFor(session.id))
            : undefined;
        states.set(mono.id, waiting ? { ...state, activity: waiting } : state);
      } else if (
        mono.sessionId &&
        liveBusySessionIds.has(mono.sessionId)
      ) {
        states.set(mono.id, overlayLiveWorking({ status: "idle" }, true));
      }
      const count = mono.sessionId
        ? monoReplies.counts.get(mono.sessionId)
        : undefined;
      if (count) unseen.set(mono.id, count);
    }
    return { states, unseen };
    // The roster is read through its snapshot.
  }, [
    monosSnap,
    sessions,
    liveBusySessionIds,
    monoReplies.counts,
    prWatches,
    prWatchVersion,
  ]);
  const monoRail = useStableValue(monoRailState);
  const busyProjectPaths = useStableValue(
    promptableSessions.flatMap((session) =>
      session.busy && session.cwd ? [session.cwd] : [],
    ),
  );
  const onOpenRailMono = useCallback(
    (monoId: string) => void onOpenMono(monoId),
    [onOpenMono],
  );
  const onDeleteRailMono = useCallback(
    (monoId: string) => void onDeleteMono(monoId),
    [onDeleteMono],
  );
  const onDeleteRailMonoChat = useCallback(
    (monoId: string) => void onDeleteMonoChat(monoId),
    [onDeleteMonoChat],
  );
  // The memoized sidebar only skips a streamed batch if this keeps identity.
  const sidebarMonos = useMemo(
    () =>
      monosEnabled
        ? {
            activeId: monoViewMono?.id,
            states: monoRail.states,
            unseenCounts: monoRail.unseen,
            onOpen: onOpenRailMono,
            onCreate: onCreateMono,
            onDelete: onDeleteRailMono,
            onDeleteChat: onDeleteRailMonoChat,
          }
        : undefined,
    [
      monosEnabled,
      monoViewMono?.id,
      monoRail,
      onOpenRailMono,
      onCreateMono,
      onDeleteRailMono,
      onDeleteRailMonoChat,
    ],
  );
  const onDismissUpdate = useCallback(() => setUpdateNotice(null), []);

  // r30h: which chats run a turn now, so a worker that declared it cannot go on goes to Ash once its Lead's turn ended.
  useBusyChatsFeed(sessions, liveBusySessionIds);
  useFirstMateCheckoutGuard(sessions);
  // Hub shell: the project strip, the project's items, and hub views.
  const hubSel = useHubSelection();
  useHubDataVersion();
  useMonoTeamsVersion();
  const hubProject = hubData()
    .listProjects()
    .find((project) => project.id === hubSel.project);
  const closeChromeViews = () => {
    // Dropwave (Ash, 11 Nov): picking anything in the sidebar or the project strip leaves Settings too; no Back first.
    setSettingsOpen(false);
    setSearchViewOpen(false);
    setInboxViewOpen(false);
    setNotesViewOpen(false);
    setAutomationsViewOpen(false);
    // WP-06: a room or project pick is a leave. closeMonoView moves the request, so a Lead open still in flight
    // cannot come back over it (leadOpenMayShow). The latest coding-team open bumps the request again and wins.
    closeMonoView();
  };
  // WP-73: one look when the app opens, and a line on Home opens the screen it names.
  const homeOpenRef = useRef({ onOpenNotes, onSelectHistorySession, openCodingTeam, closeChromeViews });
  homeOpenRef.current = { onOpenNotes, onSelectHistorySession, openCodingTeam, closeChromeViews };
  useHomeOnOpen();
  useHomeOpener({
    closeChrome: () => homeOpenRef.current.closeChromeViews(),
    openInbox: () => setInboxViewOpen(true),
    openNotes: () => homeOpenRef.current.onOpenNotes(),
    openSession: (id) => { void homeOpenRef.current.onSelectHistorySession(id); },
    openTeam: (projectId) => homeOpenRef.current.openCodingTeam(projectId),
    // WP-161: a Needs you line about the machine (new builders waiting on disk) opens Settings where it says so.
    openSettings: (section, anchor) => openSettings(section, anchor),
    projects: () => hubData().listProjects(),
  });
  // WP-125: a local chat or prompt link opens in this window. A missing chat is a message, not a new window.
  // openChat is false when no pane was shown, so the opener can say the chat is not on this computer.
  useThreadLinkOpener({
    hasChat: (id) =>
      sessionsRef.current.some((session) => session.id === id) ||
      getSession(id).then((session) => session != null),
    hasProject: (id) => hubData().listProjects().some((project) => project.id === id),
    openChat: (id) => onSelectHistorySession(id),
    openPrompt: (projectId, text, ticket) => {
      placePrompt(
        projectId,
        text,
        ticket,
        {
          projects: () => hubData().listProjects(),
          sessions: () => sessionsRef.current,
        },
        {
          openProject: (id) => {
            openCodingTeam(id, { lead: false });
            noteCodingTeamView(id, "chat");
          },
          addSession: (session) => {
            const next = rememberPromptSession(sessionsRef.current, session);
            if (!next) return;
            sessionsRef.current = next;
            setSessions(next);
            const tab = newTab(session.id);
            appendTab(tab, session.cwd);
            setActiveTabId(tab.id);
            setComposerFocused(true);
            // A new chat from a prompt link follows the same worktree setting as New session.
            attachNewChatWorktree(session.id, session.cwd, setSessions);
          },
          focusSession: (id) => {
            void onSelectHistorySession(id);
          },
        },
      );
    },
  });
  // r63 (PM, 0.16.3): Pages (an automations-view mode) and Coding team were highlighted at once. Any view that covers
  // the main area (a Mono's 1:1, Search, Settings, Inbox, Notes, Automations or Pages) takes the highlight from the
  // project's items, so one nav row is ever active.
  const hubItemsCovered =
    searchViewOpen ||
    settingsOpen ||
    inboxViewOpen ||
    notesViewOpen ||
    automationsViewOpen ||
    monoCovers;
  const hubShown = hubSurfaceOpen(hubSel) && !hubItemsCovered;
  // WP-06: a stored Today, Being built, Decisions or Builds item opens the project's coding team. A stored
  // coding-team item on a project with no folder is the no-code page, not the previous workspace. The folder
  // string is the dependency: the project object is a new one whenever the list is read.
  const hubFolder = hubProject ? (hubProject.folder ?? null) : undefined;
  useEffect(() => {
    if (!hubDefaultsOn()) return;
    if (hubSel.project === NO_PROJECT) return;
    if (retiredHubItem(hubSel.item)) {
      openCodingTeam(hubSel.project);
      return;
    }
    if (hubSel.item === "coding-team" && hubFolder !== undefined && !projectHasCodeFolder(hubFolder)) {
      setHubSelection(projectHomeSelection({ id: hubSel.project, folder: hubFolder }));
    }
  }, [hubSel.project, hubSel.item, hubFolder, openCodingTeam]);
  // Dropwave (Ash, 11 Nov): on Home there is only the Chief of Staff, so its sidebar lists no first mates.
  const hubOnHome = hubSel.item === "home" || homeMonoInView(hubSel);
  const hubMonos = sidebarMonos && !hubOnHome
    ? { ...sidebarMonos, rank: hubMonoRank, projectFilter: hubSel.item === "home" || homeMonoInView(hubSel) ? HOME_MONOS : hubSel.project === NO_PROJECT ? undefined : (hubProject?.folder ?? `hub-project:${hubSel.project}`) }
    : undefined;

  const chromeSurfaceOpen =
    searchViewOpen ||
    settingsOpen ||
    inboxViewOpen ||
    notesViewOpen ||
    automationsViewOpen;
  const compactProjectRail = collapsedProjectRailMode === "compact";
  const compactRailActive = compactProjectRail && !projectRailOpen;
  const compactTitleNavigation =
    IS_MAC && compactRailActive && !chromeSurfaceOpen;
  const compactTitleBar = compactTitleNavigation && !monoCovers;
  // The inset layout keeps its tabs across the top of the window at all
  // times, with the rail and the card below them.
  const titleBarSpansWindow = insetLayout || compactTitleBar;
  const titleBarInBody = !insetLayout && !compactTitleBar;
  // Matches when the sidebar portals Explorer or Changes into the panel.
  const insetRightPanelShown =
    insetLayout &&
    (rightPanelOpen || rightPanelClosing) &&
    !settingsOpen &&
    !monoCovers &&
    !activeAppView &&
    looksLikeProject(sidebarCwd);
  // The right panel grows from the card's edge and pushes the workspace. Its
  // own contents keep their full width and ride its edge.
  // A reversal mid-slide starts from wherever the width currently is.
  useLayoutEffect(() => {
    const toggled = rightPanelWasOpen.current !== rightPanelOpen;
    rightPanelWasOpen.current = rightPanelOpen;
    const pane = rightPanelRef.current;
    const content = pane?.firstElementChild;
    if (!toggled || !pane || !(content instanceof HTMLElement)) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const animate =
      insetRightPanelShown && typeof pane.animate === "function" && !reduceMotion;
    const current = pane.getBoundingClientRect().width;
    const from = rightPanelAnimation.current || !rightPanelOpen ? current : 0;
    rightPanelAnimation.current?.cancel();
    rightPanelAnimation.current = null;
    endRightPanelTransition.current?.();
    endRightPanelTransition.current = null;
    if (!animate) {
      content.style.width = "";
      if (!rightPanelOpen) setRightPanelClosing(false);
      return;
    }
    // The committed width; a running slide only overrides it. Only the
    // width is pinned: the column still stretches the contents to full
    // height, so the panel's scrolling content stays put while it slides.
    const full = parseFloat(pane.style.width) || pane.offsetWidth;
    content.style.width = `${full}px`;
    endRightPanelTransition.current = beginLayoutTransition();
    const animation = pane.animate(
      [{ width: `${from}px` }, { width: `${rightPanelOpen ? full : 0}px` }],
      {
        duration: rightPanelOpen ? 240 : 200,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
        fill: "forwards",
      },
    );
    rightPanelAnimation.current = animation;
    animation.onfinish = () => {
      if (rightPanelAnimation.current !== animation) return;
      if (rightPanelOpen) {
        animation.cancel();
        rightPanelAnimation.current = null;
        endRightPanelTransition.current?.();
        endRightPanelTransition.current = null;
        content.style.width = "";
      } else {
        setRightPanelClosing(false);
      }
    };
  }, [rightPanelOpen]);
  // A slid-out panel holds its last frame until it is hidden, in the same
  // commit, so it never flashes back in place.
  useLayoutEffect(() => {
    if (rightPanelClosing || rightPanelOpen) return;
    rightPanelAnimation.current?.cancel();
    rightPanelAnimation.current = null;
    endRightPanelTransition.current?.();
    endRightPanelTransition.current = null;
    const content = rightPanelRef.current?.firstElementChild;
    if (content instanceof HTMLElement) {
      content.style.width = "";
    }
  }, [rightPanelClosing, rightPanelOpen]);
  // The same shared stats the sidebar's Changes tab reads, so the toggle
  // that opens it can carry its dot.
  const showRightPanelToggle =
    insetLayout && !settingsOpen && looksLikeProject(sidebarCwd);
  rightPanelToggleRef.current =
    showRightPanelToggle && !(monoCovers && monoViewMono) && !activeAppView
      ? onToggleRightPanel
      : null;
  const rightPanelChanges = useProjectDiffStats(
    gitCwd || sidebarCwd,
    showRightPanelToggle && isLocalProject(sidebarCwd),
  );
  const onToggleMonoOverview = () => setMonoOverviewOpen(!monoOverviewOpen);
  const onOpenMonoViewSettings = monoViewMono
    ? () => setMonoSettingsFor(monoViewMono.id)
    : undefined;
  // A Mono with a team of its own has "Team" beside Overview (monoTeams.ts): pressed while its chat shows inside its
  // team's Sessions list. A Lead needs none: it always opens in its coding team.
  const monoViewTeam =
    monoViewMono && codingTeamsOn()
      ? teamFor({ id: monoViewMono.id, name: monoLook(monoViewMono).name }, hubData().listProjects())
      : undefined;
  const monoViewTeamOpen =
    !!monoViewMono &&
    monoTeamInView(hubSel) === monoViewMono.id &&
    sameProjectPath(sidebarCwd, monoTeam(monoViewMono.id)?.folder ?? "");
  const monoViewTeamAction =
    // Dropwave (Ash, 11 Nov): every first mate's chat opens in its own chat list, so the button only shows for a chat
    // that is somehow on its own; inside its list there is nothing to toggle and every chat's top bar reads the same.
    monoViewMono && monoViewTeam?.kind === "mono" && !monoViewTeamOpen
      ? {
          name: monoViewTeam.name,
          open: monoViewTeamOpen,
          onToggle: () => {
            if (monoViewTeamOpen) showProjectToday();
            else openMonoTeamView(monoViewMono.id, { owner: true });
          },
        }
      : undefined;
  // A new session takes over from a Mono in view.
  const onNewFromTitleBar = () => {
    if (monoViewIdRef.current) closeMonoView();
    onNew();
  };
  const workspaceTitleBar = (
    <TitleBar
      // A Mono in full view stands apart from the project's tabs, except
      // in the inset layout, where it is one of them.
      tabs={monoCovers && !insetLayout ? NO_TITLE_TABS : titleTabs}
      content={
        insetLayout && settingsOpen ? (
          <div
            ref={setSettingsHeaderHost}
            data-settings-title
            className="flex h-full min-w-0 flex-1"
          />
        ) : undefined
      }
      mono={
        monoCovers && monoViewMono && monoViewSession
          ? { look: monoLook(monoViewMono), state: monoState(monoViewSession) }
          : undefined
      }
      // The inset layout keeps these in the Mono's pane, under its tab.
      onToggleMonoOverview={
        monoCovers && !insetLayout ? onToggleMonoOverview : undefined
      }
      monoOverviewOpen={monoOverviewOpen}
      onOpenMonoSettings={
        monoCovers && !insetLayout ? onOpenMonoViewSettings : undefined
      }
      monoTeam={monoCovers && !insetLayout ? monoViewTeamAction : undefined}
      hideWindowControls={monoCovers && monoOverviewOpen && !!monoOverviewPanel}
      activeId={
        monoViewSession
          ? insetLayout
            ? (monoViewTabId ?? "")
            : ""
          : insetLayout && activeAppView
            ? appViewTabId(activeAppView)
            : activeTabId
      }
      cwd={sidebarCwd}
      viewTitle={hubShown && hubSel.item === "new-project" ? "New project" : undefined}
      projectRailOpen={projectRailOpen}
      sessionSidebarOpen={sessionSidebarOpen}
      compactRail={!insetLayout && compactTitleNavigation}
      inset={insetLayout}
      rightPanelOpen={rightPanelOpen}
      onToggleRightPanel={
        showRightPanelToggle ? onToggleRightPanel : undefined
      }
      rightPanelDot={(rightPanelChanges?.files ?? 0) > 0}
      rightPanelUnavailable={!!activeAppView}
      canGoBack={!!monoViewId || tabVisitNav.canBack}
      canGoForward={tabVisitNav.canForward}
      onGoBack={onRailBack}
      onGoForward={onRailForward}
      onToggleSidebar={onToggleSidebar}
      onToggleSessionSidebar={onToggleSessionSidebar}
      onSelect={onSelectTitleTab}
      onNewTerminal={onNewTerminal}
      onNewSession={
        insetLayout && !settingsOpen && looksLikeProject(sidebarCwd)
          ? onNewFromTitleBar
          : undefined
      }
      onOpenSettings={onOpenSettings}
      onOpenInbox={onOpenInbox}
      onOpenNotes={notesEnabled ? onOpenNotes : undefined}
      onClose={onCloseDisplayedTab}
      onCloseMany={onCloseDisplayedTabs}
      onCloseAll={onCloseAllDisplayedTabs}
      onArchiveTab={onArchiveTitleTab}
      onDeleteTab={onDeleteTitleTab}
      onReorder={onReorderDisplayedTabs}
      onPlaceOnPane={onPlaceTabOnPane}
      onPinFile={onPinFile}
      recents={recents}
      onSelectProject={onSelectProject}
    />
  );

  // The coding team (hub/model/codingTeam.ts): the selected project's folder in the workspace. Its Sessions list pins
  // the project's Lead at the top and nests every chat a chat started under the chat Ash talks to.
  const teamProject =
    codingTeamsOn() &&
    hubSel.item === "coding-team" &&
    hubProject?.folder &&
    sameProjectPath(sidebarCwd, hubProject.folder)
      ? hubProject
      : undefined;
  // A Mono's own team (monoTeams.ts) is the same list on its folder: the Mono's chat pinned on top, its workers under it.
  const teamOwnerMonoId = codingTeamsOn() && !teamProject ? monoTeamInView(hubSel) : undefined;
  const ownTeam = teamOwnerMonoId ? monoTeam(teamOwnerMonoId) : undefined;
  const ownTeamShown = !!ownTeam && sameProjectPath(sidebarCwd, ownTeam.folder);
  const teamFolder = teamProject?.folder ?? (ownTeamShown ? ownTeam.folder : undefined);
  // Dropwave: the Chief of Staff's own chat for the project is the one pinned on top, unless Ash opened the project's
  // Lead there last (projectFront.ts).
  const projectFrontVersion = useProjectFrontVersion();
  const teamCaptain =
    teamProject && projectFront(teamProject.id) === "captain" ? pickCaptain(listMonos()) : undefined;
  const teamLeadMono = teamProject
    ? (teamCaptain ?? leadMono(leadSpecFor(teamProject)))
    : ownTeamShown
      ? findMono(teamOwnerMonoId!)
      : undefined;
  const teamLeadSessionId =
    teamCaptain && teamProject ? teamCaptain.projectSessions?.[teamProject.id] : teamLeadMono?.sessionId;
  const teamLeadSession = teamLeadSessionId
    ? sessions.find((session) => session.id === teamLeadSessionId)
    : undefined;
  const teamLeadLook = teamLeadMono ? monoLook(teamLeadMono) : undefined;
  const teamLeadStatus = teamLeadMono ? (monoRail.states.get(teamLeadMono.id)?.status ?? "idle") : "idle";
  const teamLeadActive =
    !!teamLeadMono && monoCovers && (teamCaptain ? monoViewId === teamLeadSessionId : monoViewMono?.id === teamLeadMono.id);
  const teamLeadBusy =
    !!teamLeadSession?.busy ||
    !!(teamLeadSessionId && liveBusySessionIds.has(teamLeadSessionId));
  // Kept by identity while nothing it shows changes: the Sidebar is memoized.
  const codingTeamList = useMemo<CodingTeamList | undefined>(
    () =>
      teamFolder
        ? {
            kind: teamProject ? "coding" : "mono",
            ...(teamLeadMono && teamLeadLook
              ? {
                  lead: {
                    session: {
                      id: teamLeadSessionId ?? `lead:${teamLeadMono.id}`,
                      cwd: teamFolder,
                      harness: teamLeadSession?.harness ?? "claude",
                      model: teamLeadSession?.model ?? "",
                      runtimeMode: teamLeadSession?.runtimeMode ?? "supervised",
                      title: teamLeadLook.name,
                      createdAt: 0,
                      updatedAt: 0,
                      pinned: true,
                    },
                    mark: (
                      <MonoRailMascot
                        name={teamLeadLook.mascot}
                        color={teamLeadLook.color}
                        status={teamLeadStatus}
                        className="size-3.5 shrink-0"
                      />
                    ),
                    active: teamLeadActive,
                    busy: teamLeadBusy,
                    // In the time's place: what it is to the team.
                    statusLabel: teamCaptain || teamLeadMono.id === pickCaptain(listMonos())?.id ? "Captain" : teamProject ? "Lead" : "First mate",
                    // Its chat's own title, which renames as any chat's does (Sidebar.tsx renderLeadCard).
                    ...(teamLeadSession ? { chatTitle: teamLeadSession.title } : {}),
                    onOpen: () =>
                      void onOpenMono(
                        teamLeadMono.id,
                        teamCaptain && teamProject ? { project: teamProject.id } : { inTeam: true },
                      ),
                  },
                }
              : {}),
          }
        : undefined,
    [
      teamProject,
      teamFolder,
      teamLeadMono?.id,
      teamLeadSessionId,
      !!teamCaptain,
      projectFrontVersion,
      teamLeadLook?.name,
      teamLeadLook?.mascot,
      teamLeadLook?.color,
      teamLeadStatus,
      teamLeadActive,
      teamLeadBusy,
      teamLeadSession?.harness,
      teamLeadSession?.model,
      teamLeadSession?.runtimeMode,
      teamLeadSession?.title,
      onOpenMono,
    ],
  );
  // Where the team remembers the chat Ash was last in (codingTeamList.ts codingTeamView): its project, or its Mono's item.
  const teamProjectId = teamProject?.id ?? (ownTeamShown ? monoTeamItem(teamOwnerMonoId!) : undefined);
  // From the coding team's list: another chat takes over from the Lead, and the coding team opens on it next time.
  const openTerminalSession = terminalMirror.openSession;
  const closeTerminalSession = terminalMirror.close;
  const onSelectSessionFromList = useCallback(
    (sessionId: string) => {
      // WP-85: a terminal session opens here, and does not start a harness chat.
      if (openTerminalSession(sessionId)) return;
      closeTerminalSession();
      if (teamProjectId && !isMonoSession(sessionId)) {
        noteCodingTeamView(teamProjectId, "chat");
        if (monoViewIdRef.current) closeMonoView();
      }
      return onSelectHistorySession(sessionId);
    },
    [teamProjectId, closeMonoView, onSelectHistorySession, openTerminalSession, closeTerminalSession],
  );
  const onNewFromList = useCallback(() => {
    if (teamProjectId) noteCodingTeamView(teamProjectId, "chat");
    if (monoViewIdRef.current) closeMonoView();
    return onNew();
  }, [teamProjectId, closeMonoView, onNew]);

  const projectStrip = (
    <ProjectStrip
      selection={hubSel}
      onPickProject={(project) => {
        closeChromeViews();
        // Dropwave: its own home, the Chief of Staff's box on top. The coding team is one of its first mates.
        if (monoViewIdRef.current) closeMonoView();
        showProjectHome(project.id);
      }}
      onCreateProject={pickProject}
      onLeaveCovers={closeChromeViews}
      // The inset layout's title bar spans the window above the strip.
      titleBarAbove={insetLayout}
    />
  );

  const sessionSidebar = (
    <Sidebar
      hubTopNav={
        <HubTopNav
          openSessionId={monoViewId}
          covered={searchViewOpen || settingsOpen || inboxViewOpen || notesViewOpen || automationsViewOpen}
          onLeaveCovers={() => {
            closeChromeViews();
            if (monoViewIdRef.current) closeMonoView();
          }}
        />
      }
      hubItems={
        <HubProjectItems
          selection={hubSel}
          monoOpen={hubItemsCovered}
          onPick={(item) => {
            closeChromeViews();
            if (item.kind === "coding-team" && hubProject?.folder)
              openCodingTeam(hubProject.id);
          }}
        />
      }
      codingTeam={codingTeamList}
      hubSurfaceActive={hubShown}
      cwd={sidebarCwd}
      gitCwd={gitCwd}
      worktreeTabStats={worktreeTabStats}
      onSelectWorkspace={onSelectWorkspace}
      workspaceSwitchPending={
        workspaceNavigation.pending?.project === sidebarCwd
      }
      workspaceSwitchError={
        workspaceNavigation.error?.project === sidebarCwd
          ? workspaceNavigation.error.message
          : undefined
      }
      explorerRootLabel={explorerRootLabel}
      open={sessionSidebarOpen}
      tab={insetLayout ? "sessions" : sidebarTab}
      onTabChange={setSidebarTab}
      rightPanel={
        insetLayout && !settingsOpen && !monoCovers
          ? {
              host: rightPanelHost,
              open: rightPanelOpen || rightPanelClosing,
              tab: rightPanelTab,
              onTabChange: showRightPanel,
            }
          : undefined
      }
      filesSearchOpen={filesSearchOpen}
      onFilesSearchOpenChange={setFilesSearchOpen}
      onOpenFilesSearch={onFindInProject}
      searchFocusToken={searchFocusToken}
      sessions={sidebarHistory}
      busySessionIds={liveBusySessionIds}
      approvalSessionIds={approvalSessionIds}
      approvalElsewhereSessionIds={approvalElsewhereSessionIds}
      chatAttention={chatListAttention}
      // The coding team's Lead in view is its pinned row's; no other chat reads as the current one meanwhile.
      activeSessionId={codingTeamList?.lead?.active ? undefined : activeSessionId}
      status={historyFailed ? "error" : "idle"}
      pending={historyPending}
      onSelectSession={onSelectSessionFromList}
      onSetSessionFolder={onSessionFolderRelinked}
      onSelectRemoteSession={onSelectRemoteSession}
      onRemoteSessionDeleted={onRemoteSessionDeleted}
      onPrefetchSession={onPrefetchHistorySession}
      onSessionNavigationOrder={onSessionNavigationOrder}
      onPlaceSessionOnPane={onPlaceSessionOnPane}
      onRenameSession={onRenameHistorySession}
      onArchiveSession={onArchiveHistorySession}
      onArchiveSessions={onArchiveHistorySessions}
      onPinSession={onPinHistorySession}
      onPinSessions={onPinHistorySessions}
      onPrivateSession={onPrivateHistorySession}
      onSetSessionLinkedWorkItem={onSetHistorySessionLinkedWorkItem}
      reminders={sessionReminders.reminders}
      onSetReminders={sessionReminders.schedule}
      onCancelReminders={sessionReminders.cancel}
      onDeleteSession={onDeleteHistorySession}
      onDeleteSessions={onDeleteHistorySessions}
      onOpenFile={onOpenFile}
      onOpenTerminal={onOpenTerminal}
      onFileMoved={onFileMoved}
      onFileDeleted={onFileDeleted}
      canGoBack={
        !!monoViewId ||
        tabVisitNav.canBack ||
        searchViewOpen ||
        settingsOpen ||
        inboxViewOpen ||
        notesViewOpen ||
        automationsViewOpen
      }
      canGoForward={tabVisitNav.canForward}
      onGoBack={onRailBack}
      onGoForward={onRailForward}
      onOpenDiff={onOpenWorkingTreeDiff}
      onOpenAllChanges={onOpenAllChanges}
      onOpenCommit={onOpenCommit}
      selectedDiffPath={
        activeTab ? selectedChangePath(activeTab, gitCwd) : undefined
      }
      selectedDiffKind={activeTab ? selectedChangeKind(activeTab) : undefined}
      selectedCommitSha={activeTab ? selectedCommitSha(activeTab) : undefined}
      textHarness={pickTextHarness(active?.harness)}
      recents={recents}
      busyProjectPaths={busyProjectPaths}
      liveAgents={liveAgents}
      onSelectAgent={onSelectLiveAgent}
      onSelectProject={onSelectProject}
      onOpenProject={pickProject}
      onRemoveProject={onRemoveProject}
      monos={hubMonos}
      // The coding team's Lead opens beside its Sessions list, which stays.
      monoViewActive={monoCovers && !codingTeamList?.lead?.active}
      onNew={onNewFromList}
      openSessions={openProjectSessions}
      onNewTerminal={onNewTerminal}
      onSearch={onOpenSearch}
      // WP-06: the Inbox button opens the Inbox, not Today's screen.
      onOpenInbox={onOpenInbox}
      onOpenInboxItem={onOpenLinkedWorkItem}
      onOpenNotes={notesEnabled ? onOpenNotes : undefined}
      onOpenAutomations={onOpenAutomations}
      onOpenPages={onOpenPages}
      onGoToFile={onGoToFile}
      searchActive={searchViewOpen}
      inboxActive={
        hubDefaultsOn() ? inboxViewOpen : hubShown && hubSel.project !== NO_PROJECT && hubSel.item === "inbox"
      }
      notesActive={notesViewOpen}
      automationsActive={automationsViewOpen && !pagesMode}
      pagesActive={automationsViewOpen && pagesMode}
      notesEnabled={notesEnabled}
      // The inset layout has no project rail: the sidebar header's menu
      // switches projects.
      projectRailOpen={!insetLayout && projectRailOpen}
      compactProjectRail={!insetLayout && compactProjectRail}
      titleBarAbove={insetLayout || compactTitleBar}
      inset={insetLayout}
      onToggleProjectRail={onToggleProjectRail}
      unseenFinishedIds={unseenFinishedIds}
      inboxUnseen={inboxUnseen}
      linkedSessionUpdateIds={linkedSessionUpdateIds}
      settingsOpen={settingsOpen}
      settingsSection={settingsSection}
      onOpenSettings={onOpenSettings}
      onOpenNotificationSettings={onOpenNotificationSettings}
      onSelectSettingsSection={onSelectSettingsSection}
      onCloseSettings={onCloseSettings}
      updateNotice={updateNotice}
      onOpenWhatsNew={onOpenWhatsNew}
      onDismissUpdate={onDismissUpdate}
    />
  );

  const usageFooter =
    (chromeSurfaceOpen && !(insetLayout && activeAppView)) ||
    (monoCovers && !insetLayout) ? null : (
      <UsageFooter
        pressureSlot={setPressureChipHost}
        providers={usageProviders}
        session={usageSession}
        project={usageSource?.cwd ?? projectCwd}
        onSelectAccount={onSelectProviderAccount}
        onManageAccounts={() => openSettings("providers", "provider-accounts")}
        // A Mono in full view has no terminal of its own.
        terminals={monoCovers ? undefined : runningTerminals}
        terminalOpen={!monoCovers && runningTerminalOpen}
        onToggleTerminal={onToggleRunningTerminal}
        onNewTerminal={
          !monoCovers && isLocalProject(projectCwd) ? onNewTerminal : undefined
        }
        onToggleProjectTerminal={
          !monoCovers && isLocalProject(projectCwd)
            ? onToggleProjectTerminal
            : undefined
        }
        projectTerminalActive={
          !monoCovers &&
          !!currentProjectDock &&
          currentProjectDock.pane.files.length > 0
        }
        projectTerminalOpen={!monoCovers && !!currentProjectDock?.open}
        inset={insetLayout}
      />
    );

  return (
    <SessionStateContext.Provider value={sessionState}>
    <OrchestrationActions.Provider value={orchestrationActions}>
      <OrchestrationWorkers.Provider value={orchestrationWorkers}>
        <div
          className={`workspace-background flex h-full flex-col text-content ${
            insetLayout
              ? "inset-shell inset-outer"
              : HAS_NATIVE_GLASS
                ? "bg-background-base/[var(--window-background-opacity)]"
                : "bg-background-base"
          }`}
        >
          {titleBarSpansWindow ? workspaceTitleBar : null}
          <div className="flex min-h-0 min-w-0 flex-1">
            {insetLayout ? (
              <div
                ref={setInsetRailHost}
                className="inset-rail-host flex h-full shrink-0"
              >
                {projectStrip}
                {sessionSidebar}
              </div>
            ) : (
              projectStrip
            )}
            {/* `contents` keeps the classic layout's flat row; the inset
                layout stacks the tabs, the card and the footer. */}
            <div
              className={
                insetLayout
                  ? "flex min-h-0 min-w-0 flex-1 flex-col"
                  : "contents"
              }
            >
              <div
                className={
                  insetLayout
                    ? "inset-card mr-1.5 flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[10px] border border-stroke"
                    : "contents"
                }
              >
                {insetLayout ? null : sessionSidebar}

                <div
                  className={`flex min-h-0 min-w-0 flex-1 flex-col${
                    insetLayout ? "" : " body-glass"
                  }`}
                >
                  {/* WP-06: ship news is a slim bar at the top of the main pane, above the coding team and every hub page. It renders nothing when there is nothing to say. */}
                  <ShipNotice />
                  {/* WP-92: a pending key request, and a finished turn's key ask, in the chat's own pane. */}
                  <div className="px-3 pt-2 empty:hidden">
                    <SecretCards />
                    {/* WP-92: a project chat's key is saved for that project, where secrets_run looks first (agentAppSecrets where()). */}
                    <SecretKeyAsk
                      chat={activeChat}
                      project={
                        activeChat && !(monoForSession(activeChat.id) ?? findMono(habitRunMono(activeChat.id) ?? "") ?? chatMonoOwner(activeChat.id))
                          ? (hubData().listProjects().find((entry) => entry.id === codingTeamChatProject(activeChat.id))?.folder ??
                            (looksLikeProject(activeChat.cwd) ? activeChat.cwd : undefined))
                          : undefined
                      }
                    />
                  </div>
                  <div
                    className={
                      searchViewOpen ||
                      settingsOpen ||
                      inboxViewOpen ||
                      notesViewOpen ||
                      automationsViewOpen ||
                      hubShown
                        ? "hidden"
                        : "flex min-h-0 min-w-0 flex-1 flex-col"
                    }
                    aria-hidden={
                      searchViewOpen ||
                      settingsOpen ||
                      inboxViewOpen ||
                      notesViewOpen ||
                      automationsViewOpen ||
                      hubShown
                    }
                    inert={
                      searchViewOpen ||
                      settingsOpen ||
                      inboxViewOpen ||
                      notesViewOpen ||
                      automationsViewOpen ||
                      hubShown ||
                      undefined
                    }
                  >
                    {!IS_MAC ? (
                      <MenuBar
                        onNew={onNew}
                        onNewTerminal={onNewTerminal}
                        onToggleTerminal={onToggleProjectTerminal}
                        onGoToFile={onGoToFile}
                        onToggleSidebar={onToggleSidebar}
                        onToggleSessionSidebar={
                          onToggleSessionSidebarShortcut
                        }
                        onShowSourceControl={onToggleChanges}
                        onCloseCurrentTab={
                          activeTabId
                            ? () => onCloseTab(activeTabId)
                            : undefined
                        }
                        onCloseOtherTabs={onCloseOtherTabs}
                        onCloseAllTabs={onCloseAllTabs}
                        onPickProject={pickProject}
                        onFindInProject={onFindInProject}
                        onSearch={onOpenSearch}
                        onOpenInbox={onOpenInbox}
                        onOpenNotes={notesEnabled ? onOpenNotes : undefined}
                        onZoomIn={() => {
                          const next = saveUiScale(
                            zoomInUiScale(loadUiScale()),
                          );
                          void applyUiScale(next);
                        }}
                        onZoomOut={() => {
                          const next = saveUiScale(
                            zoomOutUiScale(loadUiScale()),
                          );
                          void applyUiScale(next);
                        }}
                        onZoomReset={() => {
                          saveUiScale(UI_SCALE_DEFAULT);
                          void applyUiScale(UI_SCALE_DEFAULT);
                        }}
                      />
                    ) : null}
                    <div className="flex min-h-0 min-w-0 flex-1">
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        {titleBarInBody ? workspaceTitleBar : null}

                        <main className="relative flex min-h-0 min-w-0 flex-1">
                          <div
                            ref={dockGridRef}
                            className="grid h-full min-h-0 min-w-0 flex-1"
                          >
                            {projectTerminals.map((dock) => {
                              const show =
                                (dock.open || dockClosingShown) &&
                                !monoCovers &&
                                sameProjectPath(dock.projectPath, projectCwd);
                              return (
                                <div
                                  key={dock.projectPath}
                                  className={
                                    show
                                      ? "h-full min-h-0 min-w-0 w-full overflow-hidden"
                                      : "hidden"
                                  }
                                  style={
                                    show ? { gridArea: "dock" } : undefined
                                  }
                                  aria-hidden={!show}
                                  data-dock-shown={show ? "" : undefined}
                                >
                                  <ProjectTerminalDock
                                    dock={dock}
                                    focused={show && projectTerminalFocused}
                                    onFocus={focusProjectTerminal}
                                    onHide={onHideProjectTerminal}
                                    onSideChange={onProjectTerminalSide}
                                    onSizePaint={paintDockSize}
                                    onSizeCommit={commitDockSize}
                                    onAddTerminal={onNewTerminal}
                                    onSelectTerminal={onSelectProjectTerminal}
                                    onCloseTerminal={onCloseProjectTerminal}
                                    onCloseOtherTerminals={
                                      onCloseOtherProjectTerminals
                                    }
                                    onReorderTerminals={
                                      onReorderProjectTerminals
                                    }
                                    onTerminalMetaChange={onTerminalMetaChange}
                                  />
                                </div>
                              );
                            })}
                            <div
                              className="relative flex min-h-0 min-w-0 flex-row"
                              style={{ gridArea: "main" }}
                            >
                              <div className="relative min-h-0 min-w-0 flex-1">
                                {/* WP-85: the terminal session covers the chat. It is not a harness session. The key drops a reply typed for another one. */}
                                {terminalMirror.session ? (
                                  <div className="absolute inset-0 z-10">
                                    <TerminalMirrorPane
                                      key={terminalMirror.session.id}
                                      session={terminalMirror.session}
                                      projectId={hubProject?.id}
                                      note={terminalMirror.note}
                                      onReply={terminalMirror.reply}
                                      onStop={terminalMirror.stop}
                                      onAllow={terminalMirror.allow}
                                      onDeny={terminalMirror.deny}
                                      onAttach={(taskId) => void terminalMirror.attach(taskId)}
                                      onClose={terminalMirror.close}
                                    />
                                  </div>
                                ) : null}
                                {tabs.map((tab) => (
                                  <div
                                    key={tab.id}
                                    data-workspace-tab={tab.id}
                                    aria-hidden={
                                      tab.id !== activeTabId || monoCovers
                                    }
                                    className={
                                      tab.id === activeTabId && !monoCovers
                                        ? "absolute inset-0 flex h-full min-h-0 flex-col"
                                        : "hidden"
                                    }
                                  >
                                    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                                      <PaneTree
                                        {...sessionPaneProps}
                                        visible={
                                          tab.id === activeTabId &&
                                          !inboxViewOpen &&
                                          !monoCovers
                                        }
                                        layout={tab.layout}
                                        sessions={sessions}
                                        editorPanes={[
                                          ...tab.editorPanes,
                                          ...(tab.terminalPanes ?? []),
                                        ]}
                                        dirtyFileIds={dirtyFiles}
                                        fileErrorCounts={fileErrorCounts}
                                        focusedId={
                                          tab.id === activeTabId &&
                                          !monoViewId &&
                                          !inboxViewOpen &&
                                          !tab.diffFocused &&
                                          !projectTerminalFocused
                                            ? tab.focusedId
                                            : ""
                                        }
                                        addToChatSessionId={
                                          tab.id === activeTabId
                                            ? active?.id
                                            : undefined
                                        }
                                        composerFocused={
                                          composerFocused &&
                                          !projectTerminalFocused &&
                                          !monoViewId
                                        }
                                        composerFocusToken={composerFocusToken}
                                        onSelectFile={onSelectFileSurface}
                                        onCloseFile={onCloseFile}
                                        onCloseOtherFiles={onCloseOtherFiles}
                                        onPinFile={onPinFile}
                                        onReorderFiles={onReorderFiles}
                                        onFileDirtyChange={onFileDirtyChange}
                                        onFileErrorCountChange={
                                          onFileErrorCountChange
                                        }
                                        transcriptPool={transcriptPool}
                                        onRatio={(splitId, index, ratio) =>
                                          onRatio(tab.id, splitId, index, ratio)
                                        }
                                        editorNavigation={editorNavigation}
                                        onUpdatePlan={onUpdatePlan}
                                        onMovePane={onMovePane}
                                        onDetachPane={onDetachPane}
                                        onTerminalMetaChange={
                                          onTerminalMetaChange
                                        }
                                        // WP-109: pane headers split through the same handler as the shortcut.
                                        onSplit={onSplit}
                                      />
                                    </div>
                                  </div>
                                ))}
                                {sessions
                                  .filter((session) =>
                                    isMonoSession(session.id),
                                  )
                                  .map((session) => {
                                    const visible = monoViewId === session.id;
                                    return (
                                      <div
                                        key={session.id}
                                        data-mono-view={session.id}
                                        aria-hidden={!visible}
                                        inert={!visible || undefined}
                                        className={
                                          visible
                                            ? "absolute inset-0 flex h-full min-h-0 flex-col"
                                            : "hidden"
                                        }
                                      >
                                        {insetLayout &&
                                        visible &&
                                        monoViewMono ? (
                                          <MonoViewActions
                                            name={monoLook(monoViewMono).name}
                                            overviewOpen={monoOverviewOpen}
                                            onToggleOverview={
                                              onToggleMonoOverview
                                            }
                                            onOpenSettings={
                                              onOpenMonoViewSettings
                                            }
                                            team={monoViewTeamAction}
                                            // The overview header's row, so both share a centre line.
                                            className="absolute right-2.5 top-0 z-10 h-10"
                                          />
                                        ) : null}
                                        <SessionPane
                                          {...sessionPaneProps}
                                          session={session}
                                          visible={visible}
                                          focused={
                                            visible &&
                                            !projectTerminalFocused &&
                                            !monoShownSessionActive
                                          }
                                          inSplit={false}
                                          addToChatTarget={visible}
                                          composerFocused={
                                            visible &&
                                            composerFocused &&
                                            !projectTerminalFocused &&
                                            !monoShownSessionActive
                                          }
                                          composerFocusToken={
                                            composerFocusToken
                                          }
                                          onShowMonoActivity={
                                            onShowMonoActivity
                                          }
                                          onOpenArtifact={onOpenMonoArtifact}
                                          onOpenDiff={onOpenMonoDiff}
                                          onCommitChanges={onCommitMonoChanges}
                                          monoActivityTurnId={
                                            monoActivityShownTurnId
                                          }
                                          onOpenMonoSession={onOpenMonoSession}
                                          monoLaunchedSessions={
                                            visible
                                              ? monoLaunchedSessions
                                              : undefined
                                          }
                                          openMonoSessionId={shownMonoSessionId}
                                          // The inset footer stays under a
                                          // Mono and shows its usage.
                                          monoComposerUsage={!insetLayout}
                                        />
                                      </div>
                                    );
                                  })}
                              </div>
                            </div>
                          </div>
                          {[...linkedWorkItemPanels.values()].map((panel) => (
                            <LinkedWorkItemPanel
                              repairSessions={repairSessions}
                              onRepairChecks={onRepairChecks}
                              onOpenSession={(sessionId) => {
                                closeLinkedWorkItemPanel(panel.sessionId);
                                onOpenInboxSession(sessionId);
                              }}
                              key={panel.sessionId}
                              target={panel.item}
                              cwd={panel.cwd}
                              recents={recents}
                              visible={
                                !searchViewOpen &&
                                !settingsOpen &&
                                !inboxViewOpen &&
                                !notesViewOpen &&
                                !automationsViewOpen &&
                                !monoViewId &&
                                activeLinkedWorkItemPanel?.sessionId ===
                                  panel.sessionId
                              }
                              onClose={() =>
                                closeLinkedWorkItemPanel(panel.sessionId)
                              }
                            />
                          ))}
                        </main>
                      </div>
                      {monoCovers ? monoOverviewPanel : null}
                      {monoSettingsDialog}
                    </div>
                  </div>
                  {searchViewOpen ||
                  (insetLayout && openAppViews.includes("search")) ? (
                    <AppViewSurface active={searchViewOpen}>
                      <SearchView
                        tabbed={insetLayout}
                        open={searchViewOpen}
                        cwd={gitCwd}
                        recents={recents}
                        history={projectHistory}
                        sessions={sessions.filter((session) => !session.inboxAsk)}
                        focusToken={searchViewFocusToken}
                        besideRail={
                          insetLayout || projectRailOpen || compactProjectRail
                        }
                        compactRail={!insetLayout && compactRailActive}
                        onClose={onLeaveSearch}
                        onToggleSidebar={onToggleSidebar}
                        onOpenFile={onOpenFile}
                        onOpenSession={(sessionId, blockId, query) => {
                          if (blockId)
                            requestTranscriptJump(sessionId, blockId, query);
                          void onSelectHistorySession(sessionId);
                        }}
                        onOpenProject={onSelectProject}
                      />
                    </AppViewSurface>
                  ) : null}
                  <div className="hidden" aria-hidden>
                    {sessions
                      .filter((session) => session.inboxAsk)
                      .map((session) => {
                        const visible =
                          inboxViewOpen &&
                          inboxAskPortal?.sessionId === session.id;
                        return (
                          <SessionSurface
                            key={session.id}
                            host={visible ? inboxAskPortal.host : undefined}
                          >
                            <SessionPane
                              {...sessionPaneProps}
                              session={session}
                              visible={visible}
                              focused={visible}
                              inSplit={false}
                              composerFocused={composerFocused}
                              composerFocusToken={composerFocusToken}
                            />
                          </SessionSurface>
                        );
                      })}
                  </div>
                  {inboxViewOpen ||
                  (insetLayout && openAppViews.includes("inbox")) ? (
                    <AppViewSurface active={inboxViewOpen}>
                      <InboxView
                        tabbed={insetLayout}
                        active={inboxViewOpen}
                        cwd={sidebarCwd}
                        scopeProject={appViewScope}
                        recents={recents}
                        besideRail={
                          insetLayout || projectRailOpen || compactProjectRail
                        }
                        compactRail={!insetLayout && compactRailActive}
                        onClose={onLeaveInbox}
                        onToggleSidebar={onToggleSidebar}
                        onStart={onStartInboxItem}
                        onAsk={onAskInboxItem}
                        onAskRestart={onRestartInboxAsk}
                        onAskMount={setInboxAskPortal}
                        sessions={inboxRelatedSessions}
                        repairSessions={repairSessions}
                        onRepairChecks={onRepairChecks}
                        onOpenSession={onOpenInboxSession}
                        onOpenIntegrations={onOpenInboxIntegrations}
                      />
                    </AppViewSurface>
                  ) : null}
                  {hubShown ? <HubSurface selection={hubSel} /> : null}
                  <HubOnboardingGate />
                  {notesViewOpen ||
                  (insetLayout && notesEnabled && openAppViews.includes("notes")) ? (
                    <AppViewSurface active={notesViewOpen}>
                      <NotesView
                        tabbed={insetLayout}
                        active={notesViewOpen}
                        besideRail={
                          insetLayout || projectRailOpen || compactProjectRail
                        }
                        compactRail={!insetLayout && compactRailActive}
                        cwd={projectCwd}
                        scopeProject={appViewScope}
                        recents={recents}
                        onClose={onLeaveNotes}
                        onToggleSidebar={onToggleSidebar}
                        // WP-72: an @ on a page can name a chat in this project.
                        mentionChats={sessions}
                      />
                    </AppViewSurface>
                  ) : null}
                  {automationsViewOpen && pagesMode ? (
                    <AppViewSurface active>
                      <PagesView
                        onClose={onLeaveAutomations}
                        onToggleSidebar={onToggleSidebar}
                        besideRail={
                          insetLayout || projectRailOpen || compactProjectRail
                        }
                        compactRail={!insetLayout && compactRailActive}
                      />
                      {/* WP-33: plugin panels open as tabs beside Pages. */}
                      <PanelTabsScreen />
                    </AppViewSurface>
                  ) : automationsViewOpen ||
                    (insetLayout && openAppViews.includes("automations")) ? (
                    <AppViewSurface active={automationsViewOpen}>
                      <AutomationsView
                        tabbed={insetLayout}
                        besideRail={
                          insetLayout || projectRailOpen || compactProjectRail
                        }
                        compactRail={!insetLayout && compactRailActive}
                        cwd={projectCwd}
                        scopeProject={appViewScope}
                        recents={recents}
                        onClose={onLeaveAutomations}
                        onToggleSidebar={onToggleSidebar}
                        onLaunch={(automation, run) =>
                          launchAutomation(automation, run, true)
                        }
                        onOpenSession={onOpenAutomationSession}
                      />
                    </AppViewSurface>
                  ) : null}
                  {settingsOpen ? (
                    <SettingsView
                      section={settingsSection}
                      anchor={settingsAnchor}
                      notificationProjectPath={notificationProjectPath}
                      notificationSettingsRequest={notificationSettingsRequest}
                      recents={recents}
                      cwd={sidebarCwd}
                      sessions={sidebarHistory}
                      liveSessions={sessions}
                      onRemoveWorktree={onRemoveWorktree}
                      onCheckWorktreeRemoval={onCheckWorktreeRemoval}
                      onDeleteWorktreeSessions={onDeleteWorktreeSessions}
                      besideRail
                      headerHost={insetLayout ? settingsHeaderHost : undefined}
                      onClose={onCloseSettings}
                      onSelectSection={onSelectSettingsSection}
                      onOpenSession={onOpenArchivedSession}
                      onArchiveSession={onArchiveHistorySession}
                      onDeleteSession={onDeleteHistorySession}
                      onRestoreProject={onRestoreProject}
                      onDeleteProject={(path) =>
                        onRemoveProject(path, { purgeData: true })
                      }
                      onOpenWhatsNew={onOpenWhatsNew}
                      collapsedProjectRailMode={collapsedProjectRailMode}
                      onCollapsedProjectRailModeChange={
                        setCollapsedProjectRailMode
                      }
                    />
                  ) : null}
                  {insetLayout ? null : usageFooter}
                </div>
                {insetLayout ? (
                  // Part of the card: the project tools beside the
                  // workspace, behind a hairline.
                  <div
                    ref={setRightPanelRef}
                    inert={rightPanelClosing || undefined}
                    className={
                      insetRightPanelShown
                        ? "relative flex h-full shrink-0 flex-col overflow-hidden border-l border-stroke"
                        : "hidden"
                    }
                  >
                    <div
                      ref={setRightPanelHost}
                      aria-label="Project tools"
                      className="flex min-h-0 flex-1 flex-col"
                    />
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize right sidebar"
                      aria-valuenow={rightPanelResize.width}
                      aria-valuemin={RIGHT_PANEL_WIDTH_MIN}
                      aria-valuemax={RIGHT_PANEL_WIDTH_MAX}
                      className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none ${
                        rightPanelResize.dragging
                          ? "bg-content/15"
                          : "hover:bg-content/10"
                      }`}
                      onPointerDown={rightPanelResize.onPointerDown}
                      onDoubleClick={rightPanelResize.onDoubleClick}
                    />
                  </div>
                ) : null}
              </div>
              {insetLayout
                ? (usageFooter ??
                  // Settings has no footer, so the card runs down to the same
                  // gutter as its right edge.
                  <div
                    className={`${settingsOpen ? "h-1.5" : "h-[30px]"} shrink-0`}
                  />)
                : null}
            </div>
          </div>

          {filePickerOpen ? (
            <FinderHost
              key={filePickerResetToken}
              finder={finderMode}
              open
              cwd={filesCwd}
              openPaths={openFilePaths}
              initialQuery={filePickerInitialQuery}
              history={history}
              sessions={sessions.filter((session) => !session.inboxAsk)}
              recents={recents}
              onOpenFile={onOpenFile}
              onRunAction={(id) => {
                if (id === "reload") actions.current.onReload();
              }}
              paletteContext={paletteContext}
              onRunCommand={runPaletteCommandFromFinder}
              onClose={() => setFilePickerOpen(false)}
              onOpenHit={(hit, beside, query) => {
                setFilePickerOpen(false);
                // WP-74: each kind opens in the screen that already owns it.
                routeFinderHit(hit, beside, query, {
                  openTask: (id, project) => {
                    requestTaskFocus(id, project);
                    openCrew();
                    setSearchViewOpen(false);
                    setInboxViewOpen(false);
                    setNotesViewOpen(false);
                  },
                  openDoc: (id, blockId) => {
                    openDocsMode();
                    setNotesViewOpen(true);
                    setSearchViewOpen(false);
                    setInboxViewOpen(false);
                    setAutomationsViewOpen(false);
                    requestDocFocus(id, blockId);
                  },
                  openMessage: (sessionId, blockId, q) => {
                    requestTranscriptJump(sessionId, blockId, q);
                    void onSelectHistorySession(sessionId);
                  },
                  openConversation: (sessionId) => {
                    void onSelectHistorySession(sessionId);
                  },
                  openMono: (id) => {
                    void onOpenMono(id);
                  },
                  openFile: (path, line, column, beside) => {
                    onOpenFile(
                      path,
                      line != null ? { line, column } : undefined,
                      finderFileOptions(beside),
                    );
                  },
                  openProject: (path) => {
                    onSelectProject(path);
                  },
                  runCommand: (id) => {
                    if (id === "reload") actions.current.onReload();
                  },
                });
              }}
            />
          ) : null}

          <ConfirmDeleteHost />
          {sessionDeleteDialog && (
            <DeleteSessionDialog
              title={sessionDeleteDialog.title}
              unusedWorktree={sessionDeleteDialog.unusedWorktree}
              worktreeTicked={sessionDeleteDialog.worktreeTicked}
              onClose={(choice) => {
                sessionDeleteDialog.resolve(choice);
                setSessionDeleteDialog(undefined);
              }}
            />
          )}
          {/* A dev copy never offers CLI updates: the Claude/Codex binaries are shared with the daily app. */}
          {appPolicy().dailyClaude ? (
            <HarnessUpdateNotice
              topOffset={toastStackTop([reminderNoticesHeight])}
              onHeightChange={setHarnessUpdateHeight}
              // Always over the sidebar's foot, never over a view's header or content (Ash, 22 Oct: never covering screens).
              placement="bottom-left"
            />
          ) : null}
          {/* The Hub's shell is built on the classic layout, so the Hub does
              not prompt for the new one; it stays in Settings → Appearance.
              The hub's dev page doesn't either (hubDefaultsOn). */}
          {hubDefaultsOn() ? null : (
            <NewLayoutNotice
              topOffset={toastStackTop([reminderNoticesHeight, harnessUpdateHeight])}
              onHeightChange={setNewLayoutNoticeHeight}
            />
          )}
          <ResourcePressureNotice
            sessions={sessionsRef}
            onStopAgent={(id) => onStop(id, true)}
            onStopSession={onStop}
            onPressureChange={transcriptPool.setResourcePressure}
            chipHost={pressureChipHost}
            insetChip={insetLayout}
          />
          {/* WP-125: a local link that cannot be opened on this computer. */}
          <ThreadLinkNotice />
          <ApprovalToasts
            notices={IS_HUB_BUNDLE ? hubToastNotices(hiddenApprovalToasts) : hiddenApprovalToasts}
            hubView={IS_HUB_BUNDLE ? hubToastView : undefined}
            topOffset={toastStackTop([reminderNoticesHeight, harnessUpdateHeight, newLayoutNoticeHeight])}
            onFocusSession={onOpenApprovalSession}
            onApproval={onApproval}
          />
          <ReminderNotices
            reminders={sessionReminders.due}
            error={sessionReminders.error}
            onOpen={sessionReminders.open}
            onSnooze={sessionReminders.schedule}
            onDismiss={sessionReminders.cancel}
            onRetry={sessionReminders.refresh}
            onOpenSettings={() => openSettings("general", "notifications")}
            onHeightChange={setReminderNoticesHeight}
          />
          {/* WP-123: fork a chat from one message. */}
          <ThreadForkHost sessionsRef={sessionsRef} onOpen={openForkedSession} />
          {whatsNewVersion ? (
            <WhatsNewDialog
              version={whatsNewVersion}
              onClose={() => setWhatsNewVersion(null)}
            />
          ) : null}
          {remoteProjectDialogOpen ? (
            <AddRemoteProjectDialog
              onCancel={() => setRemoteProjectDialogOpen(false)}
              onOpen={(key) => {
                setRemoteProjectDialogOpen(false);
                onSelectProject(key);
              }}
            />
          ) : null}
          {providerSignInRequest ? (
            <ProviderSignInDialog
              key={providerSignInRequest.key}
              harness={providerSignInRequest.harness}
              onClose={() => setProviderSignInRequest(null)}
            />
          ) : null}
        </div>
        <TranscriptPoolOutlet pool={transcriptPool} />
      </OrchestrationWorkers.Provider>
    </OrchestrationActions.Provider>
    </SessionStateContext.Provider>
  );
}
function conversationTitle(session: Session): string {
  const hostId = isRemoteProjectPath(session.cwd)
    ? remoteSessionFor(session.id)
    : undefined;
  const remote = hostId
    ? cachedRemoteSessionSummary(session.cwd, hostId)
    : undefined;
  const title = sessionDisplayTitle(
    remote?.title ?? session.title,
    remote?.harness ?? session.harness,
  );
  return title === "New session" ? "" : title;
}

function lastUserBlockId(session: Session): string | undefined {
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    if (session.blocks[i]?.role === "user") return session.blocks[i]?.id;
  }
  return undefined;
}

function providerSignInRequestKey(session: Session): string {
  const lastBlockId = session.blocks[session.blocks.length - 1]?.id;
  return `${session.id}:${lastUserBlockId(session) ?? lastBlockId ?? "auth"}`;
}

function selectedChangePath(
  tab: WorkspaceTab,
  gitCwd?: string,
): string | undefined {
  const file = focusedFileTab(tab);
  if (!file || !isFilesystemTab(file) || !file.review) return undefined;
  return displayPath(file.path, gitCwd || file.cwd);
}

function selectedChangeKind(tab: WorkspaceTab): GitFileDiffKind | undefined {
  const file = focusedFileTab(tab);
  return file?.review ? file.changeKind : undefined;
}

function selectedCommitSha(tab: WorkspaceTab): string | undefined {
  const focused = focusedFileTab(tab);
  if (focused && isCommitTab(focused)) return focused.commit.sha;
  for (const pane of tab.editorPanes) {
    const file = pane.files.find((entry) => entry.id === pane.activeFileId);
    if (file && isCommitTab(file)) return file.commit.sha;
  }
}


function toTitleTab(
  tab: WorkspaceTab,
  sessions: Session[],
  dirtyFiles: Set<string>,
  unseenFinishedIds: ReadonlySet<string>,
): TitleTab {
  const paneIds = leafIds(tab.layout);
  const multiPane = paneIds.length > 1;
  const tabSessions = paneIds
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is Session => session != null);
  const sessionFocused = tabSessions.some(
    (session) => session.id === tab.focusedId,
  );
  const fileFocused =
    !sessionFocused &&
    (tab.editorPanes.some((pane) => pane.id === tab.focusedId) ||
      (tab.terminalPanes ?? []).some((pane) => pane.id === tab.focusedId));
  const focused =
    sessions.find((session) => session.id === tab.focusedId) ?? tabSessions[0];

  const seen = new Set<HarnessId>();
  const harnesses: HarnessId[] = [];
  const busySeen = new Set<HarnessId>();
  const busyHarnesses: HarnessId[] = [];
  const doneSeen = new Set<HarnessId>();
  const doneHarnesses: HarnessId[] = [];
  const ordered = focused
    ? [focused, ...tabSessions.filter((session) => session.id !== focused.id)]
    : tabSessions;
  for (const session of ordered) {
    if (
      session.busy &&
      !sessionNeedsInput(session) &&
      !busySeen.has(session.harness)
    ) {
      busySeen.add(session.harness);
      busyHarnesses.push(session.harness);
    }
    if (unseenFinishedIds.has(session.id) && !doneSeen.has(session.harness)) {
      doneSeen.add(session.harness);
      doneHarnesses.push(session.harness);
    }
    if (seen.has(session.harness)) continue;
    seen.add(session.harness);
    harnesses.push(session.harness);
  }

  const files: string[] = [];
  const seenKeys = new Set<string>();
  const pushFile = (file: FilePaneTab) => {
    const key = file.terminal
      ? `terminal:${file.id}`
      : file.plan
        ? `plan:${file.plan.blockId}`
        : file.releaseNotes
          ? `release-notes:${file.releaseNotes.version}`
          : file.path;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    files.push(
      file.plan?.title?.trim() ||
        (file.releaseNotes
          ? releaseNotesTitle(file.releaseNotes.version)
          : file.terminal
            ? terminalTabLabel(file)
            : basename(file.path)),
    );
  };
  const focusedPane =
    tab.editorPanes.find((pane) => pane.id === tab.focusedId) ??
    (tab.terminalPanes ?? []).find((pane) => pane.id === tab.focusedId);
  const otherPanes = [
    ...tab.editorPanes.filter((pane) => pane.id !== focusedPane?.id),
    ...(tab.terminalPanes ?? []).filter((pane) => pane.id !== focusedPane?.id),
  ];
  const panes = focusedPane ? [focusedPane, ...otherPanes] : otherPanes;
  for (const pane of panes) {
    const active = pane.files.find((file) => file.id === pane.activeFileId);
    if (active) pushFile(active);
  }
  for (const pane of panes) {
    for (const file of pane.files) pushFile(file);
  }

  const more = tabSessions
    .filter((session) => session.id !== focused?.id)
    .map(conversationTitle)
    .filter(Boolean);

  const hasTerminal = (tab.terminalPanes ?? []).some((pane) =>
    pane.files.some(isTerminalTab),
  );
  const focusedFile = focusedFileTab(tab);

  return {
    id: tab.id,
    project: focused
      ? projectName(focused.cwd)
      : focusedFile
        ? projectName(focusedFile.projectCwd ?? focusedFile.cwd)
        : "~",
    title: focused ? conversationTitle(focused) : "",
    more,
    sessionCount: tabSessions.length,
    harnesses,
    busyHarnesses,
    doneHarnesses,
    files,
    multiPane,
    fileFocused,
    blank: isBlankWorkspaceTab(tab, sessions),
    dirty: tab.editorPanes.some((pane) =>
      pane.files.some(
        (file) => isFilesystemTab(file) && dirtyFiles.has(file.id),
      ),
    ),
    terminal: hasTerminal && harnesses.length === 0,
    previewFileId: previewWorkspaceFile(tab)?.id,
    groupId: tab.groupId,
  };
}

function dropOpenFiles(
  tab: WorkspaceTab,
  shouldDrop: (path: string) => boolean,
): WorkspaceTab {
  let layout = tab.layout;
  let focusedId = tab.focusedId;
  const editorPanes: EditorPane[] = [];
  for (const pane of tab.editorPanes) {
    const files = pane.files.filter(
      (file) => !isFilesystemTab(file) || !shouldDrop(file.path),
    );
    if (files.length === 0) {
      const sibling = siblingLeafId(layout, pane.id);
      const withoutPane = removePane(layout, pane.id);
      if (withoutPane) {
        layout = withoutPane;
        if (focusedId === pane.id)
          focusedId = sibling ?? firstLeafId(withoutPane);
      }
      continue;
    }
    editorPanes.push({
      ...pane,
      files,
      activeFileId: files.some((file) => file.id === pane.activeFileId)
        ? pane.activeFileId
        : files[0].id,
    });
  }
  return { ...tab, layout, focusedId, editorPanes };
}

function trackSessionEdits(
  sessionId: string,
  cwd: string,
  event: HarnessEvent,
) {
  if (event.type !== "tool.started" && event.type !== "tool.updated") return;
  if (!isEditTool(event.kind, event.title, event.preview)) return;
  const paths = [
    ...(event.paths ?? []),
    ...(event.preview?.path ? [event.preview.path] : []),
  ].filter((path, index, all) => all.indexOf(path) === index);
  if (paths.length === 0 || cwd === "~") return;
  const completed =
    event.type === "tool.updated" &&
    (event.status === "completed" || event.status === "success");
  if (!completed) {
    void prepareSessionCheckpoint(sessionId, cwd, paths).catch(() => undefined);
    return;
  }
  void captureSessionCheckpoint(sessionId, cwd, paths)
    .catch(() => undefined)
    .then(() => notifyReviewChanged(sessionId));
}

function nudgeWorkspace(cwd?: string) {
  invalidateProjectFiles(cwd);
  notifyDirsChanged();
}

function nudgeOpenEditors(event: HarnessEvent, cwd: string) {
  if (event.type !== "tool.updated") return;
  const completed = event.status === "completed" || event.status === "success";

  const kind = event.kind?.trim().toLowerCase();
  if (kind === "execute" || event.preview?.kind === "shell") {
    if (!completed) return;
    nudgeWatchedFiles();
    window.setTimeout(() => nudgeWatchedFiles(), 150);
    notifyGitChanged();
    nudgeWorkspace(cwd);
    window.setTimeout(() => nudgeWorkspace(cwd), 150);
    return;
  }

  if (!isEditTool(event.kind, event.title, event.preview)) return;
  const resolved = [
    ...(event.paths ?? []),
    ...(event.preview?.path ? [event.preview.path] : []),
  ]
    .map((path) => resolveWorkspacePath(path, cwd) ?? path)
    .filter((path, index, paths) => paths.indexOf(path) === index);
  if (completed) {
    // A successful edit is authoritative. Reload it even if a startup race or
    // coarse filesystem timestamp makes the mtime appear unchanged.
    invalidateWatchedFiles(resolved.length > 0 ? resolved : undefined);
  } else if (resolved.length > 0) {
    nudgeWatchedFiles(resolved);
  }
  if (completed) {
    window.setTimeout(
      () => nudgeWatchedFiles(resolved.length > 0 ? resolved : undefined),
      150,
    );
    notifyGitChanged();
    nudgeWorkspace(cwd);
  }
}

function sameSettings(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}
