/**
 * The display: a panel beside the orb that JARVIS puts pictures on.
 *
 * He speaks two sentences at most, so this is where the detail goes. The
 * server pushes a `visual` frame over the voice socket (the whole spec, or
 * null to take it down); this file owns the panel and hands the spec to the
 * shared renderer. Nothing here interprets content — see visual-render.ts
 * for why that matters.
 *
 * Two things go back to the server: a `visual_closed` when the user
 * dismisses the panel (so a reconnecting tab does not get it straight
 * back), and a click on a node, row or card, which is sent as a transcript —
 * the exact sentence "Tell me more about <label>", the same words the hover
 * showed, as if he had said them. The label is the only variable part, and
 * it is the text he clicked on.
 */
import { renderVisual, type Visual } from "./visual-render";
import "./display.css";

export interface DisplayPanel {
  show(visual: Visual): void;
  clear(): void;
  isOpen(): boolean;
  current(): Visual | null;
}

export interface DisplayHandlers {
  onClose: () => void;
  onAsk: (label: string) => void;
}

export function createDisplay(handlers: DisplayHandlers): DisplayPanel {
  const panel = document.createElement("aside");
  panel.id = "display";
  panel.hidden = true;
  panel.setAttribute("aria-label", "JARVIS display");

  const head = document.createElement("div");
  head.className = "display-head";
  const kicker = document.createElement("span");
  kicker.className = "display-kicker";
  kicker.textContent = "JARVIS · display";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "display-close";
  close.title = "Take it down";
  close.setAttribute("aria-label", "Close the display");
  close.textContent = "×";
  head.append(kicker, close);

  const body = document.createElement("div");
  body.className = "display-body";
  panel.append(head, body);
  document.body.appendChild(panel);

  let shown: Visual | null = null;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    document.body.classList.toggle("display-open", open);
  }

  const api: DisplayPanel = {
    show(visual) {
      shown = visual;
      body.replaceChildren(renderVisual(visual, { onAsk: handlers.onAsk }));
      body.scrollTop = 0;
      setOpen(true);
    },
    clear() {
      shown = null;
      body.replaceChildren();
      setOpen(false);
    },
    isOpen: () => !panel.hidden,
    current: () => shown,
  };

  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.clear();
    handlers.onClose();
  });
  // A click inside the panel is not a click on the page behind it.
  panel.addEventListener("click", (e) => e.stopPropagation());

  // For trying a picture by hand from the console — the same path a frame
  // from the server takes, so what you see is what he would show.
  (window as unknown as { jarvisShow: (v: Visual) => void }).jarvisShow = (v) => api.show(v);

  return api;
}
