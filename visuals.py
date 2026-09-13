"""What JARVIS puts on the screen: the display's vocabulary, its history, and
the network map.

The user: "if I don't know something, JARVIS can visualise it for me — like
my active network." The persona rule is two spoken sentences, so this is
where the detail goes: a diagram, a table, a list of steps, a chart or a set
of cards, drawn on the JARVIS page beside the orb and kept on the dashboard's
Display tab.

Two authors, one vocabulary. The brain writes a spec itself (`show`), or the
server builds one from its own data (`show_network`); either way the spec is
validated HERE before it is stored or sent. The frontend then renders it with
DOM and SVG built element by element and text set through `textContent`, so
nothing in a spec is ever markup — which is what makes it safe for a device
name off the network, or a diagram the brain drew out of a web page, to land
on the user's screen.

Three rules:

1. **Everything is bounded.** Every string has a length cap, every list a
   count cap, and the JSON as a whole a size cap. A spec is text a model
   wrote; it must not be able to fill the screen or the socket.
2. **Everything is flat text.** Strings are collapsed to one line (every
   separator `str.splitlines()` knows about, by asking the language rather
   than a hand-written list), unknown keys are dropped, tones come from a
   fixed set and numbers must be finite. What is stored is exactly what
   `validate` produced, never the raw object.
3. **The source is part of the picture.** Every visual carries where it came
   from — JARVIS's own knowledge, a web page he read this turn, a network
   sweep — and the frontend prints it under the title. Drawing from foreign
   text is allowed; passing it off as JARVIS's own is not.

No new dependency.
"""
from __future__ import annotations

import json
import math
import time
from collections import deque

import net_scan

KINDS = ("diagram", "table", "steps", "bars", "cards")
TONES = frozenset({"accent", "ok", "warn", "bad", "idle", "dim"})

# --- the caps ---------------------------------------------------------------
#
# Sized for a panel beside the orb, read at a glance while JARVIS is talking.
# Not a document: a diagram of forty nodes is already a poster.
TITLE_MAX = 80
CAPTION_MAX = 240
SOURCE_MAX = 80
ID_MAX = 32
LABEL_MAX = 40
SUB_MAX = 48
EDGE_LABEL_MAX = 24
NODES_MAX = 40
EDGES_MAX = 80
COLUMN_MAX = 24
COLUMNS_MAX = 6
CELL_MAX = 80
ROWS_MAX = 30
STEP_TITLE_MAX = 60
STEP_DETAIL_MAX = 160
WHEN_MAX = 24
STEPS_MAX = 20
BAR_LABEL_MAX = 40
BARS_MAX = 20
UNIT_MAX = 12
CARD_TITLE_MAX = 40
CARD_VALUE_MAX = 80
CARD_NOTE_MAX = 80
CARDS_MAX = 12
SPEC_BYTES_MAX = 16_000
HISTORY_MAX = 20

# What the brain is told when a spec is refused. Fixed sentences, chosen by
# key: the refusal never echoes anything out of the spec itself.
PROBLEMS = {
    "not_an_object": "the visual must be a JSON object",
    "too_big": "the visual is too large — fewer items, shorter text",
    "kind": "kind must be one of diagram, table, steps, bars, cards",
    "title": "a title is required",
    "diagram_nodes": "a diagram needs 1 to 40 nodes, each with an id and a label",
    "diagram_ids": "every node id must be unique",
    "diagram_edges": "every edge must have from and to naming node ids that exist",
    "table_columns": "a table needs 1 to 6 column names",
    "table_rows": "a table needs 1 to 30 rows, each a list of cells",
    "steps_items": "steps need 1 to 20 items, each with a title",
    "bars_items": "bars need 1 to 20 items, each with a label and a numeric value",
    "cards_items": "cards need 1 to 12 items, each with a title and a value",
}


# --- flattening -------------------------------------------------------------

