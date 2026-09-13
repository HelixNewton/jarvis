/**
 * The display's renderer: one function that turns a validated visual spec
 * into DOM. Shared by the JARVIS page (visual.ts, the panel beside the orb)
 * and the dashboard's Display tab (dashboard/display.ts), so the two can
 * never draw the same picture differently.
 *
 * Everything here is built with createElement / createElementNS and
 * textContent. There is no innerHTML and there must never be one: a spec is
 * text a model wrote — or a device's own name off the network, or words off
 * a web page — so the only way any of it becomes a node is as the TEXT of
 * one. The server (visuals.py) has already bounded every string and list;
 * this file trusts the shape and never the content.
 *
 * Five kinds, one vocabulary:
 *   diagram  nodes and edges — radial around a hub, or a left-to-right flow
 *   table    columns and rows
 *   steps    an ordered list, or a timeline when the items carry a `when`
 *   bars     labelled quantities against a common maximum
 *   cards    a grid of title / value / note
 *
 * Clicking a node, a row, a step, a bar or a card asks JARVIS about it —
 * when the caller provides `onAsk`. The dashboard has no voice channel and
 * passes none, so nothing there pretends to be clickable.
 */
import "./visual-render.css";

export type Tone = "accent" | "ok" | "warn" | "bad" | "idle" | "dim";

export interface VisualNode { id: string; label: string; sub?: string; tone?: Tone; hub?: boolean }
export interface VisualEdge { from: string; to: string; label?: string }
export interface StepItem { title: string; detail?: string; when?: string; tone?: Tone }
export interface BarItem { label: string; value: number; tone?: Tone }
export interface CardItem { title: string; value: string; note?: string; tone?: Tone }

export type VisualKind = "diagram" | "table" | "steps" | "bars" | "cards";

export interface Visual {
  id: string;
  kind: VisualKind;
  title: string;
  caption?: string;
  /** Where it came from: "drawn by JARVIS", "drawn from a web page", … */
  source: string;
  /** Epoch seconds, set by the server. */
  at: number;
  // diagram
  nodes?: VisualNode[];
  edges?: VisualEdge[];
  layout?: "radial" | "flow";
  directed?: boolean;
  // table
  columns?: string[];
  rows?: string[][];
  // steps / bars / cards
  items?: StepItem[] | BarItem[] | CardItem[];
  numbered?: boolean;
  unit?: string;
  max?: number;
}

export interface RenderOptions {
  /** Called with the visible label of whatever was clicked. Absent = not clickable. */
  onAsk?: (label: string) => void;
  /** Draw the title block (title, caption, source). Default true. */
  header?: boolean;
}

const SVG = "http://www.w3.org/2000/svg";

// ── helpers ────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function svgText(x: number, y: number, text: string, className: string,
                 anchor: "start" | "middle" | "end" = "middle"): SVGTextElement {
  const t = svg("text", { x, y, "text-anchor": anchor });
  t.setAttribute("class", className);
  t.textContent = text;
  return t;
}

/** "just now" · "4m ago" · "3h ago" · "2d ago" — for the source line. */
export function ago(epochSec: number, nowSec = Date.now() / 1000): string {
  const s = Math.max(0, nowSec - epochSec);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Make `node` ask about `label` on click or Enter, if asking is possible. */
function askable(node: HTMLElement | SVGElement, label: string,
                 onAsk?: (label: string) => void): void {
  if (!onAsk) return;
  node.classList.add("vz-ask");
  node.setAttribute("role", "button");
  node.setAttribute("tabindex", "0");
  // A hover shows exactly what the click will say — the fixed frame plus the
  // visible label — so nothing is asked that was not shown.
  const asks = `Ask JARVIS: “Tell me more about ${label}”`;
  if (node instanceof HTMLElement) node.title = asks;
  else node.appendChild(Object.assign(document.createElementNS(SVG, "title"), { textContent: asks }));
  node.addEventListener("click", (e) => { e.stopPropagation(); onAsk(label); });
  node.addEventListener("keydown", (e: Event) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") { e.preventDefault(); onAsk(label); }
  });
}

function toneAttr(node: HTMLElement | SVGElement, tone?: Tone): void {
  if (tone) node.setAttribute("data-tone", tone);
}

