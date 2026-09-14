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

Some keys are the SERVER's to set and nobody else's: `id`, `at` and `source`
(attached by `Store.add`), and on a network map `observed_at` (when the sweep
finished) and `overflow` (how many devices there were and how many are drawn).
`validate` never copies them out of a caller's spec, so a brain cannot claim
a picture is a sweep, or was observed at a time it was not; `network_visual`
attaches its two AFTER validation, and `Store.add` keeps them.

The second wave of kinds ("think bigger than just visualising the network")
bends rule 2 in exactly two places, each on purpose and each bounded:

* `text` carries a Markdown BODY that keeps its newlines and tabs
  (`block_text`, not `text`) — a recipe or a poem is lines. Every other
  control character and every other line separator is still removed, and the
  frontend renders it with its own safe renderer, never as HTML.
* `video` and `web` carry a URL, which is the one string the frontend may put
  in a `src`. It is checked HERE (`url_problem`), normalised HERE
  (`normalise_url`: scheme, host, path, query — no fragment, no credentials),
  and for a video the `embed`/`media` string is BUILT here from the parts
  that matched, so what reaches an iframe is a string the server wrote.

The kind `image` is the server's alone: `validate` refuses it from a caller
and `image_visual` builds it, from a PNG the server captured itself. It is
EPHEMERAL — current while it is up, never in the history — because a capture
of the user's screen is not something to keep in a list.

No new dependency.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import math
import re
import string
import struct
import time
from collections import deque
from urllib.parse import parse_qs, urlsplit, urlunsplit

import net_scan

# What a CALLER may send. `image` is deliberately absent: see `image_visual`.
KINDS = ("diagram", "table", "steps", "bars", "cards",
         "text", "chart", "map", "video", "web", "scene")
SERVER_KINDS = ("image",)
TONES = frozenset({"accent", "ok", "warn", "bad", "idle", "dim"})
CHART_TYPES = frozenset({"line", "area", "pie"})
SHAPES = frozenset({"box", "sphere", "cylinder", "cone", "plane", "torus"})
# A node's icon is a KEY into the frontend's own set of inline SVG paths —
# never a path, a URL or a class name. Anything else is dropped.
NODE_ICONS = frozenset({"device", "gateway", "computer", "network"})
# The one meaning a diagram may declare beyond its shape: this is a map of
# the user's network. The frontend may draw it with that in mind; nothing in
# it is a claim about any device.
SEMANTICS = frozenset({"network"})

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
# The facts behind a node, shown when it is selected: a short label and a
# longer value, a handful per node. Enough for an address, a name and a port
# list; not enough to hide a paragraph in.
DETAILS_MAX = 8
DETAIL_LABEL_MAX = 32
DETAIL_VALUE_MAX = 120
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
# A Markdown body: a recipe, a poem, a file. Fits under SPEC_BYTES_MAX with
# the title and caption beside it.
TEXT_MAX = 12_000
CHART_LABEL_MAX = 24
CHART_POINTS_MAX = 200
CHART_SERIES_MAX = 6
CHART_PIE_SLICES_MAX = 12
SERIES_NAME_MAX = 40
MAP_ZOOM_DEFAULT = 14
MAP_ZOOM_MIN, MAP_ZOOM_MAX = 1, 19
URL_MAX = 2048
SCENE_OBJECTS_MAX = 60
SCENE_EXTENT = 100.0                 # a coordinate is within ±this
SCENE_SIZE_MIN, SCENE_SIZE_MAX = 0.01, 50.0
SCENE_ROTATION_MAX = 7.0             # radians, a shade over one full turn
# A capture, base64. About 1.9 MB of PNG — a 1280-wide screenshot is a
# fraction of that; the cap is against a picture that would stall the socket.
IMAGE_B64_MAX = 2_600_000
SPEC_BYTES_MAX = 16_000
HISTORY_MAX = 20

