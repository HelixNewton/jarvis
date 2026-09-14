/**
 * The DISPLAY view — what JARVIS has put on the screen, kept.
 *
 * The panel beside the orb shows one picture at a time and comes down with a
 * click; this tab is where pictures go afterwards. Master-detail: everything
 * shown since JARVIS started on the left, newest first, and the chosen one
 * drawn on the right by the SAME renderer the orb page uses — so this is the
 * picture he showed, not a copy of it.
 *
 * There is no voice channel on this page, so nothing here asks: the renderer
 * is given no `onAsk` and draws no Ask button. Selecting a node, row or card
 * still works — it opens the inspector with the item's details, which is
 * useful on its own. Every string is model-written text and goes through
 * textContent — inside the renderer, and in the rows here.
 *
 * One VisualView at a time: paint() destroys the current one before it
 * repaints, so switching pictures (or a reconcile re-drawing the same one)
 * never leaves an observer or a timer behind — window.__vz.live stays at
 * most 1 here.
 */
import { listVisuals, ApiError } from "./api";
import { connectDisplayLive } from "./display-live";
import { createVisual, ago, type Visual, type VisualView } from "../visual-render";
import { el, row, pill, emptyState } from "./ui";

let started = false;
let visuals: Visual[] = [];
/** The visual on the JARVIS page right now, or null when the display is down. */
let currentId: string | null = null;
/** The one the reader has opened here. Follows `currentId` until they pick. */
let openId: string | null = null;
let unavailable = false;
/** The picture drawn in the detail pane right now. */
let view: VisualView | null = null;

const KIND_WORD: Record<string, string> = {
  diagram: "diagram", table: "table", steps: "steps", bars: "chart", cards: "cards",
};

export function initDisplay(): void {
  if (started) return;
  started = true;
  connectDisplayLive({
    onReconcile: () => void refreshDisplay(),
    onConnectionChange: () => {},
  });
  void refreshDisplay();
}

export async function refreshDisplay(): Promise<void> {
  try {
    const snap = await listVisuals();
    // A capture (ephemeral) is shown, not kept: never listed here even if
    // one ever arrives in the list, and never fetched as a picture.
    visuals = snap.visuals.filter((v) => !v.ephemeral);
    currentId = snap.current;
    unavailable = false;
    // A new picture on the screen is what the reader came to look at, unless
    // they have deliberately opened an older one that is still in the list.
    if (openId === null || !visuals.some((v) => v.id === openId)) {
      openId = currentId ?? visuals[0]?.id ?? null;
    }
    banner(null);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      unavailable = true;
      banner("The display isn't available — the server didn't answer /api/visuals.");
    } else {
      console.error("[display] fetch failed", e);
      banner("Cannot reach the JARVIS server.");
    }
  }
  paint();
}

function banner(text: string | null): void {
  const node = document.getElementById("display-banner");
  if (!node) return;
  node.hidden = text === null;
  node.textContent = text ?? "";
}

function dropView(): void {
  view?.destroy();
  view = null;
}

function paint(): void {
  const list = document.getElementById("display-list");
  const meta = document.getElementById("display-list-meta");
  const detail = document.getElementById("display-detail");
  const badge = document.getElementById("display-tab-badge");
  if (!list || !detail) return;

  if (meta) meta.textContent = visuals.length > 0 ? String(visuals.length) : "";
  if (badge) {
    badge.hidden = currentId === null;
    badge.textContent = "on screen";
  }

  // The JARVIS page can be showing a capture — current, but not in the
  // history, by design. The badge stays on; the pane says why the list has
  // no such row; the picture itself is never fetched into the dashboard.
  const captureUp = currentId !== null && !visuals.some((v) => v.id === currentId);
  const captureNote = (): HTMLElement =>
    el("p", "display-capture-note", "A capture is on the screen right now; captures are not kept here.");

  list.replaceChildren();
  if (visuals.length === 0) {
    if (!unavailable) {
      list.append(emptyState("Nothing shown yet. Ask JARVIS to show you something."));
    }
    dropView();
    detail.replaceChildren();
    if (captureUp) detail.append(captureNote());
    return;
  }

  for (const v of visuals) {
    const onScreen = v.id === currentId;
    const r = row({
      tone: onScreen ? "accent" : "idle",
      onOpen: () => { openId = v.id; paint(); },
      label: v.title,
    });
    // The master column is narrow: the title gets the room, and the kind
    // and age share the line under it rather than crowding it out.
    r.setTitle(v.title);
    r.setSub(`${KIND_WORD[v.kind] ?? v.kind} · ${ago(v.at)}`);
    if (onScreen) r.addTrail(pill("on screen", "accent"));
    r.root.classList.toggle("is-open", v.id === openId);
    list.append(r.root);
  }

  const open = visuals.find((v) => v.id === openId) ?? visuals[0];
  const pane = el("section", "panel display-pane");
  const head = el("header", "panel-head");
  head.append(el("h2", "panel-title",
                 open.id === currentId ? "On the screen now" : `Shown ${ago(open.at)}`));
  head.append(el("span", "panel-meta", open.source));
  const body = el("div", "panel-body");
  // The old view goes before the new one is drawn; the new one is mounted
  // only once it is in the document, so its first layout has a real width.
  dropView();
  const next = createVisual(open, {});
  view = next;
  body.append(next.element);
  pane.append(head, body);
  detail.replaceChildren(pane);
  if (captureUp) detail.prepend(captureNote());
  next.mount();
}
