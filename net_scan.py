"""The user's own network, through `nmap`: what is on it, and what a device
on it answers on.

"What's on my network?", "is the printer online?", "what's open on the
router?" — questions about the LAN in the room, and `nmap` is on this machine
and answers them in seconds. Same shape as `gh_lookup`: a binary the user
already has, driven as an argument list with a deadline, with the speaking
half in `server.py`.

Three rules hold this file together:

1. **It scans the user's own network and nothing else.** Every target is
   checked before `nmap` sees it: an address, a range or a network must not
   be globally routable (`ipaddress`'s `is_global`), and a name is resolved
   HERE first and refused if it points anywhere public. `nmap` is then handed
   the ADDRESS that passed, never the name, so what it scans is what was
   checked. JARVIS is a home assistant, not a reconnaissance tool, and that
   line is drawn in code rather than in the prompt.
2. **`nmap` is a subprocess taking model-derived input.** Every call is an
   argument LIST — no shell, nothing for a semicolon to end — every target
   has to `fullmatch` a grammar that cannot begin with `-` (so a target can
   never become an option), and every call has a deadline that kills it.
3. **A tool call has to return inside the tool deadline.** `jarvis_mcp.TIMEOUT_SEC`
   is 20s, and past it the brain is told the server is unreachable while the
   work carries on regardless. A port scan of one device fits (`nmap -F` on
   the router: 5.7s). A sweep of a /24 does NOT, and no flag makes it:
   measured here, unprivileged, 20.9s at nmap's defaults, 24.7s with `_FAST`,
   19.5s with `--min-parallelism 128` — about thirteen addresses a second
   whatever nmap is told, because without raw sockets every probe to a silent
   address is a connect() the kernel holds while its ARP lookup fails, and
   the kernel paces those. So a sweep runs as a BACKGROUND task
   (`sweep_or_wait`): one call starts it and waits a while, a call that finds
   it still running says so and the brain asks again, and a finished sweep is
   answered from for a few minutes so the same question twice is one scan.
   `_run_nmap` still reads output line by line, so a scan killed at its hard
   cap hands back what it had found rather than nothing.

No new dependency: `nmap`, `asyncio`, `ipaddress`, `socket`, `re`.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import shutil
import socket
import time
from dataclasses import dataclass, field

log = logging.getLogger("jarvis.net")

# The whole scan, end to end, comfortably inside `jarvis_mcp.TIMEOUT_SEC`.
DEADLINE = 15.0

# Resolving one name. A LAN resolver answers in milliseconds; a name that
# takes longer than this is not a device in the room.
LOOKUP_TIMEOUT = 3.0

# The widest network one sweep will take: a /22 is 1,024 addresses, four
# times a home /24, and already at the edge of the deadline.
WIDEST_PREFIX = 22

# LAN timing. Round trips in the room are single-digit milliseconds, so a
# half-second timeout with one retry loses nothing a device would have
# answered, and cuts the wait on the 249 addresses that will never answer
# from twenty seconds to a few. Unprivileged `nmap` (no raw sockets) does its
# host discovery with TCP connects to 80 and 443, which these govern too.
_FAST = ["-T4", "--max-retries", "1",
         "--max-rtt-timeout", "500ms", "--initial-rtt-timeout", "200ms"]

# --- what a target may look like -------------------------------------------
#
# No `^`, no `$`, and used ONLY with `fullmatch`: Python's `$` matches before
# a trailing newline, and tests/test_anchored_patterns.py holds every anchored
# pattern in this repository to the rule. None of these can begin with `-`,
# which is what keeps a target from ever being read by `nmap` as an option.
_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
_IPV4 = rf"{_OCTET}(?:\.{_OCTET}){{3}}"
ADDRESS_RE = re.compile(_IPV4)
NETWORK_RE = re.compile(rf"{_IPV4}/(?:3[0-2]|[12]?\d)")
RANGE_RE = re.compile(rf"{_IPV4}-{_OCTET}")
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})"
HOSTNAME_RE = re.compile(rf"{_LABEL}(?:\.{_LABEL})*\.?")
# `nmap -p`: numbers and ranges, comma-separated. Nothing else — no `T:`, no
# service names, no `-` on its own — so the value can never be an option.
PORTS_RE = re.compile(r"\d{1,5}(?:-\d{1,5})?(?:,\d{1,5}(?:-\d{1,5})?){0,63}")


@dataclass
class Target:
    """What is to be scanned, once it has been checked — or why it will not be.

    `problem` is a short machine-readable cause the caller turns into a
    sentence: shape, too_wide, not_local, unresolved, no_network. `given` is
    only ever set to text that passed the grammar, so it is safe in a
    sentence; `address` is what `nmap` is actually handed.
    """
    given: str = ""
    address: str = ""
    kind: str = ""           # host | range | network
    problem: str = ""


@dataclass
class Port:
    number: int
    protocol: str
    state: str
    service: str = ""        # nmap's own guess from its services table


@dataclass
class Device:
    address: str
    name: str = ""           # reverse DNS: what the device (or its DNS) calls itself
    ports: list[Port] = field(default_factory=list)
    ignored: int = 0         # ports nmap folded into one "Ignored State" count


@dataclass
class Scan:
    """One scan's answer. `problem` is "", no_nmap, timeout or failed; a
    timeout may still carry the devices found before the deadline."""
    target: Target
    devices: list[Device] = field(default_factory=list)
    complete: bool = True
    problem: str = ""
    addresses: int = 0       # how many addresses nmap says it covered
    seconds: float = 0.0


# --- the user's own network, and nothing else -------------------------------

def _local(addr: ipaddress.IPv4Address) -> bool:
    """On the user's side of the router. Private ranges, link-local, loopback
    and the shared 100.64/10 that overlay networks use all pass; anything
    routable on the internet, multicast and the reserved block do not."""
    return not (addr.is_global or addr.is_multicast
                or addr.is_unspecified or addr.is_reserved)


def own_address() -> str | None:
    """This machine's address on its default route, or None when it has none.

    A UDP `connect` sends nothing; it only asks the kernel which interface
    would carry a packet to that address. TEST-NET-1 is never allocated, so
    nothing could answer even if a packet were sent.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return str(s.getsockname()[0])
    except OSError:
        return None