# What the brain is told when a spec is refused. Fixed sentences, chosen by
# key: the refusal never echoes anything out of the spec itself.
PROBLEMS = {
    "not_an_object": "the visual must be a JSON object",
    "too_big": "the visual is too large — fewer items, shorter text",
    "kind": ("kind must be one of diagram, table, steps, bars, cards, text, "
             "chart, map, video, web, scene"),
    "title": "a title is required",
    "diagram_nodes": "a diagram needs 1 to 40 nodes, each with an id and a label",
    "diagram_ids": "every node id must be unique",
    "diagram_edges": "every edge must have from and to naming node ids that exist",
    "table_columns": "a table needs 1 to 6 column names",
    "table_rows": "a table needs 1 to 30 rows, each a list of cells",
    "steps_items": "steps need 1 to 20 items, each with a title",
    "bars_items": "bars need 1 to 20 items, each with a label and a numeric value",
    "cards_items": "cards need 1 to 12 items, each with a title and a value",
    "text_body": "text needs a body — the Markdown to show",
    "chart_type": "chart type must be line, area or pie",
    "chart_x": "a chart needs x: 1 to 200 labels, each a short name",
    "chart_series": ("a chart needs 1 to 6 series, each with a name and one "
                     "finite number per x label; a pie has exactly one series "
                     "over at most 12 labels"),
    "chart_y": "y.min and y.max must be finite numbers with min below max",
    "map_point": "a map needs a finite lat within -90..90 and lon within -180..180",
    "video_url": ("video needs an http(s) YouTube or Vimeo link, or a direct "
                  ".mp4, .webm, .ogg, .ogv, .m4v or .mov file"),
    "web_url": ("web needs a plain http(s) address with a hostname, no "
                "credentials, and not JARVIS's own"),
    "scene_objects": ("a scene needs 1 to 60 objects, each with an id, a shape "
                      "(box, sphere, cylinder, cone, plane, torus) and numbers "
                      "within bounds"),
    "scene_ids": "every object id must be unique",
}


# --- flattening -------------------------------------------------------------

def text(value, limit: int) -> str:
    """`value` as one bounded line. `str.split()` with no argument splits on
    every separator the language knows, so nothing that ends a line can
    survive the join — the same rule as `jarvis_memory.one_line`."""
    flat = " ".join(str(value if value is not None else "").split())
    return flat[: limit - 1] + "…" if len(flat) > limit else flat


# The C0 and C1 controls other than tab and newline. The separators among
# them (\x0b, \x0c, \x1c-\x1e, \x85) never reach this pattern: `block_text`
# has already turned every separator into a newline by then.
_CONTROL_CHARS = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def block_text(value, limit: int = TEXT_MAX) -> str:
    """`value` as bounded MULTI-LINE text: newlines and tabs survive, every
    other line separator becomes a newline, every other control character
    goes.

    `str.splitlines()` is the language's own list of what ends a line — it
    splits on \\r\\n, \\r, \\x0b, \\x0c, \\x1c-\\x1e, \\x85, \\u2028 and
    \\u2029 as well as \\n — so joining its pieces with "\\n" normalises all
    of them without a hand-written list. Blank lines are kept (Markdown
    paragraphs need them); a trailing newline is not.
    """
    lines = str(value if value is not None else "").splitlines()
    body = _CONTROL_CHARS.sub("", "\n".join(lines))
    return body[: limit - 1] + "…" if len(body) > limit else body


# --- URLs ---------------------------------------------------------------------
#
# Two kinds carry an address the frontend will put in a `src`. The checks are
# the same for both and are made ONCE, here, on the parsed parts rather than
# on the string: a scheme that is http or https, a hostname, no userinfo (an
# `https://youtube.com@evil.example/` reads as YouTube to a person and goes to
# evil.example), a bounded length, and — unless the caller allows it — not
# JARVIS itself, because a page framed inside the page that frames it is a
# picture of nothing and a `web` visual pointing at the API is a way to make
# the user's own browser fetch it.

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"})
_WEB_SCHEMES = frozenset({"http", "https"})


def _split(url) -> tuple | None:
    """(scheme, hostname, port, path, query) or None when the string is not
    an http(s) address JARVIS will touch. `hostname` is lower-cased and
    bracket-free; `port` is None or an int."""
    raw = str(url if url is not None else "").strip()
    if not raw or len(raw) > URL_MAX:
        return None
    try:
        parts = urlsplit(raw)
        host = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in _WEB_SCHEMES or not host:
        return None
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return None
    return parts.scheme.lower(), host, port, parts.path, parts.query


def _is_jarvis_itself(host: str) -> bool:
    return host in _LOOPBACK_HOSTS or host.endswith(".localhost")


