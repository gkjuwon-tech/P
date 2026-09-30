import './style.css';
import '@fontsource-variable/jetbrains-mono'; // glyphs for the ASCII pass only
import Lenis from 'lenis';
import { Stage } from './gl.js';

const CAPTURE = new URLSearchParams(location.search).has('capture');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(max-width: 760px)').matches;
// Safari (and Chrome with proprietary codecs) gets the higher-quality H.264 file first
const H264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028"') === 'probably';
const FPS = 24;

// Video sources (landing/assets/video). Durations in frames at 24 fps.
const SOURCES = {
  tex: { base: 'hero-turntable', w: 288, h: 720, frames: 211 },
  clay: { base: 'hero-clay-turntable', w: 288, h: 720, frames: 222 },
  grip: { base: 'hero-rig-grip', w: 704, h: 720, frames: 276 },
};
const GRIP_MOTION_END = 252 / FPS; // after this the clip holds still
const GRIP_HOLD = 270 / FPS;

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 4);
const easeInOut = (t) => {
  t = clamp(t);
  return t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
root.classList.add('is-loading');

// ---------- videos ----------
const videoHost = document.createElement('div');
videoHost.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;left:0;top:0';
document.body.appendChild(videoHost);

for (const [key, s] of Object.entries(SOURCES)) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.loop = key !== 'grip';
  // three.js sizes the texture from these attributes, not videoWidth
  v.width = s.w;
  v.height = s.h * 3;
  v.setAttribute('muted', '');
  v.setAttribute('playsinline', '');
  const kinds = [['webm', 'video/webm; codecs="vp9"'], ['mp4', 'video/mp4']];
  if (H264) kinds.reverse();
  for (const [ext, type] of kinds) {
    const src = document.createElement('source');
    src.src = `./video/${s.base}/${s.base}_packed.${ext}`;
    src.type = type;
    v.appendChild(src);
  }
  videoHost.appendChild(v);
  s.video = v;
  s.duration = s.frames / FPS;
  s.dirty = true;
  s.stall = 0;
  s.manual = false; // true when the browser will not play it (e.g. iOS Low Power Mode): we step it by seeking
}

// iOS only fetches video data once play() is called; start everything muted right away,
// and again on the first touch in case autoplay was refused.
function kick() {
  for (const [key, s] of Object.entries(SOURCES)) {
    const v = s.video;
    const p = v.play();
    if (key === 'grip') p?.then(() => v.pause()).catch(() => {});
    else p?.catch(() => {});
  }
}
if (!CAPTURE) {
  kick();
  const unlock = () => {
    kick();
    removeEventListener('touchstart', unlock);
    removeEventListener('pointerdown', unlock);
  };
  addEventListener('touchstart', unlock, { passive: true });
  addEventListener('pointerdown', unlock);
}

const ready = (v) =>
  new Promise((res) => {
    if (v.readyState >= 2) return res();
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', res, { once: true });
    setTimeout(res, 15000);
  });

let loaded = 0;
const loadTotal = 4;
const loadingDone = Promise.all([
  ...Object.values(SOURCES).map((s) => ready(s.video).then(() => loaded++)),
  document.fonts.ready.then(() => document.fonts.load('500 40px "JetBrains Mono Variable"')).then(() => loaded++),
]);

// ---------- WebGL ----------
const canvas = $('.gl');
let stage = null;
function initStage() {
  try {
    const pr = CAPTURE ? 1 : Math.min(devicePixelRatio || 1, 2);
    stage = new Stage(canvas, SOURCES, { pixelRatio: pr, preserve: CAPTURE });
    stage.resize(innerWidth, innerHeight);
  } catch (e) {
    console.warn('WebGL unavailable', e);
    root.classList.add('no-gl');
    stage = null;
  }
}

