/**
 * JARVIS — Multi-mode particle visualization.
 *
 * Floating particles with line connections between nearby ones.
 * Lines fade in/out based on state. Transition tumble on state change.
 * Speaking pulls particles closer for denser connections.
 *
 * SIZE. The canvas fills its parent (#orb-host on the page); the renderer
 * takes the host's size, through a ResizeObserver and the window resize
 * event, never the viewport's. The CSS owns the canvas's box
 * (setSize(w, h, false)); the drawing buffer follows it at most 2× dense.
 *
 * TIME. The simulation runs on elapsed time, not frames, so it looks the
 * same at 60 fps as it always did and does not run double at 120 fps: every
 * "per frame" constant is scaled by dt·60 and every "ease toward" step is
 * 1 − exp(−k·dt) with k the old per-frame fraction × 60. dt is clamped to
 * 50 ms so a tab coming back from the background does not lurch.
 *
 * REST. No frames while the document is hidden (the clock is reset on
 * return so nothing jumps), and none at all under prefers-reduced-motion:
 * then one frame is drawn on a state change and on a resize, with the
 * state's look settled instantly rather than eased into.
 */

import * as THREE from "three";

// "compacting": the brain is being swapped for a fresh one behind the scenes
// (a context rotation). He answers nothing for a few seconds, and silence with
// no explanation reads as a crash. It used to be followed by a spoken line;
// the user found that annoying, so the orb carries it instead: dim, slow,
// drawn inward, in a cooler colour -- unmistakably not "about to answer".
export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "compacting";

export interface Orb {
  setState(s: OrbState): void;
  setAnalyser(a: AnalyserNode | null): void;
  /** Frames rendered so far. A page hook for tests. */
  frames(): number;
  /** True while no animation loop runs: the document is hidden, or the
   *  viewer asked for reduced motion. */
  paused(): boolean;
  destroy(): void;
}

/** The tokens' ground (theme/tokens.css --ground). */
const GROUND = 0x05070c;
const MAX_DT = 0.05;

// The four colours the cloud eases between, made once.
const COLOR_BASE = new THREE.Color(0x4ca8e8);
const COLOR_THINKING = new THREE.Color(0x6ec4ff);
const COLOR_SPEAKING = new THREE.Color(0x5ab8f0);
const COLOR_COMPACTING = new THREE.Color(0x3a5f8a);   // desaturated, cooler

interface Targets {
  radius: number; speed: number; bright: number; size: number; lines: number; electrons: number;
}

const TARGETS: Record<OrbState, Targets> = {
  idle:       { radius: 28, speed: 0.2,  bright: 0.5,  size: 0.35, lines: 0.15, electrons: 0 },
  listening:  { radius: 22, speed: 0.3,  bright: 0.65, size: 0.4,  lines: 0.4,  electrons: 0 },
  thinking:   { radius: 16, speed: 0.5,  bright: 0.7,  size: 0.3,  lines: 1.0,  electrons: 0.015 },
  speaking:   { radius: 18, speed: 0.2,  bright: 0.7,  size: 0.4,  lines: 0.8,  electrons: 0 },
  // Smaller than idle, slower than anything, half the brightness, no
  // connecting lines: a held breath, not a working mind.
  compacting: { radius: 12, speed: 0.08, bright: 0.28, size: 0.28, lines: 0.0,  electrons: 0 },
};

/** The fraction of the way to ease this frame, for a step that used to be
 *  `perFrame` of the distance at 60 fps. */
function ease(perFrame: number, dt: number): number {
  return 1 - Math.exp(-perFrame * 60 * dt);
}

