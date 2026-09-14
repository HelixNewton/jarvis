/**
 * The display's renderer: turns a validated visual spec into DOM. Shared by
 * the JARVIS page (visual.ts, the panel beside the orb) and the dashboard's
 * Display tab (dashboard/display.ts), so the two can never draw the same
 * picture differently.
 *
 * Everything here is built with createElement / createElementNS and
 * textContent. There is no innerHTML and there must never be one: a spec is
 * text a model wrote — or a device's own name off the network, or words off
 * a web page — so the only way any of it becomes a node is as the TEXT of
 * one. Nothing from a spec goes into a style, an on* attribute, an element
 * name or a class name; the only attributes a spec value reaches are
 * `data-id`, `data-tone` and `data-icon`, the last two after a check against
 * a fixed set. The ONLY strings that ever reach a `src` are the four the
 * builders in visual/embed.ts document: video.embed and video.media (built
 * or normalised by the server), web.url (normalised by the server), the
 * OpenStreetMap URL built here from map.lat/lon/zoom NUMBERS, and the data:
 * URL built from image.png. The server (visuals.py) has already bounded every
 * string and list; this file trusts the shape and never the content.
 *
 * Twelve kinds, one vocabulary:
 *   diagram  nodes and edges — radial around a hub, or a left-to-right flow
 *   table    columns and rows
 *   steps    an ordered list, or a timeline when the items carry a `when`
 *   bars     labelled quantities against a common zero baseline
 *   cards    a grid of title / value / note
 *   text     a Markdown body through the dashboard's safe renderer
 *   chart    line / area series over an x axis, or a pie      (visual/chart.ts)
 *   map      an OpenStreetMap frame at a point               (visual/embed.ts)
 *   video    a YouTube / Vimeo player or a media file         (visual/embed.ts)
 *   web      a page in a sandboxed frame                      (visual/embed.ts)
 *   image    a capture the server took                        (visual/embed.ts)
 *   scene    primitives in a Three.js canvas                  (visual/scene.ts)
 *
 * INTERACTION. Every item of a kind that has items is a control: a click (or
 * Enter / Space — they are native buttons) SELECTS it and shows an inspector
 * or an ask bar with its label, sub and details. Only when the caller passes
 * `onAsk` does that panel also carry a button reading "Ask JARVIS about
 * <label>", and only that button asks. Kinds with nothing to select (text,
 * map, video, web, a scene before a click) show one such button about the
 * visual's title; an image never offers one. Selecting sends nothing. Escape
 * is the page's business: it calls clearSelection().
 *
 * LIFECYCLE. createVisual() builds detached DOM and measures nothing.
 * mount() — after the element is in the document — lays out from the
 * container's real width, starts observers and (for a scene) the GPU;
 * destroy() disconnects, cancels, disposes and clears all of it.
 * window.__vz.live counts views mounted and not yet destroyed.
 */
import "./visual-render.css";
import {
  button, el, makeSelection, svg, toneAttr, fmtValue,
  type KindParts, type NodeDetail, type RenderOptions, type Selectable, type Selection, type Tone,
} from "./visual/shared";
import { buildText } from "./visual/text";
import { buildChart, type ChartSeries } from "./visual/chart";
import { buildImage, buildMap, buildVideo, buildWeb } from "./visual/embed";
import { buildScene, type SceneObject } from "./visual/scene";

export type { Tone, RenderOptions, NodeDetail } from "./visual/shared";
export type { ChartSeries } from "./visual/chart";
export type { SceneObject, SceneShape } from "./visual/scene";

export type NodeIcon = "device" | "gateway" | "computer" | "network";

export interface VisualNode {
  id: string; label: string; sub?: string; tone?: Tone; hub?: boolean;
  icon?: NodeIcon; details?: NodeDetail[];
}
export interface VisualEdge { from: string; to: string; label?: string }
export interface StepItem { title: string; detail?: string; when?: string; tone?: Tone }
export interface BarItem { label: string; value: number; tone?: Tone }
export interface CardItem { title: string; value: string; note?: string; tone?: Tone }

export type VisualKind =
  | "diagram" | "table" | "steps" | "bars" | "cards"
  | "text" | "chart" | "map" | "video" | "web" | "scene" | "image";

export interface Visual {
  id: string;
  kind: VisualKind;
  title: string;
  caption?: string;
  /** Where it came from: "drawn by JARVIS", "drawn from a web page", … */
  source: string;
  /** Epoch seconds, set by the server: when the picture was drawn. */
  at: number;
  /** Epoch seconds, set by the server: when the data under it was observed
   *  (a network sweep finishing). Shown as "observed …" instead of "drawn …". */
  observed_at?: number;
  /** What the picture is a picture of; "network" adds a device list, a
   *  legend and the overflow line. */
  semantic?: "network";
  /** Set by the server when a network map left devices out. */
  overflow?: { discovered: number; shown: number };
  /** Set by the server on a capture: current while up, never in the history. */
  ephemeral?: boolean;
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
  // text
  body?: string;
  // chart
  type?: "line" | "area" | "pie";
  x?: string[];
  series?: ChartSeries[];
  y?: { min?: number; max?: number };
  // map
  lat?: number;
  lon?: number;
  zoom?: number;
  label?: string;
  // video / web
  url?: string;
  embed?: string;
  media?: string;
  // scene
  objects?: SceneObject[];
  autorotate?: boolean;
  grid?: boolean;
  // image
  png?: string;
  width?: number;
  height?: number;
}

export interface VisualView {
  /** The root element, with data-kind and data-id. Detached until you insert it. */
  element: HTMLElement;
  /** Start measuring and laying out. Idempotent. Call after inserting. */
  mount(): void;
  /** Stop everything: observers, frames, timers, listeners, GPU resources. */
  destroy(): void;
  /** Drop the selection. Returns whether there was one. */
  clearSelection(): boolean;
}

/** The one fixed sentence under a network map. */
const NETWORK_LEGEND = "Lines show devices on the same subnet, not wiring or traffic.";

/** This file's own glyphs, 16×16, stroked. Keyed by the fixed icon enum;
 *  an icon value outside it draws the plain dot. Nothing from a spec is in
 *  here. */