def text(value, limit: int) -> str:
    """`value` as one bounded line. `str.split()` with no argument splits on
    every separator the language knows, so nothing that ends a line can
    survive the join — the same rule as `jarvis_memory.one_line`."""
    flat = " ".join(str(value if value is not None else "").split())
    return flat[: limit - 1] + "…" if len(flat) > limit else flat


def _tone(value) -> str | None:
    value = str(value or "")
    return value if value in TONES else None


def _number(value) -> float | None:
    """A finite number, or None. Booleans are not numbers here — `True`
    drawn as a bar of height 1 is a lie about a flag."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _flag(value) -> bool:
    return value is True or value == 1 or str(value).lower() in ("true", "yes")


# --- one validator per kind -------------------------------------------------
#
# Each takes the spec's own dict and returns (body, "") or (None, problem key).
# Every string goes through `text`, every list is bounded, every unknown key
# is dropped by never being read.

def _diagram(raw: dict) -> tuple[dict | None, str]:
    nodes_raw = raw.get("nodes")
    if not isinstance(nodes_raw, list) or not 1 <= len(nodes_raw) <= NODES_MAX:
        return None, "diagram_nodes"
    nodes: list[dict] = []
    ids: set[str] = set()
    for item in nodes_raw:
        if not isinstance(item, dict):
            return None, "diagram_nodes"
        node_id = text(item.get("id"), ID_MAX)
        label = text(item.get("label"), LABEL_MAX)
        if not node_id or not label:
            return None, "diagram_nodes"
        if node_id in ids:
            return None, "diagram_ids"
        ids.add(node_id)
        node: dict = {"id": node_id, "label": label}
        sub = text(item.get("sub"), SUB_MAX)
        if sub:
            node["sub"] = sub
        tone = _tone(item.get("tone"))
        if tone:
            node["tone"] = tone
        if _flag(item.get("hub")):
            node["hub"] = True
        nodes.append(node)

    edges_raw = raw.get("edges")
    if edges_raw is None:
        edges_raw = []
    if not isinstance(edges_raw, list) or len(edges_raw) > EDGES_MAX:
        return None, "diagram_edges"
    edges: list[dict] = []
    for item in edges_raw:
        if not isinstance(item, dict):
            return None, "diagram_edges"
        source = text(item.get("from"), ID_MAX)
        target = text(item.get("to"), ID_MAX)
        if source not in ids or target not in ids:
            return None, "diagram_edges"
        edge: dict = {"from": source, "to": target}
        label = text(item.get("label"), EDGE_LABEL_MAX)
        if label:
            edge["label"] = label
        edges.append(edge)

    body: dict = {"nodes": nodes, "edges": edges}
    layout = str(raw.get("layout") or "")
    if layout in ("radial", "flow"):
        body["layout"] = layout
    if _flag(raw.get("directed")):
        body["directed"] = True
    return body, ""


def _table(raw: dict) -> tuple[dict | None, str]:
    columns_raw = raw.get("columns")
    if not isinstance(columns_raw, list) or not 1 <= len(columns_raw) <= COLUMNS_MAX:
        return None, "table_columns"
    columns = [text(c, COLUMN_MAX) for c in columns_raw]
    if not all(columns):
        return None, "table_columns"
    rows_raw = raw.get("rows")
    if not isinstance(rows_raw, list) or not 1 <= len(rows_raw) <= ROWS_MAX:
        return None, "table_rows"
    rows: list[list[str]] = []
    for row in rows_raw:
        if not isinstance(row, list):
            return None, "table_rows"
        cells = [text(c, CELL_MAX) for c in row[: len(columns)]]
        cells += [""] * (len(columns) - len(cells))
        rows.append(cells)
    return {"columns": columns, "rows": rows}, ""


def _steps(raw: dict) -> tuple[dict | None, str]:
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not 1 <= len(items_raw) <= STEPS_MAX:
        return None, "steps_items"
    items: list[dict] = []
    timeline = False
    for item in items_raw:
        if isinstance(item, str):
            item = {"title": item}
        if not isinstance(item, dict):
            return None, "steps_items"
        step_title = text(item.get("title"), STEP_TITLE_MAX)
        if not step_title:
            return None, "steps_items"
        step: dict = {"title": step_title}
        detail = text(item.get("detail"), STEP_DETAIL_MAX)
        if detail:
            step["detail"] = detail
        when = text(item.get("when"), WHEN_MAX)
        if when:
            step["when"] = when
            timeline = True
        tone = _tone(item.get("tone"))
        if tone:
            step["tone"] = tone
        items.append(step)
    numbered = raw.get("numbered")
    body: dict = {"items": items,
                  "numbered": (not timeline) if numbered is None else _flag(numbered)}
    return body, ""


def _bars(raw: dict) -> tuple[dict | None, str]:
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not 1 <= len(items_raw) <= BARS_MAX:
        return None, "bars_items"
    items: list[dict] = []
    for item in items_raw:
        if not isinstance(item, dict):
            return None, "bars_items"
        label = text(item.get("label"), BAR_LABEL_MAX)
        value = _number(item.get("value"))
        if not label or value is None:
            return None, "bars_items"
        bar: dict = {"label": label, "value": value}
        tone = _tone(item.get("tone"))
        if tone:
            bar["tone"] = tone
        items.append(bar)
    body: dict = {"items": items}
    unit = text(raw.get("unit"), UNIT_MAX)
    if unit:
        body["unit"] = unit
    maximum = _number(raw.get("max"))
    if maximum is not None and maximum > 0:
        body["max"] = maximum
    return body, ""


def _cards(raw: dict) -> tuple[dict | None, str]:
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not 1 <= len(items_raw) <= CARDS_MAX:
        return None, "cards_items"
    items: list[dict] = []
    for item in items_raw:
        if not isinstance(item, dict):
            return None, "cards_items"
        card_title = text(item.get("title"), CARD_TITLE_MAX)
        value = text(item.get("value"), CARD_VALUE_MAX)
        if not card_title or not value:
            return None, "cards_items"
        card: dict = {"title": card_title, "value": value}
        note = text(item.get("note"), CARD_NOTE_MAX)
        if note:
            card["note"] = note
        tone = _tone(item.get("tone"))
        if tone:
            card["tone"] = tone
        items.append(card)
    return {"items": items}, ""


_VALIDATORS = {
    "diagram": _diagram,
    "table": _table,
    "steps": _steps,
    "bars": _bars,
    "cards": _cards,
}


def validate(raw) -> tuple[dict | None, str]:
    """(clean spec, "") or (None, problem key). See `PROBLEMS` for the words.

    The spec is flat: `kind` and `title` beside the kind's own fields
    (`nodes`/`edges`, `columns`/`rows`, `items`). A brain that nests them
    under the kind's name instead is met halfway.
    """
    if not isinstance(raw, dict):
        return None, "not_an_object"
    try:
        if len(json.dumps(raw, ensure_ascii=False)) > SPEC_BYTES_MAX:
            return None, "too_big"
    except (TypeError, ValueError):
        return None, "not_an_object"
    kind = str(raw.get("kind") or "")
    if kind not in KINDS:
        return None, "kind"
    heading = text(raw.get("title"), TITLE_MAX)
    if not heading:
        return None, "title"
    inner = raw.get(kind)
    body, problem = _VALIDATORS[kind](inner if isinstance(inner, dict) else raw)
    if problem:
        return None, problem
    clean: dict = {"kind": kind, "title": heading}
    caption = text(raw.get("caption"), CAPTION_MAX)
    if caption:
        clean["caption"] = caption
    clean.update(body)
    return clean, ""


# --- the history --------------------------------------------------------------

class Store:
    """What is on the display now, and what has been.

    In memory, newest first, `HISTORY_MAX` deep: the display is a
    conversation aid, not a record, and the dashboard's Display tab says
    "since JARVIS started". `version` moves on every change so a hint socket
    can say "something moved" without carrying content.
    """

    def __init__(self, limit: int = HISTORY_MAX):
        self._items: deque = deque(maxlen=limit)
        self._count = 0
        self.current_id: str | None = None
        self.version = 0

    def add(self, clean: dict, source: str) -> dict:
        """Record a validated spec as the current visual and return it with
        its id, timestamp and source attached."""
        self._count += 1
        visual = dict(clean)
        visual["id"] = "v%d" % self._count
        visual["at"] = time.time()
        visual["source"] = text(source, SOURCE_MAX) or "JARVIS"
        self._items.appendleft(visual)
        self.current_id = visual["id"]
        self.version += 1
        return visual

    @property
    def current(self) -> dict | None:
        return self.get(self.current_id) if self.current_id else None

    def clear(self) -> None:
        """Take the display down. The history keeps the visual."""
        if self.current_id is not None:
            self.current_id = None
            self.version += 1

    def get(self, visual_id: str | None) -> dict | None:
        for item in self._items:
            if item["id"] == visual_id:
                return item
        return None

    def history(self) -> list[dict]:
        return list(self._items)


# --- the network map ------------------------------------------------------------

def _ago(seconds: float) -> str:
    if seconds < 45:
        return "just now"
    if seconds < 3600:
        return "%d minutes ago" % max(1, round(seconds / 60))
    return "%d hours ago" % max(1, round(seconds / 3600))


def _ports_note(ports: list) -> str:
    """"ssh, http, https" or "5 open ports" — nmap's service names, from its
    own table, never a device's."""
    open_ports = [p for p in ports if getattr(p, "state", "") == "open"]
    if not open_ports:
        return "nothing open"
    names = [p.service or str(p.number) for p in open_ports]
    if len(names) <= 3:
        return ", ".join(names)
    return "%d open ports" % len(names)