// ---------- DOM refs ----------
const loaderEl = $('.loader');
const countEl = $('[data-count]');
const barEl = $('.loader__bar i');
const sections = Object.fromEntries($$('[data-section]').map((el) => [el.dataset.section, el]));
const heroFoot = $('.hero__foot');
const typeEl = $('[data-type]');
const typeText = typeEl.textContent;
typeEl.textContent = '';
const caret = $('.caret');
const stages = $$('[data-stage]').map((el) => ({ el, h: $('h2 span', el) }));
const STAGE_RANGES = [[0, 0.14], [0.14, 0.34], [0.34, 0.54], [0.54, 0.72], [0.72, 1.01]];
const promptLines = $$('[data-pp]');
const stLines = $$('[data-st]');
const railFill = $('.process__fill');
const modelsList = $('.models__list');
const cursor = $('.cursor');

// reveal-on-enter elements: [data-r] slide up out of a line mask, [data-f] fade up
const reveals = [...$$('[data-r]'), ...$$('[data-f]')].map((el) => ({
  el,
  kind: el.hasAttribute('data-r') ? 'r' : 'f',
  delay: parseFloat(el.dataset.r ?? el.dataset.f) || 0,
  hero: !!el.closest('.hero'),
  t0: null,
}));

// ---------- pointer ----------
const pointer = { x: innerWidth / 2, y: innerHeight / 2, sx: innerWidth / 2, sy: innerHeight / 2, active: false, force: 0 };
const pointerWorld = { x: 9, y: 9, z: 0 };
if (!CAPTURE) {
  addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (e.pointerType === 'mouse') {
      pointer.active = true;
      cursor.classList.add('is-on');
      root.classList.add('has-cursor');
    }
  });
  document.addEventListener('pointerleave', () => {
    pointer.active = false;
    cursor.classList.remove('is-on');
  });
}
const linkish = 'a, button, input, .models__list li';
document.addEventListener('pointerover', (e) => cursor.classList.toggle('is-link', !!e.target.closest?.(linkish)));

// ---------- scroll ----------
let lenis = null;
if (!CAPTURE && !REDUCED) {
  lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9 });
  lenis.stop();
}
$$('[data-link]').forEach((a) =>
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (!id?.startsWith('#')) return;
    e.preventDefault();
    const target = id === '#top' ? 0 : $(id);
    if (lenis) lenis.scrollTo(target, { duration: 1.8 });
    else (target === 0 ? scrollTo(0, 0) : target.scrollIntoView());
  }),
);

// ---------- form ----------
const form = $('.join__form');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = $('.join__msg', form);
  const v = form.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    msg.textContent = 'That address does not look right.';
    return;
  }
  msg.textContent = 'You are on the list. We will write when your seat opens.';
  form.email.value = '';
});

// ---------- timeline ----------
const T = {
  loadStart: 0,
  shown: 0, // loader counter 0..1
  loaderDone: null, // time the counter hit 100
  intro: null, // time the figure starts forming
  lastT: 0,
};

function pinnedProgress(el, vh) {
  const r = el.getBoundingClientRect();
  return clamp(-r.top / (r.height - vh));
}

// text never moves: it only fades in and out in place
function fade(el, o) {
  el.style.opacity = o;
}

// Knot -> scanning ring. B: 0 = hero knot, 0.2 = untied into a halo above the head, 1 = figure built.
function ring(s, B, t) {
  const b = clamp((B - 0.2) / 0.8);
  const sweep = B < 0.2 ? 1.6 : lerp(1.38, -1.62, b);
  s.knot = ss(0.0, 0.2, B);
  s.knotY = 0.02;
  s.knotTilt = 1.0 + Math.sin(t * 0.21) * 0.32;
  s.knotSpin = t * 0.22;
  const halfW = stage ? stage.worldHalfW : 1.4;
  s.knotScale = Math.min(0.3, (halfW * 0.82) / 3.0);
  s.flow = t;
  s.sweep = sweep;
  s.ringY = B < 0.2 ? 1.38 : Math.max(sweep, -1.3);
  s.tilt = 0; // flat: perspective alone gives the right angle above and below eye level
  s.ringR = Math.min(0.6, halfW * 0.8);
  s.ringr = 0.03;
  s.ringAlpha = 0.55 * (1 - ss(0.88, 1.0, B));
}