def url_problem(url, allow_loopback: bool = False) -> str:
    """"" when `url` is an address a visual may carry, else a short reason:
    "shape" (not an http(s) URL with a hostname, or too long), "userinfo",
    or "loopback" (JARVIS's own host, unless `allow_loopback`). The reasons
    are for the caller to map to its own `PROBLEMS` key; they are never said
    to the brain themselves."""
    raw = str(url if url is not None else "").strip()
    if not raw or len(raw) > URL_MAX:
        return "shape"
    try:
        parts = urlsplit(raw)
    except ValueError:
        return "shape"
    if "@" in parts.netloc:
        return "userinfo"
    split = _split(raw)
    if split is None:
        return "shape"
    if not allow_loopback and _is_jarvis_itself(split[1]):
        return "loopback"
    return ""


def normalise_url(url) -> str:
    """The address rebuilt from its parts: lower-cased scheme and host, the
    port if one was given, path and query as they were — no fragment and no
    credentials. "" when `_split` refuses it."""
    split = _split(url)
    if split is None:
        return ""
    scheme, host, port, path, query = split
    netloc = "[%s]" % host if ":" in host else host
    if port is not None:
        netloc += ":%d" % port
    return urlunsplit((scheme, netloc, path, query, ""))


# The one thing a video visual may frame: a player on one of two hosts, at an
# address BUILT here from an id that is nothing but these characters.
_YOUTUBE_ID_CHARS = frozenset(string.ascii_letters + string.digits + "_-")
_YOUTUBE_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com",
                            "music.youtube.com"})
_YOUTUBE_NOCOOKIE_HOSTS = frozenset({"youtube-nocookie.com", "www.youtube-nocookie.com"})
_VIMEO_HOSTS = frozenset({"vimeo.com", "www.vimeo.com"})
MEDIA_SUFFIXES = (".mp4", ".webm", ".ogg", ".ogv", ".m4v", ".mov")


def _youtube_id(value: str) -> str:
    return value if len(value) == 11 and set(value) <= _YOUTUBE_ID_CHARS else ""


def _digits(value: str) -> str:
    return value if value and value.isascii() and value.isdigit() else ""


def _video_target(host: str, path: str, query: str) -> tuple[str, str]:
    """("embed", url) for a recognised player, ("media", "") for a direct
    file — the caller supplies the normalised address — or ("", "")."""
    segments = [s for s in path.split("/") if s]
    if host in _YOUTUBE_HOSTS:
        video_id = ""
        if segments == ["watch"]:
            video_id = _youtube_id(parse_qs(query).get("v", [""])[0])
        elif len(segments) == 2 and segments[0] in ("shorts", "embed"):
            video_id = _youtube_id(segments[1])
        if video_id:
            return "embed", "https://www.youtube-nocookie.com/embed/" + video_id
    elif host in _YOUTUBE_NOCOOKIE_HOSTS:
        if len(segments) == 2 and segments[0] == "embed" and _youtube_id(segments[1]):
            return "embed", "https://www.youtube-nocookie.com/embed/" + segments[1]
    elif host == "youtu.be":
        if len(segments) == 1 and _youtube_id(segments[0]):
            return "embed", "https://www.youtube-nocookie.com/embed/" + segments[0]
    elif host in _VIMEO_HOSTS:
        if len(segments) == 1 and _digits(segments[0]):
            return "embed", "https://player.vimeo.com/video/" + segments[0]
    elif host == "player.vimeo.com":
        if len(segments) == 2 and segments[0] == "video" and _digits(segments[1]):
            return "embed", "https://player.vimeo.com/video/" + segments[1]
    if path.lower().endswith(MEDIA_SUFFIXES):
        return "media", ""
    return "", ""


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


