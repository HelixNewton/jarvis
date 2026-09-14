/**
 * JARVIS — Main entry point.
 *
 * Wires together the orb visualization, WebSocket communication,
 * speech recognition, audio playback and the display into a single
 * experience. The page is a workspace (index.html): the assistant rail —
 * the orb and its readouts — beside the result JARVIS is showing.
 */

import { createOrb, type Orb, type OrbState } from "./orb";
import { createVoiceInput, createAudioPlayer, createMicMonitor } from "./voice";
import { createSocket } from "./ws";
import { openSettings, checkFirstTimeSetup } from "./settings";
import { createDisplay } from "./visual";
import type { Visual } from "./visual-render";
import "./style.css";

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type State = "idle" | "listening" | "thinking" | "speaking" | "compacting";
let currentState: State = "idle";
let isMuted = false;

const statusEl = document.getElementById("status-text")!;
const errorEl = document.getElementById("error-text")!;
const linkEl = document.getElementById("link-state");
const micStateEl = document.getElementById("mic-state");
const rail = document.getElementById("assistant-rail") ?? document.body;
const readouts = document.getElementById("readouts") ?? rail;

function showError(msg: string) {
  errorEl.textContent = msg;
  errorEl.style.opacity = "1";
  setTimeout(() => {
    errorEl.style.opacity = "0";
  }, 5000);
}

// The status readout: one word for where he is. A notice from the server
// (a context rotation, say) borrows the line until it is cleared.
const STATUS_LABELS: Record<State, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  compacting: "Tidying up…",
};

function updateStatus(state: State) {
  statusEl.textContent = STATUS_LABELS[state];
}

function updateMicState() {
  if (micStateEl) micStateEl.textContent = isMuted ? "Muted" : "Listening";
}

// ---------------------------------------------------------------------------
// Init components
// ---------------------------------------------------------------------------

const canvas = document.getElementById("orb-canvas") as HTMLCanvasElement;

// The orb needs WebGL. Without it (a headless check, a browser with it
// switched off) the rest of the page — the readouts, the display — must
// still work, so a failure to build it leaves a quiet stand-in.
function createOrbSafely(el: HTMLCanvasElement): Orb {
  try {
    return createOrb(el);
  } catch (err) {
    console.warn("[orb] not available", err);
    return {
      setState() {}, setAnalyser() {}, frames: () => 0, paused: () => true, destroy() {},
    };
  }
}
const orb = createOrbSafely(canvas);

const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
const WS_URL = `${wsProto}//${window.location.host}/ws/voice`;
const socket = createSocket(WS_URL);

const audioPlayer = createAudioPlayer();
orb.setAnalyser(audioPlayer.getAnalyser());

let muteMicDuringSpeech = false;

function transition(newState: State) {
  if (newState === currentState) return;
  currentState = newState;
  const btn = document.getElementById("hush");
  if (btn) (btn as HTMLButtonElement).hidden = newState !== "speaking";
  orb.setState(newState as OrbState);
  updateStatus(newState);

  if (isMuted) return;
  if (newState === "speaking" && muteMicDuringSpeech) {
    voiceInput.pause();
  } else {
    voiceInput.resume();
  }
}

// ---------------------------------------------------------------------------
// Voice input
// ---------------------------------------------------------------------------

const voiceInput = createVoiceInput(
  (text: string) => {
    // The server decides whether this is echo, a barge-in, or a new turn.
    micMonitor.sawSpeech();
    socket.send({ type: "transcript", text, isFinal: true });
  },
  (text: string) => {
    micMonitor.sawSpeech();
    socket.send({ type: "interim", text });
  },
  (msg: string) => {
    showError(msg);
  },
  (event: string) => {
    // Mirror the recogniser's lifecycle to the server log. Going deaf is a
    // browser-side failure the server cannot otherwise see at all, and the
    // console it used to be confined to is never open when it happens.
    socket.send({ type: "mic", text: event });
  }
);

// A live meter for the microphone itself. If this moves when you speak, the
// microphone is working — whatever else is or is not happening. It answers
// "is it even hearing me?" without a log, a console or anyone to ask. It
// sits in the rail under the readouts.
const micDot = document.createElement("div");
micDot.id = "mic-level";
micDot.title = "microphone input";
micDot.setAttribute("aria-hidden", "true");
readouts.appendChild(micDot);