// Compute everything for time t (seconds). Returns GL state + desired video times.
function update(t) {
  const dt = clamp(t - T.lastT, 0, 0.1);
  T.lastT = t;
  const vw = innerWidth, vh = innerHeight;

  // --- loader ---
  const target = loaded / loadTotal;
  T.shown = Math.min(target, T.shown + dt * (REDUCED ? 10 : 0.85));
  if (T.loaderDone === null) {
    countEl.textContent = String(Math.round(T.shown * 100)).padStart(3, '0');
    barEl.style.transform = `scaleX(${T.shown})`;
    if (T.shown >= 1 && started) T.loaderDone = t;
  }
  if (T.loaderDone !== null) {
    const k = easeInOut((t - T.loaderDone - 0.25) / 1.0);
    loaderEl.style.clipPath = `inset(0 0 ${k * 100}% 0)`;
    if (k >= 1 && loaderEl.style.display !== 'none') {
      loaderEl.style.display = 'none';
      root.classList.remove('is-loading');
      lenis?.start();
    }
    if (T.intro === null) T.intro = T.loaderDone + 0.55;
  }
  const introT = T.intro === null ? -1 : t - T.intro;

  // --- reveals ---
  for (const r of reveals) {
    if (r.t0 === null && introT >= 0) {
      if (r.hero) r.t0 = T.intro + 0.35;
      else if (r.el.getBoundingClientRect().top < vh * 0.88) r.t0 = t;
    }
    fade(r.el, r.t0 === null ? 0 : ss(0, 1, (t - r.t0 - r.delay) / 1.1));
  }

  // --- hero details ---
  const heroP = clamp(scrollY / vh);
  heroFoot.style.opacity = 1 - ss(0.05, 0.45, heroP);
  const typeT = introT - 1.7;
  const nChars = typeT < 0 ? 0 : Math.min(typeText.length, Math.floor(typeT * 20));
  if (typeEl.textContent.length !== nChars) typeEl.textContent = typeText.slice(0, nChars);
  caret.style.opacity = nChars < typeText.length ? 1 : Math.floor(t * 1.8) % 2 ? 0 : 1;

  // --- process ---
  const P = pinnedProgress(sections.process, vh);
  const S = pinnedProgress(sections.statement, vh);
  stages.forEach((s, i) => {
    const [a, b] = STAGE_RANGES[i];
    const enter = i === 0 ? 1 : ss(a - 0.005, a + 0.03, P);
    const leave = i === stages.length - 1 ? 0 : ss(b - 0.03, b + 0.005, P);
    fade(s.h, enter * (1 - leave));
  });
  promptLines.forEach((el, i) => {
    const enter = ss(-0.06 + i * 0.012, 0.0 + i * 0.012, P);
    const leave = ss(0.085, 0.125, P);
    fade(el, enter * (1 - leave));
  });
  railFill.style.transform = `scaleY(${P})`;

  // --- statement text ---
  stLines.forEach((el, i) => {
    const enter = ss(0.16 + i * 0.2, 0.3 + i * 0.2, S);
    const leave = ss(0.84, 0.96, S);
    fade(el, enter * (1 - leave));
  });

  // --- pointer (smoothed) ---
  const pk = CAPTURE ? 0.35 : 0.14;
  pointer.sx = lerp(pointer.sx, pointer.x, pk);
  pointer.sy = lerp(pointer.sy, pointer.y, pk);
  pointer.force = lerp(pointer.force, pointer.active ? 1 : 0, 0.08);
  cursor.style.transform = `translate3d(${pointer.sx}px, ${pointer.sy}px, 0)`;
  const nx = (pointer.sx / vw) * 2 - 1, ny = -(pointer.sy / vh) * 2 + 1;

  // --- figure state ---
  const s = {
    time: t,
    offsetX: 0, offsetY: -0.02, scale: 1, rotY: 0,
    camX: nx * 0.16 * pointer.force, camY: ny * 0.08 * pointer.force,
    texPts: 0, form: 1, scatter: 0.006, depth: 0.9, mouseForce: 0, ptsOut: 0,
    knot: 1, knotY: 0, knotTilt: 1, knotSpin: 0, knotScale: 0.235, flow: 0,
    ringY: 0, tilt: 1, ringR: 0.7, ringr: 0.15, spin: 0, sweep: -9, ringAlpha: 0,
    clay: 0, clayIn: 1, clayOut: 0,
    texPlane: 0, texIn: 1, texOut: 0,
    gripPlane: 0, gripOut: 0,
    ascii: 0, asciiGain: 1.25, canvasOpacity: 1,
  };
  const video = { grip: 0 };
  s.spin = t * 0.35;

  // phones (portrait): lift the figure clear of the stage titles
  if (MOBILE) {
    s.scale = 0.86;
    s.offsetY = 0.12;
  }

  if (S <= 0) {
    // hero: a torus of points. Scrolling turns it into a scanning ring that builds the figure.
    const pr = sections.process.getBoundingClientRect();
    const buildEnd = pr.top + scrollY + 0.13 * (pr.height - vh);
    const B = clamp(scrollY / buildEnd);
    s.texPts = 1;
    s.form = REDUCED ? 1 : introT < 0 ? 0 : easeInOut(introT / 2.4);
    ring(s, B, t);
    s.spin += B * 2.5;
    s.mouseForce = pointer.force * (1 - ss(0.0, 0.3, B));
    // 02 point cloud: swing to show depth
    const swing = ss(0.16, 0.34, P);
    s.rotY = Math.sin(swing * Math.PI * 2) * 0.5;
    s.depth = 0.9 + Math.sin(swing * Math.PI) * 0.9;
    // 03 geometry: points dissolve straight into clay
    const geo = ss(0.35, 0.45, P);
    s.ptsOut = geo;
    if (P >= 0.46) s.texPts = 0;
    s.clay = P > 0.34 && P < 0.68 ? 1 : 0;
    s.clayIn = geo;
    // 04 material: same dissolve, clay -> texture
    s.texPlane = P > 0.54 && P < 0.745 ? 1 : 0;
    s.texIn = ss(0.55, 0.66, P);
    // 05 rig: glitch through ASCII into the T-pose, then scrub the motion
    s.ascii = ss(0.712, 0.745, P) * (1 - ss(0.752, 0.79, P));
    s.gripPlane = P >= 0.745 ? 1 : 0;
    video.grip = ss(0.775, 0.975, P) * GRIP_MOTION_END;
  } else if (S < 1) {
    // statement: the held pose turns to type, then dissolves the same way things arrived
    s.gripPlane = 1;
    s.ascii = ss(0.03, 0.28, S);
    s.gripLift = ss(0.0, 0.2, S);
    s.asciiGain = 1.5;
    s.gripOut = ss(0.36, 0.86, S);
    video.grip = GRIP_HOLD;
  } else {
    const jr = sections.join.getBoundingClientRect();
    const jIn = clamp((vh - jr.top) / vh);
    if (jIn <= 0.15) {
      // models: the clay figure resolves small, to the right, as type
      const r = sections.models.getBoundingClientRect();
      const mIn = clamp((vh - r.top) / (vh * 0.9));
      const lt = modelsList.getBoundingClientRect().top;
      s.clay = MOBILE ? 0 : 1; // no room beside the title on a phone
      s.clayIn = ss(0.3, 0.85, mIn);
      s.clayOut = ss(vh * 0.8, vh * 0.3, lt);
      s.ascii = 1;
      s.asciiGain = 1.15;
      s.scale = 0.78;
      s.offsetX = stage ? stage.worldHalfW * 0.5 : 1;
      s.offsetY = 0.04;
    } else {
      // finale: the ring gathers again and rebuilds the figure where it started
      s.texPts = 1;
      s.form = ss(0.12, 0.38, jIn);
      ring(s, ss(0.42, 0.98, jIn), t);
      s.mouseForce = pointer.force * ss(0.9, 1, jIn);
    }
    video.grip = GRIP_HOLD;
  }

  // cursor in figure space for repulsion
  if (stage) {
    stage.group.position.set(s.offsetX, s.offsetY, 0);
    stage.group.scale.setScalar(s.scale);
    stage.group.rotation.y = s.rotY;
    stage.group.updateMatrixWorld();
    stage.pointerToWorld(nx, ny, stage.common.uMouse.value);
  }

  return { s, video };
}

