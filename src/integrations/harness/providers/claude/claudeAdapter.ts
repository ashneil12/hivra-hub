import {
  applyClaudeSettings,
  bindClaudeSession,
  cancelClaudeTurn,
  claudeHasBackgroundWork,
  compactClaudeContext,
  dropClaudeSession,
  forgetClaudeSession,
  respondClaudeApproval,
  respondClaudeQuestion,
  restoreClaudeGoal,
  restoreClaudeMovedFolder,
  restoreClaudeTaskLists,
  sendClaudeTurn,
  steerClaudeTurn,
  stopClaudeSession,
  stopClaudeTask,
} from "./claude";
import { refreshClaudeCatalog } from "./claudeCatalog";
import {
  generateClaudeBranchName,
  generateClaudeCommitMessage,
  generateClaudePrContent,
} from "./claudeGit";
import { generateClaudeSessionTitle } from "./claudeTitle";
import {
  runClaudeTextPrompt,
  stopClaudeTextPrompt,
  warmupClaudeText,
} from "./claudeText";
import { registerHarness, type HarnessAdapter } from "../../core/registry";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  live: true,
  sendTurn: sendClaudeTurn,
  compactContext: compactClaudeContext,
  steerTurn: steerClaudeTurn,
  cancelTurn: cancelClaudeTurn,
  stopTask: stopClaudeTask,
  applySettings: applyClaudeSettings,
  respondApproval: respondClaudeApproval,
  respondQuestion: respondClaudeQuestion,
  stopSession: stopClaudeSession,
  hasBackgroundWork: claudeHasBackgroundWork,
  forgetSession: forgetClaudeSession,
  dropSession: dropClaudeSession,
  bindSession: bindClaudeSession,
  restoreTaskLists: restoreClaudeTaskLists,
  restoreGoal: restoreClaudeGoal,
  restoreMovedFolder: restoreClaudeMovedFolder,
  refreshCatalog: refreshClaudeCatalog,
  generateTitle: generateClaudeSessionTitle,
  generateCommitMessage: generateClaudeCommitMessage,
  generatePrContent: generateClaudePrContent,
  generateBranchName: generateClaudeBranchName,
  warmupText: warmupClaudeText,
  runTextPrompt: runClaudeTextPrompt,
  stopTextPrompt: stopClaudeTextPrompt,
};

let registered = false;

export function ensureClaudeRegistered(): void {
  if (registered) return;
  registerHarness(claudeAdapter);
  registered = true;
}
