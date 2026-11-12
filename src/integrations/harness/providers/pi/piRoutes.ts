import { piModelRoutes } from "../../../../features/sessions/model/customModels";
import { spawnChild } from "../../core/child";
import type { ConfigurableBinaryProvider } from "../../../../features/providers/model/providerBinaryPaths";

/**
 * Start a Pi or Oh My Pi child with the saved Other models offered through the app's router
 * (src-tauri/src/pi_routes.rs): only each model's route goes, never its key. With no model saved the start is
 * exactly the plain one.
 */
export function spawnPiChild(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  flavorId: ConfigurableBinaryProvider,
): Promise<void> {
  const routes = piModelRoutes();
  if (routes.length === 0) return spawnChild(sessionId, command, args, cwd, undefined, flavorId);
  return spawnChild(
    sessionId,
    command,
    args,
    cwd,
    undefined,
    flavorId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    routes,
  );
}