// ---------- video time control ----------
const frameTime = (src, time) => (Math.floor(clamp(time, 0, src.duration - 1e-3) * FPS) + 0.5) / FPS;

function driveVideosLive(video, t, dt) {
  const T = SOURCES.tex, C = SOURCES.clay, G = SOURCES.grip;
  // detect a video that is not advancing on its own and fall back to stepping it
  for (const s of [T, C]) {
    const v = s.video;
    if (s.manual) continue;
    if (v.paused) v.play().catch(() => {});
    s.stall = v.paused || v.currentTime === s.lastCT ? s.stall + dt : 0;
    s.lastCT = v.currentTime;
    // refused to play (paused), or claims to play with data but is not advancing
    if ((v.paused && s.stall > 0.6) || (s.stall > 2 && v.readyState >= 3)) {
      s.manual = true;
      v.pause();
    }
  }
  const texTime = T.manual ? t % T.duration : T.video.currentTime;
  if (T.manual && !T.video.seeking) {
    const ft = frameTime(T, texTime);
    if (Math.abs(T.video.currentTime - ft) > 0.5 / FPS) T.video.currentTime = ft;
  }
  // keep the clay pass on the same turn as the textured one
  const want = (texTime / T.duration) * C.duration;
  if (C.manual) {
    const ft = frameTime(C, want);
    if (!C.video.seeking && Math.abs(C.video.currentTime - ft) > 0.5 / FPS) C.video.currentTime = ft;
  } else {
    C.video.playbackRate = C.duration / T.duration;
    if (!C.video.seeking && Math.abs(C.video.currentTime - want) > 0.15) C.video.currentTime = want;
  }
  // scrub the rig clip
  G.smooth = G.smooth === undefined ? video.grip : lerp(G.smooth, video.grip, 0.3);
  const g = frameTime(G, G.smooth);
  if (!G.video.seeking && Math.abs(G.video.currentTime - g) > 0.5 / FPS) G.video.currentTime = g;
}

