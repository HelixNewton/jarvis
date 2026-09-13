# What changed, against the original JARVIS

This is not the old JARVIS with features bolted
on; the thing at the centre was replaced.

This file exists so JARVIS can answer "how are you different now?" out loud.
Keep it accurate: he reads it, and he will say what it says.

---

## The one that changes everything: whose Claude is JARVIS

**Public:** an Anthropic API client. `requirements.txt` installs the
`anthropic` SDK, `.env.example` demands an `ANTHROPIC_API_KEY`, and every
reply is a metered API call — Haiku for conversation, Opus for research. Talk
to him for an evening and it appears on a bill.

**Here:** his brain is a **Claude Code process running on your own
subscription** — the same login you use in the terminal. There is no
Anthropic SDK in `requirements.txt`, no API key on the voice path, and no way
to put one there: every child is launched through `claude_env.child_env()`,
which strips every `ANTHROPIC_*` variable out of the environment first. That
is deliberate rather than tidy — the CLI silently *prefers* an inherited key
over your login, and `claude auth status` goes on reporting `loggedIn: true`
while the billing quietly moves. So the key is removed rather than trusted.

The honest cost question stopped being "how many dollars" and became "how much
of my five-hour and seven-day windows is gone", which is what the Usage tab
answers.

## JARVIS stopped being a voice and became a foreman

Public JARVIS answers questions and can fire off actions. This one runs work
and watches it:

- **A conversation is the design phase.** He brainstorms one question at a
  time, offers a couple of approaches, and starts nothing until you agree.
- **What you agreed gets written down** as a spec file inside the project
  being built, before any process is spawned. You approve it by voice, by
  section number.
- **A build is a real Claude Code session** handed a brief: write a phased
  plan, review it against the spec, then execute task by task under
  test-driven development, ticking the plan's checkboxes. "How far has it
  got" is answered by reading those boxes, not by guessing.
- **He watches every Claude Code session on the machine** — not only his own.
  Ask which are waiting on you and he checks live. He can post into one, and
  answer a permission prompt for one running in Terminal.
- **He interrupts when it matters.** A session blocked on a human is said out
  loud immediately; one that merely finished is batched into a sentence at the
  next pause. With no browser tab open it becomes a macOS notification.

## There is a dashboard now

The public repo's frontend is the orb and nothing else — `main.ts`, `orb.ts`.
This one adds a seven-tab dashboard: **Runs, Sessions, Memory, Specs,
Projects, Display, Usage**. Every Claude Code process he starts is a *run*: a row in SQLite with
its prompt, project, status, token usage and full event stream, watchable
live.

## Memory you can read

Public memory is rows in SQLite. Here it is a folder of plain Markdown files,
one fact per file, with an index he always sees. Open it in any text editor;
edit it with anything.

## He connects to whatever you use

He ships connected to nothing on purpose. Any MCP server works — drop its
`mcpServers` block into `connections.json` and its tools are granted by name
at launch. The grant is an allowlist computed from your file, never
"everything except".

## Security became a design constraint

Public added AppleScript escaping and a permissions toggle — real fixes to a
codebase that started without them. Here it is load-bearing from the floor up:

- Acting tools are gated **in the server**, not in the prompt, so a hostile
  string in somebody else's transcript cannot make him act.
- Anything read from a web page, a search result or a connected service is
  information to report and **never** an instruction to follow — and for the
  rest of any turn that read the web, the unsupervised actions are shut.
- The loopback tool channel is bound to a bearer token created `O_EXCL` at
  mode 0600, compared in constant time.
- Credentials, keys and `.env` files are refused by the file reader, and his
  own tool token by exact name.

## He can see the network in the room

`scan_network` and `scan_host` drive the `nmap` already on the machine: which
devices are answering, and what one of them has open. Your own network only —
anything routable on the internet is refused before nmap sees it, a target
can never become an nmap option, and a device's name comes back inside an
untrusted block like everything else somebody else wrote.

## He can put things on the screen

He speaks two sentences at most, so the detail goes on the screen instead: a
diagram, a table, steps, a chart or cards he composes (`show`), or a live map
of your own network (`show_network`), drawn beside the orb and kept on the
dashboard's Display tab. Click a node to ask about it. Everything is drawn as
text, never markup, and every picture says where it came from — including
"drawn from a web page" when a page is what shaped it.

## And it is tested

Public: 6 test files, 43 tests. Here: 83 files, **2,405 tests**, named for the
behaviour they protect rather than the function they call.

---

## Saying this out loud

If asked how he differs, the short version is the first one — **he runs on
your Claude subscription instead of an API key** — then whichever of these
fits what was asked. Two sentences, not a tour. Never read this file aloud
verbatim, and never read out a path from it.