const ICONS: Record<NodeIcon, string[]> = {
  device: [
    "M3 4.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z",
    "M5 8h.01", "M8 8h.01",
  ],
  gateway: [
    "M2 9.5h12v3.5H2z", "M4.5 9.5V6", "M11.5 9.5V6", "M4 11.25h.01", "M6.5 11.25h.01",
  ],
  computer: ["M3 3.5h10v6.5H3z", "M1.5 12.5h13"],
  network: [
    "M6.5 2h3v3h-3z", "M1.5 11h3v3h-3z", "M11.5 11h3v3h-3z",
    "M8 5v2.5", "M8 7.5 3 11", "M8 7.5l5 3.5",
  ],
};

// ── the live counter ──────────────────────────────────────────────────────

interface VzWindow { __vz?: { live: number } }
function counter(): { live: number } {
  const w = window as unknown as VzWindow;
  if (!w.__vz) w.__vz = { live: 0 };
  return w.__vz;
}
if (typeof window !== "undefined") counter();

// ── helpers ────────────────────────────────────────────────────────────────

/** "just now" · "4m ago" · "3h ago" · "2d ago" — for the source line. */
export function ago(epochSec: number, nowSec = Date.now() / 1000): string {
  const s = Math.max(0, nowSec - epochSec);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** Sorted copy, ids compared numerically where they contain numbers, so
 *  "192.168.1.2" comes before "192.168.1.10" and positions never depend on
 *  the order a scan happened to report devices in. */
function byId<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

// ── diagram: geometry ─────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }
interface Sized { id: string; w: number; h: number }

const PAD = 24;         // outer padding inside the graph
const GAP = 16;         // clear space required between any two cards
const SIDE_GAP = 28;    // sides: room between the hub and a card beside it
const COL_GAP = 64;     // flow: room between columns for edges and their labels
const ROW_GAP = 14;     // flow: between cards in a column (or a line)
const LAYER_GAP = 56;   // flow, top-to-bottom: between layers
const BACK_ROOM = 64;   // flow, top-to-bottom: room on the right for back-edges
const BAND_GAP = 40;    // band: between the hub band and the first row of cards
const LIST_BELOW = 520; // narrower than this, the diagram is a list
const SIDES_UP_TO = 4;  // this many peers or fewer sit beside the hub
const GRID_ABOVE = 12;  // more peers than this and the rings are grid rings

/** How the graph was arranged; on `data-arrangement` for the stylesheet and tests. */
type Arrangement = "sides" | "ring" | "band" | "grid" | "columns" | "lines";

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap &&
         a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** The hub: the node flagged as one, else the best-connected, else none. */
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

/** One to four peers: beside the hub on a horizontal line, the first on the
 *  right, the second on the left, the third and fourth under those — two a
 *  side, stacked a GAP apart and centred on the hub's line. Never a vertical
 *  line through the hub. Without a hub, a single row. Returns null when the
 *  width cannot hold hub and cards side by side; the ring then takes over. */
function sidesRing(hub: Sized | null, peers: Sized[], width: number): Map<string, Rect> | null {
  const rects = new Map<string, Rect>();
  const cardW = peers[0]?.w ?? 180;
  const hubW = hub?.w ?? 0, hubH = hub?.h ?? 0;
  const cx = width / 2;
  if (!hub) {
    const rowW = peers.length * cardW + (peers.length - 1) * GAP * 2;
    if (rowW + 2 * PAD > width) return null;
    let x = cx - rowW / 2;
    for (const p of peers) { rects.set(p.id, { x, y: -p.h / 2, w: p.w, h: p.h }); x += cardW + GAP * 2; }
    return rects;
  }
  if (hubW + 2 * cardW + 2 * SIDE_GAP + 2 * PAD > width) return null;
  rects.set(hub.id, { x: cx - hubW / 2, y: -hubH / 2, w: hubW, h: hubH });
  const sides: Sized[][] = [[], []];                          // right, left
  peers.forEach((p, i) => sides[i % 2].push(p));
  sides.forEach((side, s) => {
    const x = s === 0 ? cx + hubW / 2 + SIDE_GAP : cx - hubW / 2 - SIDE_GAP - cardW;
    if (side.length === 1) {
      rects.set(side[0].id, { x, y: -side[0].h / 2, w: side[0].w, h: side[0].h });
    } else if (side.length === 2) {
      const [upper, lower] = side;
      rects.set(upper.id, { x, y: -GAP / 2 - upper.h, w: upper.w, h: upper.h });
      rects.set(lower.id, { x, y: GAP / 2, w: lower.w, h: lower.h });
    }
  });
  return rects;
}

/** Five to twelve peers: one ring of an ellipse around the hub. The
 *  horizontal radius comes from the width, the vertical from the card sizes;
 *  then every card is pushed straight up (upper half) or down (lower half)
 *  until it is clear of the hub and of every card already settled. Height is
 *  free — the panel scrolls — so nothing is shrunk or clipped, and on a
 *  narrow panel the ring simply becomes two columns beside the hub. */
function ellipseRing(hub: Sized | null, peers: Sized[], width: number): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const n = peers.length;
  const cardW = peers[0]?.w ?? 180;
  const hubW = hub?.w ?? 0, hubH = hub?.h ?? 0;
  const peerH = Math.max(44, ...peers.map((p) => p.h));
  const cx = width / 2;
  const rxMax = Math.max(0, (width - 2 * PAD - cardW) / 2);
  const rx = Math.min(rxMax, Math.max((hubW + cardW) / 2 + GAP, n * 40));
  const ry = Math.max(hubH / 2 + peerH / 2 + GAP, rx * 0.6);
  const step = (2 * Math.PI) / Math.max(1, n);
  // A peer level with the hub needs the whole rx to clear it; when rx cannot
  // give that, start half a step round so none is.
  let start = -Math.PI / 2;
  if (hub && rx < (hubW + cardW) / 2 + GAP &&
      peers.some((_, i) => Math.abs(Math.sin(start + i * step)) < 0.01)) start += step / 2;

  const settled: Rect[] = [];
  if (hub) {
    const r = { x: cx - hubW / 2, y: -hubH / 2, w: hubW, h: hubH };
    rects.set(hub.id, r);
    settled.push(r);
  }
  const movers = peers.map((p, i) => {
    const a = start + i * step;
    const s = Math.sin(a);
    return { p, r: { x: cx + rx * Math.cos(a) - p.w / 2, y: ry * s - p.h / 2, w: p.w, h: p.h },
             up: Math.abs(s) < 0.01 ? i % 2 === 0 : s < 0 };
  });
  // Nearest the middle first, so the cards level with the hub stay put and
  // the ones above and below give way outward.
  const order = [...movers].sort((a, b) => Math.abs(a.r.y + a.r.h / 2) - Math.abs(b.r.y + b.r.h / 2));
  for (const m of order) {
    for (;;) {
      const hit = settled.find((f) => overlaps(f, m.r, GAP));
      if (!hit) break;
      m.r.y = m.up ? hit.y - m.r.h - GAP : hit.y + hit.h + GAP;
    }
    settled.push(m.r);
    rects.set(m.p.id, m.r);
  }
  return rects;
}