function seek(src, time) {
  const v = src.video;
  const ft = frameTime(src, time);
  if (Math.abs(v.currentTime - ft) < 1e-3 && !v.seeking) return Promise.resolve();
  return new Promise((res) => {
    const done = () => {
      src.dirty = true;
      res();
    };
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = ft;
    setTimeout(done, 3000);
  });
}

// ---------- boot ----------
function onResize() {
  stage?.resize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);

let started = false;
loadingDone.then(() => {
  initStage();
  started = true;
});

if (!CAPTURE) {
  const t0 = performance.now();
  let lastLoopT = 0;
  const loop = (now) => {
    requestAnimationFrame(loop);
    lenis?.raf(now);
    const t = (now - t0) / 1000;
    const dt = t - lastLoopT;
    lastLoopT = t;
    const { s, video } = update(t);
    driveVideosLive(video, t, clamp(dt, 0, 0.1));
    stage?.render(s);
  };
  requestAnimationFrame(loop);
} else {
  // Deterministic frame stepping for recording (see tools/record.mjs).
  root.classList.add('is-capture');
  for (const src of Object.values(SOURCES)) src.video.pause();
  window.__capture = {
    ready: loadingDone.then(() => new Promise((r) => setTimeout(r, 50))),
    async frame(t, y, px, py) {
      scrollTo(0, y);
      if (px == null) {
        pointer.active = false;
        cursor.classList.remove('is-on');
      } else {
        pointer.x = px;
        pointer.y = py;
        pointer.active = true;
        cursor.classList.add('is-on');
      }
      const { s, video } = update(t);
      const texT = t % SOURCES.tex.duration;
      await Promise.all([
        seek(SOURCES.tex, texT),
        seek(SOURCES.clay, (texT / SOURCES.tex.duration) * SOURCES.clay.duration),
        seek(SOURCES.grip, video.grip),
      ]);
      stage?.render(s);
    },
    hover(selector, on) {
      const el = $(selector);
      el?.classList.toggle('is-hover', on);
      cursor.classList.toggle('is-link', on);
    },
  };
}