export function createOrb(canvas: HTMLCanvasElement): Orb {
  let destroyed = false;
  const N = 2000;
  const host: HTMLElement = canvas.parentElement ?? document.body;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(GROUND, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1000);
  camera.position.z = 80;

  // ── Particles ──
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  const phase = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.pow(Math.random(), 0.5) * 25;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i * 3 + 2] = r * Math.cos(phi);
    phase[i] = Math.random() * 1000;
  }

  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

  const mat = new THREE.PointsMaterial({
    color: 0x4ca8e8, size: 0.4, transparent: true, opacity: 0.6,
    sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // ── Connection lines ──
  const MAX_LINES = 8000;
  const linePos = new Float32Array(MAX_LINES * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setDrawRange(0, 0);

  const lineMat = new THREE.LineBasicMaterial({
    color: 0x4ca8e8, transparent: true, opacity: 0.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const lines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lines);

  // ── Electrons — bright dots that travel along connections ──
  const MAX_ELECTRONS = 200;
  const electronGeo = new THREE.BufferGeometry();
  const electronPos = new Float32Array(MAX_ELECTRONS * 3);
  electronGeo.setAttribute("position", new THREE.BufferAttribute(electronPos, 3));
  electronGeo.setDrawRange(0, 0);

  const electronMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.8, transparent: true, opacity: 1.0,
    sizeAttenuation: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const electrons = new THREE.Points(electronGeo, electronMat);
  scene.add(electrons);

  // Each electron: start point, end point, progress (0-1), speed (progress
  // per 60th of a second — the old per-frame figure)
  interface Electron { sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; t: number; speed: number; }
  const activeElectrons: Electron[] = [];
  let electronSpawnRate = 0;
  let targetElectronRate = 0;
  let lastElectronSpawn = 0; // simulated seconds at the last spawn

  // Store active connections for electron spawning
  let activeConnections: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }[] = [];

  // ── State ──
  let state: OrbState = "idle";
  let targetRadius = 25, currentRadius = 25;
  let targetSpeed = 0.3, currentSpeed = 0.3;
  let targetBright = 0.6, currentBright = 0.6;
  let targetSize = 0.4, currentSize = 0.4;
  let lineAmount = 0, targetLineAmount = 0;
  const lineDistance = 8;

  // Transition tumble
  let spinX = 0, spinY = 0, spinZ = 0;
  let transitionEnergy = 0;
  let lastState: OrbState = "idle";

  // Depth Z
  let cloudZ = 0, cloudZVel = 0;

  // ── Audio ──
  let analyser: AnalyserNode | null = null;
  let freqData = new Uint8Array(64);
  let bass = 0, mid = 0;

  // ── Time ──
  // Simulated seconds: advances only while frames are being drawn, so a
  // pause is a pause and not a leap.
  const clock = new THREE.Clock(false);
  let t = 0;
  let frameCount = 0;
  let rafId = 0;

  const reduceMotion: MediaQueryList | null =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function loopAllowed(): boolean {
    return !destroyed && !document.hidden && !(reduceMotion?.matches ?? false);
  }

  function applyTargets(): void {
    const tg = TARGETS[state];
    targetRadius = tg.radius; targetSpeed = tg.speed; targetBright = tg.bright;
    targetSize = tg.size; targetLineAmount = tg.lines; targetElectronRate = tg.electrons;
  }

  function colorFor(s: OrbState): THREE.Color {
    switch (s) {
      case "thinking": return COLOR_THINKING;
      case "speaking": return COLOR_SPEAKING;
      case "compacting": return COLOR_COMPACTING;
      default: return COLOR_BASE;
    }
  }

  /** One simulation step of `dt` seconds. */
  function step(dt: number): void {
    t += dt;
    const f = dt * 60;                          // frames' worth of motion
    const k = ease(0.02, dt);                   // the old 0.02-per-frame ease

    applyTargets();

    currentRadius += (targetRadius - currentRadius) * k;
    currentSpeed += (targetSpeed - currentSpeed) * k;
    currentBright += (targetBright - currentBright) * k;
    currentSize += (targetSize - currentSize) * k;
    lineAmount += (targetLineAmount - lineAmount) * k;
    electronSpawnRate += (targetElectronRate - electronSpawnRate) * k;

    // Transition energy
    if (state !== lastState) { transitionEnergy = 1.0; lastState = state; }
    transitionEnergy *= Math.pow(0.985, f);
    if (transitionEnergy > 0.05) {
      spinX += transitionEnergy * 0.012 * Math.sin(t * 1.7) * f;
      spinY += transitionEnergy * 0.015 * f;
      spinZ += transitionEnergy * 0.008 * Math.cos(t * 1.3) * f;
    }

    // Audio
    bass = 0; mid = 0;
    if (analyser) {
      analyser.getByteFrequencyData(freqData);
      let bSum = 0, mSum = 0;
      for (let i = 0; i < 8; i++) bSum += freqData[i];
      for (let i = 8; i < 24; i++) mSum += freqData[i];
      bass = bSum / (8 * 255); mid = mSum / (16 * 255);
    }

    // Depth Z breathing
    let zTarget = Math.sin(t * 0.12) * 8;
    if (state === "thinking") zTarget = Math.sin(t * 0.3) * 15 + Math.sin(t * 0.9) * 6;
    else if (state === "speaking") zTarget = Math.sin(t * 0.15) * 6 - bass * 10;
    else if (state === "compacting") zTarget = -20 + Math.sin(t * 0.08) * 3;   // withdrawn, barely moving
    cloudZVel += (zTarget - cloudZ) * 0.008 * f;
    cloudZVel *= Math.pow(0.94, f);
    cloudZ += cloudZVel * f;

    points.rotation.x = spinX; points.rotation.y = spinY; points.rotation.z = spinZ;
    points.position.z = cloudZ;
    lines.rotation.x = spinX; lines.rotation.y = spinY; lines.rotation.z = spinZ;
    lines.position.z = cloudZ;

    // ── Update particles ──
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const a = p.array as Float32Array;
    const damp = Math.pow(0.992, f);
    const drift = 0.001 * currentSpeed * f;
    const swirl = 0.0008 * currentSpeed * f;

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const x = a[i3], y = a[i3 + 1], z = a[i3 + 2];
      const px = phase[i];

      vel[i3] += Math.sin(t * 0.05 + px) * drift;
      vel[i3 + 1] += Math.cos(t * 0.06 + px * 1.3) * drift;
      vel[i3 + 2] += Math.sin(t * 0.055 + px * 0.7) * drift;
      vel[i3] += Math.sin(t * 0.02 + px * 2.1 + y * 0.1) * swirl;
      vel[i3 + 1] += Math.cos(t * 0.025 + px * 1.7 + z * 0.1) * swirl;
      vel[i3 + 2] += Math.sin(t * 0.022 + px * 0.9 + x * 0.1) * swirl;

      const dist = Math.sqrt(x * x + y * y + z * z) || 0.01;
      const pull = (Math.max(0, dist - currentRadius) * 0.002 + 0.0003) * f;
      vel[i3] -= (x / dist) * pull;
      vel[i3 + 1] -= (y / dist) * pull;
      vel[i3 + 2] -= (z / dist) * pull;

      if (bass > 0.05) {
        const push = bass * 0.02 * f;
        vel[i3] += (x / dist) * push;
        vel[i3 + 1] += (y / dist) * push;
        vel[i3 + 2] += (z / dist) * push;
      }
      if (state === "speaking" && mid > 0.1) {
        const pulse = Math.sin(t * 8 + px) * mid * 0.012 * f;
        vel[i3] += (x / dist) * pulse;
        vel[i3 + 1] += (y / dist) * pulse;
      }

      vel[i3] *= damp; vel[i3 + 1] *= damp; vel[i3 + 2] *= damp;
      a[i3] += vel[i3] * f; a[i3 + 1] += vel[i3 + 1] * f; a[i3 + 2] += vel[i3 + 2] * f;
    }
    p.needsUpdate = true;

    // ── Update lines ──
    if (lineAmount > 0.01) {
      const lp = lineGeo.getAttribute("position") as THREE.BufferAttribute;
      const la = lp.array as Float32Array;
      let lineCount = 0;
      const maxDist = lineDistance * (1 + bass * 0.5);
      const maxDistSq = maxDist * maxDist;
      const stride = Math.max(1, Math.floor(N / 600));

      for (let i = 0; i < N && lineCount < MAX_LINES; i += stride) {
        const i3 = i * 3;
        const x1 = a[i3], y1 = a[i3 + 1], z1 = a[i3 + 2];
        for (let j = i + stride; j < N && lineCount < MAX_LINES; j += stride) {
          const j3 = j * 3;
          const dx = a[j3] - x1, dy = a[j3 + 1] - y1, dz = a[j3 + 2] - z1;
          if (dx * dx + dy * dy + dz * dz < maxDistSq) {
            const idx = lineCount * 6;
            la[idx] = x1; la[idx+1] = y1; la[idx+2] = z1;
            la[idx+3] = a[j3]; la[idx+4] = a[j3+1]; la[idx+5] = a[j3+2];
            lineCount++;
          }
        }
      }
      lineGeo.setDrawRange(0, lineCount * 2);
      lp.needsUpdate = true;
      lineMat.opacity = lineAmount * 0.12;

      // Store connections for electron spawning
      activeConnections = [];
      for (let c = 0; c < Math.min(lineCount, 500); c++) {
        const ci = c * 6;
        activeConnections.push({
          x1: la[ci], y1: la[ci+1], z1: la[ci+2],
          x2: la[ci+3], y2: la[ci+4], z2: la[ci+5],
        });
      }
    } else {
      lineGeo.setDrawRange(0, 0);
      activeConnections = [];
    }

    // ── Update electrons — only during thinking ──
    // One fires off every ~1 second, max 3 alive, takes 2-4s to travel
    if (activeConnections.length > 0 && electronSpawnRate > 0.005) {
      if (activeElectrons.length < 3 && (t - lastElectronSpawn) > 1.0) {
        const conn = activeConnections[Math.floor(Math.random() * activeConnections.length)];
        // speed is progress per 60th of a second: 0.005 = 200 sixtieths = 3.3s
        activeElectrons.push({
          sx: conn.x1, sy: conn.y1, sz: conn.z1,
          ex: conn.x2, ey: conn.y2, ez: conn.z2,
          t: 0,
          speed: 0.003 + Math.random() * 0.003, // 2-4 seconds to travel
        });
        lastElectronSpawn = t;
      }
    }

    // Update electron positions
    const ep = electronGeo.getAttribute("position") as THREE.BufferAttribute;
    const ea = ep.array as Float32Array;
    let aliveCount = 0;

    for (let e = activeElectrons.length - 1; e >= 0; e--) {
      const el = activeElectrons[e];
      el.t += el.speed * f;
      if (el.t >= 1) {
        activeElectrons.splice(e, 1);
        continue;
      }
      const ei = aliveCount * 3;
      ea[ei] = el.sx + (el.ex - el.sx) * el.t;
      ea[ei + 1] = el.sy + (el.ey - el.sy) * el.t;
      ea[ei + 2] = el.sz + (el.ez - el.sz) * el.t;
      aliveCount++;
    }

    electronGeo.setDrawRange(0, aliveCount);
    ep.needsUpdate = true;

    // Electrons follow the same rotation/position as the main group
    electrons.rotation.x = spinX; electrons.rotation.y = spinY; electrons.rotation.z = spinZ;
    electrons.position.z = cloudZ;

    mat.opacity = currentBright + bass * 0.08;
    mat.size = currentSize + bass * 0.05;

    const hue = colorFor(state);
    const hueK = ease(state === "compacting" ? 0.03 : 0.015, dt);
    mat.color.lerp(hue, hueK);
    lineMat.color.lerp(hue, hueK);

    camera.position.x = Math.sin(t * 0.02) * 5;
    camera.position.y = Math.cos(t * 0.03) * 3;
    camera.lookAt(0, 0, cloudZ * 0.2);
  }

  function render(): void {
    if (destroyed) return;
    renderer.render(scene, camera);
    frameCount++;
  }

  /** Reduced motion: the state's look at once, no easing, then one frame. */
  function settleAndRender(): void {
    applyTargets();
    currentRadius = targetRadius; currentSpeed = targetSpeed; currentBright = targetBright;
    currentSize = targetSize; lineAmount = targetLineAmount; electronSpawnRate = targetElectronRate;
    lastState = state;
    transitionEnergy = 0;
    mat.color.copy(colorFor(state));
    lineMat.color.copy(colorFor(state));
    mat.opacity = currentBright;
    mat.size = currentSize;
    camera.lookAt(0, 0, cloudZ * 0.2);
    // A single step settles the line set for the new line amount.
    step(1 / 60);
    render();
  }

  function frame(): void {
    rafId = 0;
    if (!loopAllowed()) return;
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), MAX_DT);
    step(dt);
    render();
  }

  function start(): void {
    if (rafId || !loopAllowed()) return;
    // Reset the clock so the first delta after a pause is small, not the
    // whole time away.
    clock.start();
    rafId = requestAnimationFrame(frame);
  }

  function stop(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clock.stop();
  }

  // ── Size: the host's box, never the viewport's ──
  function resize(): void {
    if (destroyed) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w <= 0 || h <= 0) return;                 // hidden or not laid out yet
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (!loopAllowed() && !document.hidden) render();   // reduced motion: one frame
  }

  const observer: ResizeObserver | null =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  observer?.observe(host);
  window.addEventListener("resize", resize);

  function onVisibility(): void {
    if (document.hidden) stop();
    else start();
  }
  document.addEventListener("visibilitychange", onVisibility);

  function onMotionPreference(): void {
    if (loopAllowed()) start();
    else { stop(); if (!document.hidden) settleAndRender(); }
  }
  reduceMotion?.addEventListener?.("change", onMotionPreference);

  resize();
  if (loopAllowed()) start();
  else if (!document.hidden) settleAndRender();

  return {
    setState(s: OrbState) {
      state = s;
      if (!destroyed && !document.hidden && !loopAllowed()) settleAndRender();
    },
    setAnalyser(a: AnalyserNode | null) {
      analyser = a;
      if (a) freqData = new Uint8Array(a.frequencyBinCount);
    },
    frames: () => frameCount,
    paused: () => rafId === 0,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      reduceMotion?.removeEventListener?.("change", onMotionPreference);
      geo.dispose();
      mat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      electronGeo.dispose();
      electronMat.dispose();
      renderer.dispose();
    },
  };
}
