// A webview's own Tauri IPC, faked for a browser fixture: commands go to `handle`, and events reach the listeners the
// page registered through @tauri-apps/api (`listen`, `getCurrentWebviewWindow().listen`). One per frame, so two frames
// are two webviews with nothing shared but what the fixture relays between them.
type Handle = (command: string, args: Record<string, unknown>) => unknown;

export function installFakeTauri(label: string, handle: Handle) {
  const callbacks = new Map<number, (event: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  let next = 1;
  Object.assign(window, {
    isTauri: true,
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (event: string, id: number) => listeners.get(event)?.delete(id),
    },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label }, currentWebview: { label } },
      transformCallback: (callback: (event: unknown) => void) => {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") {
          const event = String(args.event);
          const set = listeners.get(event) ?? new Set<number>();
          set.add(Number(args.handler));
          listeners.set(event, set);
          return args.handler;
        }
        if (command === "plugin:event|unlisten") {
          listeners.get(String(args.event))?.delete(Number(args.eventId));
          return null;
        }
        return handle(command, args);
      },
    },
  });
  return {
    emit(event: string, payload: unknown) {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    },
  };
}