const micMonitor = createMicMonitor(
  (level: number) => {
    const pct = Math.min(100, Math.round(level * 900));
    micDot.style.setProperty("--level", `${pct}%`);
    micDot.classList.toggle("is-hot", level > 0.02);
  },
  (event: string) => {
    socket.send({ type: "mic", text: event });
    // Proven deaf: sound going in, nothing coming out. Do not wait for the
    // rotation timer to happen along — measured once at 21 seconds, all of
    // it lost. Rebuild the recogniser now.
    if (event.startsWith("DEAF")) voiceInput.restart("deaf: audio in, no results");
  }
);

// ── stopping him ──────────────────────────────────────────────────────────
// Escape, or the button that appears while he is talking. Not a spoken word:
// his voice comes back through the microphone garbled, and a mis-hear that
// looked like "stop" would cut him off at random. A keystroke cannot be
// misheard.
const hushBtn = document.createElement("button");
hushBtn.id = "hush";
hushBtn.type = "button";
hushBtn.textContent = "Stop";
hushBtn.title = "Stop speaking (Esc)";
hushBtn.hidden = true;
readouts.appendChild(hushBtn);

/** Silence him. Returns whether there was anything to silence. */
function hush(): boolean {
  if (currentState !== "speaking") return false;
  // Locally first: the round trip is real and silence should be instant.
  audioPlayer.stop();
  socket.send({ type: "hush" });
  transition(isMuted ? "idle" : "listening");
  return true;
}

hushBtn.addEventListener("click", () => { hush(); });

audioPlayer.onPlayed((utt, idx) => {
  socket.send({ type: "played", utt, idx });
});

// ── the display ───────────────────────────────────────────────────────────
// The result column of the workspace, for what JARVIS draws. Closing it
// tells the server, so a reload does not bring it straight back; the Ask
// button on a selected item asks about it in the same words, as a
// transcript — the server treats it exactly as speech, and logs it as the
// click it was.
const resultMount = document.getElementById("result-mount") ?? document.body;
const display = createDisplay({
  onClose: () => socket.send({ type: "visual_closed" }),
  onAsk: (label: string) => {
    socket.send({ type: "transcript", text: `Tell me more about ${label}`,
                  isFinal: true, via: "display" });
  },
}, resultMount);

// End of speech is the server's call (`status: idle` after every chunk is
// acked); a transient empty queue mid-utterance must not flip the UI.
audioPlayer.onFinished(() => {});

audioPlayer.onNeedsGesture(() => {
  showError("Click anywhere to enable audio");
});

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

socket.onMessage((msg) => {
  const type = msg.type as string;

  if (type === "config") {
    muteMicDuringSpeech = Boolean(msg.muteMicDuringSpeech);
  } else if (type === "audio") {
    const data = msg.data as string;
    if (data) {
      if (currentState !== "speaking") transition("speaking");
      audioPlayer.enqueue(data, Number(msg.utt), Number(msg.idx));
    }
    if (msg.text) console.log("[JARVIS]", msg.text);
  } else if (type === "stop") {
    audioPlayer.stop();
    transition(isMuted ? "idle" : "listening");
  } else if (type === "drop_queued") {
    audioPlayer.dropQueued();
  } else if (type === "status") {
    const state = msg.state as string;
    if (state === "thinking") transition("thinking");
    else if (state === "speaking") transition("speaking");
    else if (state === "compacting") transition("compacting");
    else if (state === "idle") transition(isMuted ? "idle" : "listening");
  } else if (type === "text") {
    // A chunk TTS could not voice: show it instead of losing it
    console.log("[JARVIS]", msg.text);
    statusEl.textContent = String(msg.text);
  } else if (type === "notice") {
    // Shown, never spoken. The server sends one when it is about to be busy
    // for a few seconds (a context rotation), and an empty string to clear it.
    // Without it the pause looks like a crash. Cleared, the line goes back
    // to the state word.
    const text = String(msg.text ?? "");
    if (text) { statusEl.textContent = text; console.log("[notice]", text); }
    else updateStatus(currentState);
  } else if (type === "visual") {
    // What JARVIS is putting on the screen: the whole spec, already bounded
    // and flattened by the server, or null to take the display down.
    const visual = (msg.visual ?? null) as Visual | null;
    if (visual) display.show(visual);
    else display.clear();
  }
});