/** The columns a grid of `cardW` cards gets in `width`. */
function gridColumns(width: number, cardW: number): number {
  return Math.max(1, Math.floor((width - 2 * PAD + GAP) / (cardW + GAP)));
}

/** What the band layout hands the edge router: where each card's gutter
 *  runs and where the band ends. */
interface BandMeta { hubId: string; bandBottom: number; gutterX: Map<string, number> }

/** More than twelve peers WITH a hub: the hub as a band across the top and
 *  the peers in a grid under it, row by row in id order, as many columns as
 *  the width allows. Edges are routed down the gutter to the LEFT of each
 *  column and into the card's left edge, so no line crosses a card — the
 *  paths of one column share their trunk, which is what a subnet is. The
 *  band reaches over the outermost gutters so every trunk starts on it. */
function gridBand(hub: Sized, peers: Sized[], width: number): { rects: Map<string, Rect>; meta: BandMeta } {
  const cardW = peers[0]?.w ?? 180;
  const cell = cardW + GAP;
  const ncols = gridColumns(width, cardW);
  const gridW = ncols * cell - GAP;
  const offsetX = (width - gridW) / 2;
  const rects = new Map<string, Rect>();
  rects.set(hub.id, { x: offsetX - GAP, y: PAD, w: gridW + 2 * GAP, h: hub.h });
  const rowH = new Map<number, number>();
  peers.forEach((p, k) => {
    const row = Math.floor(k / ncols);
    rowH.set(row, Math.max(rowH.get(row) ?? 44, p.h));
  });
  const rowY = new Map<number, number>();
  let y = PAD + hub.h + BAND_GAP;
  for (const row of [...rowH.keys()].sort((a, b) => a - b)) { rowY.set(row, y); y += rowH.get(row)! + GAP; }
  const gutterX = new Map<string, number>();
  peers.forEach((p, k) => {
    const col = k % ncols, row = Math.floor(k / ncols);
    rects.set(p.id, {
      x: offsetX + col * cell + (cardW - p.w) / 2,
      y: rowY.get(row)! + (rowH.get(row)! - p.h) / 2, w: p.w, h: p.h,
    });
    gutterX.set(p.id, offsetX + col * cell - GAP / 2);
  });
  return { rects, meta: { hubId: hub.id, bandBottom: PAD + hub.h, gutterX } };
}

/** More than twelve nodes and NO hub: rings of grid cells around the
 *  middle — eight in the first, sixteen in the second, and so on — as many
 *  columns wide as the width allows, growing downward and upward past that.
 *  Cells never overlap and the same ids always land in the same cells. */
function gridRings(peers: Sized[], width: number): Map<string, Rect> {
  const cardW = peers[0]?.w ?? 180;
  const cell = cardW + GAP;
  let ncols = gridColumns(width, cardW);
  if (ncols % 2 === 0) ncols -= 1;
  const half = (ncols - 1) / 2;

  const at = new Map<string, [number, number]>();
  let left = peers.slice();
  for (let r = 1; left.length; r++) {
    const cells: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -Math.min(r, half); dx <= Math.min(r, half); dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push([dx, dy]);
      }
    }
    if (!cells.length) break;                                  // cannot happen: dx = 0 always fits
    const clockwise = (c: [number, number]) => (Math.atan2(c[0], -c[1]) + 2 * Math.PI) % (2 * Math.PI);
    cells.sort((a, b) => clockwise(a) - clockwise(b));
    const take = Math.min(left.length, cells.length);
    for (let i = 0; i < take; i++) {
      const c = cells[take === cells.length ? i : Math.floor((i * cells.length) / take)];
      at.set(left[i].id, c);
    }
    left = left.slice(take);
  }

  const sized = new Map<string, Sized>(peers.map((p) => [p.id, p]));
  const rowH = new Map<number, number>();
  for (const [id, [, dy]] of at) rowH.set(dy, Math.max(rowH.get(dy) ?? 44, sized.get(id)!.h));
  const rows = [...rowH.keys()].sort((a, b) => a - b);
  const rowY = new Map<number, number>();
  let y = PAD;
  for (const dy of rows) { rowY.set(dy, y); y += rowH.get(dy)! + GAP; }
  const offsetX = (width - (ncols * cell - GAP)) / 2;
  const rects = new Map<string, Rect>();
  for (const [id, [dx, dy]] of at) {
    const s = sized.get(id)!;
    const top = rowY.get(dy)! + (rowH.get(dy)! - s.h) / 2;
    rects.set(id, { x: offsetX + (dx + half) * cell + (cardW - s.w) / 2, y: top, w: s.w, h: s.h });
  }
  return rects;
}