// ── diagram ────────────────────────────────────────────────────────────────

interface Placed { node: VisualNode; x: number; y: number; r: number }

/** The hub: the node flagged as one, else the best-connected, else the first. */
function pickHub(nodes: VisualNode[], edges: VisualEdge[]): VisualNode | null {
  const flagged = nodes.find((n) => n.hub);
  if (flagged) return flagged;
  if (nodes.length < 3) return null;
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  let best: VisualNode | null = null;
  let bestDeg = 0;
  for (const n of nodes) {
    const d = degree.get(n.id) ?? 0;
    if (d > bestDeg) { best = n; bestDeg = d; }
  }
  // A hub is a node most of the others hang off; two of eight is not one.
  return best && bestDeg >= Math.max(2, Math.ceil((nodes.length - 1) * 0.6)) ? best : null;
}

function radialLayout(nodes: VisualNode[], edges: VisualEdge[], w: number, h: number): Placed[] {
  const hub = pickHub(nodes, edges);
  const ring = nodes.filter((n) => n !== hub);
  const cx = w / 2;
  const cy = h / 2;
  const placed: Placed[] = [];
  if (hub) placed.push({ node: hub, x: cx, y: cy, r: 26 });
  const twoRings = ring.length > 12;
  const outer = Math.min(w, h) / 2 - 62;
  ring.forEach((node, i) => {
    let radius = outer;
    let count = ring.length;
    let index = i;
    if (twoRings) {
      const innerCount = Math.floor(ring.length / 2);
      const isInner = i < innerCount;
      radius = isInner ? outer * 0.52 : outer;
      count = isInner ? innerCount : ring.length - innerCount;
      index = isInner ? i : i - innerCount;
    }
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count);
    placed.push({ node, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), r: 16 });
  });
  return placed;
}

/** Left-to-right layers: sources first, each node one column past the
 * furthest thing pointing at it. A cycle's members land after everything
 * that could be ordered. */
function flowLayout(nodes: VisualNode[], edges: VisualEdge[], colW: number, rowH: number,
                    margin: number): { placed: Placed[]; width: number; height: number } {
  const ids = nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    incoming.get(e.to)?.push(e.from);
    outgoing.get(e.from)?.push(e.to);
  }
  const level = new Map<string, number>();
  const pending = new Map(ids.map((id) => [id, incoming.get(id)!.length]));
  let frontier = ids.filter((id) => pending.get(id) === 0);
  for (const id of frontier) level.set(id, 0);
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const to of outgoing.get(id) ?? []) {
        level.set(to, Math.max(level.get(to) ?? 0, (level.get(id) ?? 0) + 1));
        pending.set(to, (pending.get(to) ?? 1) - 1);
        if (pending.get(to) === 0) next.push(to);
      }
    }
    frontier = next;
  }
  const deepest = Math.max(0, ...level.values());
  for (const id of ids) if (!level.has(id)) level.set(id, deepest + 1);

  const columns = new Map<number, VisualNode[]>();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    if (!columns.has(l)) columns.set(l, []);
    columns.get(l)!.push(n);
  }
  const levels = [...columns.keys()].sort((a, b) => a - b);
  const tallest = Math.max(...levels.map((l) => columns.get(l)!.length));
  const height = margin * 2 + tallest * rowH;
  const width = margin * 2 + levels.length * colW;
  const placed: Placed[] = [];
  levels.forEach((l, col) => {
    const members = columns.get(l)!;
    const top = (height - members.length * rowH) / 2;
    members.forEach((node, i) => {
      placed.push({ node, x: margin + col * colW + colW / 2, y: top + i * rowH + rowH / 2, r: 0 });
    });
  });
  return { placed, width, height };
}

