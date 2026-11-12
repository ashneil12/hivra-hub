// Dropwave: your saved Other models, offered to Pi and Oh My Pi (src-tauri/src/pi_routes.rs).
// The app starts a local router for each model and sets DROPWAVE_PI_ROUTES (the list) and one
// DROPWAVE_PI_TOKEN_<n> per model. This file holds no secret: the router keeps the real key, and
// each token works only on that loopback router while this session lives.
export default function dropwaveRoutes(pi) {
  let routes = [];
  try {
    routes = JSON.parse(process.env.DROPWAVE_PI_ROUTES || "[]");
  } catch {
    return;
  }
  if (!Array.isArray(routes)) return;
  for (const route of routes) {
    if (!route || typeof route !== "object") continue;
    const { provider, name, baseUrl, modelId, tokenEnv, contextWindow } = route;
    if (typeof provider !== "string" || !/^dropwave-[a-z0-9-]+$/.test(provider)) continue;
    if (typeof baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) continue;
    if (typeof modelId !== "string" || !modelId) continue;
    if (typeof tokenEnv !== "string" || !/^DROPWAVE_PI_TOKEN_\d+$/.test(tokenEnv)) continue;
    if (!process.env[tokenEnv]) continue;
    pi.registerProvider(provider, {
      name: "Dropwave",
      baseUrl,
      // An env var name: Pi reads the token from it, so the token is never written anywhere.
      apiKey: tokenEnv,
      api: "anthropic-messages",
      models: [
        {
          id: modelId,
          name: typeof name === "string" ? name : modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: Number(contextWindow) > 0 ? Number(contextWindow) : 200000,
          maxTokens: 32000,
        },
      ],
    });
  }
}
