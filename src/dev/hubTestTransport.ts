// Tests only. Talks to scripts/hub-stub-server.mjs over plain node http (happy-dom's fetch won't reach a local server),
// the way the Rust plugin does: one POST per ash-hub-* call, errors as HubCallError with the plugin's kinds. The feed
// reports "down", so a HubStore polls. Never shipped: nothing in the app imports it.
import http from "node:http";
import { HubCallError, type HubTransport } from "../features/hub/model/hubTransport";

export function httpTransport(baseUrl: () => string, token: () => string): HubTransport {
  return {
    call: (action, payload = {}) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request(
          `${baseUrl()}/api/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            let raw = "";
            res.on("data", (c) => (raw += c));
            res.on("end", () => {
              let json: { ok?: boolean; result?: unknown; error?: string } = {};
              try {
                json = JSON.parse(raw);
              } catch {
                /* not JSON */
              }
              if (res.statusCode === 401) reject(new HubCallError("unauthorized", "Ash OS didn't accept the app's key."));
              else if (res.statusCode === 403) reject(new HubCallError("refused", json.error ?? "Ash OS didn't take that."));
              else if (json.ok) resolve(json.result as never);
              else reject(new HubCallError("error", json.error ?? `Ash OS answered with an error (${res.statusCode}).`));
            });
          },
        );
        req.on("error", () => reject(new HubCallError("unreachable", "Ash OS isn't running.")));
        req.end(body);
      }),
    openFeed: (_after, handlers) => {
      handlers.onState({ connected: false, message: "polling in this test" });
      return () => undefined;
    },
  };
}