function renderDiagram(v: Visual, opts: RenderOptions): HTMLElement {
  const nodes = v.nodes ?? [];
  const edges = v.edges ?? [];
  const host = el("div", "vz-diagram");
  const layout = v.layout ?? (v.directed ? "flow" : "radial");
  const directed = Boolean(v.directed);

  let placed: Placed[];
  let width = 640;
  let height = nodes.length > 12 ? 560 : 460;
  const boxW = 150;
  if (layout === "flow") {
    const laid = flowLayout(nodes, edges, boxW + 70, 64, 30);
    placed = laid.placed;
    width = Math.max(320, laid.width);
    height = Math.max(160, laid.height);
  } else {
    placed = radialLayout(nodes, edges, width, height);
  }
  const at = new Map(placed.map((p) => [p.node.id, p]));

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  root.setAttribute("class", `vz-svg vz-svg--${layout}`);
  const defs = svg("defs");
  const marker = svg("marker", {
    id: `vz-arrow-${v.id}`, viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse",
  });
  const tip = svg("path", { d: "M 0 0 L 10 5 L 0 10 z" });
  tip.setAttribute("class", "vz-arrow");
  marker.append(tip);
  defs.append(marker);
  root.append(defs);

  // Edges first, so nodes paint over them.
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    let x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    if (layout === "flow") {
      x1 = a.x + boxW / 2; x2 = b.x - boxW / 2;
    } else {
      // Stop at the rim of each circle so an arrowhead is not buried.
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      x1 = a.x + (dx / len) * a.r; y1 = a.y + (dy / len) * a.r;
      x2 = b.x - (dx / len) * b.r; y2 = b.y - (dy / len) * b.r;
    }
    const line = svg("line", { x1, y1, x2, y2 });
    line.setAttribute("class", "vz-edge");
    if (directed) line.setAttribute("marker-end", `url(#vz-arrow-${v.id})`);
    root.append(line);
    if (e.label) {
      root.append(svgText((x1 + x2) / 2, (y1 + y2) / 2 - 4, e.label, "vz-edge-label"));
    }
  }

  for (const p of placed) {
    const g = svg("g");
    g.setAttribute("class", `vz-node${p.node.hub || p.r > 20 ? " vz-node--hub" : ""}`);
    g.setAttribute("data-id", p.node.id);
    toneAttr(g, p.node.tone);
    if (layout === "flow") {
      const h = p.node.sub ? 46 : 32;
      const rect = svg("rect", { x: p.x - boxW / 2, y: p.y - h / 2, width: boxW, height: h, rx: 3 });
      rect.setAttribute("class", "vz-node-shape");
      g.append(rect);
      g.append(svgText(p.x, p.y + (p.node.sub ? -3 : 4), p.node.label, "vz-node-label"));
      if (p.node.sub) g.append(svgText(p.x, p.y + 13, p.node.sub, "vz-node-sub"));
    } else {
      const circle = svg("circle", { cx: p.x, cy: p.y, r: p.r });
      circle.setAttribute("class", "vz-node-shape");
      g.append(circle);
      // Labels sit outward from the centre so neighbours on the ring do not
      // write over each other; the hub's sits underneath.
      const cx = width / 2, cy = height / 2;
      const dx = p.x - cx, dy = p.y - cy;
      let anchor: "start" | "middle" | "end" = "middle";
      let lx = p.x, ly = p.y + p.r + 14;
      if (p.r <= 20 && Math.abs(dx) > 40) {
        anchor = dx > 0 ? "start" : "end";
        lx = p.x + (dx > 0 ? p.r + 6 : -(p.r + 6));
        ly = p.y + 4;
      } else if (p.r <= 20 && dy < -40) {
        // Above the circle, with room for the sub-label under the label
        // and both of them still clear of the rim.
        ly = p.y - p.r - (p.node.sub ? 20 : 8);
      }
      g.append(svgText(lx, ly, p.node.label, "vz-node-label", anchor));
      if (p.node.sub) g.append(svgText(lx, ly + 13, p.node.sub, "vz-node-sub", anchor));
    }
    askable(g, p.node.label, opts.onAsk);
    root.append(g);
  }
  host.append(root);
  return host;
}

// ── table ──────────────────────────────────────────────────────────────────