/** Radial, returned with the height used: the top card at the padding. */
function radialPlace(hub: Sized | null, peers: Sized[], width: number):
    { rects: Map<string, Rect>; height: number; arrangement: Arrangement; band: BandMeta | null } {
  let rects: Map<string, Rect> | null = null;
  let arrangement: Arrangement;
  let band: BandMeta | null = null;
  if (peers.length > GRID_ABOVE) {
    if (hub) { ({ rects, meta: band } = gridBand(hub, peers, width)); arrangement = "band"; }
    else { rects = gridRings(peers, width); arrangement = "grid"; }
  } else {
    if (peers.length <= SIDES_UP_TO) rects = sidesRing(hub, peers, width);
    arrangement = rects ? "sides" : "ring";
    if (!rects) rects = ellipseRing(hub, peers, width);
  }
  let minY = Infinity, maxY = -Infinity;
  for (const r of rects.values()) { minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.h); }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }
  const dy = PAD - minY;
  for (const r of rects.values()) r.y += dy;
  if (band) band = { ...band, bandBottom: band.bandBottom + dy };
  return { rects, height: Math.ceil(maxY - minY + 2 * PAD), arrangement, band };
}

/** Layers: sources first, each node one layer past the furthest thing
 *  pointing at it. A cycle is broken at its first member (in node order),
 *  which continues the ordering, so every node lands in a layer and the
 *  edges that point backwards are drawn as curves. Nodes with no edge at
 *  all share a layer of their own after everything. */
function flowLevels(nodes: VisualNode[], edges: VisualEdge[]): Map<string, number> {
  const ids = nodes.map((n) => n.id);
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const touched = new Set<string>();
  for (const e of edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to)!.push(e.from);
    outgoing.get(e.from)!.push(e.to);
    touched.add(e.from); touched.add(e.to);
  }
  const level = new Map<string, number>();
  const placed = new Set<string>();
  const order = ids.filter((id) => touched.has(id));
  const pending = new Map(order.map((id) => [id, incoming.get(id)!.length]));
  let frontier = order.filter((id) => pending.get(id) === 0);
  for (const id of frontier) { level.set(id, 0); placed.add(id); }
  for (;;) {
    while (frontier.length) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const to of outgoing.get(id) ?? []) {
          if (placed.has(to)) continue;                       // a back-edge
          level.set(to, Math.max(level.get(to) ?? 0, (level.get(id) ?? 0) + 1));
          pending.set(to, (pending.get(to) ?? 1) - 1);
          if (pending.get(to) === 0) { next.push(to); placed.add(to); }
        }
      }
      frontier = next;
    }
    const left = order.find((id) => !placed.has(id));
    if (left === undefined) break;
    // Everything unplaced is in or behind a cycle: cut it here.
    const deepest = placed.size ? Math.max(...[...placed].map((id) => level.get(id) ?? 0)) : -1;
    if (!level.has(left)) level.set(left, deepest + 1);
    placed.add(left);
    frontier = [left];
  }
  const deepest = level.size ? Math.max(...level.values()) : -1;
  for (const id of ids) if (!level.has(id)) level.set(id, deepest + 1);
  return level;
}

/** Flow, placed: left-to-right columns when they fit the width, else
 *  top-to-bottom layers with each layer's cards in lines of as many as fit.
 *  Never wider than the panel, so nothing scrolls sideways. */