def _details(raw) -> list[dict]:
    """A node's `details`: the first `DETAILS_MAX` entries that are a dict
    with both a label and a value, each through `text`. Anything else in the
    list is dropped rather than refused — details decorate a node; they do
    not make or break the diagram."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw[:DETAILS_MAX]:
        if not isinstance(entry, dict):
            continue
        label = text(entry.get("label"), DETAIL_LABEL_MAX)
        value = text(entry.get("value"), DETAIL_VALUE_MAX)
        if label and value:
            out.append({"label": label, "value": value})
    return out


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
        icon = str(item.get("icon") or "")
        if icon in NODE_ICONS:
            node["icon"] = icon
        details = _details(item.get("details"))
        if details:
            node["details"] = details
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


def _text(raw: dict) -> tuple[dict | None, str]:
    """Markdown. The one body that keeps its lines — see `block_text`. The
    frontend renders it with its own safe renderer; nothing here is HTML."""
    raw_body = raw.get("body")
    if not isinstance(raw_body, str):
        return None, "text_body"                    # a list of lines is not Markdown
    body = block_text(raw_body, TEXT_MAX)
    if not body.strip():
        return None, "text_body"
    return {"body": body}, ""


def _chart(raw: dict) -> tuple[dict | None, str]:
    chart_type = str(raw.get("type") or "")
    if chart_type not in CHART_TYPES:
        return None, "chart_type"
    x_raw = raw.get("x")
    if not isinstance(x_raw, list) or not 1 <= len(x_raw) <= CHART_POINTS_MAX:
        return None, "chart_x"
    x = [text(label, CHART_LABEL_MAX) for label in x_raw]
    if not all(x):
        return None, "chart_x"
    series_raw = raw.get("series")
    if not isinstance(series_raw, list) or not 1 <= len(series_raw) <= CHART_SERIES_MAX:
        return None, "chart_series"
    if chart_type == "pie" and (len(series_raw) != 1 or len(x) > CHART_PIE_SLICES_MAX):
        return None, "chart_series"
    series: list[dict] = []
    for item in series_raw:
        if not isinstance(item, dict):
            return None, "chart_series"
        name = text(item.get("name"), SERIES_NAME_MAX)
        values_raw = item.get("values")
        if not name or not isinstance(values_raw, list) or len(values_raw) != len(x):
            return None, "chart_series"
        values = [_number(v) for v in values_raw]
        if any(v is None for v in values):
            return None, "chart_series"
        one: dict = {"name": name, "values": values}
        tone = _tone(item.get("tone"))
        if tone:
            one["tone"] = tone
        series.append(one)
    body: dict = {"type": chart_type, "x": x, "series": series}
    unit = text(raw.get("unit"), UNIT_MAX)
    if unit:
        body["unit"] = unit
    y_raw = raw.get("y")
    if y_raw is not None:
        if not isinstance(y_raw, dict):
            return None, "chart_y"
        y: dict = {}
        for key in ("min", "max"):
            if y_raw.get(key) is not None:
                number = _number(y_raw.get(key))
                if number is None:
                    return None, "chart_y"
                y[key] = number
        if "min" in y and "max" in y and not y["min"] < y["max"]:
            return None, "chart_y"
        if y:
            body["y"] = y
    return body, ""


def _map(raw: dict) -> tuple[dict | None, str]:
    """A point. Numbers only: the frontend builds the OpenStreetMap embed
    from them, so no string of the caller's ever reaches that `src`."""
    lat = _number(raw.get("lat"))
    lon = _number(raw.get("lon"))
    if lat is None or lon is None or not -90 <= lat <= 90 or not -180 <= lon <= 180:
        return None, "map_point"
    zoom_number = _number(raw.get("zoom"))
    zoom = MAP_ZOOM_DEFAULT if zoom_number is None else int(round(zoom_number))
    zoom = min(MAP_ZOOM_MAX, max(MAP_ZOOM_MIN, zoom))
    body: dict = {"lat": lat, "lon": lon, "zoom": zoom}
    label = text(raw.get("label"), LABEL_MAX)
    if label:
        body["label"] = label
    return body, ""


def _video(raw: dict) -> tuple[dict | None, str]:
    """A YouTube or Vimeo player, or a direct media file. The output carries
    the normalised `url` and exactly one of `embed` (an address built here
    from the id that matched) or `media` (the normalised address itself).
    A loopback host is allowed: a file served off this machine is his."""
    url = raw.get("url")
    if url_problem(url, allow_loopback=True):
        return None, "video_url"
    normalised = normalise_url(url)
    scheme, host, port, path, query = _split(normalised)
    how, target = _video_target(host, path, query)
    if how == "embed":
        return {"url": normalised, "embed": target}, ""
    if how == "media":
        return {"url": normalised, "media": normalised}, ""
    return None, "video_url"


