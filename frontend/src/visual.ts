/**
 * The display: the panel in the workspace that JARVIS puts pictures on.
 *
 * He speaks two sentences at most, so this is where the detail goes. The
 * server pushes a `visual` frame over the voice socket (the whole spec, or
 * null to take it down); this file owns the panel and hands the spec to the
 * shared renderer. Nothing here interprets content — see visual-render.ts
 * for why that matters.
 *
 * Two things go back to the server: a `visual_closed` when the user
 * dismisses the panel (so a reconnecting tab does not get it straight
 * back), and the Ask button on a selected node, row or card, which is sent
 * as a transcript — the exact sentence "Tell me more about <label>", as if
 * he had said them. The label is the only variable part, and it is the text
 * the button named. Selecting something sends nothing; only the button asks.
 *
 * LIFECYCLE. One VisualView at a time. show() destroys the previous view,
 * builds the new one, inserts it, opens the panel and THEN mounts — the
 * renderer measures its container, and a hidden container has no width to
 * measure. clear() destroys before it empties. The page (main.ts) owns
 * Escape and calls clearSelection() first.
 */
import { createVisual, type Visual, type VisualView } from "./visual-render";
import "./display.css";

export interface DisplayPanel {
  show(visual: Visual): void;
  clear(): void;
  isOpen(): boolean;
  current(): Visual | null;
  /** Drop the selection in the shown picture. False when nothing is shown
   *  or nothing was selected. */
  clearSelection(): boolean;
}

export interface DisplayHandlers {
  onClose: () => void;
  onAsk: (label: string) => void;
}

/**
 * `mount` is where the panel lives: the page's #result-mount, which is
 * hidden along with the panel so the workspace grid collapses to one
 * column. With no mount given the panel goes straight into the body.
 */
export function createDisplay(handlers: DisplayHandlers, mount: HTMLElement = document.body): DisplayPanel {
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
  mount.appendChild(panel);

  let shown: Visual | null = null;
  let view: VisualView | null = null;

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    if (mount !== document.body) mount.hidden = !open;
    document.body.classList.toggle("display-open", open);
  }

  function dropView(): void {
    view?.destroy();
    view = null;
  }

  const api: DisplayPanel = {
    show(visual) {
      shown = visual;
      dropView();
      const next = createVisual(visual, { onAsk: handlers.onAsk });
      view = next;
      body.replaceChildren(next.element);
      body.scrollTop = 0;
      // Open first: the renderer measures on mount, and a hidden container
      // has no width.
      setOpen(true);
      next.mount();
    },
    clear() {
      shown = null;
      dropView();
      body.replaceChildren();
      setOpen(false);
    },
    isOpen: () => !panel.hidden,
    current: () => shown,
    clearSelection: () => (view ? view.clearSelection() : false),
  };

  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.clear();
    handlers.onClose();
  });
  // A click inside the panel is not a click on the page behind it.
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Dev and test hook: for trying a picture by hand from the console — the
  // same path a frame from the server takes, so what you see is what he
  // would show.
  (window as unknown as { jarvisShow: (v: Visual) => void }).jarvisShow = (v) => api.show(v);

  return api;
}