def default_network() -> str | None:
    """The /24 this machine sits in, as `nmap` wants it, or None.

    A /24 is assumed rather than read: the standard library has no way to
    ask an interface for its netmask, and a home network is a /24 in
    practice. Anyone on a wider one names it — `resolve_target` takes a
    network up to a /22.
    """
    address = own_address()
    if not address or not ADDRESS_RE.fullmatch(address):
        return None
    if not _local(ipaddress.ip_address(address)):
        return None
    return str(ipaddress.ip_network(f"{address}/24", strict=False))


async def _lookup(host: str) -> list[str]:
    """Every IPv4 address a name resolves to, or [] if it does not (or takes
    too long). Its own function so a test can replace it."""
    def _do() -> list[str]:
        infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
        return sorted({str(info[4][0]) for info in infos})
    try:
        return await asyncio.wait_for(asyncio.to_thread(_do), LOOKUP_TIMEOUT)
    except (socket.gaierror, OSError, asyncio.TimeoutError, TimeoutError):
        return []


async def resolve_target(spoken: str | None) -> Target:
    """Check what the brain asked for. Nothing here has touched `nmap` yet.

    An empty target is the network this machine is on. Everything else must
    be an address, a range on the last octet, a network in CIDR form, or a
    name — and every one of them must land on the user's own side of the
    router before it is allowed through.
    """
    text = " ".join(str(spoken or "").split())
    if not text:
        network = default_network()
        if network is None:
            return Target(problem="no_network")
        return Target(given=network, address=network, kind="network")
    if len(text) > 253:
        return Target(problem="shape")

    if NETWORK_RE.fullmatch(text):
        network = ipaddress.ip_network(text, strict=False)
        if network.prefixlen < WIDEST_PREFIX:
            return Target(given=text, problem="too_wide")
        if not (_local(network.network_address) and _local(network.broadcast_address)):
            return Target(given=text, problem="not_local")
        return Target(given=text, address=str(network), kind="network")

    if RANGE_RE.fullmatch(text):
        first, _, last_octet = text.partition("-")
        start = ipaddress.ip_address(first)
        stem = first.rsplit(".", 1)[0]
        end = ipaddress.ip_address(f"{stem}.{last_octet}")
        if end < start:
            return Target(problem="shape")
        if not (_local(start) and _local(end)):
            return Target(given=text, problem="not_local")
        return Target(given=text, address=text, kind="range")

    if ADDRESS_RE.fullmatch(text):
        if not _local(ipaddress.ip_address(text)):
            return Target(given=text, problem="not_local")
        return Target(given=text, address=text, kind="host")

    if HOSTNAME_RE.fullmatch(text):
        addresses = await _lookup(text.rstrip("."))
        if not addresses:
            return Target(given=text, problem="unresolved")
        if not all(_local(ipaddress.ip_address(a)) for a in addresses):
            return Target(given=text, problem="not_local")
        # The checked address, not the name: `nmap` resolving the name again
        # could be given a different answer than we were.
        return Target(given=text, address=addresses[0], kind="host")

    return Target(problem="shape")


def ports_problem(ports: str) -> str:
    """"" if `ports` is something `nmap -p` may be handed, else a cause."""
    text = str(ports or "").strip()
    if not text:
        return ""
    if not PORTS_RE.fullmatch(text):
        return "shape"
    for piece in text.split(","):
        lo, _, hi = piece.partition("-")
        if int(lo) > 65535 or (hi and (int(hi) > 65535 or int(hi) < int(lo))):
            return "shape"
    return ""