function flowPlace(nodes: VisualNode[], levels: Map<string, number>, sized: Map<string, Sized>,
                   width: number, cardW: number, hasBack: boolean):
    { rects: Map<string, Rect>; height: number; vertical: boolean } {
  const layers = new Map<number, VisualNode[]>();
  for (const n of nodes) {
    const l = levels.get(n.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  }
  const keys = [...layers.keys()].sort((a, b) => a - b);
  const rects = new Map<string, Rect>();
  const contentW = keys.length * cardW + Math.max(0, keys.length - 1) * COL_GAP;
  if (contentW + 2 * PAD <= width) {
    const colHeights = keys.map((k) => layers.get(k)!.reduce((s, n, i) => s + sized.get(n.id)!.h + (i ? ROW_GAP : 0), 0));
    const tallest = Math.max(0, ...colHeights);
    const offsetX = (width - contentW) / 2;
    keys.forEach((k, col) => {
      let y = PAD + (tallest - colHeights[col]) / 2;
      for (const n of layers.get(k)!) {
        const s = sized.get(n.id)!;
        rects.set(n.id, { x: offsetX + col * (cardW + COL_GAP), y, w: cardW, h: s.h });
        y += s.h + ROW_GAP;
      }
    });
    return { rects, height: 2 * PAD + tallest + (hasBack ? 72 : 0), vertical: false };
  }
  const inner = width - 2 * PAD - (hasBack ? BACK_ROOM : 0);
  const perLine = Math.max(1, Math.floor((inner + GAP) / (cardW + GAP)));
  let y = PAD;
  keys.forEach((k, i) => {
    const members = layers.get(k)!;
    for (let start = 0; start < members.length; start += perLine) {
      const line = members.slice(start, start + perLine);
      const lineW = line.length * cardW + (line.length - 1) * GAP;
      const lineH = Math.max(...line.map((n) => sized.get(n.id)!.h));
      const x0 = PAD + (inner - lineW) / 2;
      line.forEach((n, j) => {
        const s = sized.get(n.id)!;
        rects.set(n.id, { x: x0 + j * (cardW + GAP), y: y + (lineH - s.h) / 2, w: cardW, h: s.h });
      });
      y += lineH + ROW_GAP;
    }
    y += i < keys.length - 1 ? LAYER_GAP - ROW_GAP : -ROW_GAP;
  });
  return { rects, height: y + PAD, vertical: true };
}

/** A cubic's midpoint, for the label. */
function cubicMid(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): [number, number] {
  return [(p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8, (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8];
}

function cubic(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number]): string {
  return `M ${p0[0]} ${p0[1]} C ${p1[0]} ${p1[1]}, ${p2[0]} ${p2[1]}, ${p3[0]} ${p3[1]}`;
}

/** Where a line from the centre of `r` towards (tx, ty) leaves the rect. */
function exit(r: Rect, tx: number, ty: number): [number, number] {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const t = Math.min(dx !== 0 ? (r.w / 2 + 2) / Math.abs(dx) : Infinity,
                     dy !== 0 ? (r.h / 2 + 2) / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/** Band mode: from the band straight down the card's gutter, then into its
 *  left edge — or the reverse when the edge points at the hub. Null for an
 *  edge that does not touch the hub (drawn straight, as before). */
function bandPath(e: VisualEdge, rects: Map<string, Rect>, band: BandMeta):
    { d: string; mid: [number, number] } | null {
  const peerId = e.from === band.hubId ? e.to : e.to === band.hubId ? e.from : null;
  if (peerId === null) return null;
  const peer = rects.get(peerId);
  const gx = band.gutterX.get(peerId);
  if (!peer || gx === undefined) return null;
  const cy = peer.y + peer.h / 2;
  const top = band.bandBottom + 2;
  const d = e.from === band.hubId
    ? `M ${gx} ${top} V ${cy} H ${peer.x - 2}`
    : `M ${peer.x - 2} ${cy} H ${gx} V ${top}`;
  return { d, mid: [gx, (top + cy) / 2] };
}

/** The path and label point for one edge. `levels` is null for radial. */
function edgePath(a: Rect, b: Rect, levels: Map<string, number> | null, e: VisualEdge,
                  vertical: boolean, fan: number): { d: string; mid: [number, number]; back: boolean } {
  if (!levels) {
    const [x1, y1] = exit(a, b.x + b.w / 2, b.y + b.h / 2);
    const [x2, y2] = exit(b, a.x + a.w / 2, a.y + a.h / 2);
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, mid: [(x1 + x2) / 2, (y1 + y2) / 2], back: false };
  }
  const la = levels.get(e.from) ?? 0, lb = levels.get(e.to) ?? 0;
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  let p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number];
  let back = false;
  if (la < lb) {
    if (vertical) {
      p0 = [acx, a.y + a.h]; p3 = [bcx, b.y];
      const k = Math.max(16, (p3[1] - p0[1]) / 2);
      p1 = [p0[0], p0[1] + k]; p2 = [p3[0], p3[1] - k];
    } else {
      p0 = [a.x + a.w, acy]; p3 = [b.x, bcy];
      const k = Math.max(16, (p3[0] - p0[0]) / 2);
      p1 = [p0[0] + k, p0[1]]; p2 = [p3[0] - k, p3[1]];
    }
  } else if (la === lb) {
    // The same layer: an arc off the right (columns) or off the top (lines).
    back = true;
    const bow = 36 + 10 * (fan % 3);
    if (vertical) {
      p0 = [acx, a.y]; p3 = [bcx, b.y];
      p1 = [p0[0], p0[1] - bow]; p2 = [p3[0], p3[1] - bow];
    } else {
      p0 = [a.x + a.w, acy]; p3 = [b.x + b.w, bcy];
      p1 = [p0[0] + bow, p0[1]]; p2 = [p3[0] + bow, p3[1]];
    }
  } else {
    // Backwards: under the columns, or out to the right of the lines.
    back = true;
    if (vertical) {
      p0 = [a.x + a.w, acy]; p3 = [b.x + b.w, bcy];
      const bow = 32 + 0.1 * Math.abs(acy - bcy) + 10 * (fan % 3);
      p1 = [p0[0] + bow, p0[1]]; p2 = [p3[0] + bow, p3[1]];
    } else {
      p0 = [acx, a.y + a.h]; p3 = [bcx, b.y + b.h];
      const bow = 28 + 0.12 * Math.abs(acx - bcx) + 10 * (fan % 3);
      p1 = [p0[0], p0[1] + bow]; p2 = [p3[0], p3[1] + bow];
    }
  }
  return { d: cubic(p0, p1, p2, p3), mid: cubicMid(p0, p1, p2, p3), back };
}

// ── diagram: DOM ──────────────────────────────────────────────────────────

let arrowSeq = 0;

function nodeCard(n: VisualNode, hub: boolean): HTMLButtonElement {
  const card = button(`vz-node${hub ? " vz-node--hub" : ""}`);
  card.setAttribute("data-id", n.id);
  toneAttr(card, n.tone);
  const glyph = el("span", "vz-node-icon");
  glyph.setAttribute("aria-hidden", "true");
  const paths = n.icon !== undefined && Object.prototype.hasOwnProperty.call(ICONS, n.icon)
    ? ICONS[n.icon] : null;
  if (paths) {
    card.setAttribute("data-icon", n.icon!);
    const g = svg("svg", { viewBox: "0 0 16 16", width: 16, height: 16, focusable: "false" });
    for (const d of paths) g.append(svg("path", { d }));
    glyph.append(g);
  } else {
    glyph.append(el("span", "vz-node-dot"));
  }
  const text = el("span", "vz-node-text");
  text.append(el("span", "vz-node-label", n.label));
  if (n.sub) text.append(el("span", "vz-node-sub", n.sub));
  card.append(glyph, text);
  return card;
}

function nodeDetails(n: VisualNode): NodeDetail[] {
  return (n.details ?? []).slice(0, 8).map((d) => ({ label: String(d.label), value: String(d.value) }));
}

function renderDiagram(v: Visual, opts: RenderOptions): KindParts {
  const nodes = v.nodes ?? [];
  const edges = v.edges ?? [];
  const layoutKind: "radial" | "flow" = v.layout ?? (v.directed ? "flow" : "radial");
  const directed = Boolean(v.directed);
  const network = v.semantic === "network";

  const body = el("div", "vz-diagram");
  body.setAttribute("data-layout", layoutKind);
  body.setAttribute("data-mode", "list");                    // until measured

  const scroll = el("div", "vz-graph-wrap");
  const graph = el("div", "vz-graph");
  const edgeLayer = svg("svg", { class: "vz-edges", "aria-hidden": "true", focusable: "false" });
  const defs = svg("defs");
  const arrowId = `vz-arrow-${++arrowSeq}`;
  const marker = svg("marker", {
    id: arrowId, viewBox: "0 0 10 10", refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse",
  });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "vz-arrow" }));
  defs.append(marker);
  edgeLayer.append(defs);
  const edgeGroup = svg("g");
  edgeLayer.append(edgeGroup);
  graph.append(edgeLayer);

  const hub = layoutKind === "radial" ? pickHub(nodes, edges) : null;
  const peers = byId(nodes.filter((n) => n !== hub));
  const ordered = hub ? [hub, ...peers] : layoutKind === "radial" ? peers : nodes;
  const cards = new Map<string, HTMLButtonElement>();
  for (const n of ordered) {
    const card = nodeCard(n, n === hub);
    cards.set(n.id, card);
    graph.append(card);
  }
  scroll.append(graph);
  body.append(scroll);

  if (network) body.append(el("p", "vz-legend", NETWORK_LEGEND));
  if (network && v.overflow && Number.isFinite(v.overflow.shown) && Number.isFinite(v.overflow.discovered)) {
    body.append(el("p", "vz-overflow", `${v.overflow.shown} of ${v.overflow.discovered} devices shown`));
  }

  // The device list: every node again, as a row, filtered by the search.
  const deviceRows = new Map<string, HTMLButtonElement>();
  let deviceList: HTMLElement | null = null;
  if (network) {
    deviceList = el("div", "vz-device-list");
    const search = el("input", "vz-search");
    search.type = "search";
    search.placeholder = "Search devices";
    search.setAttribute("aria-label", "Search devices");
    search.autocomplete = "off";
    const rows = el("div", "vz-device-rows");
    const none = el("p", "vz-device-none", "No devices match.");
    none.hidden = true;
    const haystack = new Map<string, string>();
    for (const n of ordered) {
      const row = button("vz-device");
      row.setAttribute("data-id", n.id);
      toneAttr(row, n.tone);
      row.append(el("span", "vz-device-label", n.label));
      if (n.sub) row.append(el("span", "vz-device-sub", n.sub));
      rows.append(row);
      deviceRows.set(n.id, row);
      haystack.set(n.id, [n.label, n.sub ?? "", ...nodeDetails(n).map((d) => `${d.label} ${d.value}`)]
        .join(" ").toLowerCase());
    }
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const [id, row] of deviceRows) {
        const hit = q === "" || (haystack.get(id) ?? "").includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      }
      none.hidden = shown > 0;
    });
    deviceList.append(search, rows, none);
  }

  const selectables: Selectable[] = ordered.map((n) => ({
    id: n.id, label: n.label, sub: n.sub, details: nodeDetails(n),
    controls: [cards.get(n.id)!, ...(deviceRows.has(n.id) ? [deviceRows.get(n.id)!] : [])],
  }));
  const selection = makeSelection("vz-inspector", selectables, opts);
  body.append(selection.panel);
  if (deviceList) body.append(deviceList);

  // Levels do not depend on measurement; settle them once.
  const levels = layoutKind === "flow" ? flowLevels(nodes, edges) : null;
  const layerCount = levels ? new Set(levels.values()).size : 0;
  const hasBack = levels ? edges.some((e) => (levels.get(e.from) ?? 0) >= (levels.get(e.to) ?? 0)) : false;
  const bandMode = layoutKind === "radial" && hub !== null && peers.length > GRID_ABOVE;

  function drawEdges(rects: Map<string, Rect>, vertical: boolean, width: number, height: number,
                     band: BandMeta | null): void {
    edgeGroup.replaceChildren();
    edgeLayer.setAttribute("width", String(width));
    edgeLayer.setAttribute("height", String(height));
    edgeLayer.setAttribute("viewBox", `0 0 ${width} ${height}`);
    let fan = 0;
    for (const e of edges) {
      const a = rects.get(e.from);
      const b = rects.get(e.to);
      if (!a || !b) continue;                                   // an omitted node
      let d: string, mid: [number, number], back = false;
      const routed = band ? bandPath(e, rects, band) : null;
      if (routed) ({ d, mid } = routed);
      else ({ d, mid, back } = edgePath(a, b, levels, e, vertical, fan));
      if (back) fan++;
      const path = svg("path", { d, class: `vz-edge${back ? " vz-edge--back" : ""}${routed ? " vz-edge--bus" : ""}` });
      if (directed) path.setAttribute("marker-end", `url(#${arrowId})`);
      edgeGroup.append(path);
      if (e.label) {
        const t = svg("text", { x: mid[0], y: mid[1] - 5, "text-anchor": "middle", class: "vz-edge-label" });
        t.textContent = e.label;
        edgeGroup.append(t);
      }
    }
  }

  function layout(): void {
    if (!body.isConnected) return;
    const width = scroll.clientWidth;
    if (width <= 0) return;                                    // hidden: nothing to measure
    if (width < LIST_BELOW || nodes.length === 0) {
      body.setAttribute("data-mode", "list");
      body.removeAttribute("data-arrangement");
      graph.style.removeProperty("height");
      for (const card of cards.values()) {
        card.style.removeProperty("left"); card.style.removeProperty("top"); card.style.removeProperty("width");
        card.removeAttribute("data-band");
      }
      edgeGroup.replaceChildren();
      return;
    }
    body.setAttribute("data-mode", "graph");
    // Card width from the room: three across where there is room for it. A
    // flow whose columns would only fit at the narrow end takes that.
    let cardW = Math.max(180, Math.min(220, Math.floor((width - 2 * PAD - 2 * GAP) / 3)));
    if (levels && layerCount * cardW + (layerCount - 1) * COL_GAP + 2 * PAD > width) cardW = 180;
    // The hub: a band the grid's width over many peers, a wider card over few.
    const hubW = bandMode ? gridColumns(width, cardW) * (cardW + GAP) + GAP : Math.min(cardW + 40, width - 2 * PAD);
    for (const [id, card] of cards) {
      card.style.width = `${id === hub?.id ? hubW : cardW}px`;
      card.toggleAttribute("data-band", bandMode && id === hub?.id);
    }
    // One read of every card's height, after the widths are set.
    const sized = new Map<string, Sized>();
    for (const [id, card] of cards) sized.set(id, { id, w: card.offsetWidth || cardW, h: Math.max(44, card.offsetHeight) });

    let rects: Map<string, Rect>;
    let height: number;
    let vertical = false;
    let arrangement: Arrangement;
    let band: BandMeta | null = null;
    if (levels) {
      ({ rects, height, vertical } = flowPlace(nodes, levels, sized, width, cardW, hasBack));
      arrangement = vertical ? "lines" : "columns";
    } else {
      ({ rects, height, arrangement, band } = radialPlace(hub ? sized.get(hub.id)! : null, peers.map((p) => sized.get(p.id)!), width));
    }
    body.setAttribute("data-direction", vertical ? "down" : "across");
    body.setAttribute("data-arrangement", arrangement);
    for (const [id, card] of cards) {
      const r = rects.get(id);
      if (!r) continue;
      card.style.left = `${Math.round(r.x)}px`;
      card.style.top = `${Math.round(r.y)}px`;
    }
    graph.style.height = `${height}px`;
    drawEdges(rects, vertical, width, height, band);
  }

  // ── lifecycle: measure on mount, relayout on width changes ──
  let observer: ResizeObserver | null = null;
  let frame = 0;
  let lastWidth = -1;
  let destroyed = false;

  function relayout(force: boolean): void {
    if (destroyed) return;
    const width = scroll.clientWidth;
    if (!force && width === lastWidth) return;
    lastWidth = width;
    layout();
  }

  function scheduleLayout(force: boolean): void {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; relayout(force); });
  }

  return {
    body, selection,
    mount() {
      if (body.isConnected) relayout(true);
      if (typeof ResizeObserver !== "undefined") {
        // Width only: the layout sets the height itself, and reacting to
        // that would be a loop. A hidden container reports 0 and is
        // skipped; it fires again when shown.
        observer = new ResizeObserver(() => scheduleLayout(false));
        observer.observe(scroll);
      }
      // Fonts arriving after the first pass change the cards' heights.
      const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
      if (fonts?.ready) void fonts.ready.then(() => { if (!destroyed) scheduleLayout(true); });
    },
    destroy() {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

// ── table ──────────────────────────────────────────────────────────────────

function renderTable(v: Visual, opts: RenderOptions): KindParts {
  const columns = v.columns ?? [];
  const wrap = el("div", "vz-table-wrap");
  const table = el("table", "vz-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const c of columns) {
    const th = el("th", undefined, c);
    th.scope = "col";
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el("tbody");
  const selectables: Selectable[] = [];
  (v.rows ?? []).forEach((cells, i) => {
    const tr = el("tr");
    const id = String(i);
    tr.setAttribute("data-id", id);
    cells.forEach((cell, c) => {
      if (c === 0) {
        const th = el("th", "vz-row-head");
        th.scope = "row";
        if (cell) {
          const ctl = button("vz-row-button");
          ctl.setAttribute("data-id", id);
          ctl.textContent = cell;
          th.append(ctl);
          selectables.push({
            id, label: cell, controls: [ctl],
            details: cells.slice(1).map((value, j) => ({ label: columns[j + 1] ?? "", value })).filter((d) => d.value !== ""),
          });
          // A click on the rest of the row is a click on its control.
          tr.addEventListener("click", (e) => {
            if (e.target instanceof Node && ctl.contains(e.target)) return;
            e.stopPropagation();
            ctl.focus();
            ctl.click();
          });
        } else {
          th.textContent = cell;
        }
        tr.append(th);
      } else {
        tr.append(el("td", undefined, cell));
      }
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  // Rows carry the state too, so the whole row can light up.
  const rowsById = new Map<string, HTMLTableRowElement>();
  for (const tr of tbody.querySelectorAll("tr")) rowsById.set(tr.getAttribute("data-id") ?? "", tr);
  const selection = makeSelection("vz-askbar", selectables, opts, (id) => {
    for (const [rid, tr] of rowsById) tr.toggleAttribute("data-selected", rid === id);
  });
  const body = el("div", "vz-table-body");
  body.append(wrap, selection.panel);
  return { body, selection };
}

// ── steps / timeline ───────────────────────────────────────────────────────

function renderSteps(v: Visual, opts: RenderOptions): KindParts {
  const items = (v.items ?? []) as StepItem[];
  const timeline = items.some((s) => s.when);
  // The server settles `numbered`; a spec that skipped it (a hand-fed one
  // from the console) gets the same default it would have been given.
  const numbered = v.numbered ?? !timeline;
  const list = el(numbered ? "ol" : "ul", `vz-steps${timeline ? " vz-steps--timeline" : ""}`);
  const selectables: Selectable[] = [];
  items.forEach((step, i) => {
    const li = el("li", "vz-step");
    const id = String(i);
    toneAttr(li, step.tone);
    const ctl = button("vz-step-button");
    ctl.setAttribute("data-id", id);
    if (timeline) ctl.append(el("span", "vz-step-when", step.when ?? ""));
    const text = el("span", "vz-step-body");
    text.append(el("span", "vz-step-title", step.title));
    if (step.detail) text.append(el("span", "vz-step-detail", step.detail));
    ctl.append(text);
    li.append(ctl);
    list.append(li);
    const details: NodeDetail[] = [];
    if (step.when) details.push({ label: "When", value: step.when });
    selectables.push({ id, label: step.title, sub: step.detail, details, controls: [ctl] });
  });
  const selection = makeSelection("vz-askbar", selectables, opts);
  const body = el("div", "vz-steps-body");
  body.append(list, selection.panel);
  return { body, selection };
}

// ── bars ───────────────────────────────────────────────────────────────────

function renderBars(v: Visual, opts: RenderOptions): KindParts {
  const items = (v.items ?? []) as BarItem[];
  const values = items.map((b) => (Number.isFinite(b.value) ? b.value : 0));
  // The domain always contains zero, so a bar's length is its distance from
  // the baseline and a negative one extends left of it. `max` is a ceiling
  // the author asked for; it is honoured only when every value is >= 0,
  // because with negatives in play it says nothing about the floor and the
  // picture would be a lie about the scale. A value above `max` widens the
  // domain rather than being clipped — clipping would hide the overshoot.
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (v.max !== undefined && Number.isFinite(v.max) && v.max > 0 && values.every((x) => x >= 0)) {
    hi = Math.max(hi, v.max);
  }
  // All zero: a one-unit domain keeps the arithmetic finite; every bar is
  // then zero wide and the baseline sits at the left edge.
  const span = hi - lo || 1;
  const zeroPct = ((0 - lo) / span) * 100;

  const host = el("div", "vz-bars");
  const texts = items.map((b) => (v.unit ? `${fmtValue(b.value)} ${v.unit}` : fmtValue(b.value)));
  const widest = Math.max(3, ...texts.map((t) => t.length));
  host.style.setProperty("--vz-value-ch", `${widest}ch`);
  const selectables: Selectable[] = [];
  items.forEach((b, i) => {
    const id = String(i);
    const row = button("vz-bar");
    row.setAttribute("data-id", id);
    row.style.gridRow = String(i + 1);
    toneAttr(row, b.tone);
    row.append(el("span", "vz-bar-label", b.label));
    const track = el("span", "vz-bar-track");
    const fill = el("span", "vz-bar-fill");
    const value = values[i];
    const len = (Math.abs(value) / span) * 100;
    const left = value >= 0 ? zeroPct : zeroPct - len;
    fill.style.left = `${left}%`;
    fill.style.width = `${len}%`;
    if (value < 0) fill.setAttribute("data-negative", "");
    track.append(fill);
    row.append(track);
    row.append(el("span", "vz-bar-value", texts[i]));
    host.append(row);
    selectables.push({ id, label: b.label, details: [{ label: "Value", value: texts[i] }], controls: [row] });
  });
  // The one zero line, spanning every row of the track column.
  const baseline = el("span", "vz-baseline");
  baseline.setAttribute("aria-hidden", "true");
  baseline.style.gridRow = `1 / span ${Math.max(1, items.length)}`;
  baseline.style.marginLeft = `${zeroPct}%`;
  host.append(baseline);

  const selection = makeSelection("vz-askbar", selectables, opts);
  const body = el("div", "vz-bars-body");
  body.append(host, selection.panel);
  return { body, selection };
}

// ── cards ──────────────────────────────────────────────────────────────────

function renderCards(v: Visual, opts: RenderOptions): KindParts {
  const items = (v.items ?? []) as CardItem[];
  const grid = el("div", "vz-cards");
  const selectables: Selectable[] = [];
  items.forEach((c, i) => {
    const id = String(i);
    const card = button("vz-card");
    card.setAttribute("data-id", id);
    toneAttr(card, c.tone);
    card.append(el("span", "vz-card-title", c.title));
    card.append(el("span", "vz-card-value", c.value));
    if (c.note) card.append(el("span", "vz-card-note", c.note));
    grid.append(card);
    const details: NodeDetail[] = [{ label: "Value", value: c.value }];
    if (c.note) details.push({ label: "Note", value: c.note });
    selectables.push({ id, label: c.title, details, controls: [card] });
  });
  const selection = makeSelection("vz-askbar", selectables, opts);
  const body = el("div", "vz-cards-body");
  body.append(grid, selection.panel);
  return { body, selection };
}

// ── the view ───────────────────────────────────────────────────────────────

const WHEN_REFRESH_MS = 30_000;

/** One kind's parts. An image never asks, so it is built without `onAsk`. */
function buildParts(v: Visual, opts: RenderOptions): KindParts {
  switch (v.kind) {
    case "diagram": return renderDiagram(v, opts);
    case "table": return renderTable(v, opts);
    case "steps": return renderSteps(v, opts);
    case "bars": return renderBars(v, opts);
    case "cards": return renderCards(v, opts);
    case "text": return buildText(v, opts);
    case "chart": return buildChart(v, opts);
    case "map": return buildMap(v, opts);
    case "video": return buildVideo(v, opts);
    case "web": return buildWeb(v, opts);
    case "scene": return buildScene(v, opts);
    case "image": return buildImage(v);
    default: return { body: el("div", "vz-unknown", "JARVIS drew something this page cannot show.") };
  }
}

export function createVisual(v: Visual, opts: RenderOptions = {}): VisualView {
  const root = el("div", "vz");
  root.setAttribute("data-kind", v.kind);
  root.setAttribute("data-id", v.id);
  const withHeader = opts.header !== false;

  if (withHeader) {
    const head = el("header", "vz-head");
    head.append(el("h2", "vz-title", v.title));
    if (v.caption) head.append(el("p", "vz-caption", v.caption));
    root.append(head);
  }

  const parts = buildParts(v, opts);
  const selection: Selection | null = parts.selection ?? null;
  parts.body.classList.add("vz-body");
  root.append(parts.body);

  // The provenance line. It is part of the picture: what shaped it is
  // stated under it, never left for the viewer to assume.
  let when: HTMLTimeElement | null = null;
  let whenSec = 0;
  let whenVerb = "drawn";
  if (withHeader) {
    const foot = el("footer", "vz-source");
    foot.append(el("span", "vz-source-text", v.source));
    const observed = typeof v.observed_at === "number" && Number.isFinite(v.observed_at);
    const sec = observed ? v.observed_at! : v.at;
    if (typeof sec === "number" && Number.isFinite(sec)) {
      whenSec = sec;
      whenVerb = observed ? "observed" : "drawn";
      foot.append(el("span", "vz-source-sep", "·"));
      when = el("time", "vz-source-when");
      const date = new Date(sec * 1000);
      when.dateTime = date.toISOString();
      when.title = date.toLocaleString();
      when.textContent = `${whenVerb} ${ago(sec)}`;
      foot.append(when);
    }
    // The hint is only true of a kind with something to select.
    if (opts.onAsk && selection) foot.append(el("span", "vz-source-hint", "select anything to ask about it"));
    root.append(foot);
  }

  // ── lifecycle ──
  let mounted = false;
  let destroyed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const view: VisualView = {
    element: root,
    mount() {
      if (mounted || destroyed) return;
      mounted = true;
      counter().live += 1;
      if (when) {
        timer = setInterval(() => {
          if (when) when.textContent = `${whenVerb} ${ago(whenSec)}`;
        }, WHEN_REFRESH_MS);
      }
      parts.mount?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (mounted) counter().live -= 1;
      parts.destroy?.();
      if (timer !== null) clearInterval(timer);
      timer = null;
      when = null;
    },
    clearSelection() {
      if (!selection) return false;
      const had = selection.current() !== null;
      if (had) selection.select(null);
      return had;
    },
  };
  return view;
}
