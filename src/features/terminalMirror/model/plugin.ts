// WP-85. Re-exports so the app's type check covers the plugin. Claude Code loads the plugin from its own folder.

export { applyMapped, attachSession, emptyBook, removeSession } from "../../../../plugins/hivra-mirror/src/book.ts";
export { kindFromEnv, resolveDataDir } from "../../../../plugins/hivra-mirror/src/config.ts";
export { onHook, toWire } from "../../../../plugins/hivra-mirror/src/hook.ts";
export {
  INSTALL_PREVIEW,
  commitPlan,
  defaultSetting,
  planChange,
  touchesPersonClaude,
} from "../../../../plugins/hivra-mirror/src/install.ts";
export { mapEvent } from "../../../../plugins/hivra-mirror/src/mapper.ts";
export { dailyDataDir, devConfigDir, personClaudeDir } from "../../../../plugins/hivra-mirror/src/paths.ts";
export { discover, hivraStarted, shouldMirror } from "../../../../plugins/hivra-mirror/src/protocol.ts";
export { permissionHookOutput, steerLine } from "../../../../plugins/hivra-mirror/src/steer.ts";
export { loadTranscript, transcriptEvents } from "../../../../plugins/hivra-mirror/src/transcript.ts";