// The link readout: polled, because the socket reconnects on its own and
// the readout should say so without the socket having to know about it.
let linkedOnce = false;
function updateLinkState() {
  const on = socket.isConnected();
  if (on) linkedOnce = true;
  // "Reconnecting…" is only true after a drop; before the first connection it is "Connecting…".
  if (linkEl) linkEl.textContent = on ? "Connected" : linkedOnce ? "Reconnecting…" : "Connecting…";
}
updateLinkState();
setInterval(updateLinkState, 1000);
updateMicState();
updateStatus(currentState);

// ---------------------------------------------------------------------------
// Kick off
// ---------------------------------------------------------------------------

// Start listening after a brief delay for the orb to render
setTimeout(() => {
  voiceInput.start();
  if (currentState !== "speaking") transition("listening");
}, 1000);

// Resume AudioContext on ANY user interaction (browser autoplay policy)
function ensureAudioContext() {
  const ctx = audioPlayer.getAnalyser().context as AudioContext;
  if (ctx.state === "suspended") {
    ctx.resume().then(() => console.log("[audio] context resumed"));
  }
}
document.addEventListener("click", ensureAudioContext);
document.addEventListener("touchstart", ensureAudioContext);
document.addEventListener("keydown", ensureAudioContext, { once: true });

// Try to resume audio context on load
ensureAudioContext();

// ---------------------------------------------------------------------------
// UI Controls
// ---------------------------------------------------------------------------

const btnMute = document.getElementById("btn-mute")!;
const btnMenu = document.getElementById("btn-menu")!;
const menuDropdown = document.getElementById("menu-dropdown")!;
const btnRestart = document.getElementById("btn-restart")!;
const btnFixSelf = document.getElementById("btn-fix-self")!;

function menuIsOpen(): boolean {
  return menuDropdown.style.display !== "none";
}
function setMenu(open: boolean) {
  menuDropdown.style.display = open ? "block" : "none";
  btnMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

btnMute.addEventListener("click", (e) => {
  e.stopPropagation();
  isMuted = !isMuted;
  btnMute.classList.toggle("muted", isMuted);
  btnMute.setAttribute("aria-pressed", isMuted ? "true" : "false");
  updateMicState();
  if (isMuted) {
    voiceInput.pause();
    transition("idle");
  } else {
    voiceInput.resume();
    transition("listening");
  }
});

btnMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(!menuIsOpen());
});

document.addEventListener("click", () => {
  setMenu(false);
});

btnRestart.addEventListener("click", async (e) => {
  e.stopPropagation();
  setMenu(false);
  statusEl.textContent = "Restarting…";
  try {
    await fetch("/api/restart", { method: "POST" });
    // Wait a few seconds then reload
    setTimeout(() => window.location.reload(), 4000);
  } catch {
    statusEl.textContent = "Restart failed";
  }
});

btnFixSelf.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(false);
  // Activate work mode on the WebSocket session (JARVIS becomes Claude Code's voice)
  // Milestone 1 has no tools yet; "Fix yourself" returns as a brain tool later.
  statusEl.textContent = "Fix-yourself is not available in this build";
});

// Settings button
const btnSettings = document.getElementById("btn-settings")!;
btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(false);
  openSettings();
});

// ── Escape ────────────────────────────────────────────────────────────────
// The one keydown handler for it, in this order: an open menu closes; else
// a selection in the display clears (the renderer never handles the key
// itself); else it hushes him. Handled, it is consumed; already handled by
// something before us, left alone.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (e.defaultPrevented) return;
    if (menuIsOpen()) { setMenu(false); e.preventDefault(); return; }
    if (display.clearSelection()) { e.preventDefault(); return; }
    if (hush()) e.preventDefault();
  }
});

// First-time setup detection — check after a short delay for server readiness
setTimeout(() => {
  checkFirstTimeSetup();
}, 2000);

// ---------------------------------------------------------------------------
// Dev and test hooks. window.jarvisShow is set by the display (visual.ts);
// window.jarvisOrb reports whether the orb is drawing.
// ---------------------------------------------------------------------------
(window as unknown as { jarvisOrb: { frames(): number; paused(): boolean } }).jarvisOrb = {
  frames: () => orb.frames(),
  paused: () => orb.paused(),
};