def _web(raw: dict) -> tuple[dict | None, str]:
    """A page in a frame beside the orb. Not JARVIS's own host — see
    `url_problem`. Whether the site allows framing is the site's decision;
    the frontend shows the refusal when it does not."""
    url = raw.get("url")
    if url_problem(url):
        return None, "web_url"
    return {"url": normalise_url(url)}, ""


def _vector(value, low: float, high: float) -> list[float] | None:
    """Three finite numbers each within [low, high], or None."""
    if not isinstance(value, list) or len(value) != 3:
        return None
    numbers = [_number(v) for v in value]
    if any(n is None or not low <= n <= high for n in numbers):
        return None
    return numbers


def _colour(value) -> str | None:
    """A tone name, or "#rrggbb" lower-cased. Nothing else — a colour is a
    CSS value on the frontend, and `url(...)` is a colour to a browser."""
    tone = _tone(value)
    if tone:
        return tone
    raw = str(value or "")
    if len(raw) == 7 and raw[0] == "#" and all(c in string.hexdigits for c in raw[1:]):
        return raw.lower()
    return None


def _scene(raw: dict) -> tuple[dict | None, str]:
    """Primitives with a position, a size, a rotation and a colour. The
    frontend renders these shapes and nothing else: no model files, no
    textures, no URLs — a scene is numbers and names."""
    objects_raw = raw.get("objects")
    if not isinstance(objects_raw, list) or not 1 <= len(objects_raw) <= SCENE_OBJECTS_MAX:
        return None, "scene_objects"
    objects: list[dict] = []
    ids: set[str] = set()
    for item in objects_raw:
        if not isinstance(item, dict):
            return None, "scene_objects"
        object_id = text(item.get("id"), ID_MAX)
        shape = str(item.get("shape") or "")
        if not object_id or shape not in SHAPES:
            return None, "scene_objects"
        if object_id in ids:
            return None, "scene_ids"
        ids.add(object_id)
        position_raw = item.get("position")
        position = ([0.0, 0.0, 0.0] if position_raw is None
                    else _vector(position_raw, -SCENE_EXTENT, SCENE_EXTENT))
        if position is None:
            return None, "scene_objects"
        size_raw = item.get("size")
        if size_raw is None:
            size = [1.0, 1.0, 1.0]
        elif isinstance(size_raw, list):
            size = _vector(size_raw, SCENE_SIZE_MIN, SCENE_SIZE_MAX)
        else:
            scalar = _number(size_raw)
            size = ([scalar] * 3 if scalar is not None
                    and SCENE_SIZE_MIN <= scalar <= SCENE_SIZE_MAX else None)
        if size is None:
            return None, "scene_objects"
        obj: dict = {"id": object_id, "shape": shape, "position": position, "size": size}
        rotation_raw = item.get("rotation")
        if rotation_raw is not None:
            rotation = _vector(rotation_raw, -SCENE_ROTATION_MAX, SCENE_ROTATION_MAX)
            if rotation is None:
                return None, "scene_objects"
            obj["rotation"] = rotation
        colour = _colour(item.get("color"))
        if colour:
            obj["color"] = colour
        label = text(item.get("label"), LABEL_MAX)
        if label:
            obj["label"] = label
        objects.append(obj)
    autorotate = raw.get("autorotate")
    grid = raw.get("grid")
    body: dict = {"objects": objects,
                  "autorotate": True if autorotate is None else _flag(autorotate),
                  "grid": True if grid is None else _flag(grid)}
    return body, ""


_VALIDATORS = {
    "diagram": _diagram,
    "table": _table,
    "steps": _steps,
    "bars": _bars,
    "cards": _cards,
    "text": _text,
    "chart": _chart,
    "map": _map,
    "video": _video,
    "web": _web,
    "scene": _scene,
}