function renderTable(v: Visual, opts: RenderOptions): HTMLElement {
  const wrap = el("div", "vz-table-wrap");
  const table = el("table", "vz-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const c of v.columns ?? []) hr.append(el("th", undefined, c));
  thead.append(hr);
  const tbody = el("tbody");
  for (const cells of v.rows ?? []) {
    const tr = el("tr");
    cells.forEach((cell, i) => tr.append(el(i === 0 ? "th" : "td", undefined, cell)));
    if (cells[0]) askable(tr, cells[0], opts.onAsk);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

// ── steps / timeline ───────────────────────────────────────────────────────

function renderSteps(v: Visual, opts: RenderOptions): HTMLElement {
  const items = (v.items ?? []) as StepItem[];
  const timeline = items.some((s) => s.when);
  // The server settles `numbered`; a spec that skipped it (a hand-fed one
  // from the console) gets the same default it would have been given.
  const numbered = v.numbered ?? !timeline;
  const list = el(numbered ? "ol" : "ul", `vz-steps${timeline ? " vz-steps--timeline" : ""}`);
  for (const step of items) {
    const li = el("li", "vz-step");
    toneAttr(li, step.tone);
    if (timeline) li.append(el("span", "vz-step-when", step.when ?? ""));
    const body = el("div", "vz-step-body");
    body.append(el("div", "vz-step-title", step.title));
    if (step.detail) body.append(el("div", "vz-step-detail", step.detail));
    li.append(body);
    askable(li, step.title, opts.onAsk);
    list.append(li);
  }
  return list;
}

// ── bars ───────────────────────────────────────────────────────────────────

function fmtValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function renderBars(v: Visual, opts: RenderOptions): HTMLElement {
  const items = (v.items ?? []) as BarItem[];
  const top = v.max ?? Math.max(...items.map((b) => Math.abs(b.value)), 0);
  const host = el("div", "vz-bars");
  for (const b of items) {
    const rowEl = el("div", "vz-bar");
    toneAttr(rowEl, b.tone);
    rowEl.append(el("span", "vz-bar-label", b.label));
    const track = el("div", "vz-bar-track");
    const fill = el("div", "vz-bar-fill");
    const pct = top > 0 ? Math.min(100, (Math.abs(b.value) / top) * 100) : 0;
    fill.style.width = `${pct}%`;
    track.append(fill);
    rowEl.append(track);
    rowEl.append(el("span", "vz-bar-value", v.unit ? `${fmtValue(b.value)} ${v.unit}` : fmtValue(b.value)));
    askable(rowEl, b.label, opts.onAsk);
    host.append(rowEl);
  }
  return host;
}

// ── cards ──────────────────────────────────────────────────────────────────

function renderCards(v: Visual, opts: RenderOptions): HTMLElement {
  const items = (v.items ?? []) as CardItem[];
  const grid = el("div", "vz-cards");
  for (const c of items) {
    const card = el("div", "vz-card");
    toneAttr(card, c.tone);
    card.append(el("div", "vz-card-title", c.title));
    card.append(el("div", "vz-card-value", c.value));
    if (c.note) card.append(el("div", "vz-card-note", c.note));
    askable(card, c.title, opts.onAsk);
    grid.append(card);
  }
  return grid;
}

// ── the one entry point ────────────────────────────────────────────────────

export function renderVisual(v: Visual, opts: RenderOptions = {}): HTMLElement {
  const root = el("div", "vz");
  root.setAttribute("data-kind", v.kind);
  root.setAttribute("data-id", v.id);

  if (opts.header !== false) {
    const head = el("header", "vz-head");
    head.append(el("h2", "vz-title", v.title));
    if (v.caption) head.append(el("p", "vz-caption", v.caption));
    root.append(head);
  }

  let body: HTMLElement;
  switch (v.kind) {
    case "diagram": body = renderDiagram(v, opts); break;
    case "table": body = renderTable(v, opts); break;
    case "steps": body = renderSteps(v, opts); break;
    case "bars": body = renderBars(v, opts); break;
    case "cards": body = renderCards(v, opts); break;
    default: body = el("div", "vz-unknown", "JARVIS drew something this page cannot show.");
  }
  body.classList.add("vz-body");
  root.append(body);

  if (opts.header !== false) {
    // The provenance line. It is part of the picture: what shaped it is
    // stated under it, never left for the viewer to assume.
    const foot = el("footer", "vz-source");
    foot.append(el("span", "vz-source-text", v.source));
    foot.append(el("span", "vz-source-sep", "·"));
    foot.append(el("time", "vz-source-when", ago(v.at)));
    if (opts.onAsk) foot.append(el("span", "vz-source-hint", "click anything to ask about it"));
    root.append(foot);
  }
  return root;
}
