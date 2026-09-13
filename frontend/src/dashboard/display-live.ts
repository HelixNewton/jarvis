/**
 * Live hints for the DISPLAY view.
 *
 * Same discipline as specs-live.ts: the message carries no content. JARVIS
 * put something on the screen, or took it down — the server says only that
 * something moved, and the view re-reads /api/visuals for the truth.
 */
import { createSocket } from "../ws";

export interface DisplayLiveHandlers {
  onReconcile: () => void;
  onConnectionChange: (connected: boolean) => void;
}

export function connectDisplayLive(handlers: DisplayLiveHandlers): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = createSocket(`${proto}://${location.host}/ws/visuals`);

  socket.onMessage((msg) => {
    if (msg.type === "hello" || msg.type === "changed") {
      if (msg.type === "hello") handlers.onConnectionChange(true);
      handlers.onReconcile();
    }
  });

  let wasConnected = false;
  setInterval(() => {
    const now = socket.isConnected();
    if (now !== wasConnected) {
      handlers.onConnectionChange(now);
      if (now) handlers.onReconcile();
      wasConnected = now;
    }
  }, 1000);
}