def validate(raw) -> tuple[dict | None, str]:
    """(clean spec, "") or (None, problem key). See `PROBLEMS` for the words.

    The spec is flat: `kind` and `title` beside the kind's own fields
    (`nodes`/`edges`, `columns`/`rows`, `items`). A brain that nests them
    under the kind's name instead is met halfway.

    `semantic` survives only as the one value it may have. The server-set
    keys — `id`, `at`, `source`, `observed_at`, `overflow` — are never read
    from the caller, so a spec cannot arrive already wearing them. Nor is the
    kind `image`: it is not in `KINDS`, so a caller sending it gets the
    "kind" refusal, and only `image_visual` builds one.

    The size cap is checked twice: on the raw object before anything is
    read, and on the CLEAN spec, which is what is actually stored and sent.
    Today normalising can only pad (a short table row is squared to its
    columns); the second check is there so that stays a fact about the code
    rather than an assumption.
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
    semantic = str(raw.get("semantic") or "")
    if semantic in SEMANTICS:
        clean["semantic"] = semantic
    clean.update(body)
    if len(json.dumps(clean, ensure_ascii=False)) > SPEC_BYTES_MAX:
        return None, "too_big"
    return clean, ""


# --- the server's own kind: a capture ---------------------------------------------

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_dimensions(png: bytes) -> tuple[int, int] | None:
    """(width, height) out of the IHDR chunk, which a PNG always opens with:
    bytes 16..24, two big-endian unsigned ints. None when the bytes are too
    short, or the chunk is not where a PNG keeps it."""
    if len(png) < 24 or png[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", png[16:24])
    if width <= 0 or height <= 0:
        return None
    return width, height


def image_visual(png: bytes, *, title, caption="", width=None, height=None) -> dict:
    """A picture the SERVER took — of a page, of the user's screen — as a
    visual. Not reachable through `validate`: a caller cannot send bytes and
    must not be able to claim a capture.

    Raises ValueError("image_not_png") when the bytes do not open with the
    PNG signature and ValueError("image_too_big") when the base64 would be
    over `IMAGE_B64_MAX`. Width and height are read off the IHDR chunk when
    not given. The result is `ephemeral`: `Store.add` keeps it current and
    never in the history — a capture is shown, not kept.
    """
    data = bytes(png) if isinstance(png, (bytes, bytearray, memoryview)) else b""
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("image_not_png")
    encoded = base64.b64encode(data).decode("ascii")
    if len(encoded) > IMAGE_B64_MAX:
        raise ValueError("image_too_big")
    clean: dict = {"kind": "image", "title": text(title, TITLE_MAX) or "A picture"}
    words = text(caption, CAPTION_MAX)
    if words:
        clean["caption"] = words
    if width is None or height is None:
        size = _png_dimensions(data)
        if size is not None:
            width, height = size
    if width is not None and height is not None and int(width) > 0 and int(height) > 0:
        clean["width"] = int(width)
        clean["height"] = int(height)
    clean["png"] = encoded
    clean["ephemeral"] = True
    return clean


# --- the history --------------------------------------------------------------

class Store:
    """What is on the display now, and what has been.

    In memory, newest first, `HISTORY_MAX` deep: the display is a
    conversation aid, not a record, and the dashboard's Display tab says
    "since JARVIS started". `version` moves on every change so a hint socket
    can say "something moved" without carrying content.

    One visual may be EPHEMERAL — a capture of a page or of the user's
    screen. It is current like any other (`current`, `current_id`, `get`)
    for as long as it is up, and it is never in the history: `clear` drops
    it, the next `add` replaces it, and `history()` never lists it. So while
    a capture is up, `current_id` names a visual `history()` does not hold.
    That is intended, and `/api/visuals` says so.
    """

    def __init__(self, limit: int = HISTORY_MAX):
        self._items: deque = deque(maxlen=limit)
        self._ephemeral: dict | None = None
        self._count = 0
        self.current_id: str | None = None
        self.version = 0

    def add(self, clean: dict, source: str, ephemeral: bool = False) -> dict:
        """Record a validated spec as the current visual and return it with
        its id, timestamp and source attached. Everything else in `clean`
        is kept as it is — including the keys `network_visual` set after
        validation (`observed_at`, `overflow`). An `ephemeral` visual
        becomes current and nothing more: it is not placed in the history,
        and whatever ephemeral visual was up before is gone."""
        self._count += 1
        visual = dict(clean)
        visual["id"] = "v%d" % self._count
        visual["at"] = time.time()
        visual["source"] = text(source, SOURCE_MAX) or "JARVIS"
        if ephemeral:
            visual["ephemeral"] = True
            self._ephemeral = visual
        else:
            self._ephemeral = None
            self._items.appendleft(visual)
        self.current_id = visual["id"]
        self.version += 1
        return visual

    @property
    def current(self) -> dict | None:
        return self.get(self.current_id) if self.current_id else None

    def clear(self) -> None:
        """Take the display down. The history keeps the visual; a capture
        is dropped."""
        self._ephemeral = None
        if self.current_id is not None:
            self.current_id = None
            self.version += 1

    def get(self, visual_id: str | None) -> dict | None:
        if self._ephemeral is not None and self._ephemeral["id"] == visual_id:
            return self._ephemeral
        for item in self._items:
            if item["id"] == visual_id:
                return item
        return None

    def history(self) -> list[dict]:
        """Newest first, and never the ephemeral one."""
        return list(self._items)


# --- the network map ------------------------------------------------------------

def _ago(seconds: float) -> str:
    if seconds < 45:
        return "just now"
    if seconds < 3600:
        return "%d minutes ago" % max(1, round(seconds / 60))
    return "%d hours ago" % max(1, round(seconds / 3600))


def _open_ports(ports: list) -> list:
    """The ports `nmap` reported open, by its own state word."""
    return [p for p in ports if getattr(p, "state", "") == "open"]


def _ports_note(ports: list) -> str:
    """"ssh, http, https" or "5 open ports" — nmap's service names, from its
    own table, never a device's. The line under a label."""
    open_ports = _open_ports(ports)
    if not open_ports:
        return "nothing open"
    names = [p.service or str(p.number) for p in open_ports]
    if len(names) <= 3:
        return ", ".join(names)
    return "%d open ports" % len(names)