def network_visual(network: str, devices: list, *, own_address: str | None,
                   gateway: str | None, ports_by_address: dict,
                   age_seconds: float, complete: bool = True) -> dict:
    """The LAN as a diagram: the router in the middle, every device that
    answered around it, this Mac marked, and what is open on anything that
    has been port-scanned. Built from `net_scan`'s own results; the names
    are what the devices call themselves and go into labels, which the
    frontend renders as text."""
    nodes: list[dict] = []
    edges: list[dict] = []
    addresses = [d.address for d in devices]
    if gateway and gateway in addresses:
        hub_id = gateway
    else:
        hub_id = "network"
        nodes.append({"id": hub_id, "label": text(network, LABEL_MAX) or "network",
                      "sub": "router not answering" if gateway else "",
                      "tone": "accent", "hub": True})
    for device in devices:
        name = text(getattr(device, "name", ""), LABEL_MAX)
        node: dict = {"id": device.address,
                      "label": name or device.address}
        subs: list[str] = []
        if name:
            subs.append(device.address)
        if device.address == own_address:
            subs.append("this Mac")
            node["tone"] = "ok"
        if device.address == gateway:
            subs.insert(0, "router")
            node["tone"] = "accent"
            node["hub"] = True
        ports = ports_by_address.get(device.address)
        if ports is not None:
            subs.append(_ports_note(ports))
        node.setdefault("tone", "idle")
        sub = text(" · ".join(s for s in subs if s), SUB_MAX)
        if sub:
            node["sub"] = sub
        nodes.append(node)
        if device.address != hub_id:
            edges.append({"from": hub_id, "to": device.address})

    count = len(devices)
    caption = "%d device%s answering on %s · swept %s" % (
        count, "" if count == 1 else "s", text(network, LABEL_MAX), _ago(age_seconds))
    if not complete:
        caption += " · the sweep ran out of time"
    spec = {"kind": "diagram", "title": "Your network", "caption": caption,
            "nodes": nodes, "edges": edges, "layout": "radial"}
    clean, problem = validate(spec)
    if clean is None:                                  # pragma: no cover
        raise ValueError(problem)
    return clean


def ports_for_map(addresses: list) -> dict:
    """{address: [Port]} for every device `net_scan` has port-scanned
    recently — the map shows what is known and claims nothing else."""
    out: dict = {}
    for address in addresses:
        ports = net_scan.known_ports(address)
        if ports is not None:
            out[address] = ports
    return out