# --- the subprocess ---------------------------------------------------------

def nmap_path() -> str | None:
    """Where `nmap` is, or None. Its own function so a test can move it."""
    return shutil.which("nmap")


async def _run_nmap(args: list[str], timeout: float) -> tuple[int | None, list[str], str]:
    """(returncode, stdout lines, stderr) for one `nmap` call.

    THE seam. An argument list, never a command string: the target in `args`
    came out of a language model, by way of speech recognition, and possibly
    out of somebody's web page before that.

    Output is read a line at a time into a list that survives the deadline,
    so a scan killed at `timeout` still hands back the hosts it had reported.
    `returncode` is None in that case.
    """
    binary = nmap_path()
    if binary is None:
        raise FileNotFoundError("nmap")
    proc = await asyncio.create_subprocess_exec(
        binary, *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    assert proc.stdout is not None and proc.stderr is not None
    # Drained alongside stdout so a chatty stderr can never fill its pipe and
    # stall the child before it has finished writing the lines we want.
    err_task = asyncio.ensure_future(proc.stderr.read())
    lines: list[str] = []

    async def _drain() -> None:
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                return
            lines.append(raw.decode("utf-8", errors="replace").rstrip("\r\n"))

    try:
        await asyncio.wait_for(_drain(), timeout)
    except (asyncio.TimeoutError, TimeoutError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        err_task.cancel()
        try:
            await asyncio.wait_for(proc.wait(), 2.0)
        except (asyncio.TimeoutError, TimeoutError):
            pass
        return None, lines, ""

    try:
        err = await asyncio.wait_for(err_task, 2.0)
    except (asyncio.TimeoutError, TimeoutError, asyncio.CancelledError):
        err = b""
    await proc.wait()
    return proc.returncode, lines, err.decode("utf-8", errors="replace")


# --- reading what nmap says -------------------------------------------------
#
# Grepable output (`-oG -`): one line per host, tab-separated `Key: value`
# fields, and `#` comment lines around them. Chosen over XML because it is
# line-oriented — a scan killed at the deadline leaves whole lines behind,
# where it would leave an unparseable half of a document.
#
#   Host: 192.168.1.13 (adguard)\tStatus: Up
#   Host: 192.168.1.1 ()\tPorts: 22/open/tcp//ssh///, 80/open/tcp//http///\tIgnored State: filtered (97)
#   # Nmap done at ... -- 256 IP addresses (7 hosts up) scanned in 5.20 seconds

_HOST_RE = re.compile(r"Host: (\S+) \((.*)\)")
_DONE_RE = re.compile(r"(\d+) IP address(?:es)? \((\d+) hosts? up\) scanned in ([\d.]+) seconds")
_IGNORED_RE = re.compile(r"\((\d+)\)")


def _parse_ports(value: str) -> list[Port]:
    out: list[Port] = []
    for entry in value.split(","):
        parts = entry.strip().split("/")
        # port/state/protocol/owner/service/rpc info/version
        if len(parts) < 5 or not parts[0].isdigit():
            continue
        out.append(Port(number=int(parts[0]), protocol=parts[2] or "tcp",
                        state=parts[1], service=parts[4]))
    return out


def parse_grepable(lines: list[str]) -> tuple[list[Device], int, float, bool]:
    """(devices, addresses covered, seconds, whether nmap finished)."""
    devices: dict[str, Device] = {}
    order: list[str] = []
    addresses, seconds, done = 0, 0.0, False
    for line in lines:
        if line.startswith("#"):
            m = _DONE_RE.search(line)
            if m:
                addresses, seconds, done = int(m.group(1)), float(m.group(3)), True
            continue
        fields = line.split("\t")
        m = _HOST_RE.fullmatch(fields[0])
        if not m:
            continue
        address, name = m.group(1), m.group(2)
        rest: dict[str, str] = {}
        for f in fields[1:]:
            key, _, value = f.partition(": ")
            rest[key.strip()] = value
        if rest.get("Status", "").strip() == "Down":
            continue
        dev = devices.get(address)
        if dev is None:
            dev = devices[address] = Device(address=address, name=name)
            order.append(address)
        elif name and not dev.name:
            dev.name = name
        if "Ports" in rest:
            dev.ports.extend(_parse_ports(rest["Ports"]))
        if "Ignored State" in rest:
            m2 = _IGNORED_RE.search(rest["Ignored State"])
            if m2:
                dev.ignored += int(m2.group(1))
    return [devices[a] for a in order], addresses, seconds, done


# --- the two scans ----------------------------------------------------------

async def _scan(target: Target, mode: list[str], deadline: float) -> Scan:
    args = [*mode, *_FAST, "-oG", "-", target.address]
    try:
        rc, lines, err = await _run_nmap(args, deadline)
    except FileNotFoundError:
        return Scan(target, problem="no_nmap")
    devices, addresses, seconds, done = parse_grepable(lines)
    scan = Scan(target, devices=devices, addresses=addresses, seconds=seconds)
    if rc is None:
        scan.complete = False
        scan.problem = "timeout"
        log.warning("nmap %s overran %.0fs; %d hosts reported before the kill",
                    mode[0], deadline, len(devices))
    elif rc != 0 or not done:
        scan.complete = False
        scan.problem = "failed"
        log.warning("nmap %s exited %s: %s", mode[0], rc, err.strip()[:300])
    return scan


async def sweep(target: Target, deadline: float = DEADLINE) -> Scan:
    """Which addresses answer: host discovery, no ports. Runs to `deadline`
    and is killed there — see `sweep_or_wait` for the one the tools use."""
    return await _scan(target, ["-sn"], deadline)


# --- the sweep, in the background --------------------------------------------
#
# See rule 3 at the top: a /24 takes ~20s unprivileged and the tool call has
# to be back inside 20s. So the sweep is a task the server keeps, and a call
# is a WAIT on it, not the scan itself.

# How long one tool call waits for a sweep before saying "still going". Leaves
# room inside `jarvis_mcp.TIMEOUT_SEC` for resolving the target and speaking.
SWEEP_WAIT = 12.0

# When a background sweep is killed regardless. A /22 at thirteen addresses a
# second is ~80s; anything slower than that is not going to finish.
SWEEP_CAP = 90.0

# How long a finished sweep is answered from. "What's on my network" twice in
# ten minutes is one scan, and the answer says how old it is.
RESULT_TTL = 600.0


@dataclass
class SweepAnswer:
    """What one call to `sweep_or_wait` came back with.

    `status` is "done" (finished during this call), "cached" (finished
    earlier; `age` says how long ago) or "running" (`elapsed` says how long
    it has been going; `scan` is None).
    """
    status: str
    scan: Scan | None = None
    elapsed: float = 0.0
    age: float = 0.0


@dataclass
class _Sweep:
    target: Target
    task: "asyncio.Task[Scan]"
    started: float
    finished: float = 0.0


_sweeps: dict[str, _Sweep] = {}


def _now() -> float:
    """Monotonic seconds. Its own function so a test can move the clock."""
    return time.monotonic()


def _finished_cleanly(current: _Sweep) -> bool:
    task = current.task
    return (task.done() and not task.cancelled()
            and task.exception() is None)


async def sweep_or_wait(target: Target, *, fresh: bool = False,
                        wait: float | None = None, cap: float | None = None,
                        ttl: float | None = None) -> SweepAnswer:
    """The sweep of `target`, started if it is not running, waited on for
    `wait` seconds, and answered from a recent finish unless `fresh`.

    One sweep per target at a time: a second call while one is running
    joins it rather than starting another nmap. The three timings default
    to the module constants at CALL time, so a test (or an operator) can
    move them without re-importing.
    """
    wait = SWEEP_WAIT if wait is None else wait
    cap = SWEEP_CAP if cap is None else cap
    ttl = RESULT_TTL if ttl is None else ttl
    key = target.address
    current = _sweeps.get(key)
    if current is not None and _finished_cleanly(current):
        if not fresh and _now() - current.finished <= ttl:
            return SweepAnswer("cached", current.task.result(),
                               age=_now() - current.finished)
        current = None                    # stale, or a fresh one was asked for
    if current is None or current.task.done():
        task = asyncio.ensure_future(sweep(target, deadline=cap))
        current = _sweeps[key] = _Sweep(target=target, task=task, started=_now())

        def _mark(_t, s=current):
            s.finished = _now()
        task.add_done_callback(_mark)
    try:
        # `shield`: the caller's patience running out must not cancel the scan.
        scan = await asyncio.wait_for(asyncio.shield(current.task), wait)
    except (asyncio.TimeoutError, TimeoutError):
        return SweepAnswer("running", elapsed=_now() - current.started)
    return SweepAnswer("done", scan)


async def ports(target: Target, which: str | None = None,
                deadline: float = DEADLINE) -> Scan:
    """What one device answers on: the hundred most common TCP ports, or the
    ones asked for. `which` must already have passed `ports_problem`."""
    if which and ports_problem(which):
        raise ValueError("ports")
    select = ["-p", which] if which else ["-F"]
    # nmap's own per-host deadline sits inside ours, so it stops and prints
    # what it has rather than being killed with nothing written.
    host_timeout = f"{max(1, int(deadline) - 3)}s"
    return await _scan(target, [*select, "--host-timeout", host_timeout], deadline)