# The three things the Ports detail can say. `scan_host` without a port list
# runs `nmap -F`, which is nmap's hundred most common ports.
PORTS_NONE_OPEN = "none open in the 100 scanned"
PORTS_NOT_SCANNED = "not scanned"


def _ports_detail(ports: list | None) -> str:
    """The Ports line of a device's details: the open list as nmap printed
    it ("22 ssh, 80 http, 443 https"), what an empty list means, or that
    nobody has looked. Observed or absent — never inferred."""
    if ports is None:
        return PORTS_NOT_SCANNED
    open_ports = _open_ports(ports)
    if not open_ports:
        return PORTS_NONE_OPEN
    return ", ".join(("%d %s" % (p.number, p.service or "")).strip()
                     for p in open_ports)


def _ip_key(address: str) -> tuple:
    """Numeric order for addresses, so which devices make the cut on a
    crowded network depends on where they sit and not on the order nmap
    happened to print them. Anything that is not an address sorts last."""
    try:
        return (0, int(ipaddress.ip_address(address)), "")
    except ValueError:
        return (1, 0, str(address))


def _network_nodes(network: str, devices: list, *, own_address: str | None,
                   gateway: str | None, ports_by_address: dict,
                   budget: int) -> tuple[list, list, int]:
    """(nodes, edges, devices shown) for a map of at most `budget` nodes.

    The router is the hub when it answered; otherwise the network itself is,
    as a node that is not a device. When the devices will not all fit, the
    router and this Mac are always kept, the rest are taken in numeric
    order, and one "n more devices" node — not a device either — stands for
    the remainder. Edges run from the hub to every node that is drawn and
    to nothing that is not.
    """
    addresses = [d.address for d in devices]
    hub_is_device = bool(gateway) and gateway in addresses
    hub_id = gateway if hub_is_device else "network"

    slots = budget - (0 if hub_is_device else 1)
    if len(devices) > slots:
        slots -= 1                                  # room for the "more" node
        chosen = {a for a in (gateway, own_address) if a and a in addresses}
        for address in sorted(addresses, key=_ip_key):
            if len(chosen) >= slots:
                break
            chosen.add(address)
        shown_devices = [d for d in devices if d.address in chosen]
    else:
        shown_devices = list(devices)
    omitted = len(devices) - len(shown_devices)

    nodes: list[dict] = []
    edges: list[dict] = []
    if not hub_is_device:
        nodes.append({"id": hub_id, "label": text(network, LABEL_MAX) or "network",
                      "sub": "router not answering" if gateway else "",
                      "tone": "accent", "hub": True, "icon": "network"})
    for device in shown_devices:
        name = text(getattr(device, "name", ""), LABEL_MAX)
        node: dict = {"id": device.address,
                      "label": name or device.address,
                      "icon": "device"}
        subs: list[str] = []
        if name:
            subs.append(device.address)
        if device.address == own_address:
            subs.append("this Mac")
            node["tone"] = "ok"
            node["icon"] = "computer"
        if device.address == gateway:
            subs.insert(0, "router")
            node["tone"] = "accent"
            node["hub"] = True
            node["icon"] = "gateway"
        ports = ports_by_address.get(device.address)
        if ports is not None:
            subs.append(_ports_note(ports))
        node.setdefault("tone", "idle")
        sub = text(" · ".join(s for s in subs if s), SUB_MAX)
        if sub:
            node["sub"] = sub
        # What discovery actually returned, and nothing it did not: the
        # address, the name the device (or its DNS) gave, and the ports if
        # anyone has looked. Never a guess at what the device IS.
        details = [{"label": "Address", "value": device.address}]
        if name:
            details.append({"label": "Name",
                            "value": text(getattr(device, "name", ""), DETAIL_VALUE_MAX)})
        # Bounded HERE as well as in `validate`, so the raw spec is already
        # the size the clean one will be and the budget loop in
        # `network_visual` only ever shrinks a map that truly does not fit.
        details.append({"label": "Ports",
                        "value": text(_ports_detail(ports), DETAIL_VALUE_MAX)})
        node["details"] = details
        nodes.append(node)
        if device.address != hub_id:
            edges.append({"from": hub_id, "to": device.address})
    if omitted:
        nodes.append({"id": "more",
                      "label": "%d more device%s" % (omitted, "" if omitted == 1 else "s"),
                      "sub": "not shown", "icon": "network", "tone": "dim"})
        edges.append({"from": hub_id, "to": "more"})
    return nodes, edges, len(shown_devices)


def _network_caption(network: str, discovered: int, shown: int,
                     age_seconds: float, complete: bool) -> str:
    """One truthful line: how many answered, how many are drawn when that
    is fewer, and how old the sweep is."""
    where = text(network, LABEL_MAX) or "network"
    when = _ago(age_seconds)
    omitted = discovered - shown
    if omitted:
        caption = "%d discovered on %s · %d shown · %d more · swept %s" % (
            discovered, where, shown, omitted, when)
    else:
        caption = "%d device%s answering on %s · swept %s" % (
            discovered, "" if discovered == 1 else "s", where, when)
    if not complete:
        caption += " · the sweep ran out of time"
    return caption


def network_visual(network: str, devices: list, *, own_address: str | None,
                   gateway: str | None, ports_by_address: dict,
                   age_seconds: float, complete: bool = True,
                   observed_at: float | None = None) -> dict:
    """The LAN as a diagram: the router in the middle, every device that
    answered around it, this Mac marked, and what is open on anything that
    has been port-scanned. Built from `net_scan`'s own results; the names
    are what the devices call themselves and go into labels and details,
    which the frontend renders as text.

    At most `NODES_MAX` nodes, hub and overflow node included — see
    `_network_nodes` for who is kept. The spec goes through `validate` like
    any other, and should forty nodes of long names still not fit the size
    cap, the budget comes down a node at a time until it does; the caption
    and the `overflow` counts describe what is actually drawn. `observed_at`
    (when the sweep finished) and `overflow` are attached AFTER validation:
    they are the server's to set, and `validate` drops them from anyone
    else.
    """
    discovered = len(devices)
    budget = NODES_MAX
    while True:
        nodes, edges, shown = _network_nodes(
            network, devices, own_address=own_address, gateway=gateway,
            ports_by_address=ports_by_address, budget=budget)
        spec = {"kind": "diagram", "title": "Your network",
                "caption": _network_caption(network, discovered, shown,
                                            age_seconds, complete),
                "semantic": "network",
                "nodes": nodes, "edges": edges, "layout": "radial"}
        clean, problem = validate(spec)
        if clean is not None:
            break
        if problem != "too_big" or budget <= 3:          # pragma: no cover
            raise ValueError(problem)
        budget -= 1
    if observed_at is not None:
        clean["observed_at"] = float(observed_at)
    if shown < discovered:
        clean["overflow"] = {"discovered": discovered, "shown": shown}
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
